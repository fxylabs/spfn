/**
 * @spfn/auth - Sign in with Apple on Android: native start, callback relay, assetlinks.json
 * (GitHub fxylabs/spfn#149, design w-1t19t — case tables S, C and A)
 *
 * The router is mounted on a Hono app with no database behind it, so a query
 * anywhere on these paths would answer 500: every relay row that sees its 303
 * also proves no DB call ran. The real Apple provider is registered — the
 * form_post suite swaps a fake in under `apple` and puts this one back, and
 * every file runs in one fork.
 *
 * ### Native start
 *
 * | # | request | outcome |
 * | --- | --- | --- |
 * | S1 | valid nonce, valid state, `relayUrl` configured | `200 { authUrl }`; authUrl params exactly as P5; its `state` is not the app's state and verifies with `verifyAppleRelayState`; no `Set-Cookie` |
 * | S2 | `relayUrl` not configured (also: trailing `/` added, different case in host, extra query) | `400`; no authUrl |
 * | S3 | relay URLs unset | refusal names `SPFN_AUTH_APPLE_RELAY_URLS`; no authUrl |
 * | S4 | Apple web flow not configured | `requireEnabledProvider` refusal; no authUrl |
 * | S5 | `requestNonce` not 64 lowercase hex | `400` |
 * | S6 | `state` outside P3 | `400` |
 * | S7 | 21st call in a minute from one IP | `429` |
 *
 * ### POST callback
 *
 * | # | posted state | posted body | outcome |
 * | --- | --- | --- | --- |
 * | C1 | valid relay state | field `id_token` holding T | `303`, Location = relayUrl with query `id_token` (T) then `state` (the app state); no `Set-Cookie`; no DB query |
 * | C2 | valid relay state | `error=user_cancelled_authorize` | `303` to `relayUrl?error=user_cancelled_authorize&state=<app state>` |
 * | C3 | valid relay state | `error=<script>` | `303` with `error=failed` |
 * | C4 | valid relay state | neither id_token nor error | `303` with `state` only |
 * | C5 | valid relay state | `id_token` over 4096 bytes | `303` without `id_token` |
 * | C6 | expired relay state | anything | `303` to `relayUrl?error=expired&state=<app state>` |
 * | C7 | valid relay state, its `relayUrl` removed from config since the start | anything | not relayed; today's `303` to the GET callback |
 * | C8 | web state from `/_auth/oauth/apple/url` | `code=…` | today's `303` to the GET callback, unchanged (existing tests stay green) |
 * | C9 | garbage | anything | today's `303` to the GET callback |
 * | C10 | valid relay state | field `id_token` holding T, field `user` ≤ 2048 bytes | `user` relayed too; over 2048 bytes dropped |
 *
 * C8 and C9 are also the unchanged rows P1–P8 of `oauth-callback-form-post.test.ts`
 * and the GET-callback rows of `oauth-apple-web.test.ts`, run beside this file.
 *
 * ### assetlinks.json
 *
 * | # | configuration | outcome |
 * | --- | --- | --- |
 * | A1 | package + one fingerprint (lowercase input) | `200`, `content-type: application/json`, body equals the statement with the fingerprint uppercased |
 * | A2 | package + two fingerprints | both listed, in configured order |
 * | A3 | unset | `404`, empty body |
 *
 * A4 (`spfn init`) is in `packages/cli/src/commands/init/steps/__tests__/next-config.test.ts`;
 * B1–B8 in `oauth-apple-android-boot.test.ts`; G1, N1, N2 in
 * `integration/oauth-apple-android.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { EncryptJWT } from 'jose';
import { ErrorHandler } from '@spfn/core/middleware';
import { registerRoutes } from '@spfn/core/route';

const transactional = vi.hoisted(() => ({ runs: 0 }));

vi.mock('@spfn/core/db', async (importActual) => ({
    ...(await importActual<typeof import('@spfn/core/db')>()),
    Transactional: () => async (_c: unknown, next: () => Promise<void>) =>
    {
        transactional.runs += 1;
        await next();
    },
}));

import { getDatabaseInfo } from '@spfn/core/db';
import { registerOAuthProvider } from '../../server/lib/oauth';
import { appleProvider } from '../../server/lib/oauth/apple-provider';
import { createAppleRelayState, createOAuthState, verifyAppleRelayState } from '../../server/lib/oauth/state';
import { mainAuthRouter } from '../../server/routes';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const SERVICES_ID = 'com.example.app.web';
const APP_URL = 'https://app.example.com';
const RELAY_URL = 'https://app.example.com/_auth/apple-relay';
const OTHER_RELAY_URL = 'https://links.example.com/apple';
const APP_STATE = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const REQUEST_NONCE = 'f'.repeat(64);
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhcHBsZSJ9.c2lnbmF0dXJl';
const USER_JSON = '{"name":{"firstName":"Ada","lastName":"Lovelace"},"email":"ada@privaterelay.appleid.com"}';
const FINGERPRINT = '14:6d:e9:83:c5:73:06:50:d8:ee:b9:95:2f:34:fc:64:16:a0:83:42:e6:1d:be:a8:8a:04:96:b2:3f:cf:44:e5';
const SECOND_FINGERPRINT = 'AB:'.repeat(31) + 'CD';

let app: Hono;

/** A fresh client address per request unless one is given, so the per-IP limit only trips on purpose. */
let requests = 0;

