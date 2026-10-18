/**
 * @spfn/auth - a web browser as the new device, end to end (#143)
 *
 * The issuer is a signed-in device talking to the backend with its own bearer,
 * as `device-link.test.ts` drives it. The browser is a cookie jar talking
 * through the shipped `authInterceptors` chain, as `createRpcProxy` runs it, to
 * the mounted auth router on the real database — so the key the proxy mints is
 * the key the backend parks, registers and later verifies a signature against.
 *
 * | # | flow | expected |
 * | --- | --- | --- |
 * | I1 | issue → a cookie-less browser redeems → status, confirm → the browser polls | SESSION set; `getAuthSession` with that jar answers the issuer; the key is the issuer's, platform `web` |
 * | I2 | I1, but the jar carries a second redeem's pending cookie when it polls the first | 401 mismatch; `getAuthSession` is anonymous |
 * | I3 | device-code login: start → approve → poll, the browser through the chain | as I1's last two |
 * | A6 | a `/web` route called on the mounted router, no proxy: (a) no key, (b) an oversize `publicKey`, (c) a valid key with `platform: 'ios'` | (a), (b) answer as the mobile route does; (c) 200, and the key lands as `web` |
 * | A7 | one IP, within a minute: 6 calls to the mobile route, then 5 to its `/web` twin | the 11th is 429 — one bucket per pair |
 *
 * The browser redeems and starts on the `/web` routes, the ones the proxy
 * injects its key into; the mobile routes it leaves alone.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import type { SetCookie } from '@spfn/core/nextjs';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { createTestUser, JSON_HEADERS, mountAuthApp, resetMemoryRateLimitStore, TEST_PASSWORD } from '../helpers/oauth2';
import { authInterceptors } from '../../nextjs/interceptors';
import { generateClientToken, generateKeyPair } from '../../server/lib/crypto';
import { COOKIE_NAMES } from '../../server/lib/config';
import { CSRF_HEADER } from '../../server/lib/csrf';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Each `/web` route and the mobile route it twins, with the page's own fields. */
const WEB_TWINS = [
    ['device/link/redeem', '/_auth/device/link/redeem', '/_auth/device/link/redeem/web', { userCode: 'ABCD-EFGH' }],
    ['device/start', '/_auth/device/start', '/_auth/device/start/web', { deviceName: 'Office PC' }],
] as const;

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'device-link-web@test.com';
const CLIENT_IP = '203.0.113.143';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** What the proxy answered and the cookies it set. */
interface ProxyAnswer
{
    status: number;
    body: Record<string, unknown>;
    setCookies: SetCookie[];
}

/** The signed-in device that shows the code. */
interface Issuer
{
    authorization: string;
    keyId: string;
}

