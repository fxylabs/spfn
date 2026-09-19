/**
 * @spfn/auth - Session Renewal Routes
 *
 * The two-step ceremony a bound session runs when its key has run out.
 *
 * Neither is behind `authenticate` — it refuses an expired key, which is every
 * caller here — and neither is public either. `authenticateForRenewal` verifies
 * the same bearer JWT `authenticate` would, and admits the one key `authenticate`
 * will not: this session's own, bound and inside its renewal grace. So the key a
 * renewal acts on is named by a signature rather than by a body field, and a
 * caller without the private half of that key gets one refusal whatever id they
 * name.
 *
 * The assertion is what the ceremony is actually worth: a JWT signed by a key
 * the person is trying to replace proves the cookie, and the cookie is what may
 * have been copied. The fresh WebAuthn signature is what the copy cannot make.
 *
 * Imported directly by `routes/index.ts`, like every other route file — the
 * route-map generator only parses what that file imports.
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

import { getAuth } from '../../helpers';
import { authenticateForRenewal } from '../../middleware/authenticate-for-renewal';
import { KEY_ALGORITHM } from '../../types';
import { finishSessionRenewService, startSessionRenewService } from '../../services';
import type { AuthenticationResponseJSON } from '../../lib/webauthn';

/**
 * The credential the browser hands back, passed through unchanged — the same
 * reasoning the passkey routes record.
 */
const CredentialResponseSchema = Type.Unknown({
    description: 'The credential from @simplewebauthn/browser, passed through unchanged',
});

/**
 * Ten a minute per address.
 *
 * Keyed on the address alone, unlike the authenticated passkey routes: the
 * principal here is a key that has already run out, and rate limiting by it would
 * key on the very thing a caller is trying to replace.
 *
 * Ahead of the middleware in `use`, so a flood costs the limiter rather than a
 * key lookup and a signature verification each.
 */
const RENEW_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * POST /_auth/session/renew/options - Begin renewing a bound session key
 *
 * `allowCredentials` comes back empty whoever is asking, and the account the
 * challenge belongs to lives only on the challenge row: a key id is not a secret
 * the cookie-copying adversary lacks — it is stored in the clear, only HttpOnly —
 * so an answer that listed this account's credential ids would hand them a stable
 * per-relying-party identifier list.
 */
export const sessionRenewOptions = route.post('/_auth/session/renew/options')
    .input({
        body: Type.Object({}),
    })
    .use([rateLimitPolicy('auth-session-renew', RENEW_RATE_LIMIT), authenticateForRenewal])
    .handler(async (c) =>
    {
        return await startSessionRenewService({ expiredKeyId: getAuth(c).keyId });
    });

/**
 * POST /_auth/session/renew/verify - Finish renewing, and get a new bound key
 *
 * The new key pair's fields arrive under the names the login interceptor already
 * writes — this path is on its list — while the key being replaced is read off
 * the credential the request is signed with, never off the body. `Transactional()`:
 * the challenge is spent, the old key revoked and the new one registered together,
 * so a failure part-way leaves a session that can still be renewed rather than one
 * with no key at all.
 */
export const sessionRenewVerify = route.post('/_auth/session/renew/verify')
    .input({
        body: Type.Object({
            response: CredentialResponseSchema,
        }),
    })
    .interceptor({
        body: Type.Object({
            publicKey: Type.String({ description: 'Client public key' }),
            keyId: Type.String({ description: 'Key identifier' }),
            fingerprint: Type.String({ description: 'Key fingerprint' }),
            algorithm: Type.Optional(Type.Union(
                KEY_ALGORITHM.map(algo => Type.Literal(algo)),
                { description: 'Signature algorithm — the service default when absent' },
            )),
        }),
    })
    .use([rateLimitPolicy('auth-session-renew', RENEW_RATE_LIMIT), authenticateForRenewal, Transactional()])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await finishSessionRenewService({
            ...body,
            expiredKeyId: getAuth(c).keyId,
            response: body.response as AuthenticationResponseJSON,
        });
    });