function clientIp(): string
{
    requests += 1;

    return `2001:db8:149::${requests.toString(16)}`;
}

function configureApple(): void
{
    vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', SERVICES_ID);
    vi.stubEnv('SPFN_AUTH_APPLE_TEAM_ID', 'TEAM123456');
    vi.stubEnv('SPFN_AUTH_APPLE_KEY_ID', 'KEY9876543');
    vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', 'not read when an authorize URL is built');
    vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY_FILE', '');
}

async function startRelay(body: Record<string, unknown>, ip = clientIp()): Promise<Response>
{
    return await app.request('/_auth/oauth/apple/native/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify(body),
    });
}

function validStart(overrides: Record<string, unknown> = {}): Record<string, unknown>
{
    return { requestNonce: REQUEST_NONCE, state: APP_STATE, relayUrl: RELAY_URL, ...overrides };
}

async function postCallback(fields: string[][]): Promise<Response>
{
    return await app.request('/_auth/oauth/apple/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-for': clientIp() },
        body: new URLSearchParams(fields).toString(),
    });
}

async function relayState(relayUrl = RELAY_URL): Promise<string>
{
    return await createAppleRelayState({ appState: APP_STATE, relayUrl });
}

/** The Location the relay must answer with, built independently of the code under test. */
function relayLocation(params: string[][], relayUrl = RELAY_URL): string
{
    return `${relayUrl}?${new URLSearchParams(params)}`;
}

/** Today's hand-on to the GET callback, as the form_post suite's P1 spells it. */
function handOnLocation(params: string[][]): string
{
    return `/_auth/oauth/apple/callback?${new URLSearchParams(params)}`;
}

beforeAll(() =>
{
    registerOAuthProvider(appleProvider);
    app = new Hono();
    app.onError(ErrorHandler());
    registerRoutes(app, mainAuthRouter);
});

beforeEach(() =>
{
    vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', APP_URL);
    vi.stubEnv('SPFN_AUTH_APPLE_REDIRECT_URI', '');
    vi.stubEnv('SPFN_AUTH_APPLE_RELAY_URLS', `${RELAY_URL}, ${OTHER_RELAY_URL}`);
    vi.stubEnv('SPFN_AUTH_ANDROID_PACKAGE_NAME', '');
    vi.stubEnv('SPFN_AUTH_ANDROID_CERT_SHA256', '');
    configureApple();
    transactional.runs = 0;
});

