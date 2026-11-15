/**
 * Login/Register Interceptor
 *
 * Automatically handles key generation and session management
 * for login, register, and invitation-accept endpoints.
 * (Invitation acceptance creates the user account + key pair and
 * logs the new user in, so it follows the same key/session flow.)
 *
 * `session/renew/verify` is on the list too (#97). Renewing a bound session key
 * needs exactly what a sign-in needs — a fresh pair generated here, the public
 * half in the body, the private half sealed into the cookie — so it is served by
 * this interceptor rather than by a second copy of it. The body's `keyId` means
 * the new key on that path exactly as it does on every other; the key being
 * replaced is not in the body at all, it is the one `general-auth` signs the
 * request with — and because `general-auth` matches the same request, the
 * replacement credentials are kept under `newPrivateKey`/`newKeyId`/
 * `newAlgorithm` rather than under names that rule also writes (#99).
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession, unsealSession } from '../../server/lib/session';
import { signKeyReplacementProof } from '../../server/lib/key-replacement-proof';
import { getSessionTtl, COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';
import { bindingSessionFields } from './session-binding';

/**
 * The sign-in paths that replace a key the browser already holds.
 *
 * Register, invitation-accept and signup/password create the account, so there
 * is nothing to rotate; the two sign-ins can each arrive at a browser that is
 * already carrying a session key.
 */
const ROTATING_SIGN_IN_PATHS = new Set(['/_auth/login', '/_auth/passkeys/login/verify']);

/**
 * The fields that claim a replacement, which only this interceptor may write.
 *
 * Deleted from whatever the browser sent, on every path this rule matches,
 * before anything is decided: a key id the browser names is not a proof, and a
 * `replacementProof` it supplies would be one this proxy did not make.
 */
const REPLACEMENT_FIELDS = ['oldKeyId', 'replacementProof'] as const;

/**
 * A proof that this browser's session key is being replaced by `newKeyId`,
 * signed with that key's private half — or nothing, when there is no sealed
 * session to sign with.
 *
 * Only the **sealed** session cookie is read. The plain key-id cookie names a
 * key and proves nothing; the private key inside the sealed cookie is the one
 * thing that can, and an unreadable cookie is the same as none: the sign-in goes
 * ahead as a new device.
 */
async function replacementProofFromSession(sealed: string | undefined, newKeyId: string): Promise<string | undefined>
{
    const session = sealed ? await unsealSession(sealed).catch(() => null) : null;

    return session
        ? signKeyReplacementProof({ oldKeyId: session.keyId, newKeyId }, session.privateKey, session.algorithm)
        : undefined;
}

/**
 * Login, Register, and Invitation-Accept Interceptor
 *
 * Request: Generates key pair and adds publicKey to request body
 * Response: Saves privateKey to HttpOnly cookie
 */
export const loginRegisterInterceptor: InterceptorRule =
    {
        pathPattern: /^\/_auth\/(login|register|invitations\/accept|signup\/password|password\/reset\/complete|passkeys\/login\/verify|session\/renew\/verify)$/,
        method: 'POST',

        request: async (ctx, next) =>
        {
            // Extract remember option from request body (if provided)
            const remember = ctx.body?.remember;

            // Generate new key pair
            const keyPair = generateKeyPair('ES256');

            // Add publicKey data to request body
            if (!ctx.body)
            {
                ctx.body = {};
            }

            for (const field of REPLACEMENT_FIELDS)
            {
                delete ctx.body[field];
            }

            ctx.body.publicKey = keyPair.publicKey;
            ctx.body.keyId = keyPair.keyId;
            ctx.body.fingerprint = keyPair.fingerprint;
            ctx.body.algorithm = keyPair.algorithm;
            ctx.body.keySize = Buffer.from(keyPair.publicKey, 'base64').length;

            // Prove the replacement for a sign-in. Both sign-in paths: a passkey
            // assertion starts a session exactly as a password login does, so
            // the key the browser was already carrying has to be retired by the
            // same request that replaces it — and only a signature by that key
            // makes the backend treat this as the same device.
            const replacementProof = ROTATING_SIGN_IN_PATHS.has(ctx.path)
                ? await replacementProofFromSession(ctx.cookies.get(COOKIE_NAMES.SESSION), keyPair.keyId)
                : undefined;

            if (replacementProof)
            {
                ctx.body.replacementProof = replacementProof;
            }

            // Remove remember from body (not part of contract)
            delete ctx.body.remember;

            // Store the replacement credentials and remember in metadata for the
            // response interceptor. The `new` prefix is the whole point: the
            // metadata object is shared by every rule that matched this request,
            // and on `session/renew/verify` `generalAuthInterceptor` also matches
            // and writes `keyId` — the id of the *expiring* key it signs the
            // request with. Sharing that name sealed the new private key with the
            // retired id and answered 200 to a session the next request could not
            // use (#99). `keyRotationInterceptor` has always named them this way.
            ctx.metadata.newPrivateKey = keyPair.privateKey;
            ctx.metadata.newKeyId = keyPair.keyId;
            ctx.metadata.newAlgorithm = keyPair.algorithm;
            ctx.metadata.remember = remember;

            await next();
        },

        response: async (ctx, next) =>
        {
            // Only process successful responses
            if (ctx.response.status !== 200)
            {
                await next();

                return;
            }

            // Handle both wrapped ({ data: { userId } }) and direct ({ userId }) responses
            const userData = ctx.response.body?.data || ctx.response.body;
            if (!userData?.userId)
            {
                authLogger.interceptor.login.error('No userId in response');
                await next();

                return;
            }

            try
            {
                // Get session TTL (priority: runtime > global > env > default)
                const ttl = getSessionTtl(ctx.metadata.remember);

                // Encrypt session data. The binding fields ride along when the
                // sign-in said the account asked for a bound session; without
                // them this is the same four-field literal it has always been.
                const sessionData =
                    {
                        userId: userData.userId,
                        privateKey: ctx.metadata.newPrivateKey,
                        keyId: ctx.metadata.newKeyId,
                        algorithm: ctx.metadata.newAlgorithm,
                        ...bindingSessionFields(userData, ctx.request.headers['user-agent']),
                    };

                const sealed = await sealSession(sessionData, ttl);

                // Set HttpOnly session cookie
                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION,
                    value: sealed,
                    options: {
                        httpOnly: true,
                        secure: cookieSecure,
                        sameSite: 'lax',
                        maxAge: ttl,
                        path: '/',
                    },
                });

                // Set keyId cookie. Not read for the replacement decision — the
                // proof above is signed from the sealed cookie alone
                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION_KEY_ID,
                    value: ctx.metadata.newKeyId,
                    options: {
                        httpOnly: true,
                        secure: cookieSecure,
                        sameSite: 'lax',
                        maxAge: ttl,
                        path: '/',
                    },
                });

                // Set the readable CSRF cookie the client mirrors into a header
                await pushCsrfCookie(ctx.setCookies, ctx.metadata.newKeyId, ttl);
            }
            catch (error)
            {
                const err = error as Error;
                authLogger.interceptor.login.error('Failed to save session', err);
            }

            await next();
        },
    };
