/**
 * @spfn/auth - OAuth 2.1 Token and Revocation Routes
 *
 * The two endpoints a CLI talks to with no session and no cookie, from
 * somebody's laptop. Both are public, both are IP rate limited, and both answer
 * in RFC shapes rather than the application's envelope — see `./http.ts`.
 *
 * A separate file from the rest of the oauth2 routes, imported directly by
 * `routes/index.ts`: the route-map generator only parses files that file
 * imports, so a route reached through a re-export would be missing from the
 * generated map and from every typed client built on it.
 *
 * Neither endpoint is reachable through the Next.js proxy's CSRF check in any
 * state that could refuse it. That check runs only after a session cookie has
 * been unsealed, and these requests carry no cookie at all — and both paths are
 * listed in `getCsrfExemptPaths()` besides, so an application that does route
 * them through the proxy is not left with a 403 it cannot explain. The authorize
 * POST is deliberately not on that list: it IS a cookie-session mutation.
 */

import { route } from '@spfn/core/route';
import { rateLimitPolicy } from '@spfn/core/middleware';

import { oauth2TokenService, revokeOAuth2TokenService } from '../../services/oauth2-token.service';
import {
    oauth2ErrorResponse,
    oauth2JsonResponse,
    readOAuth2Body,
    requireAuthorizationServer,
} from './http';

/**
 * POST /_auth/oauth2/token
 *
 * `authorization_code` with a PKCE verifier, or `refresh_token` with rotation.
 * Every refusal is RFC 6749 §5.2 JSON with status 400 and `Cache-Control:
 * no-store`, which is what the waiting client can read.
 *
 * The limit is per IP and generous: one connection costs a client one exchange
 * and then one refresh every eight hours, so a number this size is only reached
 * by something trying codes.
 */
export const oauth2Token = route.post('/_auth/oauth2/token')
    .use([rateLimitPolicy('auth-oauth2-token', { limit: 60, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        const result = await oauth2TokenService(await readOAuth2Body(c.raw));

        if (!result.ok)
        {
            return oauth2ErrorResponse(c.raw, 400, result.error, result.description);
        }

        return oauth2JsonResponse(c.raw, 200, result.tokens);
    });

/**
 * POST /_auth/oauth2/revoke
 *
 * RFC 7009. Answers 200 for a token that was never issued as surely as for one
 * that was, so the endpoint cannot be used to ask whether a value found
 * somewhere is real. A body without a `token` field is the same 200 — there is
 * nothing to report about a revocation that was never asked for, and so is a
 * `client_id` that is not the token's.
 */
export const oauth2Revoke = route.post('/_auth/oauth2/revoke')
    .use([rateLimitPolicy('auth-oauth2-revoke', { limit: 60, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        const body = await readOAuth2Body(c.raw);

        await revokeOAuth2TokenService(body.token ?? '', body.client_id);

        return oauth2JsonResponse(c.raw, 200, {});
    });
