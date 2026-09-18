/**
 * @spfn/auth - OAuth 2.1 Authorize Routes (API side)
 *
 * The consent screen is a page on the web app, because that is where the session
 * cookie lives and this is the API. These two routes are what that page calls:
 * GET asks what to draw, POST records what the user decided. Both authenticate —
 * a consent with no signed-in account is not a consent — and both are rate
 * limited per calling account as well as per IP, since the identifier being
 * tried here is a `client_id` and not an address.
 *
 * A separate file from the rest of the oauth2 routes, imported directly by
 * `routes/index.ts`, for the reason `password-reset.ts` is: the route-map
 * generator only parses files that file imports.
 *
 * These answer in the application's own envelope and not in RFC shapes,
 * deliberately. Their caller is the web handler over RPC, not an OAuth client —
 * the handler is the one that turns a refusal into either a screen or a 302, and
 * `OAuth2AuthorizeRedirectError` carries the vetted redirect URI it needs to
 * build that 302 safely.
 */

import { Type } from '@sinclair/typebox';
import { route } from '@spfn/core/route';
import { rateLimitPolicy } from '@spfn/core/middleware';

import { authenticate } from '../../middleware';
import { getAuth } from '../../helpers';
import { byIpAndCaller } from '../../lib/rate-limit-keys';
import {
    approveOAuth2AuthorizeService,
    denyOAuth2AuthorizeService,
    describeOAuth2AuthorizeRequestService,
    type OAuth2AuthorizeParams,
} from '../../services/oauth2-authorize.service';
import { requireAuthorizationServer } from './http';

/** The request the consent screen is deciding about, as query or as body. */
const AUTHORIZE_FIELDS = {
    client_id: Type.String({ minLength: 1, description: 'client_id from dynamic registration' }),
    redirect_uri: Type.String({ minLength: 1, description: 'Where the code is sent; must be registered' }),
    code_challenge: Type.Optional(Type.String({ description: 'PKCE S256 challenge' })),
    code_challenge_method: Type.Optional(Type.String({ description: 'Must be S256' })),
    resource: Type.Optional(Type.String({ description: 'RFC 8707 target the token will be good against' })),
    scope: Type.Optional(Type.String({ description: 'Space-delimited scope names; absent asks for the default set' })),
    state: Type.Optional(Type.String({ description: "Client's opaque value, echoed back verbatim" })),
};

/** Route input names the fields as the protocol spells them; the service does not. */
function toParams(input: Record<string, unknown>): OAuth2AuthorizeParams
{
    return {
        clientId: input.client_id as string,
        redirectUri: input.redirect_uri as string,
        codeChallenge: input.code_challenge as string | undefined,
        codeChallengeMethod: input.code_challenge_method as string | undefined,
        resource: input.resource as string | undefined,
        scope: input.scope as string | undefined,
        state: input.state as string | undefined,
    };
}

const authorizeRateLimit = rateLimitPolicy('auth-oauth2-authorize', {
    limit: 30,
    windowMs: 60_000,
    by: byIpAndCaller({ ipLimit: 120 }),
});

/**
 * GET /_auth/oauth2/authorize
 *
 * What the consent screen should say: who is asking, where the code would go,
 * which permissions in words, and for which resource. Records nothing — a user
 * who closes the tab has consented to nothing and left nothing behind.
 */
export const getOAuth2Authorize = route.get('/_auth/oauth2/authorize')
    .input({ query: Type.Object(AUTHORIZE_FIELDS) })
    .use([authenticate, authorizeRateLimit])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        const { query } = await c.data();

        return await describeOAuth2AuthorizeRequestService(toParams(query));
    });

/**
 * POST /_auth/oauth2/authorize
 *
 * The decision. Validates the whole request again rather than trusting what the
 * GET was shown — the form between the two is in the user's browser.
 *
 * `userId` is read from the authenticated session and never from the body: it is
 * the entire authorization, and a body field of that name would let a caller
 * consent on somebody else's behalf.
 */
export const createOAuth2AuthorizationCode = route.post('/_auth/oauth2/authorize')
    .input({
        body: Type.Object({
            ...AUTHORIZE_FIELDS,
            approve: Type.Boolean({ description: 'What the account owner decided' }),
        }),
    })
    .use([authenticate, authorizeRateLimit])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        const { body } = await c.data();
        const params = toParams(body);

        if (!body.approve)
        {
            return await denyOAuth2AuthorizeService(params);
        }

        return await approveOAuth2AuthorizeService(params, Number(getAuth(c).userId));
    });
