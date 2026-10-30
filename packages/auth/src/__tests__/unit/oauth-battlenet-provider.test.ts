/**
 * Battle.net built-in OAuth provider adapter (fxylabs/spfn#154).
 *
 * Rows from the case table in artifacts/issue-154-battlenet-design.md §7-1:
 * L6 (no account id), L8 (China host), L9 (unconfigured), L10 (an email in the
 * userinfo body is never reported), plus the normalization the sign-in and link
 * rows depend on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { battlenetProvider } from '@/server/lib/oauth/battlenet-provider';
import { getEnabledOAuthProviders } from '@/server/services/oauth.service';

function jsonResponse(body: unknown, status = 200): Response
{
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function hostOf(url: string): string
{
    return new URL(url).origin;
}

describe('Battle.net OAuth provider', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_BATTLENET_CLIENT_ID', 'bnet-client-id');
        vi.stubEnv('SPFN_AUTH_BATTLENET_CLIENT_SECRET', 'bnet-client-secret');
        vi.stubEnv('SPFN_AUTH_BATTLENET_REDIRECT_URI', 'https://app.example.com/_auth/oauth/battlenet/callback');
        vi.stubEnv('SPFN_AUTH_BATTLENET_REGION', '');
        vi.stubEnv('SPFN_AUTH_BATTLENET_SCOPES', '');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('builds a code-flow authorization URL on the global host with the openid scope', () =>
    {
        const url = new URL(battlenetProvider.getAuthUrl('sealed-state'));

        expect(url.origin + url.pathname).toBe('https://oauth.battle.net/authorize');
        expect(url.searchParams.get('client_id')).toBe('bnet-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/_auth/oauth/battlenet/callback');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe('openid');
        expect(url.searchParams.get('state')).toBe('sealed-state');
    });

    it('takes configured scopes, comma-separated', () =>
    {
        vi.stubEnv('SPFN_AUTH_BATTLENET_SCOPES', 'openid, sc2.profile');

        expect(new URL(battlenetProvider.getAuthUrl('s')).searchParams.get('scope')).toBe('openid sc2.profile');
    });

    it('exchanges a code with HTTP Basic client credentials', async () =>
    {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
            access_token: 'bnet-access',
            token_type: 'bearer',
            expires_in: 86399,
        }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(battlenetProvider.exchangeCodeForTokens('the-code', { state: 'state' }))
            .resolves.toEqual({ accessToken: 'bnet-access', expiresIn: 86399 });

        const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = request.headers as Record<string, string>;
        const params = request.body as URLSearchParams;

        expect(url).toBe('https://oauth.battle.net/token');
        expect(headers.Authorization)
            .toBe(`Basic ${Buffer.from('bnet-client-id:bnet-client-secret').toString('base64')}`);
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('the-code');
        expect(params.get('redirect_uri')).toBe('https://app.example.com/_auth/oauth/battlenet/callback');
        expect(params.has('client_secret')).toBe(false);
    });

    it('defaults a missing expiry to a day', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ access_token: 'bnet-access' })));

        const tokens = await battlenetProvider.exchangeCodeForTokens('code', { state: 'state' });

        expect(tokens.expiresIn).toBe(60 * 60 * 24);
    });

    it('refuses a failed or malformed token response', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400)));
        await expect(battlenetProvider.exchangeCodeForTokens('code', { state: 'state' })).rejects.toThrow(/status 400/);

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ token_type: 'bearer' })));
        await expect(battlenetProvider.exchangeCodeForTokens('code', { state: 'state' })).rejects.toThrow(/invalid/);
    });

    it('normalizes userinfo: sub is the provider user id, the BattleTag is the handle and the name', async () =>
    {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sub: '123456789', id: 123456789, battletag: 'Flash#1234' }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(battlenetProvider.getUserInfo('bnet-access')).resolves.toEqual({
            providerUserId: '123456789',
            email: null,
            emailVerified: false,
            name: 'Flash#1234',
            handle: 'Flash#1234',
        });

        const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://oauth.battle.net/userinfo');
        expect((request.headers as Record<string, string>).Authorization).toBe('Bearer bnet-access');
    });

    it('falls back to a numeric id when the body has no sub', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 987, battletag: 'Jaedong#5678' })));

        expect((await battlenetProvider.getUserInfo('t')).providerUserId).toBe('987');
    });

    it('never uses a numeric id past 2^53: sub wins, and without sub the response is refused', async () =>
    {
        // Raw JSON: 9007199254740993 parses to 9007199254740992, so two accounts would share an id.
        const raw = (body: string) => new Response(body, { headers: { 'Content-Type': 'application/json' } });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raw('{"id":9007199254740993,"sub":"9007199254740993"}')));
        expect((await battlenetProvider.getUserInfo('t')).providerUserId).toBe('9007199254740993');

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(raw('{"id":9007199254740993}')));
        await expect(battlenetProvider.getUserInfo('t')).rejects.toThrow(/missing the account id/);
    });

    it('reports no handle and no name when the body has no BattleTag', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 42 })));

        const identity = await battlenetProvider.getUserInfo('t');

        expect(identity.handle).toBeUndefined();
        expect(identity.name).toBeUndefined();
    });

    it('L6: refuses a userinfo body with neither id nor sub, never falling back to the BattleTag', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ battletag: 'Flash#1234' })));

        await expect(battlenetProvider.getUserInfo('t')).rejects.toThrow(/missing the account id/);
    });

    it('refuses a failed userinfo request', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)));

        await expect(battlenetProvider.getUserInfo('t')).rejects.toThrow(/status 403/);
    });

    it('L10: an email in the userinfo body is not reported', async () =>
    {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
            id: 1, battletag: 'A#1', email: 'someone@example.com', email_verified: true,
        })));

        const identity = await battlenetProvider.getUserInfo('t');

        expect(identity.email).toBeNull();
        expect(identity.emailVerified).toBe(false);
    });

    it('L8: the cn region sends authorize, token and userinfo to the China host', async () =>
    {
        vi.stubEnv('SPFN_AUTH_BATTLENET_REGION', 'cn');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ access_token: 'a', expires_in: 10 }))
            .mockResolvedValueOnce(jsonResponse({ id: 1, battletag: 'A#1' }));
        vi.stubGlobal('fetch', fetchMock);

        expect(hostOf(battlenetProvider.getAuthUrl('s'))).toBe('https://oauth.battlenet.com.cn');
        await battlenetProvider.exchangeCodeForTokens('code', { state: 's' });
        await battlenetProvider.getUserInfo('a');

        expect(fetchMock.mock.calls.map(([url]) => hostOf(url as string)))
            .toEqual(['https://oauth.battlenet.com.cn', 'https://oauth.battlenet.com.cn']);
    });

    it('refuses an unknown region instead of guessing a host', () =>
    {
        vi.stubEnv('SPFN_AUTH_BATTLENET_REGION', 'eu');

        expect(() => battlenetProvider.getAuthUrl('s')).toThrow(/"global" or "cn"/);
    });

    it('L9: without the client id and secret it is disabled and absent from the provider list', () =>
    {
        vi.stubEnv('SPFN_AUTH_BATTLENET_CLIENT_ID', '');
        vi.stubEnv('SPFN_AUTH_BATTLENET_CLIENT_SECRET', '');

        expect(battlenetProvider.isEnabled()).toBe(false);
        expect(getEnabledOAuthProviders()).not.toContain('battlenet');
        expect(() => battlenetProvider.getAuthUrl('s')).toThrow(/not configured/);
    });

    it('is listed once configured', () =>
    {
        expect(battlenetProvider.isEnabled()).toBe(true);
        expect(getEnabledOAuthProviders()).toContain('battlenet');
    });
});
