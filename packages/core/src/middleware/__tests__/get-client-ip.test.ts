/**
 * getClientIp — trust the proxy-forwarded client IP only when verified (S-I6)
 */

import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { getClientIp } from '../client-ip';
import { PROXY_CLIENT_IP_HEADER } from '../../security/proxy-signature';

function ctx(headers: Record<string, string>, clientType?: string): Context
{
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

    return {
        get: (k: string) => (k === 'clientType' ? clientType : undefined),
        req: { header: (n: string) => lower[n.toLowerCase()] },
    } as unknown as Context;
}

describe('getClientIp', () =>
{
    it('uses the forwarded client IP when proxy-guard verified the request', () =>
    {
        const c = ctx({ [PROXY_CLIENT_IP_HEADER]: '203.0.113.9', 'x-forwarded-for': '10.0.0.1' }, 'web');

        expect(getClientIp(c)).toBe('203.0.113.9');
    });

    it('ignores the forwarded header on an untrusted request (spoofable)', () =>
    {
        const c = ctx({ [PROXY_CLIENT_IP_HEADER]: '1.2.3.4', 'x-forwarded-for': '10.0.0.1' }, 'untrusted');

        expect(getClientIp(c)).toBe('unknown');
    });

    it('ignores the forwarded header when proxy-guard did not run (clientType unset)', () =>
    {
        const c = ctx({ [PROXY_CLIENT_IP_HEADER]: '1.2.3.4', 'x-forwarded-for': '10.0.0.1' });

        expect(getClientIp(c)).toBe('unknown');
    });

    it('reads no forwarding header when no proxy is declared', () =>
    {
        expect(getClientIp(ctx({ 'x-real-ip': '198.51.100.7' }))).toBe('unknown');
        expect(getClientIp(ctx({}))).toBe('unknown');
    });
});
