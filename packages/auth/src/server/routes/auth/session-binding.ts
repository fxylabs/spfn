/**
 * @spfn/auth - Session Binding Routes
 *
 * The account setting behind #97: whether this account's web sessions run on a
 * key that expires in hours and can only be renewed by a fresh passkey
 * assertion.
 *
 * All three need a session. That is the difference between this file and
 * `session-renew.ts` beside it: renewing is what a browser does once its key has
 * already run out, so it cannot be behind authentication, while changing the
 * setting is an account change like any other.
 *
 * Imported directly by `routes/index.ts`. The route-map generator only parses
 * files that file imports, so a route reached through a re-export would be
 * missing from the generated map and from every typed client built on it.
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

import { getAuth } from '../../helpers';
import { byIpAndCaller } from '../../lib/rate-limit-keys';
import { deviceProvenance } from '../../lib/device-provenance';
import {
    disableSessionBindingService,
    enableSessionBindingService,
    getSessionBindingService,
    startSessionBindingDisableService,
} from '../../services';
import type { AuthenticationResponseJSON } from '../../lib/webauthn';

/**
 * The credential the browser hands back, passed through to the WebAuthn adapter
 * as it arrived — the same reasoning as the passkey routes: the library decides
 * what a valid response is, and a second copy of that shape here would start
 * refusing responses the moment the specification grows a field.
 */
const CredentialResponseSchema = Type.Unknown({
    description: 'The credential from @simplewebauthn/browser, passed through unchanged',
});

const CurrentPasswordSchema = Type.String({
    minLength: 1,
    description: 'Account password — one of the two ways to prove ownership when turning binding off',
});

/**
 * POST /_auth/session/binding - Turn session binding on or off
 *
 * On needs recent authentication and a live passkey to renew with; off needs a
 * fresh credential rather than key age, because a cookie copied minutes after a
 * sign-in satisfies key age and would otherwise be able to switch the protection
 * off. The 200 is what the Next.js interceptor re-seals the session cookie from,
 * so the browser stops believing in an expiry that no longer applies.
 */
export const setSessionBinding = route.post('/_auth/session/binding')
    .input({
        body: Type.Object({
            mode: Type.Union([Type.Literal('passkey'), Type.Literal('none')], {
                description: 'passkey binds this account\'s web sessions; none returns them to ordinary long-lived keys',
            }),
            response: Type.Optional(CredentialResponseSchema),
            currentPassword: Type.Optional(CurrentPasswordSchema),
        }),
    })
    .use([
        rateLimitPolicy('auth-session-binding', {
            limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }),
        }),
        Transactional(),
    ])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId, keyId } = getAuth(c);
        const params = { userId: Number(userId), keyId, webProxy: deviceProvenance(c.raw).webProxy };

        if (body.mode === 'none')
        {
            return await disableSessionBindingService({
                ...params,
                response: body.response as AuthenticationResponseJSON | undefined,
                currentPassword: body.currentPassword,
            });
        }

        return await enableSessionBindingService(params);
    });

/**
 * GET /_auth/session/binding - What binding is on, and when this key expires
 *
 * A GET, unlike the key-management routes: it takes no arguments, so there is no
 * body for the mobile auth profile to sign and nothing the shape could disagree
 * about.
 */
export const getSessionBinding = route.get('/_auth/session/binding')
    .handler(async (c) =>
    {
        const { userId, keyId } = getAuth(c);

        return await getSessionBindingService({ userId: Number(userId), keyId });
    });

/**
 * POST /_auth/session/binding/disable/options - Challenge for turning binding off
 *
 * Authenticated, unlike `session/renew/options`: this one is asked for by a
 * session that still works, so there is no reason to answer it to anyone else.
 * `allowCredentials` is empty all the same — the ceremony is happening on the
 * device that holds the passkey, so naming the account's credential ids buys
 * nothing and costs the rule the sign-in ceremony keeps.
 */
export const sessionBindingDisableOptions = route.post('/_auth/session/binding/disable/options')
    .input({
        body: Type.Object({}, {
            additionalProperties: false,
            description: 'No input — the session names the account',
        }),
    })
    .use([rateLimitPolicy('auth-session-binding-disable-options', {
        limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }),
    })])
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);

        return await startSessionBindingDisableService(Number(userId));
    });
