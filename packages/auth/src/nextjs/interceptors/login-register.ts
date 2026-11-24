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

import type { InterceptorRule, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import { generateKeyPair } from '../../server/lib/crypto';
import { unsealSession } from '../../server/lib/session';
import { signKeyReplacementProof } from '../../server/lib/key-replacement-proof';
import { COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { establish } from './session-decision';
import { rememberField, takeRemember } from './remember';

/**
 * The paths this rule establishes a session on — every one but the renewal also
 * takes `remember` (`REMEMBER_PATHS`), and completes on the same request unless
 * it answers 202, when `mfaVerifyInterceptor` carries the choice to the verify.
 */
export const ESTABLISHING_PATHS = [
    '/_auth/login',
    '/_auth/register',
    '/_auth/invitations/accept',
    '/_auth/signup/password',
    '/_auth/password/reset/complete',
    '/_auth/passkeys/login/verify',
    '/_auth/session/renew/verify',
] as const;

/**
 * The sign-in paths that replace a key the browser already holds.
 *
 * Register, invitation-accept and signup/password create the account, so there
 * is nothing to rotate; the two sign-ins can each arrive at a browser that is
 * already carrying a session key.
 */
/** The sign-ins whose request takes `remember`. */
export const REMEMBER_PATHS = ESTABLISHING_PATHS.filter(path => path !== '/_auth/session/renew/verify');

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
        pathPattern: new RegExp(`^(${ESTABLISHING_PATHS.join('|')})$`),
        method: 'POST',

        request: async (ctx, next) =>
        {
            // A renewal continues the session it renews, kept or not (keptSession)
            const remember = ctx.path === '/_auth/session/renew/verify' ? false : takeRemember(ctx);

            if (remember === null)
            {
                return;
            }

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

            // A renewal's body carries no choice of its own
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
            // Handle both wrapped ({ data: { userId } }) and direct ({ userId }) responses
            const userData = ctx.response.body?.data || ctx.response.body;

            // Only a 200 that names the account it signed in is a session. The
            // user id is the backend's — the account the key was registered to —
            // and never anything the page sent.
            if (ctx.response.status === 200 && userData?.userId)
            {
                await establish(ctx, {
                    userId: String(userData.userId),
                    privateKey: ctx.metadata.newPrivateKey,
                    keyId: ctx.metadata.newKeyId,
                    algorithm: ctx.metadata.newAlgorithm,
                    ...rememberField(keptSession(ctx)),
                });
            }
            else if (ctx.response.status === 200)
            {
                authLogger.interceptor.login.error('No userId in response');
            }

            await next();
        },
    };

/**
 * Whether the session being sealed is a kept one: the sign-in asked, or — for a
 * renewal, which continues the session it renews — the renewed one was.
 */
function keptSession(ctx: Pick<ResponseInterceptorContext, 'path' | 'metadata'>): boolean
{
    return ctx.path === '/_auth/session/renew/verify'
        ? ctx.metadata.inboundSession?.remember === true
        : ctx.metadata.remember === true;
}
