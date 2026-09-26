/**
 * The OAuth callback page with a second factor (GitHub fxylabs/spfn#107).
 *
 * `OAuthCallback` is a browser component and this package's specs run in node,
 * so the rows run against `runOAuthCallback` — the whole of what the component
 * decides — with `fetch` stubbed. The component itself only renders the outcome:
 * an error slot, or a navigation to `outcome.to`.
 *
 * Each `it` is named for its row in the #107 case table.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    mfaConfirmUrl,
    runOAuthCallback,
    type CallbackOptions,
} from '../../nextjs/components/oauth-callback-flow';

/** A challenge the size the backend mints: 32 bytes, base64url. */
const CHALLENGE = 'q3Jd0a7Vx2mKc9LbT1wZr8YpNe5Hs4Gf6Uo0Ai3Bk2E';

function jsonResponse(status: number, body: unknown): Response
{
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function optionsWith(response: Response | Error, mfaPath?: string): CallbackOptions
{
    const fetchStub = response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response);

    return { apiBasePath: '/api/rpc', mfaPath, fetch: fetchStub };
}

/** The `body` the component posted to `oauthFinalize`, unwrapped from the RPC envelope. */
function postedBody(options: CallbackOptions): Record<string, string>
{
    const [url, init] = vi.mocked(options.fetch).mock.calls[0];

    expect(url).toBe('/api/rpc/oauthFinalize');

    return JSON.parse(String(init?.body)).body;
}

function confirmQuery(to: string): URLSearchParams
{
    return new URL(to, 'http://app.test').searchParams;
}

describe('OAuthCallback — mfaChallenge (#107)', () =>
{
    it('row 1: userId + keyId finalize and redirect to the return path, unchanged', async () =>
    {
        const options = optionsWith(jsonResponse(200, { success: true, mfaRequired: false, returnUrl: '/dashboard' }));

        const outcome = await runOAuthCallback('?userId=7&keyId=key-1&returnUrl=%2Fdashboard', options);

        expect(outcome).toEqual({ kind: 'navigate', to: '/dashboard', userId: '7' });
        expect(postedBody(options)).toEqual({ userId: '7', keyId: 'key-1', returnUrl: '/dashboard' });
    });

    it('row 2: ?error= wins over mfaChallenge — error slot, no finalize call', async () =>
    {
        const options = optionsWith(jsonResponse(202, {}));

        const outcome = await runOAuthCallback(`?error=access_denied&mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'error', message: 'access_denied' });
        expect(options.fetch).not.toHaveBeenCalled();
    });

    it('row 3: mfaChallenge and a 202 navigate to /auth/mfa with challenge and returnUrl', async () =>
    {
        const options = optionsWith(jsonResponse(202, { success: true, mfaRequired: true, challenge: CHALLENGE, returnUrl: '/settings' }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}&returnUrl=%2Fsettings`, options);

        expect(outcome.kind).toBe('navigate');
        expect(postedBody(options)).toEqual({ mfaChallenge: CHALLENGE, returnUrl: '/settings' });

        const to = (outcome as { to: string }).to;

        expect(to.startsWith('/auth/mfa?')).toBe(true);
        expect(confirmQuery(to).get('challenge')).toBe(CHALLENGE);
        expect(confirmQuery(to).get('returnUrl')).toBe('/settings');
    });

    it('row 4: mfaPath="/signin/2fa" navigates there instead', async () =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '/' }), '/signin/2fa');

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'navigate', to: `/signin/2fa?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it('env unset, no prop: a 202 without mfaPath navigates to /auth/mfa', async () =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '/' }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'navigate', to: `/auth/mfa?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it('env /signin/2fa, no prop: navigates to the mfaPath the 202 carries', async () =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '/', mfaPath: '/signin/2fa' }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'navigate', to: `/signin/2fa?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it('env /signin/2fa, prop /x: the prop overrides the server value', async () =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '/', mfaPath: '/signin/2fa' }), '/x');

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'navigate', to: `/x?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it.each([
        ['https://evil.test/p'],
        ['//evil.test/p'],
    ])('a server mfaPath of %s navigates to the same-origin path only', async (mfaPath) =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '/', mfaPath }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'navigate', to: `/p?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it('a server mfaPath that is not a string is ignored', async () =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '/', mfaPath: 42 }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'navigate', to: `/auth/mfa?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it.each([
        ['//evil.test'],
        ['https://evil.test'],
    ])('row 5: returnUrl=%s becomes returnUrl=/ on the confirm URL', async (returnUrl) =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE }));

        const outcome = await runOAuthCallback(
            `?mfaChallenge=${CHALLENGE}&returnUrl=${encodeURIComponent(returnUrl)}`,
            options,
        );

        expect(postedBody(options).returnUrl).toBe('/');
        expect(confirmQuery((outcome as { to: string }).to).get('returnUrl')).toBe('/');
    });

    it('row 5: an off-site returnUrl echoed by finalize is dropped to / as well', async () =>
    {
        const options = optionsWith(jsonResponse(202, { challenge: CHALLENGE, returnUrl: '//evil.test' }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(confirmQuery((outcome as { to: string }).to).get('returnUrl')).toBe('/');
    });

    it.each([
        [400, { message: 'returnUrl must be a relative path within the app' }],
        [429, { message: 'Too many requests' }],
        [500, {}],
    ])('row 6: finalize answering %i shows the error slot and does not navigate', async (status, body) =>
    {
        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, optionsWith(jsonResponse(status, body)));

        expect(outcome.kind).toBe('error');
    });

    it('row 6: a 200 to a challenge is not the 202 the pending cookie comes from — error, no navigation', async () =>
    {
        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, optionsWith(jsonResponse(200, { success: true })));

        expect(outcome).toEqual({ kind: 'error', message: 'Failed to finalize OAuth' });
    });

    it('row 6: a network failure is an error outcome, not a throw', async () =>
    {
        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, optionsWith(new TypeError('Failed to fetch')));

        expect(outcome).toEqual({ kind: 'error', message: 'Failed to fetch' });
    });

    it('row 6: a failure message that echoes the challenge never reaches onError', async () =>
    {
        const options = optionsWith(jsonResponse(400, { message: `Invalid mfaChallenge ${CHALLENGE}` }));

        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, options);

        expect(outcome).toEqual({ kind: 'error', message: 'Failed to finalize OAuth' });
    });

    it('row 7: neither userId/keyId nor mfaChallenge is "Missing required parameters" as today', async () =>
    {
        const options = optionsWith(jsonResponse(200, {}));

        expect(await runOAuthCallback('?userId=7', options)).toEqual({ kind: 'error', message: 'Missing required parameters' });
        expect(await runOAuthCallback('', options)).toEqual({ kind: 'error', message: 'Missing required parameters' });
        expect(options.fetch).not.toHaveBeenCalled();
    });
});

describe('mfaConfirmUrl', () =>
{
    it('uses the query names createOAuthCallbackHandler writes', () =>
    {
        expect(mfaConfirmUrl('/auth/mfa', CHALLENGE, '/a?b=1')).toBe(`/auth/mfa?challenge=${CHALLENGE}&returnUrl=%2Fa%3Fb%3D1`);
    });

    it('keeps the challenge on this origin whatever mfaPath holds', () =>
    {
        expect(mfaConfirmUrl('https://evil.test/collect', CHALLENGE, '/')).toBe(`/collect?challenge=${CHALLENGE}&returnUrl=%2F`);
        expect(mfaConfirmUrl('//evil.test/collect', CHALLENGE, '/')).toBe(`/collect?challenge=${CHALLENGE}&returnUrl=%2F`);
    });
});
