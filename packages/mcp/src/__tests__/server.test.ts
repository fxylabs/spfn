import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { defineMiddleware, defineRouter, registerRoutes } from '@spfn/core/route';
import type { RouteDef } from '@spfn/core/route';
import { createMcpRoute } from '../server';
import type { McpRouteConfig } from '../index';

type TestAuth = {
    clientId: string;
    scopes: string[];
    userId: number;
};

function createConfig(overrides: Partial<McpRouteConfig<TestAuth, { userId: number }>> = {}): McpRouteConfig<TestAuth, { userId: number }>
{
    return {
        appUrl: 'https://example.com',
        serverInfo: { name: 'test-server', version: '1.0.0' },
        validateToken: async token =>
        {
            if (token !== 'valid-token')
            {
                return null;
            }

            return { clientId: 'client-1', scopes: ['tools'], userId: 42 };
        },
        resolveContext: async auth => ({ userId: auth.userId }),
        listTools: () => [{
            name: 'echo',
            description: 'Echo a message',
            inputSchema: {
                type: 'object',
                properties: { message: { type: 'string' } },
                required: ['message'],
            },
            handler: async (args, ctx) => ({ message: args.message, userId: ctx.userId }),
        }],
        ...overrides,
    };
}

function createApp(overrides: Partial<McpRouteConfig<TestAuth, { userId: number }>> = {}): Hono
{
    const app = new Hono();
    registerRoutes(app, createMcpRoute(createConfig(overrides)));

    return app;
}

function readSseMessage(body: string): Record<string, unknown>
{
    const data = body
        .split('\n')
        .find(line => line.startsWith('data: '))
        ?.slice('data: '.length);

    if (!data)
    {
        throw new Error('SSE response did not contain a data event');
    }

    return JSON.parse(data) as Record<string, unknown>;
}

describe('createMcpRoute', () =>
{
    it('returns an RFC 9728 challenge when authentication is missing', async () =>
    {
        const response = await createApp().request('/mcp', { method: 'POST' });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer resource_metadata='
            + '"https://example.com/.well-known/oauth-protected-resource/mcp"',
        );
        expect(response.headers.get('www-authenticate')).not.toContain('error=');
    });

    it('mounts modern protocol discovery on the SPFN route', async () =>
    {
        const response = await createApp().request('/mcp', {
            method: 'POST',
            headers: {
                authorization: 'Bearer valid-token',
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                'mcp-method': 'server/discover',
                'mcp-protocol-version': '2026-07-28',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: {
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                        'io.modelcontextprotocol/clientCapabilities': {},
                        'io.modelcontextprotocol/clientInfo': {
                            name: 'test-client',
                            version: '1.0.0',
                        },
                    },
                },
            }),
        });

        expect(response.status, await response.clone().text()).toBe(200);
        const body = await response.json();
        expect(body.result.supportedVersions).toContain('2026-07-28');
        expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('test-server');
    });

    it('keeps legacy stateless clients compatible over SSE', async () =>
    {
        const response = await createApp().request('/mcp', {
            method: 'POST',
            headers: {
                authorization: 'Bearer valid-token',
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' },
                },
            }),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const body = await response.text();
        expect(body).toContain('"protocolVersion":"2025-11-25"');
        expect(body).toContain('"name":"test-server"');
    });

    it('marks an SSE answer as one an intermediary must not transform', async () =>
    {
        const response = await createApp().request('/mcp', {
            method: 'POST',
            headers: {
                authorization: 'Bearer valid-token',
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' },
                },
            }),
        });

        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    });

    it('runs application tools with the resolved SPFN context', async () =>
    {
        const toolCalls: string[] = [];
        const response = await createApp({
            onToolCall: event => void toolCalls.push(
                `${event.toolName}:${event.ctx.userId}:${event.ok}`,
            ),
        }).request('/mcp', {
            method: 'POST',
            headers: {
                authorization: 'Bearer valid-token',
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'echo', arguments: { message: 'hello' } },
            }),
        });

        expect(response.status).toBe(200);
        const message = readSseMessage(await response.text());

        expect(message).toMatchObject({
            result: {
                structuredContent: { message: 'hello', userId: 42 },
            },
        });
        expect(toolCalls).toEqual(['echo:42:true']);
    });

    it('uses the official SDK to reject invalid tool arguments', async () =>
    {
        let called = false;
        const response = await createApp({
            listTools: () => [{
                name: 'echo',
                inputSchema: {
                    type: 'object',
                    properties: { message: { type: 'string' } },
                    required: ['message'],
                },
                handler: async () =>
                {
                    called = true;

                    return {};
                },
            }],
        }).request('/mcp', {
            method: 'POST',
            headers: {
                authorization: 'Bearer valid-token',
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'echo', arguments: {} },
            }),
        });

        expect(response.status).toBe(200);
        const message = readSseMessage(await response.text());

        expect(message).toMatchObject({ result: { isError: true } });
        expect(JSON.stringify(message)).toContain("required property 'message'");
        expect(called).toBe(false);
    });

    it('applies host validation before token validation', async () =>
    {
        let validated = false;
        const response = await createApp({
            security: { allowedHosts: ['mcp.example.com'] },
            validateToken: async () =>
            {
                validated = true;

                return { clientId: 'client-1', scopes: [], userId: 42 };
            },
        }).request('/mcp', {
            method: 'GET',
            headers: {
                authorization: 'Bearer valid-token',
                host: 'attacker.example',
            },
        });

        expect(response.status).toBe(403);
        expect(validated).toBe(false);
    });
});

