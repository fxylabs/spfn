/**
 * @spfn/auth - Signed Sign-Out-Everywhere Link Routes
 *
 * The two endpoints behind the emailed link that signs every device of an
 * account out. Both are unauthenticated — the whole point is that the owner has
 * no device they trust to sign in on — and the token in the body is what stands
 * in for a credential.
 *
 * A separate file from the other auth routes, imported directly by
 * `routes/index.ts`: the route-map generator only parses files that file
 * imports, so a route reached through a re-export would be missing from the
 * generated map and from every typed client built on it.
 *
 * The token travels in the body and never in the path. `requestLogger` records
 * `new URL(req.url).pathname` on every request, so a bearer capability in a path
 * segment is a bearer capability in the application log — and in whatever proxy
 * log sits in front of it. The two mailed-link flows in this package are shaped
 * the same way, and the key-management section of the README states the rule.
 *
 * Opening the page is not signing out. `confirm` describes the link and changes
 * nothing, so a mail scanner that prefetches the page has done nothing; `consume`
 * is the owner pressing the button.
 */

import { Type } from '@sinclair/typebox';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

import {
    consumeRevokeAllLink as _consumeRevokeAllLink,
    describeRevokeAllLink,
} from '../../services';

/**
 * Body of both endpoints.
 *
 * `minLength: 1` and no upper bound of its own beyond what the framework gives:
 * every refusal here is the same 404, so a length that does not match a minted
 * token has nothing to say that the lookup does not already say — and a 400 that
 * fired for some tokens and not others would be a way to measure them.
 */
const revokeAllLinkBody = Type.Object({
    token: Type.String({
        minLength: 1,
        description: 'Token from the sign-out-everywhere link, read from the app page query string',
    }),
});

/**
 * The limit both endpoints share.
 *
 * One policy and one dimension for valid and invalid tokens alike: a counter
 * that only moved on refusals would tell whoever is trying values which of them
 * was real.
 */
const revokeAllLinkLimit = () => rateLimitPolicy('auth-keys-revoke-all', { limit: 10, windowMs: 60_000 });

/**
 * POST /_auth/keys/revoke-all/confirm - Describe a sign-out-everywhere link
 *
 * Answers what the link would do, so the app page can render it: when the link
 * stops working, and how many devices are signed in. Changes nothing at all.
 */
export const confirmRevokeAllLink = route.post('/_auth/keys/revoke-all/confirm')
    .input({ body: revokeAllLinkBody })
    .use([revokeAllLinkLimit()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const described = await describeRevokeAllLink(body.token);

        return {
            expiresAt: described.expiresAt.toISOString(),
            activeKeyCount: described.activeKeyCount,
        };
    });

/**
 * POST /_auth/keys/revoke-all/consume - Sign every device out
 *
 * One-time: the claim and the answer are one statement, so of two requests
 * carrying the same token exactly one gets the 200. Device-code approvals in
 * flight and OAuth 2.1 grants go with the keys, as they do on every other
 * global revocation.
 */
export const consumeRevokeAllLink = route.post('/_auth/keys/revoke-all/consume')
    .input({ body: revokeAllLinkBody })
    .use([revokeAllLinkLimit()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await _consumeRevokeAllLink(body.token);
    });