afterEach(() =>
{
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('POST /_auth/oauth/apple/native/start', () =>
{
    it('S1: answers the Apple authorize URL of P5, its state a sealed relay state, and sets no cookie', async () =>
    {
        const response = await startRelay(validStart());

        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
        const { authUrl } = await response.json() as { authUrl: string };
        const url = new URL(authUrl);
        expect(`${url.origin}${url.pathname}`).toBe('https://appleid.apple.com/auth/authorize');

        const { state, ...params } = Object.fromEntries(url.searchParams);
        expect(params).toEqual({
            client_id: SERVICES_ID,
            redirect_uri: `${APP_URL}/_auth/oauth/apple/callback`,
            response_type: 'code id_token',
            response_mode: 'form_post',
            scope: 'name email',
            nonce: REQUEST_NONCE,
        });
        expect([...url.searchParams.keys()]).toHaveLength(7);
        expect(state).not.toBe(APP_STATE);
        expect(state).not.toContain(APP_STATE);
        expect(await verifyAppleRelayState(state)).toEqual({
            relay: { appState: APP_STATE, relayUrl: RELAY_URL },
            expired: false,
        });
    });

    it.each([
        ['not configured', 'https://evil.example/_auth/apple-relay'],
        ['a trailing / added', `${RELAY_URL}/`],
        ['the host in another case', 'https://App.example.com/_auth/apple-relay'],
        ['an extra query', `${RELAY_URL}?x=1`],
        ['a prefix of a configured URL', 'https://app.example.com/_auth'],
        ['a configured URL as a prefix', `${RELAY_URL}x`],
    ])('S2: a relayUrl with %s is refused 400 with no authUrl', async (_case, relayUrl) =>
    {
        const response = await startRelay(validStart({ relayUrl }));

        expect(response.status).toBe(400);
        expect(await response.text()).not.toContain('authUrl');
    });

    it('S2: the second configured URL is accepted, matched exactly', async () =>
    {
        const response = await startRelay(validStart({ relayUrl: OTHER_RELAY_URL }));

        expect(response.status).toBe(200);
    });

    it('S3: with SPFN_AUTH_APPLE_RELAY_URLS unset the refusal names it and carries no authUrl', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_RELAY_URLS', '');

        const response = await startRelay(validStart());

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain('SPFN_AUTH_APPLE_RELAY_URLS');
        expect(text).not.toContain('authUrl');
    });

    it('S4: with the Apple web flow not configured the refusal is requireEnabledProvider\'s, no authUrl', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_TEAM_ID', '');

        const response = await startRelay(validStart());

        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain('OAuth provider \'apple\' is registered but not configured');
        expect(text).not.toContain('authUrl');
    });

    it.each([
        ['uppercase hex', 'F'.repeat(64)],
        ['63 characters', 'f'.repeat(63)],
        ['65 characters', 'f'.repeat(65)],
        ['a non-hex character', `${'f'.repeat(63)}g`],
        ['empty', ''],
    ])('S5: a requestNonce that is %s is refused 400', async (_case, requestNonce) =>
    {
        const response = await startRelay(validStart({ requestNonce }));

        expect(response.status).toBe(400);
    });

    it.each([
        ['15 characters', 'a'.repeat(15)],
        ['129 characters', 'a'.repeat(129)],
        ['a dot', `${'a'.repeat(20)}.b`],
        ['a space', `${'a'.repeat(20)} b`],
        ['a percent sign', `${'a'.repeat(20)}%41`],
    ])('S6: a state with %s is refused 400', async (_case, state) =>
    {
        const response = await startRelay(validStart({ state }));

        expect(response.status).toBe(400);
    });

    it('S6: the bounds of P3 are accepted — 16 and 128 characters of [A-Za-z0-9_-]', async () =>
    {
        expect((await startRelay(validStart({ state: 'aZ09_-aZ09_-aZ09' }))).status).toBe(200);
        expect((await startRelay(validStart({ state: 'x'.repeat(128) }))).status).toBe(200);
    });

    it('S7: the 21st call within a minute from one address is answered 429', async () =>
    {
        const ip = '2001:db8:149:ffff::1';

        for (let i = 0; i < 20; i += 1)
        {
            expect((await startRelay(validStart(), ip)).status).toBe(200);
        }

        expect((await startRelay(validStart(), ip)).status).toBe(429);
    });
});

