/**
 * @spfn/auth - Authentication Middleware
 *
 * Verify client-signed JWT token with public key
 *
 * Flow:
 * 1. Extract Authorization header
 * 2. Decode JWT to extract keyId
 * 3. Fetch public key from database
 * 4. Verify JWT signature with public key
 * 5. Admission: user status, key revocation, a bound key's browser family,
 *    key expiration, the second-factor policy
 * 7. Update last used timestamp
 * 8. Attach user to context
 *
 * Security Checks:
 * - Token signature verification
 * - Key expiration check
 * - User status check (active/inactive/suspended)
 * - Key revocation check (isActive flag and the account's key generation)
 */

import type { Context, Next } from 'hono';
import { defineMiddleware } from '@spfn/core/route';
import { getClientIp } from '@spfn/core/middleware';
import { UnauthorizedError } from '@spfn/core/errors';

import type { ClientTokenRefusal, KeyAlgorithmType } from '@spfn/auth/server';
import { verifyClientToken, decodeToken, authLogger, keysRepository, REQUEST_TOKEN_MAX_LIFETIME_SECONDS, REQUEST_TOKEN_CLOCK_SKEW_SECONDS } from '@spfn/auth/server';
import {
    InvalidTokenError,
    TokenExpiredError,
    SecondFactorEnrolmentRequiredError,
} from '@spfn/auth/errors';

import type { UserPublicKey } from '../entities/user-public-keys';
import { recordKeyUse } from './record-key-use';
import { keyLiveness, type KeyWithAccountEpoch } from '../lib/key-liveness';
import { runAuthProfile, type AuthContext, type AuthProfileOutcome } from './auth-profiles';
import { matchesMachineDiscriminator } from './machine-principals';
import {
    admissionRefusalError,
    admitPrincipal,
    authContextFor,
    presentingRequest,
    type Admission,
    type PresentingRequest,
} from '../services/admission.service';
import { registerEnrolmentGate } from '../lib/enrolment-routes';

// Auth context type — one principal shape for every scheme (see admission.service).
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
    | ClientTokenRefusal;

/**
 * What a Bearer credential resolved to: the key row it named — live or
 * expired, never revoked — or why not.
 */
export type BearerOutcome =
    | { key: KeyWithAccountEpoch }
    | { refused: BearerRefusal };

/**
 * Admit the Bearer credential on this request, or say what stopped it.
 *
 * The one lookup-and-verify path every Bearer middleware takes — header, machine
 * discriminator, decode, key row, signature — kept in one place because the
 * order is itself a rule: a machine credential never reaches a decode, and a
 * key row is found before its signature is checked so that an unknown key and a
 * forged one cost the same work.
 *
 * An expired key is not answered here: it comes back like a live one once its
 * signature verified, and admission says what it gets — after the account, and
 * for a bound key after the browser family (`admitPrincipal`). Answering it
 * here would tell anyone who knows a key id, without its private key, that the
 * key is expired and renewable, and would prompt a copy presented from another
 * browser to renew the owner's session.
 *
 * It answers rather than throws, which is what lets two middlewares share it.
 * `authenticate` turns each refusal into the error that step has always
 * answered with; `authenticateForRenewal` turns every one of them into a single
 * refusal, so a caller holding no private key cannot tell a live key id from a
 * dead one. A shared step that threw would have to be unwound to get there.
 *
 * @param c - the Hono context of the request being authenticated
 */
export async function admitBearerKey(c: Context): Promise<BearerOutcome>
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

    // A revoked key — and one of an ended key generation, which is the same
    // thing (see keyLiveness) — is an unknown one.
    const key = await keysRepository.findWithAccountEpochOnPrimary(decoded.keyId as string);

    if (!key || keyLiveness(key) === 'revoked')
    {
        return { refused: 'unknown' };
    }

    return signatureOutcome(token, key);
}

