/**
 * OAuth 2.1 endpoint plumbing
 *
 * Two things the rest of this package does not need and these endpoints cannot
 * do without.
 *
 * **The error shape.** RFC 6749 §5.2 and RFC 7591 §3.2.2 both say a failure is
 * `{ "error": "...", "error_description": "..." }` with status 400 and
 * `Cache-Control: no-store`. The application's own envelope is a different
 * shape, and the client reading this one is an OAuth library that knows those
 * two field names and nothing about SPFN — so these routes build the response
 * themselves and return it, which `registerRoutes` passes through untouched
 * when a handler returns a `Response`.
 *
 * **The request shape.** RFC 6749 §4.1.3 says a token request is
 * `application/x-www-form-urlencoded`, and that is what every OAuth client
 * sends; some registration clients send JSON. Neither is declared as a route
 * input schema, because a schema violation would be answered in the envelope
 * these endpoints are not allowed to speak. The body is read here and validated
 * by the service, which refuses in the right words.
 */

import type { Context } from 'hono';
import { NotFoundError } from '@spfn/core/errors';

import {
    getAuthorizationServerConfig,
    type AuthorizationServerConfig,
} from '../../lib/oauth2/config';

/** `no-store` on every one of these answers: tokens and codes are in them. */
const NO_STORE_HEADERS = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
};

/**
 * The configuration these endpoints need, or a 404.
 *
 * The routes are registered unconditionally because registration happens at
 * module-import time, which always precedes `createAuthLifecycle()` in the
 * application's own module — the same ordering that makes the job router take
 * its cron as a parameter. So "not registered when unconfigured" is not
 * available, and 404 is the next truest thing: an application that runs no
 * authorization server has no metadata document, no registration endpoint and
 * no token endpoint, which is exactly what a discovery request finds.
 */
export function requireAuthorizationServer(): AuthorizationServerConfig
{
    const config = getAuthorizationServerConfig();

    if (!config)
    {
        throw new NotFoundError({
            message: 'This application does not run an OAuth 2.1 authorization server. '
                + 'Pass `authorizationServer` to createAuthLifecycle() to enable one.',
        });
    }

    return config;
}

/** An RFC-shaped refusal, built rather than thrown. */
export function oauth2ErrorResponse(
    c: Context,
    status: 400 | 429,
    error: string,
    description: string,
): Response
{
    return c.json({ error, error_description: description }, status, NO_STORE_HEADERS);
}

/** A success answer that must not be cached — the token and register responses. */
export function oauth2JsonResponse(c: Context, status: 200 | 201, body: unknown): Response
{
    return c.json(body, status, NO_STORE_HEADERS);
}

/**
 * The request body as flat strings, whichever of the two encodings it arrived in.
 *
 * A body that is neither parses to nothing, and the service refuses it on the
 * fields it is missing — which is the same refusal a well-formed body missing
 * those fields earns, and one fewer way for this endpoint to answer.
 */
export async function readOAuth2Body(c: Context): Promise<Record<string, string>>
{
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('application/json'))
    {
        return await readJsonBody(c);
    }

    return await readFormBody(c);
}

async function readJsonBody(c: Context): Promise<Record<string, string>>
{
    try
    {
        return flatten(await c.req.json());
    }
    catch
    {
        return {};
    }
}

async function readFormBody(c: Context): Promise<Record<string, string>>
{
    try
    {
        return flatten(await c.req.parseBody());
    }
    catch
    {
        return {};
    }
}

/**
 * Keep the string-valued fields and drop everything else.
 *
 * `redirect_uris` on a registration is the one array this surface takes, and it
 * is read from the parsed JSON directly rather than through here — every other
 * field is a single string by specification, and a client sending an object or
 * an uploaded file where one belongs has sent something this endpoint has no
 * reading of.
 */
function flatten(parsed: unknown): Record<string, string>
{
    if (!parsed || typeof parsed !== 'object')
    {
        return {};
    }

    const flat: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>))
    {
        if (typeof value === 'string')
        {
            flat[key] = value;
        }
    }

    return flat;
}
