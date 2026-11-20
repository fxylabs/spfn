/**
 * Proxy-guard middleware 테스트
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import { createProxyGuard, createInMemoryNonceStore, type NonceStore } from '../proxy-guard';
import { getClientIp } from '../client-ip';
import {
    signProxyRequest,
    parseProxyKey,
    buildLegacyCanonicalString,
    PROXY_CLIENT_IP_HEADER,
    PROXY_SIGNATURE_HEADER,
    PROXY_TIMESTAMP_HEADER,
    PROXY_NONCE_HEADER,
    PROXY_KEY_ID_HEADER,
} from '../../security/proxy-signature';

const SECRET = 'test-shared-secret';

/**
 * Build a Hono app whose handler echoes back the parsed body and clientType,
 * so we can assert both verification outcome AND that body-reading still works.
 */
function buildApp(guard: ReturnType<typeof createProxyGuard>)
{
    const app = new Hono();
    app.use('*', guard);
    app.post('/users', async (c) =>
    {
        const body = await c.req.json();

        return c.json({ clientType: c.get('clientType'), echo: body });
    });
    app.get('/users/:id', (c) => c.json({ clientType: c.get('clientType'), id: c.req.param('id') }));
    app.get('/files/:name', (c) => c.json({ clientType: c.get('clientType'), name: c.req.param('name') }));
    app.get('/search', (c) => c.json({ clientType: c.get('clientType') }));

    return app;
}

function signedHeaders(method: string, path: string, body?: string, secret = SECRET, query?: string)
{
    return signProxyRequest({ key: parseProxyKey(secret), method, path, query, body });
}