/**
 * The token check — signature, issuer, algorithm, expiry and lifetime — as
 * the verifier's typed outcome. A token that ran out is told apart from every
 * other refusal: its client signs a new one, it does not sign in again.
 */
function signatureOutcome(token: string, key: KeyWithAccountEpoch): BearerOutcome
{
    const verified = verifyClientToken(
        token,
        key.publicKey,
        key.algorithm as KeyAlgorithmType, // entity.algorithm is always defined
    );

    return 'refused' in verified ? verified : { key };
}

/**
 * The error `authenticate` answers each refusal with, one per step. A token
 * that ran out answers `TokenExpiredError` — sign a new one — and every other
 * token refusal `InvalidTokenError`.
 *
 * `machine` and `undecodable` deliberately share a message: on this middleware
 * that makes the machine registry invisible (see INVALID_TOKEN_MESSAGE).
 */
function bearerRefusal(c: Context, outcome: { refused: BearerRefusal }): Error
{
    if (outcome.refused === 'absent')
    {
        authLogger.middleware.error('Missing or invalid authorization header. If using Next.js API routes, ensure you have imported \'@spfn/auth/nextjs/api\' in your API route handler (e.g., src/app/api/actions/[[...path]]/route.ts) to enable automatic authentication header forwarding from client to backend.', {
            headers: c.req.header(),
            path: c.req.path,
        });

        return new UnauthorizedError({ message: 'Authentication header missing or invalid: Bearer {token}' });
    }

    switch (outcome.refused)
    {
        case 'machine':
        case 'undecodable':
            return new UnauthorizedError({ message: INVALID_TOKEN_MESSAGE });
        case 'unknown':
            return admissionRefusalError({ reason: 'credentialRevoked' });
        case 'token-expired':
            return new TokenExpiredError();
        case 'bad-signature':
            return new InvalidTokenError({ message: 'Invalid token signature' });
        case 'malformed':
        case 'wrong-issuer-or-algorithm':
            return new InvalidTokenError();
        case 'bad-lifetime':
            return new InvalidTokenError({
                message: `Token must carry exp and iat, iat at most ${REQUEST_TOKEN_CLOCK_SKEW_SECONDS} seconds ahead, `
                    + `and live at most ${REQUEST_TOKEN_MAX_LIFETIME_SECONDS / 60} minutes`,
            });
    }
}

/**
 * The admission of a verified Bearer key: the account, the key's revocation on
 * the same read, a bound key's browser family, its expiry, and the
 * second-factor policy —
 * `admitPrincipal`, as every door asks it. `route` is the request for the
 * global `authenticate`, whose enrolment routes the policy exempts, and for
 * `optionalAuth`, which is no enrolment gate and so exempts none.
 *
 * @param presentedOn - the request a bound key's family is compared against;
 *   null only for sign-out, which is not family-checked
 */
export async function admitBearerPrincipal(c: Context, key: UserPublicKey, presentedOn: PresentingRequest | null): Promise<Admission>
{
    return await admitPrincipal({
        userId: key.userId,
        credential: { kind: 'deviceKey', keyId: key.keyId },
        route: c,
        presentedOn,
    });
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

    return await authenticateBearer(c, next, presentingRequest(c));
});

/**
 * `authenticate`'s Bearer path, for a request that names no auth profile.
 *
 * Exported for `authenticateForSignOut`, which runs it with `presentedOn` null:
 * a sign-out is not family-checked — a thief ending the owner's session does no
 * harm, and the owner ending it from a changed browser must work.
 *
 * @param presentedOn - the request a bound key's family is compared against
 */
