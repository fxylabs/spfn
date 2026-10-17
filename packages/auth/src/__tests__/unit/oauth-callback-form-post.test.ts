/**
 * @spfn/auth - form_post callback (fxylabs/spfn#142, case table P)
 *
 * Apple sends the browser back with a cross-site POST, which carries none of
 * the SameSite=Lax OAuth cookies. `POST /_auth/oauth/:provider/callback`
 * therefore completes nothing: it answers 303 to the GET callback with the
 * form fields in the query, and the browser's top-level GET brings the cookies.
 *
 * A fake form_post provider is registered under `apple` — no other suite
 * drives the Apple id through the routes — and the real one is put back in
 * `afterAll`, since auth's suite runs every file in one fork.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { ErrorHandler } from '@spfn/core/middleware';
import { registerRoutes } from '@spfn/core/route';

vi.mock('@spfn/core/db', async (importActual) => ({
    ...(await importActual<typeof import('@spfn/core/db')>()),
    Transactional: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}));

import {
    getOAuthProvider,
    registerOAuthProvider,
    type OAuthCodeExchangeOptions,
    type OAuthProvider,
    type OAuthTokens,
} from '../../server/lib/oauth';
import { createOAuthState } from '../../server/lib/oauth/state';
import { buildStartCookieName } from '../../server/lib/oauth/start-cookies';
import { socialAccountsRepository } from '../../server/repositories';
import { mainAuthRouter } from '../../server/routes';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const NONCE = 'nonce-of-this-browser';
const KEY_ID = 'key-form-post';
const USER_JSON = '{"name":{"firstName":"Ada","lastName":"Lovelace"}}';

const fake = {
    enabled: true,
    returnsIdentity: true,
    exchanges: [] as OAuthCodeExchangeOptions[],
    userInfoCalls: 0,
};

function formPostProvider(): OAuthProvider
{
    return {
        id: 'apple',
        callbackResponseMode: 'form_post',
        isEnabled: () => fake.enabled,
        getAuthUrl: (state: string) => `https://idp.example/auth?state=${state}`,
        exchangeCodeForTokens: async (_code: string, options: OAuthCodeExchangeOptions): Promise<OAuthTokens> =>
        {
            fake.exchanges.push(options);
            const identity = { providerUserId: 'fake-sub', email: null, emailVerified: false };

            return { accessToken: 'a', expiresIn: 3600, ...(fake.returnsIdentity ? { identity } : {}) };
        },
        getUserInfo: async () =>
        {
            fake.userInfoCalls += 1;

            return { providerUserId: 'fake-sub', email: null, emailVerified: false };
        },
    };
}

const previousApple = getOAuthProvider('apple');

afterAll(() =>
{
    if (previousApple)
    {
        registerOAuthProvider(previousApple);
    }
});

/** A fresh client address per request unless one is given, so the per-IP limit only trips on purpose. */
let requests = 0;

function clientIp(): string
{
    requests += 1;

    return `2001:db8:142::${requests.toString(16)}`;
}

async function postForm(app: Hono, path: string, fields: string[][], ip = clientIp()): Promise<Response>
{
    return await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
        body: new URLSearchParams(fields).toString(),
    });
}

async function stateIssued(): Promise<string>
{
    return await createOAuthState({
        provider: 'apple',
        returnUrl: '/',
        publicKey: 'pk',
        keyId: KEY_ID,
        fingerprint: 'fp',
        algorithm: 'ES256',
        nonce: NONCE,
    });
}

/** The GET the browser makes after the 303, with this start's CSRF cookie. */
async function followWithCookie(app: Hono, location: string): Promise<Response>
{
    return await app.request(location, {
        headers: { 'Cookie': `${buildStartCookieName('csrf', KEY_ID)}=${NONCE}`, 'x-forwarded-for': clientIp() },
    });
}

