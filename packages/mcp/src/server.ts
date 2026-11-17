import { randomUUID } from 'node:crypto';
import {
    createMcpHandler,
    hostHeaderValidationResponse,
    isLegacyRequest,
    originValidationResponse,
} from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { defineRouter, route } from '@spfn/core/route';
import type { RouteBuilderContext, RouteDef, Router } from '@spfn/core/route';
import {
    McpError,
    type McpAuth,
    type McpHttpRouteConfig,
    type McpRouteConfig,
} from './index';
import {
    createDispatcherServer,
    createMcpDispatcher,
    reportDispatcherError,
} from './dispatcher';

type RuntimeState<Auth, Ctx> = {
    auth: Auth;
    ctx: Ctx;
    requestId: string;
};

const RUNTIME_STATE_KEY = 'spfn.runtime';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const DEFAULT_RESOURCE_PATH = '/mcp';
const LITERAL_RESOURCE_PATH = /^(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9\-._~]+)+$/;

type ResourceMetadata = {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
    bearer_methods_supported: string[];
};

type ResolvedResource = {
    resource: string;
    /** The path the path-aware metadata route is named by; empty for a bare origin. */
    path: string;
    metadata: string;
    metadataUrl: string;
};

export function createMcpRoute<Auth extends McpAuth, Ctx>(
    config: McpRouteConfig<Auth, Ctx>,
): Router<Record<string, RouteDef>>
{
    return createMcpHttpRoute({
        ...config,
        dispatcher: createMcpDispatcher(config),
    });
}

export function createMcpHttpRoute<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
): Router<Record<string, RouteDef>>
{
    refuseInvalidLocation(config);
    const path = acceptedResourcePath(config);
    const resolve = resourceResolver(config, path);
    const handler = createMcpHandler(
        request => createDispatcherServer(
            config.dispatcher,
            runtimeState<Auth, Ctx>(request.authInfo),
        ),
        {
            legacy: 'stateless',
            responseMode: config.responseMode ?? 'auto',
            onerror: error => void reportDispatcherError(
                config.dispatcher,
                { operation: 'transport', error },
            ),
        },
    );
    const handle = (c: RouteBuilderContext) => handleRequest(
        config,
        handler.fetch,
        resolve,
        c,
    );

    return defineRouter({
        mcpPost: route.post('/mcp').skip('*').handler(handle),
        mcpGet: route.get('/mcp').skip('*').handler(handle),
        mcpDelete: route.delete('/mcp').skip('*').handler(handle),
        ...metadataRoutes(path ?? resolve().path, resolve),
    });
}

/**
 * Refuse what the config type refuses, for a caller the type did not reach.
 */
function refuseInvalidLocation<Auth extends McpAuth, Ctx>(config: McpHttpRouteConfig<Auth, Ctx>): void
{
    const appUrl: unknown = config.appUrl;
    if (typeof appUrl !== 'string' && typeof appUrl !== 'function')
    {
        throw new Error(
            `@spfn/mcp: \`appUrl\` was ${appUrl === null ? 'null' : typeof appUrl}; a string `
            + '`appUrl` is read when the router is created. For an origin known only at run '
            + 'time, such as one read from the environment, give a function that returns it.',
        );
    }
    if (config.resource !== undefined && typeof config.appUrl === 'function')
    {
        throw new Error(
            '@spfn/mcp: `resource` is not accepted with a lazy `appUrl`: its path cannot be '
            + 'known without calling `appUrl`. Give `resourcePath` instead.',
        );
    }
    if (config.resource !== undefined && config.resourcePath !== undefined)
    {
        throw new Error(
            '@spfn/mcp: `resource` and `resourcePath` are two sources of one fact; give one.',
        );
    }
}

/**
 * The resource's path, fixed when the router is created, or `undefined` when it is taken
 * from `resource` or the default as it always was.
 *
 * The one value the resource, the path-aware metadata route and the challenge URL are all
 * built from, so it is accepted only in a form the URL parser and the router both read as
 * the same literal path: one or more segments of URL unreserved characters
 * (`A-Z a-z 0-9 - . _ ~`), none of them `.` or `..`, each led by a single `/`. Anything
 * else — an escape, a query, a trailing `/`, or router syntax such as `:id`, `*` or `{…}` —
 * could publish one path and route another. `''` and `/` both name the bare origin,
 * returned as `''`.
 */