export async function authenticateBearer(c: Context, next: Next, presentedOn: PresentingRequest | null): Promise<undefined>
{
    // 1.–4. The shared Bearer step: header, machine discriminator, decode, key
    //        row, signature. An expired key passes it; admission refuses it.
    const outcome = await admitBearerKey(c);

    if ('refused' in outcome)
    {
        throw bearerRefusal(c, outcome);
    }

    const keyRecord = outcome.key;
    const keyId = keyRecord.keyId;

    // 5.–6. The admission every door takes (admitPrincipal): the account's
    // status, the key's revocation on the same read, a bound key's browser
    // family, its expiry, then the second-factor policy, which an enrolment
    // route exempts here.
    const admission = await admitBearerPrincipal(c, keyRecord, presentedOn);

    if ('refused' in admission)
    {
        throw admissionRefusalError(admission.refused);
    }

    const { user } = admission.admitted;

    // 7. Record the key's use (fire-and-forget) — see recordKeyUse
    recordKeyUse(c, keyRecord, user);

    // 8. Attach auth data to context
    // Available in downstream route handlers via c.get('auth')
    c.set('auth', authContextFor(admission.admitted, 'bearer'));

    // Log API access
    const method = c.req.method;
    const path = c.req.path;
    authLogger.middleware.info('API access', {
        userId: user.id,
        email: user.email,
        keyId,
        method,
        path,
        ip: getClientIp(c),
        userAgent: c.req.header('user-agent'),
    });

    // Continue to route handler
    await next();

    return undefined;
}

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
    const profile = await optionalProfile(c);
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

        const keyRecord = await keysRepository.findWithAccountEpochOnPrimary(keyId);

        // A key that is not live continues anonymously rather than refusing —
        // revoked, of an ended generation, or expired, and that includes a bound
        // key past its window: this middleware's whole posture is that an
        // unusable credential is the same as none, and a route that works
        // signed-out must go on working. The renewal prompt belongs to the proxy
        // and to the routes that do require a principal. An unusable token —
        // expired, forged, too long-lived — is the same.
        if (!keyRecord || keyLiveness(keyRecord) !== 'live'
            || 'refused' in verifyClientToken(token, keyRecord.publicKey, keyRecord.algorithm as KeyAlgorithmType))
        {
            await next();

            return undefined;
        }

        // The admission `authenticate` asks, through the one function that
        // answers it. A refusal — an account that is not active, a key that
        // died, a person the policy holds to enrolling — continues
        // anonymously, which is this middleware's answer to an unusable
        // principal.
        const admission = await admitBearerPrincipal(c, keyRecord, presentingRequest(c));

        if ('admitted' in admission)
        {
            recordKeyUse(c, keyRecord, admission.admitted.user);

            c.set('auth', authContextFor(admission.admitted, 'bearer'));
        }
    }
    catch
    {
        // Invalid token, or a principal the account rules refuse — continue without auth context
    }

    await next();

    return undefined;
}, { skips: ['auth'] });

// The one middleware an enrolment route's marker answers to: it runs on every
// enrolment route, ahead of the route's own middlewares (#309).
registerEnrolmentGate(authenticate.handler);

/**
 * The profile path, as `optionalAuth` reads it.
 *
 * Presented-but-invalid profile credentials are refused, exactly as on
 * `authenticate`. A person the second-factor policy holds to enrolling is not
 * an invalid credential, though — it is a principal this route may not use,
 * which on a route that works signed-out is the anonymous caller the Bearer
 * path below also continues as.
 */
async function optionalProfile(c: Context): Promise<AuthProfileOutcome>
{
    try
    {
        return await runAuthProfile(c);
    }
    catch (err)
    {
        if (isEnrolmentRequiredRefusal(err))
        {
            return { kind: 'none' };
        }

        throw err;
    }
}

/**
 * Matched by name as well as by class: `@spfn/auth/errors` can resolve to two
 * module instances at once — the package entry and the source tree — and
 * `instanceof` across them is false.
 */
function isEnrolmentRequiredRefusal(err: unknown): boolean
{
    return err instanceof SecondFactorEnrolmentRequiredError
        || (err as { name?: unknown } | null)?.name === 'SecondFactorEnrolmentRequiredError';
}
