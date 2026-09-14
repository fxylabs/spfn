/**
 * createAuthSSEClient — the one-time token request under the CSRF rule
 *
 * The token route is a cookie-authenticated POST, so under
 * SPFN_AUTH_CSRF=enforce the proxy refuses it without x-spfn-csrf. The
 * client mirrors the spfn_csrf cookie family into that header like the api
 * client does; without a cookie it sends none.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAuthSSEClient, tokenRequestHeaders } from '../client';

describe('tokenRequestHeaders', () =>
{
    it('mirrors the spfn_csrf cookie family into x-spfn-csrf', () =>
    {
        const headers = tokenRequestHeaders([['spfn_csrf', 'aa11'], ['spfn_csrf_8790', 'bb22'], ['other', 'x']]);

        expect(headers['x-spfn-csrf']).toBe('aa11,bb22');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('sends no CSRF header without a cookie', () =>
    {
        expect(tokenRequestHeaders([])).toEqual({ 'Content-Type': 'application/json' });
    });
});

describe('createAuthSSEClient token request', () =>
{
    afterEach(() =>
    {
        vi.unstubAllGlobals();
    });

    it('POSTs eventsToken with credentials and the CSRF header read from document.cookie', async () =>
    {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: 't-1' }), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('document', { cookie: 'spfn_session=hidden; spfn_csrf_8790=cafe0123' });
        // EventSource is what createSSEClient opens after the token arrives; the
        // request under test happens before it, so a stub that never connects is enough
        vi.stubGlobal('EventSource', class
        {
            onerror = null;
            onopen = null;

            addEventListener()
            {
            }

            close()
            {
            }
        });

        const client = createAuthSSEClient<any>({ host: 'http://api.test' });
        const unsubscribe = client.subscribe({ events: [], handlers: {} });
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        unsubscribe();

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe('/api/rpc/eventsToken');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('include');
        expect((init.headers as Record<string, string>)['x-spfn-csrf']).toBe('cafe0123');
    });
});
