import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerRoutes } from '@spfn/core/route';
import { createMcpRoute } from '../server';
import type { McpRouteConfig } from '../index';

type TestAuth = {
    clientId: string;
    scopes: string[];
    userId: number;
};

function createApp(overrides: Partial<McpRouteConfig<TestAuth, { userId: number }>> = {}): Hono
{
    const config: McpRouteConfig<TestAuth, { userId: number }> = {
        appUrl: 'https://example.com',
        serverInfo: { name: 'test-server', version: '1.0.0' },
        validateToken: async token =>
        {
            if (token !== 'valid-token')
            {
                throw new Error('invalid');
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
    const app = new Hono();
    registerRoutes(app, createMcpRoute(config));

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
