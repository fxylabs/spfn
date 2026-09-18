/**
 * @spfn/auth - Session Renewal Routes
 *
 * The two-step ceremony a bound session runs when its key has run out.
 *
 * Both are public, and they have to be: the credential they would authenticate
 * with is the one that stopped working. What stands in for authentication is the
 * assertion itself — `verify` is worth nothing without a fresh signature from a
 * passkey the key's owner enrolled, which is also why a public path being exempt
 * from the proxy's CSRF check costs nothing here.
 *
 * `expiredKeyId` is injected by `sessionRenewInterceptor` from the HttpOnly
 * key-id cookie, which page script cannot read. A caller reaching these routes
 * directly may send any value; the service treats it as the unauthenticated input
 * it is and answers the same refusal for every value that does not work out.
 *
 * Imported directly by `routes/index.ts`, like every other route file — the
 * route-map generator only parses what that file imports.
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

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
 * Keyed on the address alone, unlike the authenticated passkey routes: there is
 * no principal to key on here, which is the whole shape of these two routes.
 */
const RENEW_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/**
 * POST /_auth/session/renew/options - Begin renewing a bound session key
 *
 * `allowCredentials` comes back empty whoever is asking, and the account the
 * challenge belongs to lives only on the challenge row. A key id is not a secret
 * the cookie-copying adversary lacks — it is stored in the clear, only HttpOnly —
 * so an answer that listed this account's credential ids would hand them a stable
 * per-relying-party identifier list and a live-or-not oracle on the id.
 */
export const sessionRenewOptions = route.post('/_auth/session/renew/options')
    .input({
        body: Type.Object({}),
    })
    .interceptor({
        body: Type.Object({
            expiredKeyId: Type.String({ description: 'Key that ran out, from the session key-id cookie' }),
        }),
    })
    .use([rateLimitPolicy('auth-session-renew', RENEW_RATE_LIMIT)])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await startSessionRenewService({ expiredKeyId: body.expiredKeyId });
    });

/**
 * POST /_auth/session/renew/verify - Finish renewing, and get a new bound key
 *
 * The new key pair's fields arrive under the names the login interceptor already
 * writes — this path is on its list — so the expiring key needs its own name and
 * has it. `Transactional()`: the challenge is spent, the old key revoked and the
 * new one registered together, so a failure part-way leaves a session that can
 * still be renewed rather than one with no key at all.
 */
export const sessionRenewVerify = route.post('/_auth/session/renew/verify')
    .input({
        body: Type.Object({
            response: CredentialResponseSchema,
        }),
    })
    .interceptor({
        body: Type.Object({
            expiredKeyId: Type.String({ description: 'Key that ran out, from the session key-id cookie' }),
            publicKey: Type.String({ description: 'Client public key' }),
            keyId: Type.String({ description: 'Key identifier' }),
            fingerprint: Type.String({ description: 'Key fingerprint' }),
            algorithm: Type.Union(KEY_ALGORITHM.map(algo => Type.Literal(algo)), { description: 'Signature algorithm' }),
        }),
    })
    .use([rateLimitPolicy('auth-session-renew', RENEW_RATE_LIMIT), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await finishSessionRenewService({
            ...body,
            response: body.response as AuthenticationResponseJSON,
        });
    });