/** `buildRequestContext`'s shape for a browser call; the CSRF header mirrors the cookie, as the client does. */
function requestContext(method: 'GET' | 'POST', path: string, body: unknown, jar: Map<string, string>): RequestInterceptorContext
{
    const csrf = jar.get(COOKIE_NAMES.CSRF);

    return {
        path,
        method,
        headers: { ...JSON_HEADERS, 'x-forwarded-for': CLIENT_IP, 'user-agent': CHROME } as Record<string, string>,
        body,
        query: {},
        cookies: jar,
        request: { headers: new Headers({ 'user-agent': CHROME, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) }) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

/** Forward the request to the backend; `buildResponseContext`'s shape for what came back. */
async function callBackend(app: Hono, ctx: RequestInterceptorContext): Promise<ResponseInterceptorContext>
{
    const response = await app.request(ctx.path, {
        method: ctx.method,
        headers: ctx.headers,
        body: ctx.method === 'POST' ? JSON.stringify(ctx.body) : undefined,
    });

    return {
        path: ctx.path,
        method: ctx.method,
        request: { headers: { 'user-agent': CHROME }, body: ctx.body },
        response: {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: await response.json(),
        },
        cookies: ctx.cookies,
        setCookies: [],
        metadata: ctx.metadata,
    } as unknown as ResponseInterceptorContext;
}

/** One browser call: the matching rules, the backend, the rules again — as `createRpcProxy` does. */
async function throughTheProxy(app: Hono, ctx: RequestInterceptorContext): Promise<ProxyAnswer>
{
    const matching = filterMatchingInterceptors(authInterceptors, ctx.path, ctx.method);

    await executeRequestInterceptors(
        ctx,
        matching.map(rule => rule.request).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    expect(ctx.abort).toBeUndefined();

    const responseCtx = await callBackend(app, ctx);

    await executeResponseInterceptors(
        responseCtx,
        matching.map(rule => rule.response).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    return {
        status: responseCtx.response.status,
        body: responseCtx.response.body as Record<string, unknown>,
        setCookies: responseCtx.setCookies,
    };
}

/** The browser applying a `Set-Cookie` batch to its jar. */
function applyCookies(jar: Map<string, string>, setCookies: SetCookie[]): void
{
    for (const cookie of setCookies)
    {
        if (cookie.options?.maxAge === 0 || !cookie.value)
        {
            jar.delete(cookie.name);
        }
        else
        {
            jar.set(cookie.name, cookie.value);
        }
    }
}

describe.skipIf(!dbAvailable)('a web browser as the new device (#143)', () =>
{
    let app: Hono;
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();

        userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
    });

    /** A device already signed in, calling the backend with its own key. */
    async function signIn(): Promise<Issuer>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await issuerPost('/_auth/login', {
            email: EMAIL,
            password: TEST_PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(response.status).toBe(200);

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    async function issuerPost(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.7' };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    async function issuerCall<T>(path: string, body: unknown, issuer: Issuer): Promise<T>
    {
        const response = await issuerPost(path, body, issuer.authorization);
        expect(response.status).toBe(200);

        return await response.json() as T;
    }

    /** A browser call through the chain; the jar takes whatever cookies came back. */
    async function browser(path: string, body: unknown, jar: Map<string, string>, method: 'GET' | 'POST' = 'POST'): Promise<ProxyAnswer>
    {
        const answer = await throughTheProxy(app, requestContext(method, path, body, jar));
        applyCookies(jar, answer.setCookies);

        return answer;
    }

    /** Issue a link and have a browser redeem it; the jar holds that redeem's pending cookie. */
    async function redeemedInBrowser(issuer: Issuer, jar: Map<string, string>)
    {
        const link = await issuerCall<{ linkId: string; userCode: string }>('/_auth/device/link/issue', {}, issuer);
        const redeemed = await browser('/_auth/device/link/redeem/web', { userCode: link.userCode }, jar);

        expect(redeemed.status).toBe(200);

        return { link, deviceCode: redeemed.body.deviceCode as string, matchNumber: redeemed.body.matchNumber as number };
    }

    /** The issuer sees the device on its status and picks the number the browser shows. */
    async function confirmOnIssuer(issuer: Issuer, linkId: string, matchNumber: number): Promise<void>
    {
        const status = await issuerCall<{ status: string; choices: number[] }>('/_auth/device/link/status', { linkId }, issuer);
        expect(status.status).toBe('redeemed');
        expect(status.choices).toContain(matchNumber);

        await issuerCall('/_auth/device/link/confirm', { linkId, choice: matchNumber }, issuer);
    }

    /** The browser's session as `getAuthSession` answers it through the chain. */
    function sessionOf(jar: Map<string, string>): Promise<ProxyAnswer>
    {
        return browser('/_auth/session', undefined, jar, 'GET');
    }

    /** The new key is on the issuer's account, as a web device. */
    async function expectWebKeyOnAccount(issuer: Issuer, keyId: string): Promise<void>
    {
        const { keys } = await issuerCall<{ keys: { keyId: string; platform?: string }[] }>('/_auth/keys/list', {}, issuer);

        expect(keys.find(key => key.keyId === keyId)).toMatchObject({ platform: 'web' });
    }

    it('I1 a cookie-less browser redeems, the issuer confirms, and the browser\'s poll signs it in as the issuer', async () =>
    {
        const issuer = await signIn();
        const jar = new Map<string, string>();
        const { link, deviceCode, matchNumber } = await redeemedInBrowser(issuer, jar);

        await confirmOnIssuer(issuer, link.linkId, matchNumber);

        const polled = await browser('/_auth/device/link/poll', { deviceCode }, jar);
        expect(polled.status).toBe(200);
        expect(polled.body.status).toBe('approved');
        expect(jar.get(COOKIE_NAMES.SESSION)).toEqual(expect.any(String));
        expect(jar.has(COOKIE_NAMES.DEVICE_PENDING)).toBe(false);

        const session = await sessionOf(jar);
        expect(session.status).toBe(200);
        expect(session.body.userId).toBe(userId);

        await expectWebKeyOnAccount(issuer, jar.get(COOKIE_NAMES.SESSION_KEY_ID)!);
    });

    it('I2 a browser whose pending cookie is a second redeem\'s is refused on the first one\'s poll, and stays signed out', async () =>
    {
        const issuer = await signIn();
        const jar = new Map<string, string>();
        const { link, deviceCode, matchNumber } = await redeemedInBrowser(issuer, jar);

        // A second redeem in the same browser, of a code another device issued,
        // replaces the pending cookie with one for that code.
        await redeemedInBrowser(await signIn(), jar);

        await confirmOnIssuer(issuer, link.linkId, matchNumber);

        const polled = await browser('/_auth/device/link/poll', { deviceCode }, jar);
        expect(polled.status).toBe(401);
        expect(polled.body.__type).toBe('SessionPendingMismatchError');
        expect(jar.has(COOKIE_NAMES.SESSION)).toBe(false);

        expect((await sessionOf(jar)).status).toBe(401);
    });

    it('I3 device-code login: the browser starts, the owner approves, and the browser\'s poll signs it in', async () =>
    {
        const issuer = await signIn();
        const jar = new Map<string, string>();

        const started = await browser('/_auth/device/start/web', { deviceName: 'Office PC' }, jar);
        expect(started.status).toBe(200);

        await issuerCall('/_auth/device/approve', { userCode: started.body.userCode }, issuer);

        const polled = await browser('/_auth/device/poll', { deviceCode: started.body.deviceCode }, jar);
        expect(polled.status).toBe(200);
        expect(polled.body.status).toBe('approved');

        const session = await sessionOf(jar);
        expect(session.status).toBe(200);
        expect(session.body.userId).toBe(userId);

        await expectWebKeyOnAccount(issuer, jar.get(COOKIE_NAMES.SESSION_KEY_ID)!);
    });
    /** A key a caller with no proxy sends, as the mobile SDK makes one. */
    function clientKey(): Record<string, string>
    {
        const keyPair = generateKeyPair('ES256');

        return { publicKey: keyPair.publicKey, keyId: keyPair.keyId, fingerprint: keyPair.fingerprint, algorithm: keyPair.algorithm };
    }

    /** A refusal as a client compares it: status, error class, and the fields it names. */
    async function refusalOf(response: Response): Promise<{ status: number; type: unknown; message: unknown; paths: unknown }>
    {
        const body = await response.json() as { __type?: unknown; message?: unknown; fields?: { path: string }[] };

        return { status: response.status, type: body.__type, message: body.message, paths: body.fields?.map(field => field.path).sort() };
    }

    describe.each(WEB_TWINS)('the %s pair, called on the router', (_label, mobilePath, webPath, pageFields) =>
    {
        it.each([
            ['(a) no key fields', () => ({})],
            ['(b) a publicKey over the bound', () => ({ ...clientKey(), publicKey: 'A'.repeat(2049) })],
        ])('A6 %s: the /web route answers as the mobile route does', async (_kind, key) =>
        {
            const body = { ...pageFields, ...key() };
            const mobile = await refusalOf(await issuerPost(mobilePath, body));
            const web = await refusalOf(await issuerPost(webPath, body));

            expect(mobile).toMatchObject({ status: 400, type: 'ValidationError', message: 'Invalid request body' });
            expect(mobile.paths).toContain('/publicKey');
            expect(web).toEqual(mobile);
        });

        it('A7 the mobile route and its /web twin share one rate-limit bucket', async () =>
        {
            const statuses: number[] = [];

            for (const path of [...Array(6).fill(mobilePath), ...Array(5).fill(webPath)])
            {
                statuses.push((await issuerPost(path, { ...pageFields, ...clientKey() })).status);
            }

            expect(statuses.slice(0, 10)).not.toContain(429);
            expect(statuses[10]).toBe(429);
        });
    });

    it('A6 (c) redeem/web on the router with a valid key parks it as web, whatever platform the body says', async () =>
    {
        const issuer = await signIn();
        const link = await issuerCall<{ linkId: string; userCode: string }>('/_auth/device/link/issue', {}, issuer);
        const key = clientKey();
        const redeemed = await issuerPost('/_auth/device/link/redeem/web', { userCode: link.userCode, ...key, platform: 'ios' });

        expect(redeemed.status).toBe(200);

        const { deviceCode, matchNumber } = await redeemed.json() as { deviceCode: string; matchNumber: number };
        await confirmOnIssuer(issuer, link.linkId, matchNumber);
        await issuerCall('/_auth/device/link/poll', { deviceCode }, issuer);

        await expectWebKeyOnAccount(issuer, key.keyId);
    });

    it('A6 (c) start/web on the router with a valid key parks it as web, whatever platform the body says', async () =>
    {
        const issuer = await signIn();
        const key = clientKey();
        const started = await issuerPost('/_auth/device/start/web', { ...key, platform: 'ios' });

        expect(started.status).toBe(200);

        const { deviceCode, userCode } = await started.json() as { deviceCode: string; userCode: string };
        await issuerCall('/_auth/device/approve', { userCode }, issuer);
        await issuerCall('/_auth/device/poll', { deviceCode }, issuer);

        await expectWebKeyOnAccount(issuer, key.keyId);
    });
});
