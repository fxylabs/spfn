/**
 * @spfn/auth - a browser as the new device of device link and device-code login (#143)
 *
 * One `it` per row of the case table, named by its id. Every row goes through
 * `filterMatchingInterceptors` and the two chain executors against the shipped
 * `authInterceptors` — as `session-renew-proxy-chain.test.ts` does — so nothing
 * here names the rule it wants run; the matcher decides, as in production.
 *
 * The A rows are the browser's parking calls (`device/link/redeem/web`,
 * `device/start/web`), each run for both; the B rows the polls
 * (`device/link/poll`, `device/poll`), each run for both. There is no backend: a
 * row answers with the shape the route answers, and the cookies are real JWEs
 * read back through the real unsealers. A6, A7 and the I rows are in
 * `integration/device-link-web.test.ts`; T1 in `device-web-routes-types.test.ts`.
 *
 * | # | situation | expected |
 * | --- | --- | --- |
 * | A1 | no session, `{ userCode }` (or `{ deviceName }`) to a `/web` path | the proxy's key + `platform: 'web'` forwarded; the rest passes through; no `keySize` |
 * | A2 | a client key and `platform: 'ios'` in the body | overwritten |
 * | A3 | 200 `{ deviceCode, …, expiresAtMillis }` | one `DEVICE_PENDING` cookie for that code and key, `secure` as configured, its token expiring with the code; body unchanged |
 * | A4 | 404 / 410 / 429 / 400 | no `DEVICE_PENDING` cookie |
 * | A5 | the mobile `device/link/redeem` / `device/start` with a client key and `platform: 'ios'` | body forwarded unchanged; no `DEVICE_PENDING` on a 200; response unchanged |
 * | A8 | the pending sealer throws on a parking call | backend answer unchanged; no `DEVICE_PENDING` |
 * | B1 | 200 pending | unchanged, no cookie |
 * | B2 | 200 approved, matching pending cookie | session trio sealed, `DEVICE_PENDING` expired |
 * | B3 | 200 approved, no pending cookie | 401 `SessionPendingExpiredError`, nothing sealed |
 * | B4 | 200 approved, pending cookie for another code | 401 `SessionPendingMismatchError`, cookie kept |
 * | B5 | 200 approved, tampered / expired / MFA token | as B3 |
 * | B6 | 403 / 404 / 410 / 429 | passes through, no cookie |
 * | B7 | B2 on a browser with a session (another account's, an expired one) | the last session writes are the new ones |
 * | B8 | approved matching poll, the CSRF derivation throws | 401 `SessionPendingExpiredError`; no SESSION / SESSION_KEY_ID / CSRF / DEVICE_PENDING write |
 * | P1 | a valid session on a near-miss of a public path, or on the mobile `redeem` | signed by `generalAuthInterceptor` — not public |
 * | A1-client | `redeemDeviceLinkWeb`'s body schema and `{ userCode }` from an empty jar | accepted |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

import { authInterceptors } from '../../nextjs/interceptors';
import { cookieSecure } from '../../nextjs/interceptors/cookie-options';
import {
    sealPendingDeviceSession,
    sealPendingMfaSession,
    unsealPendingDeviceSession,
} from '../../nextjs/session-helpers';
import { refusalBody } from '../../nextjs/interceptors/error-envelope';
import { sealSession, unsealSession } from '../../server/lib/session';
import { generateClientToken, generateKeyPair } from '../../server/lib/crypto';
import { verifyClientToken } from '../../server/helpers/jwt';
import { hashCredential } from '../../server/lib/link-credentials';
import { COOKIE_NAMES } from '../../server/lib/config';
import { CSRF_HEADER, deriveCsrfToken } from '../../server/lib/csrf';
import { SessionPendingExpiredError, SessionPendingMismatchError } from '../../errors';
import { redeemDeviceLinkWeb } from '../../server/routes/auth';

// Secure cookies, as in production: under test `cookieSecure` resolves false,
// and a rule that wrote `secure: false` would match it there (A3).
vi.mock('../../nextjs/interceptors/cookie-options', () => ({ cookieSecure: true }));

// Pass-through spies, so a row can make one call throw (A8, B8) while every
// other caller — the rule and this file alike — gets the real function.
vi.mock('../../nextjs/session-helpers', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../../nextjs/session-helpers')>();

    return { ...actual, sealPendingDeviceSession: vi.fn(actual.sealPendingDeviceSession) };
});

vi.mock('../../server/lib/csrf', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../../server/lib/csrf')>();

    return { ...actual, deriveCsrfToken: vi.fn(actual.deriveCsrfToken) };
});

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const DEVICE_CODE = 'device-code-the-backend-returned-for-this-redeem';
const OTHER_DEVICE_CODE = 'a-different-device-code-from-another-redeem';
const USER_CODE = 'ABCD-EFGH';
const FIVE_MINUTES = 5 * 60_000;

/** The browser's two parking calls, each with the body a page sends. */
const PARKING = [
    ['device/link/redeem/web', '/_auth/device/link/redeem/web', { userCode: USER_CODE, deviceName: 'Office PC' }],
    ['device/start/web', '/_auth/device/start/web', { deviceName: 'Office PC' }],
] as const;