describe('POST /_auth/oauth/apple/callback — the relay', () =>
{
    it('C1: an id_token is relayed with the app state, no cookie, no transaction, no database', async () =>
    {
        expect(getDatabaseInfo().hasWrite).toBe(false);

        const response = await postCallback([['state', await relayState()], ['code', 'c'], ['id_token', ID_TOKEN]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(relayLocation([['id_token', ID_TOKEN], ['state', APP_STATE]]));
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(transactional.runs).toBe(0);
    });

    it('C1: the relay goes to the URL the state sealed — the second configured one too', async () =>
    {
        const response = await postCallback([['state', await relayState(OTHER_RELAY_URL)], ['id_token', ID_TOKEN]]);

        expect(response.headers.get('location'))
            .toBe(relayLocation([['id_token', ID_TOKEN], ['state', APP_STATE]], OTHER_RELAY_URL));
    });

    it('C2: Apple\'s cancel is relayed as it came, with the app state', async () =>
    {
        const response = await postCallback([['state', await relayState()], ['error', 'user_cancelled_authorize']]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location'))
            .toBe(`${RELAY_URL}?error=user_cancelled_authorize&state=${APP_STATE}`);
    });

    it.each([
        ['markup', '<script>'],
        ['uppercase', 'Invalid_Request'],
        ['65 characters', 'a'.repeat(65)],
        ['empty', ''],
    ])('C3: an error code that is %s is relayed as error=failed', async (_case, error) =>
    {
        const response = await postCallback([['state', await relayState()], ['error', error]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(relayLocation([['error', 'failed'], ['state', APP_STATE]]));
    });

    it('C4: neither id_token nor error relays the state alone', async () =>
    {
        const response = await postCallback([['state', await relayState()], ['code', 'c']]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(relayLocation([['state', APP_STATE]]));
    });

    it('C5: an id_token over 4096 bytes is dropped, the state kept; 4096 exactly is relayed', async () =>
    {
        const over = await postCallback([['state', await relayState()], ['id_token', 'x'.repeat(4097)]]);
        expect(over.status).toBe(303);
        expect(over.headers.get('location')).toBe(relayLocation([['state', APP_STATE]]));

        const at = await postCallback([['state', await relayState()], ['id_token', 'x'.repeat(4096)]]);
        expect(at.headers.get('location')).toBe(relayLocation([['id_token', 'x'.repeat(4096)], ['state', APP_STATE]]));
    });

    it('C6: an expired relay state relays error=expired with the app state, whatever was posted', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        const state = await relayState();
        vi.setSystemTime(Date.now() + 11 * 60_000);

        const response = await postCallback([['state', state], ['id_token', ID_TOKEN], ['user', USER_JSON]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(`${RELAY_URL}?error=expired&state=${APP_STATE}`);
    });

    it('C6: an expired state that does not decrypt with the relay key is not read — today\'s hand-on', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'another-secret-with-at-least-32-characters-for-tests');
        const foreign = await relayState();
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        vi.setSystemTime(Date.now() + 11 * 60_000);

        const response = await postCallback([['code', 'c'], ['state', foreign]]);

        expect(response.headers.get('location')).toBe(handOnLocation([['code', 'c'], ['state', foreign]]));
    });

    it('C7: a relay URL removed from the configuration since the start is not relayed — today\'s hand-on', async () =>
    {
        const state = await relayState(OTHER_RELAY_URL);
        vi.stubEnv('SPFN_AUTH_APPLE_RELAY_URLS', RELAY_URL);

        const response = await postCallback([['code', 'c'], ['state', state], ['id_token', ID_TOKEN]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(handOnLocation([['code', 'c'], ['state', state]]));
    });

    it('C7: with every relay URL removed, a relay state gets today\'s hand-on', async () =>
    {
        const state = await relayState();
        vi.stubEnv('SPFN_AUTH_APPLE_RELAY_URLS', '');

        const response = await postCallback([['code', 'c'], ['state', state]]);

        expect(response.headers.get('location')).toBe(handOnLocation([['code', 'c'], ['state', state]]));
    });

    it('C8: a web state from the web start gets today\'s 303 to the GET callback, unchanged', async () =>
    {
        const state = await createOAuthState({
            provider: 'apple',
            returnUrl: '/',
            publicKey: 'pk',
            keyId: 'key-c8',
            fingerprint: 'fp',
            algorithm: 'ES256',
            nonce: 'nonce-c8',
        });

        const response = await postCallback([['code', 'c'], ['state', state], ['user', USER_JSON]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location'))
            .toBe(handOnLocation([['code', 'c'], ['state', state], ['user', USER_JSON]]));
        expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('C8: a state sealed under the web state key never relays, even one carrying a relay payload', async () =>
    {
        // The key the web start seals with (state.ts, `oauth-state:` + the session
        // secret). Only key separation refuses this: the payload is a relay's.
        const webKey = new Uint8Array(await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(`oauth-state:${SECRET}`),
        ));
        const state = await new EncryptJWT({ relay: { appState: APP_STATE, relayUrl: RELAY_URL } })
            .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
            .setIssuedAt()
            .setExpirationTime('10m')
            .encrypt(webKey);

        const response = await postCallback([['code', 'c'], ['state', state], ['id_token', ID_TOKEN]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(handOnLocation([['code', 'c'], ['state', state]]));
    });

    /** C9's assertion: today's hand-on, the id_token not carried anywhere. */
    async function expectHandOn(state: string): Promise<void>
    {
        const response = await postCallback([['code', 'c'], ['state', state], ['id_token', ID_TOKEN]]);

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(handOnLocation([['code', 'c'], ['state', state]]));
    }

    it('C9: a garbage state gets today\'s 303 to the GET callback', async () =>
    {
        await expectHandOn('st%a+te=1&x');
    });

    it('C9: a relay state sealed under another session secret gets today\'s 303', async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'another-secret-with-at-least-32-characters-for-tests');
        const foreign = await relayState();
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);

        await expectHandOn(foreign);
    });

    it('C9: a truncated relay state gets today\'s 303', async () =>
    {
        await expectHandOn((await relayState()).slice(0, -4));
    });

    it('C10: Apple\'s user JSON within 2048 bytes is relayed after the id_token; over 2048 bytes it is dropped', async () =>
    {
        const within = await postCallback([['state', await relayState()], ['id_token', ID_TOKEN], ['user', USER_JSON]]);
        expect(within.headers.get('location'))
            .toBe(relayLocation([['id_token', ID_TOKEN], ['user', USER_JSON], ['state', APP_STATE]]));

        const over = await postCallback([['state', await relayState()], ['id_token', ID_TOKEN], ['user', '가'.repeat(700)]]);
        expect(over.headers.get('location')).toBe(relayLocation([['id_token', ID_TOKEN], ['state', APP_STATE]]));
    });
});

describe('GET /.well-known/assetlinks.json', () =>
{
    async function fetchAssetLinks(): Promise<Response>
    {
        return await app.request('/.well-known/assetlinks.json', { headers: { 'x-forwarded-for': clientIp() } });
    }

    it('A1: package and one lowercase fingerprint — 200 application/json, the statement with it uppercased', async () =>
    {
        vi.stubEnv('SPFN_AUTH_ANDROID_PACKAGE_NAME', 'com.example.app');
        vi.stubEnv('SPFN_AUTH_ANDROID_CERT_SHA256', FINGERPRINT);

        const response = await fetchAssetLinks();

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^application\/json(;|$)/);
        expect(response.headers.get('location')).toBeNull();
        expect(await response.json()).toEqual([{
            relation: ['delegate_permission/common.handle_all_urls'],
            target: {
                namespace: 'android_app',
                package_name: 'com.example.app',
                sha256_cert_fingerprints: [FINGERPRINT.toUpperCase()],
            },
        }]);
    });

    it('A2: two fingerprints are both listed, in configured order', async () =>
    {
        vi.stubEnv('SPFN_AUTH_ANDROID_PACKAGE_NAME', 'com.example.app');
        vi.stubEnv('SPFN_AUTH_ANDROID_CERT_SHA256', `${SECOND_FINGERPRINT}, ${FINGERPRINT}`);

        const body = await (await fetchAssetLinks()).json() as { target: { sha256_cert_fingerprints: string[] } }[];

        expect(body[0].target.sha256_cert_fingerprints).toEqual([SECOND_FINGERPRINT, FINGERPRINT.toUpperCase()]);
    });

    it('A3: unset — 404 with an empty body', async () =>
    {
        const response = await fetchAssetLinks();

        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
    });
});