/**
 * spfn/spfn#165: every MCP route `.skip('*')`s and validates its own token, so
 * the router states no `packageName` — a skipper above it removes nothing the
 * routes rely on, and an app may mount it as a plain entry under one.
 */
describe('createMcpRoute under a router-level skipper', () =>
{
    const skipper = defineMiddleware('skipper', async (_c, next) => next(), { skips: ['auth'] });
    const refuseAll = defineMiddleware('auth', async c => c.json({ refusedBy: 'inherited auth' }, 401));

    it('states no package name', () =>
    {
        expect(createMcpRoute(createConfig())._packageName).toBeNull();
    });

    it('registers as a plain entry under a skipper and still challenges a request without a token', async () =>
    {
        const app = new Hono();
        registerRoutes(app, defineRouter({ mcp: createMcpRoute(createConfig()) }).use([skipper]), [refuseAll]);

        const response = await app.request('/mcp', { method: 'POST' });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer resource_metadata='
            + '"https://example.com/.well-known/oauth-protected-resource/mcp"',
        );
    });
});

describe('createMcpRoute with a lazy appUrl', () =>
{
    const METADATA_PATH = '/.well-known/oauth-protected-resource';

    function lazyConfig(
        appUrl: () => string,
        validateToken: McpRouteConfig<TestAuth, { userId: number }>['validateToken'],
    )
    {
        return {
            appUrl,
            serverInfo: { name: 'test-server', version: '1.0.0' },
            validateToken,
            resolveContext: async (auth: TestAuth) => ({ userId: auth.userId }),
            listTools: () => [],
        };
    }

    function routeTable(router: ReturnType<typeof createMcpRoute>): Record<string, string>
    {
        return Object.fromEntries(Object.entries(router.routes).map(
            ([name, def]) => [name, `${(def as RouteDef).method} ${(def as RouteDef).path}`],
        ));
    }

    it('reads the origin at first use, not when the router is created', async () =>
    {
        let origin: string | undefined;
        let calls = 0;
        const resources: string[] = [];
        const router = createMcpRoute(lazyConfig(
            () =>
            {
                calls++;
                if (!origin)
                {
                    throw new Error('SPFN_APP_URL is not set');
                }

                return origin;
            },
            async (_token, resource) =>
            {
                resources.push(resource);

                return null;
            },
        ));
        const reference = createMcpRoute({
            ...lazyConfig(() => '', async () => null),
            appUrl: 'https://example.com',
        });
        expect(routeTable(router)).toEqual(routeTable(reference));
        expect(calls).toBe(0);

        const errors: string[] = [];
        const app = new Hono();
        app.onError((error, c) =>
        {
            errors.push(error.message);

            return c.text('Internal Server Error', 500);
        });
        registerRoutes(app, router);

        const unset = await app.request('/mcp', { method: 'POST' });
        expect(unset.status).toBe(500);
        expect(unset.headers.get('www-authenticate')).toBeNull();
        expect((await app.request(METADATA_PATH)).status).toBe(500);
        expect(errors).toEqual(['SPFN_APP_URL is not set', 'SPFN_APP_URL is not set']);

        origin = 'https://app.example/ignored/path';
        calls = 0;
        const metadata = await (await app.request(`${METADATA_PATH}/mcp`)).json();
        expect(metadata.resource).toBe('https://app.example/mcp');
        expect(metadata.authorization_servers).toEqual(['https://app.example']);

        const challenged = await app.request('/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer some-token' },
        });
        expect(challenged.status).toBe(401);
        expect(challenged.headers.get('www-authenticate')).toBe(
            'Bearer error="invalid_token", '
            + `resource_metadata="https://app.example${METADATA_PATH}/mcp"`,
        );
        expect(resources).toEqual(['https://app.example/mcp']);

        await app.request(METADATA_PATH);
        await app.request('/mcp', { method: 'POST' });
        expect(calls).toBe(1);
    });

    it('fails a request clearly when appUrl returns something that is not an http(s) URL', async () =>
    {
        const errors: string[] = [];
        const app = new Hono();
        app.onError((error, c) =>
        {
            errors.push(error.message);

            return c.text('Internal Server Error', 500);
        });
        registerRoutes(app, createMcpRoute(lazyConfig(() => 'app.example', async () => null)));

        expect((await app.request('/mcp', { method: 'POST' })).status).toBe(500);
        expect(errors).toEqual([
            '@spfn/mcp: `appUrl` must be an absolute http(s) URL; got "app.example".',
        ]);
    });

    it('does not remember a non-http(s) URL from appUrl, and uses the next good one', async () =>
    {
        const returns = ['ftp://x', 'file:///x', 'https://app.example'];
        const errors: string[] = [];
        const resources: string[] = [];
        const app = new Hono();
        app.onError((error, c) =>
        {
            errors.push(error.message);

            return c.text('Internal Server Error', 500);
        });
        registerRoutes(app, createMcpRoute({
            ...lazyConfig(
                () => returns.shift()!,
                async (_token, resource) =>
                {
                    resources.push(resource);

                    return null;
                },
            ),
            resourceMetadataUrl: 'https://meta.example/doc',
        }));
        const post = () => app.request('/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer some-token' },
        });

        expect((await post()).status).toBe(500);
        expect((await post()).status).toBe(500);
        expect(errors).toEqual([
            '@spfn/mcp: `appUrl` must be an absolute http(s) URL; got "ftp://x".',
            '@spfn/mcp: `appUrl` must be an absolute http(s) URL; got "file:///x".',
        ]);
        expect((await post()).status).toBe(401);
        expect(resources).toEqual(['https://app.example/mcp']);
    });

    it('serves a bare-origin resource with no path-aware metadata route', async () =>
    {
        const router = createMcpRoute({
            ...lazyConfig(() => 'https://app.example/x', async () => null),
            resourcePath: '/',
        });
        const app = new Hono();
        registerRoutes(app, router);

        expect(Object.keys(router.routes)).not.toContain('mcpResourceMetadataForPath');
        expect((await (await app.request(METADATA_PATH)).json()).resource).toBe('https://app.example');
    });

    it('puts resourcePath on the origin of a string appUrl', async () =>
    {
        const router = createMcpRoute({
            ...lazyConfig(() => '', async () => null),
            appUrl: 'https://app.example/base',
            resourcePath: '/tools',
        });
        const app = new Hono();
        registerRoutes(app, router);

        const metadata = await (await app.request(`${METADATA_PATH}/tools`)).json();
        expect(metadata.resource).toBe('https://app.example/tools');
    });

    it('refuses resource beside a lazy appUrl or beside resourcePath', () =>
    {
        const base = lazyConfig(() => 'https://app.example', async () => null);

        // @ts-expect-error a lazy appUrl takes resourcePath, not resource
        expect(() => createMcpRoute({
            ...base,
            resource: 'https://app.example/mcp',
        })).toThrow('`resource` is not accepted with a lazy `appUrl`');
        // @ts-expect-error resource and resourcePath are two sources of one fact
        expect(() => createMcpRoute({
            ...base,
            appUrl: 'https://app.example',
            resource: 'https://app.example/mcp',
            resourcePath: '/x',
        })).toThrow('`resource` and `resourcePath` are two sources of one fact');
        expect(() => createMcpRoute({ ...base, resourcePath: 'mcp?x' }))
            .toThrow('`resourcePath` must start with "/"');
    });

    it('refuses an appUrl that is neither a string nor a function', () =>
    {
        expect(() => createMcpRoute({
            ...lazyConfig(() => '', async () => null),
            appUrl: undefined as unknown as string,
        })).toThrow(
            '@spfn/mcp: `appUrl` was undefined; a string `appUrl` is read when the router is '
            + 'created. For an origin known only at run time, such as one read from the '
            + 'environment, give a function that returns it.',
        );
    });

    it('refuses a resourcePath the URL parser or the router would read as another path', () =>
    {
        const base = lazyConfig(() => 'https://app.example', async () => null);

        for (const given of [
            '/a/../mcp', '/a b', '/a%2e%2e/mcp', '/a\\b',
            '/:id', '/a*', '/a{b}', '/.', '/mcp/', '/a//b',
        ])
        {
            expect(() => createMcpRoute({ ...base, resourcePath: given })).toThrow(
                `joined by single "/" with no trailing "/"; got ${JSON.stringify(given)}.`,
            );
        }
    });

    it.each(['/mcp', '/api/mcp', '/v1.2/mcp_x-y~z'])(
        'publishes resourcePath %s as the resource, the metadata route and the challenge URL',
        async (resourcePath) =>
        {
            const router = createMcpRoute({
                ...lazyConfig(() => 'https://app.example', async () => null),
                resourcePath,
            });
            const app = new Hono();
            registerRoutes(app, router);

            const metadataUrl = `https://app.example${METADATA_PATH}${resourcePath}`;
            expect(routeTable(router).mcpResourceMetadataForPath)
                .toBe(`GET ${METADATA_PATH}${resourcePath}`);
            const metadata = await (await app.request(metadataUrl)).json();
            expect(metadata.resource).toBe(`https://app.example${resourcePath}`);
            const challenged = await app.request('/mcp', { method: 'POST' });
            expect(challenged.headers.get('www-authenticate'))
                .toBe(`Bearer resource_metadata="${metadataUrl}"`);
        },
    );
});
