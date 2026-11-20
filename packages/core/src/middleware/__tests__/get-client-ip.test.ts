/**
 * getClientIp — trust the proxy-forwarded client IP only when verified (S-I6)
 */

import { describe, it, expect } from 'vitest';
import type { Context } from 'hono';
import { getClientIp } from '../client-ip';
import { PROXY_CLIENT_IP_HEADER } from '../../security/proxy-signature';

function ctx(headers: Record<string, string>, clientType?: string, proxyClientIp?: string): Context
{
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const vars: Record<string, string | undefined> = { clientType, proxyClientIp };

    return {
        get: (k: string) => vars[k],
        req: { header: (n: string) => lower[n.toLowerCase()] },
    } as unknown as Context;
}

describe('getClientIp', () =>
{
    it('uses the address proxy-guard handed on from a signature that covered it', () =>
    {
        const c = ctx({ [PROXY_CLIENT_IP_HEADER]: '203.0.113.9', 'x-forwarded-for': '10.0.0.1' }, 'web', '203.0.113.9');

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
