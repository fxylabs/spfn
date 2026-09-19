/**
 * @spfn/auth - Authentication Middleware
 *
 * Verify client-signed JWT token with public key
 *
 * Flow:
 * 1. Extract Authorization header
 * 2. Decode JWT to extract keyId
 * 3. Fetch public key from database
 * 4. Check key expiration
 * 5. Verify JWT signature with public key
 * 6. Validate user status
 * 7. Update last used timestamp
 * 8. Attach user to context
 *
 * Security Checks:
 * - Token signature verification
 * - Key expiration check
 * - User status check (active/inactive/suspended)
 * - Key revocation check (isActive flag)
 */

import type { Context } from 'hono';
import { defineMiddleware } from '@spfn/core/route';
import { UnauthorizedError } from '@spfn/core/errors';

import type { KeyAlgorithmType, User } from '@spfn/auth/server';
import { verifyClientToken, decodeToken, authLogger, keysRepository, usersRepository, userProfilesRepository } from '@spfn/auth/server';
import {
    InvalidTokenError,
    TokenExpiredError,
    KeyExpiredError,
} from '@spfn/auth/errors';

import type { UserPublicKey } from '../entities/user-public-keys';
import { readContextClientIdentity } from '../client-proof/version-middleware';
import { attestedClientIp } from '../lib/device-provenance';
import { resolveAuthenticatedUser, runAuthProfile, type AuthContext } from './auth-profiles';
import { matchesMachineDiscriminator } from './machine-principals';

// Auth context type — one principal shape for every scheme (see auth-profiles).
export type { AuthContext } from './auth-profiles';

/**
 * The refusal for a Bearer credential the user path will not admit.
 *
 * One message, shared by the machine-discriminator check and the decode step.
 * On `authenticate` that makes the registry invisible: a token in a registered
 * machine namespace answers exactly what a token in a namespace nobody
 * registered gets, so whether a machine verifier exists is not inferable from
 * the refusal (see machine-principals).
 *
 * `optionalAuth` is deliberately not that. A registered namespace is refused
 * with this message there while an unregistered one continues anonymously, so
 * on that route the registry is inferable — refusing the unregistered token
 * instead would mean refusing every unusable Bearer token, which is a change to
 * behaviour that predates machine principals. The trade is the paragraph after
 * the case table in README.md's "Machine principals" section.
 */
const INVALID_TOKEN_MESSAGE = 'Invalid token: missing keyId';

// Extend Hono context with auth
declare module 'hono'
{
    interface ContextVariableMap
    {
        auth: AuthContext;
    }
}

/** Why a Bearer credential was not admitted, in the order the steps run. */
export type BearerRefusal =
    | 'absent'
    | 'machine'
    | 'undecodable'
    | 'unknown'
    | 'expired'
    | 'token-expired'
    | 'bad-signature'
    | 'unverifiable';

/** What a Bearer credential resolved to: the key row it named, or why not. */
export type BearerOutcome = { key: UserPublicKey } | { refused: BearerRefusal };

/**
 * Admit the Bearer credential on this request, or say what stopped it.
 *
 * The one lookup-and-verify path every Bearer middleware takes — header, machine
 * discriminator, decode, key row, expiry, signature — kept in one place because
 * the order is itself a rule: a machine credential never reaches a decode, and a
 * key row is found before its signature is checked so that an unknown key and a
 * forged one cost the same work.
 *
 * It answers rather than throws, which is what lets two middlewares share it.
 * `authenticate` turns each refusal into the error that step has always
 * answered with; `authenticateForRenewal` turns every one of them into a single
 * refusal, so a caller holding no private key cannot tell a live key id from a
 * dead one. A shared step that threw would have to be unwound to get there.
 *
 * @param c - the Hono context of the request being authenticated
 * @param admitsExpired - whether a key past its `expiresAt` may still be
 *   admitted. Renewal is the only caller that says yes, and only for a bound key
 *   inside its grace.
 */
