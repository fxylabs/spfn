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

type ResourceMetadata = {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
    bearer_methods_supported: string[];
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
    const resource = resolveResource(config);
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
        resource,
        c,
    );

    return defineRouter({
        mcpPost: route.post('/mcp').skip('*').handler(handle),
        mcpGet: route.get('/mcp').skip('*').handler(handle),
        mcpDelete: route.delete('/mcp').skip('*').handler(handle),
        ...metadataRoutes(config, resource),
    });
}

/**
 * The unauthenticated protected resource metadata document (RFC 9728).
 *
 * Served at the root path and, when the resource has a path of its own, at the
 * path-aware alias the 401 challenge points a client to. Both answer the same bytes.
 */
function metadataRoutes<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    resource: string,
): Record<string, RouteDef>
{
    const body = JSON.stringify(resourceMetadata(config, resource));
    const respond = () => new Response(body, {
        headers: { 'content-type': 'application/json' },
    });
    const suffix = resourcePath(resource);
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
): ResourceMetadata
{
    return {
        resource,
        authorization_servers: config.authorizationServers ?? [new URL(config.appUrl).origin],
        ...(config.scopesSupported ? { scopes_supported: config.scopesSupported } : {}),
        bearer_methods_supported: ['header'],
    };
}

/**
 * The resource's own path, with no trailing slash.
 *
 * Empty when the resource is a bare origin, which is the one case with no path-aware
 * metadata document to serve.
 */
function resourcePath(resource: string): string
{
    return new URL(resource).pathname.replace(/\/$/, '');
}

function resolveResource<Auth extends McpAuth, Ctx>(config: McpHttpRouteConfig<Auth, Ctx>): string
{
    const resource = typeof config.resource === 'function'
        ? config.resource(config.appUrl)
        : config.resource;

    return resource ?? `${config.appUrl.replace(/\/$/, '')}/mcp`;
}

async function handleRequest<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    fetch: ReturnType<typeof createMcpHandler>['fetch'],
    resource: string,
    c: RouteBuilderContext,
): Promise<Response>
{
    const request = c.raw.req.raw;
    const rejected = validateSource(config, request);
    if (rejected)
    {
        return rejected;
    }

    const bearer = bearerToken(request.headers.get('authorization'));
    if (!bearer)
    {
        return challenge(config, resource, false);
    }

    const auth = await validateAuth(config, bearer, resource);
    if (!auth)
    {
        return challenge(config, resource, true);
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

async function validateAuth<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    token: string,
    resource: string,
): Promise<Auth | null | undefined>
{
    try
    {
        return await config.validateToken(token, resource);
    }
    catch
    {
        return undefined;
    }
}

/**
 * The RFC 9728 challenge.
 *
 * `rejectedBearer` distinguishes a token the client should replace from an absent one it
 * should go and obtain: RFC 6750 §3 marks the former with `error="invalid_token"`.
 */
function challenge<Auth extends McpAuth, Ctx>(
    config: McpHttpRouteConfig<Auth, Ctx>,
    resource: string,
    rejectedBearer: boolean,
): Response
{
    const metadataUrl = config.resourceMetadataUrl ?? defaultMetadataUrl(resource);
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

function defaultMetadataUrl(resource: string): string
{
    return `${new URL(resource).origin}${RESOURCE_METADATA_PATH}${resourcePath(resource)}`;
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
    McpResourceResult,
    McpRouteConfig,
    McpServerInfo,
    McpTool,
    McpToolAnnotations,
    McpToolCallEvent,
} from './index';