function acceptedResourcePath<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
): string | undefined
{
    const given: unknown = config.resourcePath;
    if (given === undefined)
    {
        return typeof config.appUrl === 'function' ? DEFAULT_RESOURCE_PATH : undefined;
    }
    if (given === '' || given === '/')
    {
        return '';
    }

    if (typeof given !== 'string' || !LITERAL_RESOURCE_PATH.test(given))
    {
        throw new Error(
            '@spfn/mcp: `resourcePath` must start with "/" and be segments of URL unreserved '
            + 'characters (A-Z a-z 0-9 - . _ ~), none "." or "..", joined by single "/" with no '
            + `trailing "/"; got ${JSON.stringify(given)}.`,
        );
    }

    return given;
}

/**
 * Everything derived from the resource, built on first use and kept once it succeeds.
 *
 * A string `appUrl` is resolved here, when the router is created, as it always was. A
 * lazy one is called on the first request that needs it; a call that throws is not
 * remembered, so the request that hit it fails with that error and the next one calls
 * again.
 */
function resourceResolver<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    path: string | undefined,
): () => ResolvedResource
{
    const appUrl = config.appUrl;
    if (typeof appUrl === 'string')
    {
        const resolved = resolveResource(config, path, appUrl);

        return () => resolved;
    }

    let resolved: ResolvedResource | undefined;

    return () => resolved ??= resolveResource(config, path, appUrl());
}

/**
 * With an accepted `path`, the resource is that path on the origin of `appUrl`; without
 * one, `resource` or the default is taken as it always was, and the path the metadata is
 * served under is read from it.
 */
function resolveResource<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    path: string | undefined,
    appUrl: string,
): ResolvedResource
{
    const location = path === undefined
        ? configuredResource(config, appUrl)
        : resourceOnOrigin(appOrigin(appUrl), path);

    return {
        resource: location.resource,
        path: location.path,
        metadata: JSON.stringify(resourceMetadata(config, location.resource, appUrl)),
        metadataUrl: config.resourceMetadataUrl
            ?? `${location.origin}${RESOURCE_METADATA_PATH}${location.path}`,
    };
}

type ResourceLocation = {
    resource: string;
    origin: string;
    path: string;
};

function resourceOnOrigin(origin: string, path: string): ResourceLocation
{
    return { resource: `${origin}${path}`, origin, path };
}

function configuredResource<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    appUrl: string,
): ResourceLocation
{
    const resource = (typeof config.resource === 'function'
        ? config.resource(appUrl)
        : config.resource) ?? `${appUrl.replace(/\/$/, '')}${DEFAULT_RESOURCE_PATH}`;
    const url = new URL(resource);

    return { resource, origin: url.origin, path: url.pathname.replace(/\/$/, '') };
}

function appOrigin(appUrl: unknown): string
{
    const url = typeof appUrl === 'string' && URL.canParse(appUrl) ? new URL(appUrl) : undefined;
    if (url?.protocol !== 'http:' && url?.protocol !== 'https:')
    {
        throw new Error(
            `@spfn/mcp: \`appUrl\` must be an absolute http(s) URL; got ${JSON.stringify(appUrl)}.`,
        );
    }

    return url.origin;
}

/**
 * The unauthenticated protected resource metadata document (RFC 9728).
 *
 * Served at the root path and, when the resource has a path of its own, at the
 * path-aware alias the 401 challenge points a client to. Both answer the same bytes.
 */
function metadataRoutes(
    suffix: string,
    resolve: () => ResolvedResource,
): Record<string, RouteDef>
{
    const respond = () => new Response(resolve().metadata, {
        headers: { 'content-type': 'application/json' },
    });
    const routes: Record<string, RouteDef> = {
        mcpResourceMetadata: route.get(RESOURCE_METADATA_PATH).skip('*').handler(respond),
    };

    if (suffix)
    {
        routes.mcpResourceMetadataForPath = route
            .get(`${RESOURCE_METADATA_PATH}${suffix}`)
            .skip('*')
            .handler(respond);
    }

    return routes;
}