export async function admitBearerKey(
    c: Context,
    admitsExpired: (key: UserPublicKey) => boolean,
): Promise<BearerOutcome>
{
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer '))
    {
        return { refused: 'absent' };
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // A machine credential is refused before this path decodes it or looks a key
    // up. Resolving a machine token to its owning user is what would make the
    // machine's request indistinguishable from that user's own session (#79), so
    // the user path never admits one. With no machine verifier registered this is
    // two array-length checks and the flow below is unchanged.
    if (matchesMachineDiscriminator(token))
    {
        // The wire answer says nothing; the log says what happened, so an
        // operator can tell this apart from an ordinary malformed token.
        authLogger.middleware.warn('Machine credential presented to the user path — refused', { path: c.req.path });

        return { refused: 'machine' };
    }

    const decoded = decodeToken(token);

    if (!decoded || !decoded.keyId)
    {
        return { refused: 'undecodable' };
    }

    // isActive = true is part of the lookup, so a revoked key is an unknown one.
    const key = await keysRepository.findActiveByKeyId(decoded.keyId as string);

    if (!key)
    {
        return { refused: 'unknown' };
    }

    if (key.expiresAt && new Date() > key.expiresAt && !admitsExpired(key))
    {
        return { refused: 'expired' };
    }

    return signatureOutcome(token, key);
}

/**
 * The signature check, as an outcome rather than an exception.
 *
 * Three refusals rather than one because `authenticate` has always answered
 * three different things here — a 15-minute token that ran out is not a forged
 * one, and neither is a verifier that failed for a third reason.
 */
function signatureOutcome(token: string, key: UserPublicKey): BearerOutcome
{
    try
    {
        verifyClientToken(
            token,
            key.publicKey,
            key.algorithm as KeyAlgorithmType, // entity.algorithm is always defined
        );
    }
    catch (err)
    {
        const name = err instanceof Error ? err.name : '';

        if (name === 'TokenExpiredError')
        {
            return { refused: 'token-expired' };
        }

        return { refused: name === 'JsonWebTokenError' ? 'bad-signature' : 'unverifiable' };
    }

    return { key };
}

/**
 * The error `authenticate` answers each refusal with — unchanged, one per step.
 *
 * `machine` and `undecodable` deliberately share a message: on this middleware
 * that makes the machine registry invisible (see INVALID_TOKEN_MESSAGE).
 */
function bearerRefusal(c: Context, refused: BearerRefusal): Error
{
    if (refused === 'absent')
    {
        authLogger.middleware.error('Missing or invalid authorization header. If using Next.js API routes, ensure you have imported \'@spfn/auth/nextjs/api\' in your API route handler (e.g., src/app/api/actions/[[...path]]/route.ts) to enable automatic authentication header forwarding from client to backend.', {
            headers: c.req.header(),
            path: c.req.path,
        });

        return new UnauthorizedError({ message: 'Authentication header missing or invalid: Bearer {token}' });
    }

    switch (refused)
    {
        case 'machine':
        case 'undecodable':
            return new UnauthorizedError({ message: INVALID_TOKEN_MESSAGE });
        case 'unknown':
            return new UnauthorizedError({ message: 'Invalid or revoked key' });
        case 'expired':
            return new KeyExpiredError();
        case 'token-expired':
            return new TokenExpiredError();
        case 'bad-signature':
            return new InvalidTokenError({ message: 'Invalid token signature' });
        default:
            return new UnauthorizedError({ message: 'Authentication failed' });
    }
}

/**
 * The principal a verified Bearer key resolves to.
 *
 * The one place the Bearer path builds an `AuthContext`, so that a middleware
 * added beside `authenticate` cannot invent a second shape of it.
 */
export function bearerAuthContext(
    keyId: string,
    resolved: { user: User; role: string | null; locale: string },
): AuthContext
{
    return {
        user: resolved.user,
        userId: String(resolved.user.id),
        keyId,
        role: resolved.role,
        locale: resolved.locale,
        scheme: 'bearer',
    };
}

/**
 * Authentication middleware
 *
 * Verifies client-signed JWT token using stored public key
 * Must be applied to routes that require authentication
 *
 * @example
 * ```typescript
 * // In server.config.ts
 * import { authenticate } from '@spfn/auth/server/middleware';
 *
 * export default defineServerConfig()
 *   .middlewares([authenticate])
 *   .routes(appRouter)
 *   .build();
 *
 * // In route file - skip auth for public routes
 * export const publicRoute = route.get('/status')
 *   .skip(['auth'])  // Type-safe skip
 *   .handler(async (c) => c.success({ status: 'ok' }));
 *
 * // Protected route - auth applied automatically
 * export const protectedRoute = route.get('/profile')
 *   .handler(async (c) => {
 *     const auth = c.get('auth');  // Get auth context
 *     const { user, userId, keyId } = auth;
 *     // Or access directly: c.get('auth').user
 *   });
 * ```
 */
export const authenticate = defineMiddleware('auth', async (c, next) =>
{
    // Profile-named requests (x-spfn-auth-profile) are answered by the
    // registered verifier; a request mixing Bearer credentials in, and an
    // unknown profile, are refused inside runAuthProfile — which answers a
    // refusal with the contract's own error envelope rather than throwing.
    // Everything below this block is the unchanged Bearer path.
    const profile = await runAuthProfile(c);
    if (profile.kind === 'refused')
    {
        return profile.response;
    }
    if (profile.kind === 'authenticated')
    {
        c.set('auth', profile.auth);
        await next();

        return undefined;
    }

    // 1.–4. The shared Bearer step: header, machine discriminator, decode, key
    //        row, expiry, signature. No key past its `expiresAt` is admitted
    //        here — `authenticateForRenewal` is the only caller that says
    //        otherwise, and only for a bound key inside its renewal grace.
    const outcome = await admitBearerKey(c, () => false);

    if ('refused' in outcome)
    {
        throw bearerRefusal(c, outcome.refused);
    }

    const keyRecord = outcome.key;
    const keyId = keyRecord.keyId;

    // 5.–6. Load the user and apply the account-status rules — the shared
    // path every scheme takes (see resolveAuthenticatedUser).
    const resolved = await resolveAuthenticatedUser(keyRecord.userId);
    const { user } = resolved;

    // 7. Update last used timestamp (fire-and-forget)
    // Don't await to avoid blocking the request
    // Useful for:
    // - Security audits
    // - Detecting inactive keys
    // - Key rotation reminders
    // The client address joins the same statement — see updateLastUsedById — and
    // only where proxy-guard attested it, see attestedClientIp. A failure here
    // still never blocks the request: it is the audit trail and the concurrent-use
    // signal, neither of which is worth a 500.
    keysRepository.updateLastUsedById(keyRecord.id, readContextClientIdentity(c), attestedClientIp(c))
        .catch((err: unknown) => authLogger.middleware.error('Failed to update lastUsedAt', err));

    // 8. Attach auth data to context
    // Available in downstream route handlers via c.get('auth')
    c.set('auth', bearerAuthContext(keyId, resolved));

    // Log API access
    const method = c.req.method;
    const path = c.req.path;
    authLogger.middleware.info('API access', {
        userId: user.id,
        email: user.email,
        keyId,
        method,
        path,
        ip: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
        userAgent: c.req.header('user-agent'),
    });

    // Continue to route handler
    await next();

    return undefined;
});

/**
 * Optional authentication middleware
 *
 * Same as `authenticate` but does NOT reject unauthenticated requests.
 * - No token → continues without auth context
 * - Invalid token → continues without auth context
 * - Valid token → sets auth context normally
 *
 * Auto-skips the global 'auth' middleware when used at route level.
 *
 * @example
 * ```typescript
 * // No need for .skip(['auth']) — handled automatically
 * export const getProducts = route.get('/products')
 *   .use([optionalAuth])
 *   .handler(async (c) => {
 *     const auth = getOptionalAuth(c);  // AuthContext | undefined
 *
 *     if (auth)
 *     {
 *       return getPersonalizedProducts(auth.userId);
 *     }
 *
 *     return getPublicProducts();
 *   });
 * ```
 */
export const optionalAuth = defineMiddleware('optionalAuth', async (c, next) =>
{
    // Presented profile credentials are verified exactly as authenticate
    // does: credentials that are presented but invalid are refused with the
    // contract envelope, never downgraded to anonymous passage. Only
    // "presented nothing" continues without an auth context.
    const profile = await runAuthProfile(c);
    if (profile.kind === 'refused')
    {
        return profile.response;
    }
    if (profile.kind === 'authenticated')
    {
        c.set('auth', profile.auth);
        await next();

        return undefined;
    }

    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer '))
    {
        await next();

        return undefined;
    }

    const token = authHeader.substring(7);

    // A machine credential was presented, and this route cannot admit one:
    // refused, not downgraded to anonymous passage — the same answer presented
    // profile credentials get above, and the reason this check sits outside the
    // try below, which exists to swallow an unusable *user* token.
    if (matchesMachineDiscriminator(token))
    {
        authLogger.middleware.warn('Machine credential presented to the user path — refused', { path: c.req.path });

        throw new UnauthorizedError({ message: INVALID_TOKEN_MESSAGE });
    }

    try
    {
        const decoded = decodeToken(token);

        if (!decoded || !decoded.keyId)
        {
            await next();

            return undefined;
        }

        const keyId = decoded.keyId as string;

        const keyRecord = await keysRepository.findActiveByKeyId(keyId);

        if (!keyRecord)
        {
            await next();

            return undefined;
        }

        // An expired key continues anonymously rather than refusing, and that
        // includes a bound key past its window: this middleware's whole posture
        // is that an unusable credential is the same as none, and a route that
        // works signed-out must go on working. The renewal prompt belongs to the
        // proxy and to the routes that do require a principal.
        if (keyRecord.expiresAt && new Date() > keyRecord.expiresAt)
        {
            await next();

            return undefined;
        }

        verifyClientToken(
            token,
            keyRecord.publicKey,
            keyRecord.algorithm as KeyAlgorithmType,
        );

        const [result, locale] = await Promise.all([
            usersRepository.findByIdWithRole(keyRecord.userId),
            userProfilesRepository.findLocaleByUserId(keyRecord.userId),
        ]);

        if (!result || result.user.status !== 'active')
        {
            await next();

            return undefined;
        }

        const { user, role } = result;

        keysRepository.updateLastUsedById(keyRecord.id, readContextClientIdentity(c), attestedClientIp(c))
            .catch((err: unknown) => authLogger.middleware.error('Failed to update lastUsedAt', err));

        c.set('auth', {
            user,
            userId: String(user.id),
            keyId,
            role: role?.name ?? null,
            locale,
            scheme: 'bearer',
        });
    }
    catch
    {
        // Invalid token — continue without auth context
    }

    await next();

    return undefined;
}, { skips: ['auth'] });