describe('POST /_auth/oauth/:provider/callback (form_post)', () =>
{
    let app: Hono;

    beforeAll(() =>
    {
        registerOAuthProvider(formPostProvider());
        app = new Hono();
        app.onError(ErrorHandler());
        registerRoutes(app, mainAuthRouter);
    });

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        fake.enabled = true;
        fake.returnsIdentity = true;
        fake.exchanges = [];
        fake.userInfoCalls = 0;
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('P1: 303 to the GET callback with code, state, user — path from the param, nothing else, no cookie', async () =>
    {
        const state = 'st%a+te=1&x';

        const response = await postForm(app, '/_auth/oauth/apple/callback', [
            ['code', 'c'], ['state', state], ['user', USER_JSON], ['extra', '1'], ['provider', 'google'],
        ]);

        expect(response.status).toBe(303);
        const location = response.headers.get('location')!;
        expect(location).toBe(`/_auth/oauth/apple/callback?${new URLSearchParams({ code: 'c', state, user: USER_JSON })}`);
        expect(new URL(location, 'https://app.example').searchParams.get('state')).toBe(state);
        expect(location).not.toContain('extra');
        expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('P2: a cancel is handed on and ends as reason=cancelled', async () =>
    {
        const response = await postForm(app, '/_auth/oauth/apple/callback', [
            ['error', 'user_cancelled_authorize'], ['error_description', 'x'],
        ]);

        expect(response.status).toBe(303);
        const location = response.headers.get('location')!;
        expect(location).toBe('/_auth/oauth/apple/callback?error=user_cancelled_authorize&error_description=x');

        const followed = await followWithCookie(app, location);
        expect(followed.status).toBe(302);
        const query = new URL(followed.headers.get('location')!, 'https://app.example').searchParams;
        expect(query.get('reason')).toBe('cancelled');
    });

    it('P3: a user field over 2048 bytes is dropped, code and state kept', async () =>
    {
        const response = await postForm(app, '/_auth/oauth/apple/callback', [
            ['code', 'c'], ['state', 's'], ['user', 'x'.repeat(3000)],
        ]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/_auth/oauth/apple/callback?code=c&state=s');
    });

    it('P3b: a multibyte user of 1000 characters but 3000 UTF-8 bytes is dropped, code and state kept', async () =>
    {
        const response = await postForm(app, '/_auth/oauth/apple/callback', [
            ['code', 'c'], ['state', 's'], ['user', '가'.repeat(1000)],
        ]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/_auth/oauth/apple/callback?code=c&state=s');
    });

    it('P4: a provider without form_post (google) answers 404 without a Location', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'google-client-id');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'google-client-secret');

        const response = await postForm(app, '/_auth/oauth/google/callback', [['code', 'c'], ['state', 's']]);

        expect(response.status).toBe(404);
        expect(response.headers.get('location')).toBeNull();
        expect(await response.text()).toBe('');
    });

    it('P5: a form_post provider that is not enabled answers 404', async () =>
    {
        fake.enabled = false;

        const response = await postForm(app, '/_auth/oauth/apple/callback', [['code', 'c'], ['state', 's']]);

        expect(response.status).toBe(404);
        expect(response.headers.get('location')).toBeNull();
    });

    it('P6: the GET callback hands { state, user } to the exchange; identity skips getUserInfo', async () =>
    {
        // Stop the sign-in right after step 2 — the rows below are about steps 1 and 2.
        vi.spyOn(socialAccountsRepository, 'findByProviderAndProviderId')
            .mockRejectedValue(new Error('stop after the identity'));
        // A '%' in the state proves the form value survives the 303 hop and the GET decode verbatim.
        const state = (await stateIssued()).replaceAll('.', '%2E');

        const hop = await postForm(app, '/_auth/oauth/apple/callback', [['code', 'c'], ['state', state], ['user', USER_JSON]]);
        await followWithCookie(app, hop.headers.get('location')!);

        expect(fake.exchanges).toEqual([{ state, user: USER_JSON }]);
        expect(fake.userInfoCalls).toBe(0);

        fake.returnsIdentity = false;
        await followWithCookie(app, hop.headers.get('location')!);

        expect(fake.userInfoCalls).toBe(1);
    });

    it('P7: the 31st POST within a minute is rate limited under the oauth-callback policy', async () =>
    {
        const ip = '2001:db8:142:ffff::1';

        for (let i = 0; i < 30; i += 1)
        {
            expect((await postForm(app, '/_auth/oauth/apple/callback', [['code', 'c']], ip)).status).toBe(303);
        }

        expect((await postForm(app, '/_auth/oauth/apple/callback', [['code', 'c']], ip)).status).toBe(429);

        // One bucket with the GET callback: the same address is refused there too.
        const get = await app.request('/_auth/oauth/apple/callback?code=c', { headers: { 'x-forwarded-for': ip } });
        expect(get.status).toBe(429);
    });

    it('P8: a multipart body that does not parse answers 303 with an empty query, not a 500', async () =>
    {
        const response = await app.request('/_auth/oauth/apple/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=x', 'x-forwarded-for': clientIp() },
            body: 'not a multipart body',
        });

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe('/_auth/oauth/apple/callback?');
    });
});
