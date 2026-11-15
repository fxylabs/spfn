/**
 * The address a tracking event is recorded under (a12f1-F5).
 *
 * Both endpoints stored `X-Forwarded-For` (else `X-Real-IP`) verbatim, so a
 * caller chose the address its opens and clicks counted under. They record
 * core's client address now, which reads no forwarding header unless the
 * operator declared proxies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { recordOpenEvent, recordClickEvent } = vi.hoisted(() => ({
    recordOpenEvent: vi.fn(),
    recordClickEvent: vi.fn(),
}));

vi.mock('../tracking.service', () => ({ recordOpenEvent, recordClickEvent }));

vi.mock('../token', () => ({
    verifyOpenToken: () => ({ valid: true, notificationId: 7 }),
    verifyClickToken: () => ({ valid: true, notificationId: 7, linkIndex: 0 }),
    hashClickUrl: () => 'unused',
}));

const { trackOpen, trackClick } = await import('../routes');
const { setTrustedProxyHops } = await import('@spfn/core/middleware');

const SPOOFED: Record<string, string> = { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' };

/**
 * What a handler is given for a request carrying the spoofed headers from the
 * connection peer `192.0.2.10`, as the Node adapter shows it — this package
 * has no Hono of its own to mount the router on.
 */
function context(data: Record<string, unknown>): never
{
    return {
        data: async () => data,
        raw: {
            get: () => undefined,
            req: { header: (name: string) => SPOOFED[name.toLowerCase()] },
            env: { incoming: { socket: { remoteAddress: '192.0.2.10' } } },
        },
    } as never;
}

describe('tracking records the address the caller cannot choose', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        setTrustedProxyHops(0);
    });

    it('records an open under the connection peer, not the forwarding headers', async () =>
    {
        await trackOpen.handler(context({ params: { token: 'token' } }));

        expect(recordOpenEvent).toHaveBeenCalledWith(7, expect.objectContaining({ ipAddress: '192.0.2.10' }));
    });

    it('records a click under the connection peer, not the forwarding headers', async () =>
    {
        const response = await trackClick.handler(context({ params: { token: 'token' }, query: { url: 'https://example.com/' } }));

        expect((response as Response).status).toBe(302);
        expect(recordClickEvent).toHaveBeenCalledWith(7, 0, 'https://example.com/', expect.objectContaining({ ipAddress: '192.0.2.10' }));
    });
});