function resourceMetadata<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    resource: string,
    appUrl: string,
): ResourceMetadata
{
    return {
        resource,
        authorization_servers: config.authorizationServers ?? [new URL(appUrl).origin],
        ...(config.scopesSupported ? { scopes_supported: config.scopesSupported } : {}),
        bearer_methods_supported: ['header'],
    };
}
async function handleRequest<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    fetch: ReturnType<typeof createMcpHandler>['fetch'],
    resolve: () => ResolvedResource,
    c: RouteBuilderContext,
): Promise<Response>
{
    const request = c.raw.req.raw;
    const rejected = validateSource(config, request);
    if (rejected)
    {
        return rejected;
    }

    // A lazy appUrl that throws is answered like any other server error, through the
    // application's error handler: a challenge would point the client at a made-up URL.
    const { resource, metadataUrl } = resolve();
    const bearer = bearerToken(request.headers.get('authorization'));
    if (!bearer)
    {
        return challenge(metadataUrl, false);
    }

    // A throw is not a refusal: it propagates to the application's error
    // handler, which answers it with its own status — a 403 from a validator
    // that knows the person may not act right now, a 5xx from one that could
    // not decide. Only null or undefined means the token is not valid.
    const auth = await config.validateToken(bearer, resource);
    if (!auth)
    {
        return challenge(metadataUrl, true);
    }

    const requestId = randomUUID();
    const era = await isLegacyRequest(request) ? 'legacy' : 'modern';
    try
    {
        const ctx = await config.resolveContext(auth, { era, requestId, request });

        return fetch(request, {
            authInfo: toAuthInfo(auth, bearer, resource, { auth, ctx, requestId }),
        });
    }
    catch (error)
    {
        await reportDispatcherError(config.dispatcher, { operation: 'context', error });

        return contextError(error);
    }
}

function validateSource<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    request: Request,
): Response | undefined
{
    const hostRejection = config.security?.allowedHosts
        ? hostHeaderValidationResponse(request, config.security.allowedHosts)
        : undefined;
    if (hostRejection)
    {
        return hostRejection;
    }

    return config.security?.allowedOrigins
        ? originValidationResponse(request, config.security.allowedOrigins)
        : undefined;
}

function bearerToken(header: string | null): string | undefined
{
    const match = header?.match(/^Bearer\s+(.+)$/i);

    return match?.[1];
}

/**
 * The RFC 9728 challenge.
 *
 * `rejectedBearer` distinguishes a token the client should replace from an absent one it
 * should go and obtain: RFC 6750 §3 marks the former with `error="invalid_token"`.
 */
function challenge(metadataUrl: string, rejectedBearer: boolean): Response
{
    const error = rejectedBearer ? 'error="invalid_token", ' : '';

    return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } },
        {
            status: 401,
            headers: {
                'WWW-Authenticate': `Bearer ${error}resource_metadata="${metadataUrl}"`,
            },
        },
    );
}

function toAuthInfo<Auth, Ctx>(
    auth: Auth & McpAuth,
    token: string,
    resource: string,
    state: RuntimeState<Auth, Ctx>,
): AuthInfo
{
    return {
        token,
        clientId: auth.clientId,
        scopes: auth.scopes,
        ...(auth.expiresAt === undefined ? {} : { expiresAt: auth.expiresAt }),
        resource: new URL(resource),
        extra: { [RUNTIME_STATE_KEY]: state },
    };
}

function runtimeState<Auth, Ctx>(authInfo: AuthInfo | undefined): RuntimeState<Auth, Ctx>
{
    const state = authInfo?.extra?.[RUNTIME_STATE_KEY];
    if (!state || typeof state !== 'object')
    {
        throw new Error('Missing SPFN MCP request state');
    }

    return state as RuntimeState<Auth, Ctx>;
}

function contextError(error: unknown): Response
{
    const exposed = error instanceof McpError;

    return Response.json(
        {
            jsonrpc: '2.0',
            id: null,
            error: {
                code: exposed ? error.code : -32603,
                message: exposed ? error.message : 'Internal error',
            },
        },
        { status: exposed ? (error.httpStatus ?? 400) : 500 },
    );
}

export { McpError } from './index';
export type {
    McpAuth,
    McpHttpRouteConfig,
    McpErrorEvent,
    McpIcon,
    McpObjectSchema,
    McpPromptArgument,
    McpPromptDefinition,
    McpPromptMessage,
    McpPromptResult,
    McpProtocolEra,
    McpRequestInfo,
    McpResourceDefinition,
    McpResourceLocation,
    McpResourceResult,
    McpRouteConfig,
    McpServerInfo,
    McpTool,
    McpToolAnnotations,
    McpToolCallEvent,
} from './index';
