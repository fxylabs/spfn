/**
 * @spfn/auth - OAuth 2.1 Registration, Grants and Metadata Routes
 *
 * Three unrelated endpoints that share a file because each is a handful of
 * lines: the public one a CLI registers itself at, the pair a user manages
 * their connected CLIs with, and the discovery document that leads a client to
 * all of them.
 *
 * The token and revoke endpoints are in `./token.ts` and the authorize pair in
 * `./authorize.ts`, both imported directly by `routes/index.ts` — the route-map
 * generator parses only the files that file imports, so a route reached through
 * a re-export would be missing from every typed client built on the map.
 */

import type { Context } from 'hono';
import { Type } from '@sinclair/typebox';
import { route } from '@spfn/core/route';
import { getClientIp, rateLimitPolicy } from '@spfn/core/middleware';

import { authenticate } from '../../middleware';
import { getAuth } from '../../helpers';
import {
    registerOAuth2ClientService,
    SUPPORTED_GRANT_TYPES,
    SUPPORTED_RESPONSE_TYPES,
} from '../../services/oauth2-client.service';
import {
    listOAuth2GrantsService,
    revokeOAuth2GrantService,
} from '../../services/oauth2-grant.service';
import { oauth2ErrorResponse, oauth2JsonResponse, requireAuthorizationServer } from './http';

/**
 * POST /_auth/oauth2/register
 *
 * RFC 7591 dynamic client registration, unauthenticated by definition — the CLI
 * has nothing to authenticate with yet, and a registered client authorizes
 * nothing until a user approves it.
 *
 * Two bounds, because this is a table anyone may write to. This limit caps the
 * rate from one address; the service caps how many unapproved clients one
 * address may have standing at once, which a rate limit cannot do — a row costs
 * nothing to make and lives until the purge job sweeps it, so a slow enough
 * attacker walks past any window.
 *
 * `redirect_uris` is the one array this surface takes, so the body is read as
 * JSON here rather than through the shared flat reader.
 */
export const registerOAuth2Client = route.post('/_auth/oauth2/register')
    .use([rateLimitPolicy('auth-oauth2-register', { limit: 10, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        const body = await readRegistrationBody(c.raw);
        const result = await registerOAuth2ClientService(body, getClientIp(c.raw) || null);

        if (!result.ok)
        {
            return oauth2ErrorResponse(c.raw, result.status, result.error, result.description);
        }

        return oauth2JsonResponse(c.raw, 201, result.client);
    });

/**
 * The registration body, unvalidated.
 *
 * JSON and nothing else: RFC 7591 §3.1 says a registration request is
 * `application/json`, which is what makes this the one surface in the feature
 * that does not go through `readOAuth2Body` — `redirect_uris` is an array, and
 * the flat reader the form-encoded endpoints share would drop it.
 *
 * Nothing is asserted about its shape here — the service refuses in RFC 7591's
 * own words, and a route input schema would refuse in the application's envelope
 * instead, which the client's OAuth library cannot read. A body that is not JSON
 * at all becomes an empty object and earns the same refusal as one missing
 * `redirect_uris`, because that is what it is.
 */
async function readRegistrationBody(c: Context): Promise<Record<string, unknown>>
{
    try
    {
        const parsed: unknown = await c.req.json();

        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    }
    catch
    {
        return {};
    }
}

/**
 * GET /_auth/oauth2/grants
 *
 * What this account has connected — one entry per client, resource and scope
 * set, which is the unit a person can recognise and the unit revocation works
 * on.
 */
export const listOAuth2Grants = route.get('/_auth/oauth2/grants')
    .use([authenticate])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        return { grants: await listOAuth2GrantsService(Number(getAuth(c).userId)) };
    });

/**
 * DELETE /_auth/oauth2/grants/:id
 *
 * Disconnect one client. Takes effect immediately: the grant and every token
 * under it are revoked in the same call, and verification reads the primary.
 */
export const revokeOAuth2Grant = route.delete('/_auth/oauth2/grants/:id')
    .input({ params: Type.Object({ id: Type.Number({ description: 'Grant id from the list' }) }) })
    .use([authenticate])
    .handler(async (c) =>
    {
        requireAuthorizationServer();

        const { params } = await c.data();

        await revokeOAuth2GrantService(params.id, Number(getAuth(c).userId));

        return { revoked: true };
    });

/**
 * GET /.well-known/oauth-authorization-server
 *
 * RFC 8414. The first request any MCP client makes, and the reason the issuer
 * has to be an origin with no path — this document is served at an origin's
 * root and nowhere else, which the boot check refuses to start without.
 *
 * `authorization_endpoint` is on the web app while everything else is on the
 * API, which RFC 8414 allows and this deployment needs: the consent screen is
 * the one part of the flow that requires the session cookie.
 */
export const oauth2AuthorizationServerMetadata = route.get('/.well-known/oauth-authorization-server')
    .skip(['auth'])
    .handler(async (c) =>
    {
        const config = requireAuthorizationServer();

        return c.json({
            issuer: config.issuer,
            authorization_endpoint: config.authorizeUrl,
            token_endpoint: new URL('/_auth/oauth2/token', config.issuer).toString(),
            registration_endpoint: new URL('/_auth/oauth2/register', config.issuer).toString(),
            revocation_endpoint: new URL('/_auth/oauth2/revoke', config.issuer).toString(),
            response_types_supported: SUPPORTED_RESPONSE_TYPES,
            grant_types_supported: SUPPORTED_GRANT_TYPES,
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: Object.keys(config.scopes),
        });
    });