describe('createProxyGuard', () =>
{
    describe('mode: strict', () =>
    {
        const guard = createProxyGuard({ mode: 'strict', secret: SECRET });

        it('accepts a properly signed request and tags clientType=web', async () =>
        {
            const app = buildApp(guard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders('POST', '/users', body) },
                body,
            });

            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.clientType).toBe('web');
            // body must still be readable by the handler after the guard cloned it
            expect(json.echo).toEqual({ name: 'Ray' });
        });

        it('rejects an unsigned request with 403', async () =>
        {
            const app = buildApp(guard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
            });

            expect(res.status).toBe(403);
        });

        it('rejects a request whose body was tampered after signing', async () =>
        {
            const app = buildApp(guard);
            const signedBody = JSON.stringify({ amount: 100 });
            const tamperedBody = JSON.stringify({ amount: 999999 });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders('POST', '/users', signedBody) },
                body: tamperedBody,
            });

            expect(res.status).toBe(403);
        });

        it('verifies a signed GET request', async () =>
        {
            const app = buildApp(guard);

            const res = await app.request('/users/42', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/users/42') },
            });

            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.clientType).toBe('web');
        });
    });

    describe('mode: tag', () =>
    {
        const guard = createProxyGuard({ mode: 'tag', secret: SECRET });

        it('lets an unsigned request through but tags it untrusted', async () =>
        {
            const app = buildApp(guard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
            });

            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.clientType).toBe('untrusted');
            expect(json.echo).toEqual({ name: 'Ray' });
        });

        it('tags a properly signed request as web', async () =>
        {
            const app = buildApp(guard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders('POST', '/users', body) },
                body,
            });

            const json = await res.json();
            expect(json.clientType).toBe('web');
        });

        it('tags a cross-origin request untrusted (observes what strict would reject)', async () =>
        {
            const taggingGuard = createProxyGuard({
                mode: 'tag',
                secret: SECRET,
                allowedOrigins: ['https://app.example.com'],
            });
            const app = buildApp(taggingGuard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: 'https://evil.example.com',
                    ...signedHeaders('POST', '/users', body),
                },
                body,
            });

            // tag mode evaluates the same gates strict would — a disallowed origin is
            // observable as 'untrusted', not silently 'web'.
            expect(res.status).toBe(200);
            expect((await res.json()).clientType).toBe('untrusted');
        });
    });

    describe('availability & limits', () =>
    {
        it('degrades to allow (not 500) when the nonce store throws', async () =>
        {
            const flakyStore: NonceStore = {
                async checkAndSet()
                {
                    throw new Error('redis unreachable');
                },
            };
            const guard = createProxyGuard({ mode: 'strict', secret: SECRET, nonceStore: flakyStore });
            const app = buildApp(guard);

            const res = await app.request('/users/9', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/users/9') },
            });

            expect(res.status).toBe(200);
        });

        it('rejects (fail-closed) when the nonce store throws and nonceFailClosed is set', async () =>
        {
            const flakyStore: NonceStore = {
                async checkAndSet()
                {
                    throw new Error('redis unreachable');
                },
            };
            const guard = createProxyGuard({
                mode: 'strict', secret: SECRET, nonceStore: flakyStore, nonceFailClosed: true,
            });
            const app = buildApp(guard);

            const res = await app.request('/users/9', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/users/9') },
            });

            expect(res.status).toBe(403);
        });

        it('rejects a replayed nonce with the in-memory store', async () =>
        {
            const guard = createProxyGuard({ mode: 'strict', secret: SECRET, nonceStore: createInMemoryNonceStore() });
            const app = buildApp(guard);
            // Reuse the SAME signed headers (same nonce) for both requests.
            const headers = { ...signedHeaders('GET', '/users/9') };

            const first = await app.request('/users/9', { method: 'GET', headers });
            const replay = await app.request('/users/9', { method: 'GET', headers });

            expect(first.status).toBe(200);
            expect(replay.status).toBe(403);
        });

        it('rejects an oversized body with 413 (strict)', async () =>
        {
            const guard = createProxyGuard({ mode: 'strict', secret: SECRET, maxBodyBytes: 16 });
            const app = buildApp(guard);
            const body = JSON.stringify({ data: 'x'.repeat(200) });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders('POST', '/users', body) },
                body,
            });

            expect(res.status).toBe(413);
        });

        it('rejects with a clean 403 (not 500) when the body stream errors mid-read', async () =>
        {
            const guard = createProxyGuard({ mode: 'strict', secret: SECRET });
            const app = buildApp(guard);
            const stream = new ReadableStream({
                start(controller)
                {
                    controller.error(new Error('client abort'));
                },
            });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders('POST', '/users', '{}') },
                body: stream,
                // @ts-expect-error duplex is required for a stream request body
                duplex: 'half',
            });

            // A read failure is a clean reject, never a 500 / on-call page.
            expect(res.status).toBe(403);
        });

        it('caps oversized body via stream measurement (no truthful Content-Length)', async () =>
        {
            const guard = createProxyGuard({ mode: 'strict', secret: SECRET, maxBodyBytes: 16 });
            const app = buildApp(guard);
            const big = 'x'.repeat(500);
            const stream = new ReadableStream({
                start(controller)
                {
                    controller.enqueue(new TextEncoder().encode(big));
                    controller.close();
                },
            });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...signedHeaders('POST', '/users', big) },
                body: stream,
                // @ts-expect-error duplex is required for a stream request body
                duplex: 'half',
            });

            expect(res.status).toBe(413);
        });
    });

    describe('mode: off', () =>
    {
        it('is a no-op (no clientType, no rejection)', async () =>
        {
            const app = buildApp(createProxyGuard({ mode: 'off', secret: SECRET }));
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
            });

            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.clientType).toBeUndefined();
        });
    });

    describe('origin allowlist', () =>
    {
        const guard = createProxyGuard({
            mode: 'strict',
            secret: SECRET,
            allowedOrigins: ['https://app.example.com'],
        });

        it('rejects a disallowed Origin', async () =>
        {
            const app = buildApp(guard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: 'https://evil.example.com',
                    ...signedHeaders('POST', '/users', body),
                },
                body,
            });

            expect(res.status).toBe(403);
        });

        it('accepts an allowed Origin with a valid signature', async () =>
        {
            const app = buildApp(guard);
            const body = JSON.stringify({ name: 'Ray' });

            const res = await app.request('/users', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: 'https://app.example.com',
                    ...signedHeaders('POST', '/users', body),
                },
                body,
            });

            expect(res.status).toBe(200);
        });

        it('exempts OPTIONS from the origin gate but still blocks the real cross-origin request', async () =>
        {
            const app = buildApp(guard);

            // Preflight from a disallowed origin is NOT 403'd by the guard (CORS owns it)
            const preflight = await app.request('/users', {
                method: 'OPTIONS',
                headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
            });
            expect(preflight.status).not.toBe(403);

            // ...but the actual cross-origin request is rejected — no data exposure.
            const body = JSON.stringify({ name: 'Ray' });
            const real = await app.request('/users', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    origin: 'https://evil.example.com',
                    ...signedHeaders('POST', '/users', body),
                },
                body,
            });
            expect(real.status).toBe(403);
        });
    });

    describe('nonce replay rejection', () =>
    {
        it('rejects a replayed nonce when a nonce store is provided', async () =>
        {
            const seen = new Set<string>();
            const nonceStore: NonceStore = {
                async checkAndSet(nonce)
                {
                    if (seen.has(nonce))
                    {
                        return false;
                    }
                    seen.add(nonce);

                    return true;
                },
            };

            const guard = createProxyGuard({ mode: 'strict', secret: SECRET, nonceStore });
            const app = buildApp(guard);
            const headers = { ...signedHeaders('GET', '/users/7') };

            const first = await app.request('/users/7', { method: 'GET', headers });
            expect(first.status).toBe(200);

            // Same signed headers (same nonce) replayed → rejected
            const second = await app.request('/users/7', { method: 'GET', headers });
            expect(second.status).toBe(403);
        });
    });

    describe('fail-closed on misconfiguration', () =>
    {
        it('throws at construction when strict mode has no key', () =>
        {
            expect(() => createProxyGuard({ mode: 'strict', secret: '' })).toThrow(/strict/);
        });

        it('does not throw in tag mode with no key (observe-only)', () =>
        {
            expect(() => createProxyGuard({ mode: 'tag', secret: '' })).not.toThrow();
        });
    });

    describe('wire request-target binding', () =>
    {
        const guard = createProxyGuard({ mode: 'strict', secret: SECRET });

        it('verifies a percent-encoded path without decode drift', async () =>
        {
            const app = buildApp(guard);
            const res = await app.request('/files/a%2Fb', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/files/a%2Fb') },
            });

            expect(res.status).toBe(200);
        });

        it('verifies a matching query string', async () =>
        {
            const app = buildApp(guard);
            const res = await app.request('/search?q=hi&limit=10', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/search', undefined, SECRET, '?q=hi&limit=10') },
            });

            expect(res.status).toBe(200);
        });

        it('rejects a tampered query param', async () =>
        {
            const app = buildApp(guard);
            const res = await app.request('/search?limit=99999', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/search', undefined, SECRET, '?limit=10') },
            });

            expect(res.status).toBe(403);
        });

        it('binds the body even for a non-json content-type', async () =>
        {
            const app = buildApp(guard);
            const signedBody = JSON.stringify({ amount: 100 });
            const tampered = JSON.stringify({ amount: 999999 });

            const res = await app.request('/users', {
                method: 'POST',
                headers: { 'content-type': 'text/plain', ...signedHeaders('POST', '/users', signedBody) },
                body: tampered,
            });

            expect(res.status).toBe(403);
        });
    });

    describe('bypass-path handling', () =>
    {
        it('exempts a genuine CORS preflight but tags it untrusted (unsigned, not trusted)', async () =>
        {
            const app = new Hono();
            app.use('*', createProxyGuard({ mode: 'strict', secret: SECRET }));
            app.options('/users', (c) => c.json({ clientType: c.get('clientType') }));

            const res = await app.request('/users', {
                method: 'OPTIONS',
                headers: { 'access-control-request-method': 'POST' },
            });

            expect(res.status).toBe(200);
            // Set (never undefined) but NOT 'web' — a bare preflight isn't trusted.
            expect((await res.json()).clientType).toBe('untrusted');
        });

        it('verifies a NON-preflight OPTIONS — OPTIONS-as-API is not an unguarded bypass', async () =>
        {
            const app = new Hono();
            app.use('*', createProxyGuard({ mode: 'strict', secret: SECRET }));
            app.options('/data', (c) => c.json({ ok: true }));

            // No Access-Control-Request-Method → not a preflight → must be verified.
            const res = await app.request('/data', { method: 'OPTIONS' });

            expect(res.status).toBe(403);
        });

        it('skips configured skipPaths without a signature', async () =>
        {
            const guard = createProxyGuard({ mode: 'strict', secret: SECRET, skipPaths: ['/events/stream'] });
            const app = new Hono();
            app.use('*', guard);
            app.get('/events/stream', (c) => c.json({ ok: true }));

            const res = await app.request('/events/stream', { method: 'GET' });
            expect(res.status).toBe(200);
        });
    });

    describe('key rotation (grace window)', () =>
    {
        // Backend mid-rotation: active v2, still accepting v1
        const guard = createProxyGuard({
            mode: 'strict',
            secret: 'v2:new-secret',
            previousSecrets: 'v1:old-secret',
        });

        it('accepts the new active key', async () =>
        {
            const app = buildApp(guard);
            const res = await app.request('/users/1', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/users/1', undefined, 'v2:new-secret') },
            });

            expect(res.status).toBe(200);
        });

        it('still accepts the previous (grace) key', async () =>
        {
            const app = buildApp(guard);
            const res = await app.request('/users/1', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/users/1', undefined, 'v1:old-secret') },
            });

            expect(res.status).toBe(200);
        });

        it('rejects a retired key no longer in the set', async () =>
        {
            const app = buildApp(guard);
            const res = await app.request('/users/1', {
                method: 'GET',
                headers: { ...signedHeaders('GET', '/users/1', undefined, 'v0:retired-secret') },
            });

            expect(res.status).toBe(403);
        });
    });

    describe('the client address (#363)', () =>
    {
        /** A backend that answers the address `getClientIp` read. */
        function addressApp(mode: 'strict' | 'tag')
        {
            const app = new Hono();

            app.use('*', createProxyGuard({ mode, secret: SECRET }));
            app.get('/whoami', c => c.json({ clientType: c.get('clientType'), ip: getClientIp(c) }));

            return app;
        }

        it('C4: an address changed after signing fails verification', async () =>
        {
            const signed = signProxyRequest({ key: parseProxyKey(SECRET), method: 'GET', path: '/whoami', clientIp: '203.0.113.7' });

            // The control: as signed, it is believed
            const asSigned = await addressApp('strict').request('/whoami', { headers: { ...signed, [PROXY_CLIENT_IP_HEADER]: '203.0.113.7' } });
            expect(await asSigned.json()).toEqual({ clientType: 'web', ip: '203.0.113.7' });

            const res = await addressApp('strict').request('/whoami', {
                headers: { ...signed, [PROXY_CLIENT_IP_HEADER]: '192.0.2.66' },
            });

            expect(res.status).toBe(403);
        });

        it('a version-1 signature (no version header) is still verified until 0.5.0, and its address is ignored', async () =>
        {
            const timestamp = String(Date.now());
            const legacy = buildLegacyCanonicalString({ method: 'GET', path: '/whoami', query: '', timestamp, nonce: 'n1', bodyHash: '' });

            const res = await addressApp('strict').request('/whoami', {
                headers: {
                    [PROXY_SIGNATURE_HEADER]: createHmac('sha256', SECRET).update(legacy).digest('hex'),
                    [PROXY_TIMESTAMP_HEADER]: timestamp,
                    [PROXY_NONCE_HEADER]: 'n1',
                    [PROXY_KEY_ID_HEADER]: 'default',
                    [PROXY_CLIENT_IP_HEADER]: '192.0.2.66',
                },
            });

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ clientType: 'web', ip: 'unknown' });
        });
    });
});
