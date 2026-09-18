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

type TestConfig = McpRouteConfig<TestAuth, { userId: number }>;

const METADATA_PATH = '/.well-known/oauth-protected-resource';

function createApp(overrides: Partial<TestConfig> = {}): Hono
{
    const config: TestConfig = {
        appUrl: 'https://example.com',
        serverInfo: { name: 'test-server', version: '1.0.0' },
        validateToken: async () => ({ clientId: 'client-1', scopes: ['tools'], userId: 42 }),
        resolveContext: async auth => ({ userId: auth.userId }),
        listTools: () => [],
        ...overrides,
    };
    const app = new Hono();
    registerRoutes(app, createMcpRoute(config));

    return app;
}

async function challengeFor(validateToken: TestConfig['validateToken']): Promise<Response>
{
    return createApp({ validateToken }).request('/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer some-token' },
    });
}

/**
 * A validator shaped like `verifyAccessToken`: it finds the token's record and refuses it
 * only once `expiresAt` has passed, rather than refusing an unrecognized string.
 */
function validatorForExpiry(expiresAt: number): TestConfig['validateToken']
{
    const record = { clientId: 'client-1', scopes: ['tools'], userId: 42, expiresAt };

    return async () => record.expiresAt * 1000 > Date.now() ? record : null;
}

describe('rejected bearer challenge', () =>
{
    it('marks an expired access token as invalid_token', async () =>
    {
        const now = Math.floor(Date.now() / 1000);
        const response = await challengeFor(validatorForExpiry(now - 3600));

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer error="invalid_token", '
            + `resource_metadata="https://example.com${METADATA_PATH}/mcp"`,
        );

        // The same validator, one still-live record: the refusal above is the expiry.
        const live = await challengeFor(validatorForExpiry(now + 3600));
        expect(live.headers.get('www-authenticate')).toBeNull();
    });

    it('treats a null result as a refusal', async () =>
    {
        const response = await challengeFor(async () => null);

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer error="invalid_token", '
            + `resource_metadata="https://example.com${METADATA_PATH}/mcp"`,
        );
    });

    it('treats an undefined result as a refusal', async () =>
    {
        const response = await challengeFor(async () => undefined);

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer error="invalid_token", '
            + `resource_metadata="https://example.com${METADATA_PATH}/mcp"`,
        );
    });

    it('treats a thrown error as a refusal', async () =>
    {
        const response = await challengeFor(async () =>
        {
            throw new Error('invalid');
        });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer error="invalid_token", '
            + `resource_metadata="https://example.com${METADATA_PATH}/mcp"`,
        );
    });

    it('accepts a validateToken that only ever refuses', async () =>
    {
        const router = createMcpRoute({
            appUrl: 'https://example.com',
            serverInfo: { name: 'test-server', version: '1.0.0' },
            validateToken: async () => null,
            resolveContext: async (auth: TestAuth) => ({ userId: auth.userId }),
            listTools: () => [],
        });
        const app = new Hono();
        registerRoutes(app, router);

        const response = await app.request('/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer some-token' },
        });

        expect(response.status).toBe(401);
    });
});

describe('protected resource metadata', () =>
{
    it('serves the document at the root well-known path', async () =>
    {
        const response = await createApp().request(METADATA_PATH);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const body = await response.json();
        expect(body.resource).toBe('https://example.com/mcp');
        expect(body.authorization_servers).toEqual(['https://example.com']);
        expect(body.bearer_methods_supported).toEqual(['header']);
    });

    it('serves the same bytes at the path-aware well-known path', async () =>
    {
        const app = createApp();
        const root = await app.request(METADATA_PATH);
        const pathAware = await app.request(`${METADATA_PATH}/mcp`);

        expect(pathAware.status).toBe(200);
        expect(await pathAware.text()).toBe(await root.text());
    });

    it('follows a custom resource to its own path-aware document', async () =>
    {
        const app = createApp({ resource: appUrl => `${appUrl}/tools` });

        const response = await app.request(`${METADATA_PATH}/tools`);
        expect(response.status).toBe(200);
        expect((await response.json()).resource).toBe('https://example.com/tools');

        const unauthorized = await app.request('/mcp', { method: 'POST' });
        expect(unauthorized.headers.get('www-authenticate')).toBe(
            `Bearer resource_metadata="https://example.com${METADATA_PATH}/tools"`,
        );
    });

    it('publishes configured authorization servers and scopes', async () =>
    {
        const response = await createApp({
            authorizationServers: ['https://id.example'],
            scopesSupported: ['mcp'],
        }).request(METADATA_PATH);

        const body = await response.json();
        expect(body.authorization_servers).toEqual(['https://id.example']);
        expect(body.scopes_supported).toEqual(['mcp']);
    });
});
