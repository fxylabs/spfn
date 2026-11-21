/**
 * Proxy signature (HMAC) + key rotation 테스트
 */

import { describe, it, expect } from 'vitest';

import {
    signProxyRequest,
    verifyProxyRequest,
    parseProxyKey,
    parseProxyKeySet,
    DEFAULT_KEY_ID,
    PROXY_SIGNATURE_HEADER,
    PROXY_TIMESTAMP_HEADER,
    PROXY_NONCE_HEADER,
    PROXY_KEY_ID_HEADER,
    PROXY_SIGNATURE_VERSION_HEADER,
    type ProxyKey,
} from '../proxy-signature';

const KEY: ProxyKey = { keyId: 'v1', secret: 'test-shared-secret-please-rotate' };

function sign(opts: { key?: ProxyKey; method: string; path: string; query?: string; body?: string; timestamp?: string })
{
    return signProxyRequest({ key: opts.key ?? KEY, ...opts });
}

describe('proxy-signature', () =>
{
    describe('key parsing', () =>
    {
        it('parses <keyId>:<secret>', () =>
        {
            expect(parseProxyKey('v2:abc123')).toEqual({ keyId: 'v2', secret: 'abc123' });
        });

        it('keeps colons inside the secret', () =>
        {
            expect(parseProxyKey('v2:ab:cd')).toEqual({ keyId: 'v2', secret: 'ab:cd' });
        });

        it('falls back to DEFAULT_KEY_ID for a bare secret', () =>
        {
            expect(parseProxyKey('abc123')).toEqual({ keyId: DEFAULT_KEY_ID, secret: 'abc123' });
        });

        it('normalizes a leading-colon secret to DEFAULT_KEY_ID (empty keyId footgun)', () =>
        {
            expect(parseProxyKey(':mysecret')).toEqual({ keyId: DEFAULT_KEY_ID, secret: 'mysecret' });
        });

        it('builds a key set, active wins on keyId collision, skips blanks', () =>
        {
            const keys = parseProxyKeySet(['v2:new', 'v1:old, v0:older', undefined, '', 'v2:dupe']);
            expect(keys).toEqual([
                { keyId: 'v2', secret: 'new' },
                { keyId: 'v1', secret: 'old' },
                { keyId: 'v0', secret: 'older' },
            ]);
        });

        it('exposes the active key as [0] for a comma key set (proxy parity)', () =>
        {
            // The proxy signs with parseProxyKeySet([secret])[0]; it MUST match the
            // active key the backend selects from the same env var.
            expect(parseProxyKeySet(['v2:new,v1:old'])[0]).toEqual({ keyId: 'v2', secret: 'new' });
        });
    });

    describe('sign → verify round-trip', () =>
    {
        it('verifies a signed POST with JSON body', () =>
        {
            const body = JSON.stringify({ name: 'Ray' });
            const headers = sign({ method: 'POST', path: '/users', body });

            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'POST',
                path: '/users',
                body,
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(true);
            expect(result.nonce).toBe(headers[PROXY_NONCE_HEADER]);
            expect(result.keyId).toBe('v1');
        });

        it('verifies a signed GET with no body', () =>
        {
            const headers = sign({ method: 'GET', path: '/users/123' });

            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'GET',
                path: '/users/123',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(true);
        });
    });

    describe('key rotation', () =>
    {
        const oldKey: ProxyKey = { keyId: 'v1', secret: 'old-secret' };
        const newKey: ProxyKey = { keyId: 'v2', secret: 'new-secret' };
        // Backend accepts both during the grace window
        const keySet = [newKey, oldKey];

        it('accepts a request signed with the new active key', () =>
        {
            const headers = sign({ key: newKey, method: 'GET', path: '/ping' });
            const result = verifyProxyRequest({
                keys: keySet,
                method: 'GET',
                path: '/ping',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(true);
            expect(result.keyId).toBe('v2');
        });

        it('still accepts a request signed with the previous (grace) key', () =>
        {
            const headers = sign({ key: oldKey, method: 'GET', path: '/ping' });
            const result = verifyProxyRequest({
                keys: keySet,
                method: 'GET',
                path: '/ping',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(true);
            expect(result.keyId).toBe('v1');
        });

        it('rejects a key that has been retired from the set', () =>
        {
            const retired: ProxyKey = { keyId: 'v0', secret: 'retired-secret' };
            const headers = sign({ key: retired, method: 'GET', path: '/ping' });
            const result = verifyProxyRequest({
                keys: keySet,
                method: 'GET',
                path: '/ping',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('unknown-key');
        });

        it('rejects a matching keyId whose secret was rotated underneath it', () =>
        {
            // Attacker replays v2 keyId but signed with a stale/guessed secret
            const headers = sign({ key: { keyId: 'v2', secret: 'wrong-secret' }, method: 'GET', path: '/ping' });
            const result = verifyProxyRequest({
                keys: keySet,
                method: 'GET',
                path: '/ping',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('signature-mismatch');
        });
    });

    describe('tamper detection', () =>
    {
        const body = JSON.stringify({ amount: 100 });
        const headers = sign({ method: 'POST', path: '/transfer', body });

        const base = {
            keys: [KEY],
            signature: headers[PROXY_SIGNATURE_HEADER],
            timestamp: headers[PROXY_TIMESTAMP_HEADER],
            nonce: headers[PROXY_NONCE_HEADER],
            keyId: headers[PROXY_KEY_ID_HEADER],
            version: headers[PROXY_SIGNATURE_VERSION_HEADER],
        };

        it('rejects a tampered body', () =>
        {
            const result = verifyProxyRequest({
                ...base,
                method: 'POST',
                path: '/transfer',
                body: JSON.stringify({ amount: 999999 }),
            });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('signature-mismatch');
        });

        it('rejects a swapped path', () =>
        {
            const result = verifyProxyRequest({ ...base, method: 'POST', path: '/admin/transfer', body });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('signature-mismatch');
        });

        it('rejects a swapped method', () =>
        {
            const result = verifyProxyRequest({ ...base, method: 'DELETE', path: '/transfer', body });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('signature-mismatch');
        });
    });

    describe('query + encoded path binding', () =>
    {
        it('verifies a matching query string', () =>
        {
            const headers = sign({ method: 'GET', path: '/users', query: '?limit=10&page=2' });
            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'GET',
                path: '/users',
                query: '?limit=10&page=2',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(true);
        });

        it('rejects an altered query param', () =>
        {
            const headers = sign({ method: 'GET', path: '/users', query: '?limit=10' });
            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'GET',
                path: '/users',
                query: '?limit=99999',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('signature-mismatch');
        });

        it('verifies a percent-encoded path verbatim (no decode drift)', () =>
        {
            const headers = sign({ method: 'GET', path: '/files/a%2Fb' });
            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'GET',
                path: '/files/a%2Fb',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: headers[PROXY_TIMESTAMP_HEADER],
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
            });

            expect(result.valid).toBe(true);
        });
    });

    describe('timestamp window', () =>
    {
        it('rejects a stale timestamp (replay outside window)', () =>
        {
            const oldTs = String(1_000_000);
            const headers = sign({ method: 'GET', path: '/ping', timestamp: oldTs });

            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'GET',
                path: '/ping',
                signature: headers[PROXY_SIGNATURE_HEADER],
                timestamp: oldTs,
                nonce: headers[PROXY_NONCE_HEADER],
                keyId: headers[PROXY_KEY_ID_HEADER],
                version: headers[PROXY_SIGNATURE_VERSION_HEADER],
                now: 1_000_000 + 60_000,
                windowMs: 30_000,
            });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('stale-timestamp');
        });
    });

    describe('missing headers', () =>
    {
        it('rejects when signature/timestamp/nonce/keyId are absent', () =>
        {
            const result = verifyProxyRequest({
                keys: [KEY],
                method: 'GET',
                path: '/ping',
                signature: undefined,
                timestamp: undefined,
                nonce: undefined,
                keyId: undefined,
            });

            expect(result.valid).toBe(false);
            expect(result.reason).toBe('missing-headers');
        });
    });
});