/** The mobile and CLI parking calls, which carry the caller's own key. */
const MOBILE_PARKING = [
    ['device/link/redeem', '/_auth/device/link/redeem', { userCode: USER_CODE, deviceName: 'Phone' }],
    ['device/start', '/_auth/device/start', { deviceName: 'Phone' }],
] as const;

/** The two polls. */
const POLLING = [
    ['device/link/poll', '/_auth/device/link/poll'],
    ['device/poll', '/_auth/device/poll'],
] as const;

interface ChainResult
{
    requestCtx: RequestInterceptorContext;
    responseCtx: ResponseInterceptorContext;
}

/** `buildRequestContext`'s shape; `csrf` is the header the browser client mirrors, when it has one. */
function requestContext(path: string, body: unknown, jar: Map<string, string>): RequestInterceptorContext
{
    const csrf = jar.get(COOKIE_NAMES.CSRF);

    return {
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' } as Record<string, string>,
        body,
        query: {},
        cookies: jar,
        request: { headers: new Headers({ 'user-agent': CHROME, ...(csrf ? { [CSRF_HEADER]: csrf } : {}) }) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

/** `buildResponseContext`'s shape — `metadata` is the request's own object. */
function responseContext(requestCtx: RequestInterceptorContext, status: number, body: unknown): ResponseInterceptorContext
{
    return {
        path: requestCtx.path,
        method: requestCtx.method,
        request: { headers: { 'user-agent': CHROME }, body: requestCtx.body },
        response: { ok: status < 400, status, statusText: '', headers: new Headers(), body },
        cookies: requestCtx.cookies,
        setCookies: [] as SetCookie[],
        metadata: requestCtx.metadata,
    } as unknown as ResponseInterceptorContext;
}

/** One call through every matching rule, both phases, as `createRpcProxy` runs them. */
async function throughTheChain(
    path: string,
    body: unknown,
    jar: Map<string, string>,
    backend: { status: number; body: unknown },
): Promise<ChainResult>
{
    const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');
    const requestCtx = requestContext(path, body, jar);

    await executeRequestInterceptors(
        requestCtx,
        matching.map(rule => rule.request).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    expect(requestCtx.abort).toBeUndefined();

    const responseCtx = responseContext(requestCtx, backend.status, structuredClone(backend.body));

    await executeResponseInterceptors(
        responseCtx,
        matching.map(rule => rule.response).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    return { requestCtx, responseCtx };
}

/** What a parking call answers on success. */
function parkedBody(deviceCode = DEVICE_CODE): Record<string, unknown>
{
    return {
        deviceCode,
        userCode: USER_CODE,
        matchNumber: 42,
        expiresAtMillis: Date.now() + FIVE_MINUTES,
        intervalMillis: 5000,
    };
}

/** What a poll answers once the owner said yes: a `LoginResult` spread, no key id. */
function approvedBody(userId = '7'): Record<string, unknown>
{
    return { status: 'approved', mfaRequired: false, userId, publicId: `pub_${userId}`, passwordChangeRequired: false };
}

/** Every write of `name` in a response, in order. */
function writesOf(setCookies: SetCookie[], name: string): SetCookie[]
{
    return setCookies.filter(cookie => cookie.name === name);
}

/** The last write of `name` — the one the browser keeps. */
function lastWrite(setCookies: SetCookie[], name: string): SetCookie | undefined
{
    return writesOf(setCookies, name).at(-1);
}

/** A pending cookie as the parking call would have baked it, for `deviceCode`. */
async function pendingJar(deviceCode = DEVICE_CODE): Promise<{ jar: Map<string, string>; keyId: string; privateKey: string }>
{
    const keyPair = generateKeyPair('ES256');
    const sealed = await sealPendingDeviceSession({
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
        deviceCodeHash: hashCredential(deviceCode),
    }, 300);

    return { jar: new Map([[COOKIE_NAMES.DEVICE_PENDING, sealed]]), keyId: keyPair.keyId, privateKey: keyPair.privateKey };
}

/** A session cookie trio for another account, sealed for `ttl` seconds (negative: already expired). */
async function sessionCookies(userId: string, ttl: number): Promise<{ cookies: [string, string][]; keyId: string }>
{
    const keyPair = generateKeyPair('ES256');
    const sealed = await sealSession({ userId, privateKey: keyPair.privateKey, keyId: keyPair.keyId, algorithm: keyPair.algorithm }, ttl);

    return {
        cookies: [
            [COOKIE_NAMES.SESSION, sealed],
            [COOKIE_NAMES.SESSION_KEY_ID, keyPair.keyId],
            [COOKIE_NAMES.CSRF, await deriveCsrfToken(keyPair.keyId)],
        ],
        keyId: keyPair.keyId,
    };
}

/** The B3 refusal, compared without its per-response request id. */
function expectRefusal(responseCtx: ResponseInterceptorContext, error: SessionPendingExpiredError | SessionPendingMismatchError): void
{
    const expected = refusalBody(error) as { error: Record<string, unknown> };

    expect(responseCtx.response.status).toBe(401);
    expect(responseCtx.response.body).toEqual({ ...expected, error: { ...expected.error, requestId: expect.any(String) } });
}

/** No session, key id or CSRF cookie in a response. */
function expectNothingSealed(setCookies: SetCookie[]): void
{
    for (const name of [COOKIE_NAMES.SESSION, COOKIE_NAMES.SESSION_KEY_ID, COOKIE_NAMES.CSRF])
    {
        expect(writesOf(setCookies, name)).toHaveLength(0);
    }
}

describe('a browser as the new device: the proxy makes the key and seals the approved poll (#143)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe.each(PARKING)('parking on %s', (_label, path, body) =>
    {
        it('A1 forwards the proxy\'s key as a web device; the page\'s own fields pass through; no keySize', async () =>
        {
            const { requestCtx, responseCtx } = await throughTheChain(path, { ...body }, new Map(), { status: 200, body: parkedBody() });

            const sent = requestCtx.body as Record<string, unknown>;
            expect(sent).toEqual({
                ...body,
                publicKey: expect.any(String),
                keyId: expect.any(String),
                fingerprint: expect.any(String),
                algorithm: 'ES256',
                platform: 'web',
            });
            expect(sent).not.toHaveProperty('keySize');

            // The key the backend was asked to park is the one whose private half
            // the browser now holds: sign with what the pending cookie carries and
            // verify against what was forwarded.
            const pending = await unsealPendingDeviceSession(lastWrite(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)!.value);
            const token = generateClientToken({ keyId: pending.keyId }, pending.privateKey, pending.algorithm, { expiresIn: '5m' });

            expect(verifyClientToken(token, sent.publicKey as string, 'ES256').keyId).toBe(sent.keyId);
        });

        it('A2 overwrites a key and a platform the page sent with its own', async () =>
        {
            const client = generateKeyPair('ES256');
            const { requestCtx } = await throughTheChain(path, {
                ...body,
                publicKey: client.publicKey,
                keyId: client.keyId,
                fingerprint: client.fingerprint,
                platform: 'ios',
            }, new Map(), { status: 200, body: parkedBody() });

            const sent = requestCtx.body as Record<string, unknown>;
            expect(sent.publicKey).not.toBe(client.publicKey);
            expect(sent.keyId).not.toBe(client.keyId);
            expect(sent.fingerprint).not.toBe(client.fingerprint);
            expect(sent.platform).toBe('web');
        });

        it('A3 bakes one pending cookie for that device code and key, living as long as the code', async () =>
        {
            const answer = parkedBody();
            const { requestCtx, responseCtx } = await throughTheChain(path, { ...body }, new Map(), { status: 200, body: answer });

            const written = writesOf(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING);
            expect(written).toHaveLength(1);
            expect(written[0].options).toMatchObject({ httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/' });

            const secondsLeft = ((answer.expiresAtMillis as number) - Date.now()) / 1000;
            expect(written[0].options!.maxAge).toBeGreaterThanOrEqual(Math.floor(secondsLeft) - 1);
            expect(written[0].options!.maxAge).toBeLessThanOrEqual(Math.ceil(secondsLeft) + 1);

            const sent = requestCtx.body as Record<string, unknown>;
            const pending = await unsealPendingDeviceSession(written[0].value);
            expect(pending).toEqual({
                privateKey: expect.any(String),
                keyId: sent.keyId,
                algorithm: 'ES256',
                deviceCodeHash: hashCredential(DEVICE_CODE),
            });

            expect(responseCtx.response.body).toEqual(answer);
        });

        it('A3 the sealed token expires with the device code, not only the cookie', async () =>
        {
            const issuedAt = Date.now();
            const { responseCtx } = await throughTheChain(path, { ...body }, new Map(), {
                status: 200,
                body: { ...parkedBody(), expiresAtMillis: issuedAt + 120_000 },
            });
            const sealed = lastWrite(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)!.value;

            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(issuedAt + 115_000);
            await expect(unsealPendingDeviceSession(sealed)).resolves.toMatchObject({ deviceCodeHash: hashCredential(DEVICE_CODE) });

            vi.setSystemTime(issuedAt + 125_000);
            await expect(unsealPendingDeviceSession(sealed)).rejects.toThrow();
        });

        it('A8 a pending seal that fails leaves the backend answer as it was and bakes nothing', async () =>
        {
            vi.mocked(sealPendingDeviceSession).mockRejectedValueOnce(new Error('seal failed'));
            const answer = parkedBody();
            const { responseCtx } = await throughTheChain(path, { ...body }, new Map(), { status: 200, body: answer });

            expect(responseCtx.response.status).toBe(200);
            expect(responseCtx.response.body).toEqual(answer);
            expect(writesOf(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)).toHaveLength(0);
        });

        it.each([404, 410, 429, 400])('A4 a %i bakes no pending cookie, and leaves a live one alone', async (status) =>
        {
            // The body carries a device code on purpose: the status alone decides,
            // so a refusal is never baked whatever its body happens to hold.
            const { jar } = await pendingJar();
            const { responseCtx } = await throughTheChain(path, { ...body }, jar, {
                status,
                body: { ...parkedBody(OTHER_DEVICE_CODE), __type: 'DeviceLinkNotFoundError', message: 'no' },
            });

            expect(writesOf(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)).toHaveLength(0);
        });
    });

    describe.each(MOBILE_PARKING)('the mobile %s', (_label, path, body) =>
    {
        it('A5 passes the caller\'s own key and platform through, and bakes nothing on a 200', async () =>
        {
            const client = generateKeyPair('ES256');
            const sent = {
                ...body,
                publicKey: client.publicKey,
                keyId: client.keyId,
                fingerprint: client.fingerprint,
                algorithm: client.algorithm,
                platform: 'ios',
            };
            const answer = parkedBody();
            const { requestCtx, responseCtx } = await throughTheChain(path, structuredClone(sent), new Map(), { status: 200, body: answer });

            expect(requestCtx.body).toEqual(sent);
            expect(responseCtx.response.status).toBe(200);
            expect(responseCtx.response.body).toEqual(answer);
            expect(responseCtx.setCookies).toHaveLength(0);
        });
    });

    describe.each(POLLING)('polling on %s', (_label, path) =>
    {
        it('B1 a pending answer passes through and sets nothing', async () =>
        {
            const { jar } = await pendingJar();
            const answer = { status: 'pending', intervalMillis: 5000 };
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, jar, { status: 200, body: answer });

            expect(responseCtx.response.body).toEqual(answer);
            expect(responseCtx.setCookies).toHaveLength(0);
        });

        it('B2 an approved poll for the parked code seals the session and expires the pending cookie', async () =>
        {
            const { jar, keyId, privateKey } = await pendingJar();
            const answer = approvedBody();
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, jar, { status: 200, body: answer });

            const session = await unsealSession(lastWrite(responseCtx.setCookies, COOKIE_NAMES.SESSION)!.value);
            expect(session).toMatchObject({ userId: '7', privateKey, keyId, algorithm: 'ES256' });
            expect(lastWrite(responseCtx.setCookies, COOKIE_NAMES.SESSION_KEY_ID)!.value).toBe(keyId);
            expect(lastWrite(responseCtx.setCookies, COOKIE_NAMES.CSRF)!.value).toBe(await deriveCsrfToken(keyId));
            expect(lastWrite(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)!.options!.maxAge).toBe(0);

            expect(responseCtx.response.status).toBe(200);
            expect(responseCtx.response.body).toEqual(answer);
        });

        it('B3 an approved poll with no pending cookie is refused as expired and seals nothing', async () =>
        {
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, new Map(), { status: 200, body: approvedBody() });

            expectRefusal(responseCtx, new SessionPendingExpiredError());
            expectNothingSealed(responseCtx.setCookies);
        });

        it('B4 an approved poll for a code the cookie was not baked for is refused as a mismatch; the cookie stays', async () =>
        {
            const { jar } = await pendingJar(OTHER_DEVICE_CODE);
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, jar, { status: 200, body: approvedBody() });

            expectRefusal(responseCtx, new SessionPendingMismatchError());
            expectNothingSealed(responseCtx.setCookies);
            expect(writesOf(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)).toHaveLength(0);
        });

        it('B4 a poll with no device code in it is a mismatch, never a match', async () =>
        {
            const { jar } = await pendingJar();
            const { responseCtx } = await throughTheChain(path, { deviceCode: 42 }, jar, { status: 200, body: approvedBody() });

            expectRefusal(responseCtx, new SessionPendingMismatchError());
            expectNothingSealed(responseCtx.setCookies);
        });

        it.each([
            ['tampered', async () => `${(await pendingJar()).jar.get(COOKIE_NAMES.DEVICE_PENDING)!.slice(0, -4)}AAAA`],
            ['past its seal expiry', async () =>
            {
                const sealed = (await pendingJar()).jar.get(COOKIE_NAMES.DEVICE_PENDING)!;
                vi.useFakeTimers({ toFake: ['Date'] });
                vi.setSystemTime(Date.now() + 301_000);

                return sealed;
            }],
            ['an MFA pending token', async () =>
            {
                const keyPair = generateKeyPair('ES256');

                return await sealPendingMfaSession({
                    privateKey: keyPair.privateKey,
                    keyId: keyPair.keyId,
                    algorithm: keyPair.algorithm,
                    challengeHash: hashCredential(DEVICE_CODE),
                }, 300);
            }],
        ])('B5 a pending cookie that is %s is refused as expired and seals nothing', async (_kind, cookie) =>
        {
            const jar = new Map([[COOKIE_NAMES.DEVICE_PENDING, await cookie()]]);
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, jar, { status: 200, body: approvedBody() });

            expectRefusal(responseCtx, new SessionPendingExpiredError());
            expectNothingSealed(responseCtx.setCookies);
        });

        it.each([403, 404, 410, 429])('B6 a %i passes through unchanged and sets nothing', async (status) =>
        {
            const { jar } = await pendingJar();
            const answer = { __type: 'DeviceLinkDeniedError', message: 'no' };
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, jar, { status, body: answer });

            expect(responseCtx.response.status).toBe(status);
            expect(responseCtx.response.body).toEqual(answer);
            expect(responseCtx.setCookies).toHaveLength(0);
        });

        it.each([
            ['(a) a valid session for another account', 7 * 24 * 3600],
            ['(b) an expired session', -60],
        ])('B7 %s: the last session writes are the new ones', async (_kind, ttl) =>
        {
            const old = await sessionCookies('99', ttl);
            const { jar, keyId } = await pendingJar();
            const browser = new Map([...jar, ...old.cookies]);

            const { requestCtx, responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, browser, { status: 200, body: approvedBody() });

            // The browser client mirrors the CSRF cookie into the header, as it
            // does on every call; and the old session signs nothing here.
            expect(requestCtx.request.headers.get(CSRF_HEADER)).toBe(browser.get(COOKIE_NAMES.CSRF));
            expect(requestCtx.headers['X-Key-Id']).toBeUndefined();

            const session = await unsealSession(lastWrite(responseCtx.setCookies, COOKIE_NAMES.SESSION)!.value);
            expect(session.keyId).toBe(keyId);
            expect(session.userId).toBe('7');
            expect(lastWrite(responseCtx.setCookies, COOKIE_NAMES.SESSION_KEY_ID)!.value).toBe(keyId);
            expect(lastWrite(responseCtx.setCookies, COOKIE_NAMES.CSRF)!.value).toBe(await deriveCsrfToken(keyId));

            // Nothing cleared the old session after the new one went in, and
            // nothing re-sealed it: one write of each name, and it is the new one.
            expect(writesOf(responseCtx.setCookies, COOKIE_NAMES.SESSION)).toHaveLength(1);
            expect(writesOf(responseCtx.setCookies, COOKIE_NAMES.SESSION_KEY_ID)).toHaveLength(1);
            expect(session.keyId).not.toBe(old.keyId);
        });

        it('B8 a CSRF derivation that throws after the seal is refused as expired, with no cookie queued', async () =>
        {
            vi.mocked(deriveCsrfToken).mockRejectedValueOnce(new Error('derivation failed'));
            const { jar } = await pendingJar();
            const { responseCtx } = await throughTheChain(path, { deviceCode: DEVICE_CODE }, jar, { status: 200, body: approvedBody() });

            expectRefusal(responseCtx, new SessionPendingExpiredError());
            expectNothingSealed(responseCtx.setCookies);
            expect(writesOf(responseCtx.setCookies, COOKIE_NAMES.DEVICE_PENDING)).toHaveLength(0);
        });
    });

    it.each([
        '/_auth/device/link/poll-anything',
        '/_auth/device/link/redeem/web/x',
        '/_auth/device/start/webx',
        '/_auth/device/poll/',
        '/_auth/device/link/redeem',
    ])('P1 %s with a valid session is signed by the session key, not public', async (path) =>
    {
        const session = await sessionCookies('99', 7 * 24 * 3600);
        const { requestCtx } = await throughTheChain(path, {}, new Map(session.cookies), { status: 200, body: {} });

        expect(requestCtx.headers['X-Key-Id']).toBe(session.keyId);
    });

    it('A1-client redeemDeviceLinkWeb takes `{ userCode }` alone, and so does the body the proxy forwards from an empty jar', async () =>
    {
        const { requestCtx } = await throughTheChain('/_auth/device/link/redeem/web', { userCode: USER_CODE }, new Map(), {
            status: 200,
            body: parkedBody(),
        });

        expect(Value.Check(redeemDeviceLinkWeb.input!.body!, { userCode: USER_CODE })).toBe(true);
        expect(Value.Check(redeemDeviceLinkWeb.input!.body!, requestCtx.body)).toBe(true);
    });
});
