/**
 * @spfn/auth - the proxy half of session binding (design #97 v2, case table 6c)
 *
 * One `it` per row, driving the interceptors directly with a hand-built context —
 * the way `oauth-callback-handler.test.ts` drives the callback handler and the
 * other interceptor suites drive theirs. No database and no backend: what these
 * rows are about is what the Next.js proxy does with a sealed cookie before and
 * after the backend is (or is not) called.
 *
 * The cookie is real throughout. Every session here is produced by `sealSession`
 * and read back by `unsealSession`, so a row that says "the two fields survive"
 * is asserting what is actually in the JWE rather than what a stub agreed to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

import { generalAuthInterceptor } from '../../nextjs/interceptors/general-auth';
import { loginRegisterInterceptor } from '../../nextjs/interceptors/login-register';
import { keyRotationInterceptor } from '../../nextjs/interceptors/key-rotation';
import { oauthFinalizeInterceptor } from '../../nextjs/interceptors/oauth';
import { sessionBindingInterceptor } from '../../nextjs/interceptors/session-binding';
import { SESSION_RENEW_PATH_PATTERN } from '../../nextjs/interceptors/session-renew';
import { sealPendingSession } from '../../nextjs/session-helpers';
import { sealSession, unsealSession, type SessionData } from '../../server/lib/session';
import { generateKeyPair } from '../../server/lib/crypto';
import { COOKIE_NAMES } from '../../server/lib/config';
import { authErrorRegistry, SessionContextChangedError, SessionRenewalRequiredError, SessionResealFailedError } from '../../errors';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0';

const BOUND = { sessionBinding: 'passkey', keyExpiresAtMillis: Date.now() + 3_600_000 };

/** A session as a sign-in would have sealed it. */
async function sealedSession(overrides: Partial<SessionData> = {}): Promise<{ sealed: string; keyId: string }>
{
    const keyPair = generateKeyPair('ES256');
    const sealed = await sealSession({
        userId: '7',
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
        ...overrides,
    } as SessionData, 3600);

    return { sealed, keyId: keyPair.keyId };
}

/** The session cookie a response queued, unsealed. */
async function queuedSession(setCookies: SetCookie[]): Promise<SessionData>
{
    const cookie = [...setCookies].reverse().find(entry => entry.name === COOKIE_NAMES.SESSION && entry.value);

    return await unsealSession(cookie!.value);
}

function requestContext(path: string, cookies: Map<string, string>, userAgent?: string): RequestInterceptorContext
{
    return {
        path,
        method: 'GET',
        headers: {} as Record<string, string>,
        body: undefined,
        cookies,
        request: { headers: new Headers(userAgent ? { 'user-agent': userAgent } : {}) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

function responseContext(
    path: string,
    status: number,
    body: unknown,
    options: { cookies?: Map<string, string>; metadata?: Record<string, unknown>; userAgent?: string } = {},
): ResponseInterceptorContext
{
    return {
        path,
        method: 'POST',
        request: { headers: options.userAgent ? { 'user-agent': options.userAgent } : {}, body: {} },
        response: { ok: status < 400, status, statusText: '', headers: new Headers(), body },
        cookies: options.cookies ?? new Map(),
        setCookies: [] as SetCookie[],
        metadata: options.metadata ?? {},
    } as unknown as ResponseInterceptorContext;
}

const next = async (): Promise<void> => undefined;

describe('the proxy and a bound session (case table 6c)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('bound, keyExpiresAt is past, an ordinary route: forwarded to the backend all the same, signed, cookies kept', async () =>
    {
        // The cookie's copy of the expiry decides nothing. It is a hint written at
        // the last seal, and the key row is the fact — so the request goes to the
        // backend and the answer comes back from there.
        const { sealed, keyId } = await sealedSession({ binding: 'passkey', keyExpiresAt: Date.now() - 1_000 });
        const ctx = requestContext('/_auth/users/me', new Map([[COOKIE_NAMES.SESSION, sealed]]), CHROME);
        const forwarded = vi.fn(next);

        await generalAuthInterceptor.request?.(ctx, forwarded);

        expect(forwarded).toHaveBeenCalledOnce();
        expect(ctx.abort).toBeUndefined();
        expect(ctx.headers['X-Key-Id']).toBe(keyId);
        expect(ctx.metadata.sessionBound).toBe(true);
    });

    it('bound, the backend answers 401 KeyExpiredError: the SessionRenewalRequiredError envelope, cookies kept', async () =>
    {
        const ctx = responseContext('/_auth/users/me', 401, { __type: 'KeyExpiredError', message: 'Public key has expired' }, {
            metadata: { sessionValid: true, sessionBound: true },
        });

        await generalAuthInterceptor.response?.(ctx, next);

        expect(ctx.response.body).toMatchObject({
            __type: 'SessionRenewalRequiredError',
            error: { code: 'SessionRenewalRequiredError' },
        });
        expect(ctx.setCookies.filter(cookie => cookie.value === '')).toEqual([]);
    });

    it('binding turned off on another device: this device\'s stale bound cookie crosses its old expiry and the backend still answers 200', async () =>
    {
        // Disabling rewrites every active key to 90-day and unbound, but only the
        // device that asked gets a re-sealed cookie. The other one keeps
        // `binding: 'passkey'` and an expiry that no longer applies — and because
        // nothing is decided here, its request is forwarded and the backend, which
        // reads the row, answers it normally. No renewal prompt for a session that
        // does not need one.
        const { sealed } = await sealedSession({ binding: 'passkey', keyExpiresAt: Date.now() - 1_000, uaFamily: 'chrome' });
        const ctx = requestContext('/_auth/users/me', new Map([[COOKIE_NAMES.SESSION, sealed]]), CHROME);
        const forwarded = vi.fn(next);

        await generalAuthInterceptor.request?.(ctx, forwarded);
        expect(forwarded).toHaveBeenCalledOnce();

        const answered = responseContext('/_auth/users/me', 200, { ok: true }, { metadata: ctx.metadata });
        await generalAuthInterceptor.response?.(answered, next);

        expect(answered.response.status).toBe(200);
        expect(answered.response.body).toEqual({ ok: true });
        expect(answered.setCookies.filter(cookie => cookie.value === '')).toEqual([]);
    });

    it('bound, expired, POST session/renew/options: signed and passed to the backend, cookies kept', async () =>
    {
        const { sealed, keyId } = await sealedSession({ binding: 'passkey', keyExpiresAt: Date.now() - 1_000 });
        const ctx = requestContext('/_auth/session/renew/options', new Map([[COOKIE_NAMES.SESSION, sealed]]), CHROME);
        const forwarded = vi.fn(next);

        await generalAuthInterceptor.request?.(ctx, forwarded);

        expect(forwarded).toHaveBeenCalledOnce();
        expect(ctx.abort).toBeUndefined();
        expect(ctx.headers['X-Key-Id']).toBe(keyId);
    });

    it('bound, expired, session/renew/verify answers 401 (signature mismatch): 401 passed through, cookies KEPT', async () =>
    {
        // `sessionValid` is set because the request phase sets it: the renewal
        // paths are signed like any other, so the "backend said 401" branch would
        // fire on them without the explicit path skip — and a refused renewal that
        // emptied the jar would destroy the session being repaired.
        const ctx = responseContext('/_auth/session/renew/verify', 401, { __type: 'SessionRenewalRefusedError', message: 'no' }, {
            metadata: { sessionValid: true },
        });

        await generalAuthInterceptor.response?.(ctx, next);

        expect(ctx.setCookies.filter(cookie => cookie.value === '')).toEqual([]);
    });

    it('bound, the user-agent family does not match: 401 SessionContextChangedError envelope, the three cookies cleared', async () =>
    {
        const { sealed } = await sealedSession({ binding: 'passkey', keyExpiresAt: Date.now() + 3_600_000, uaFamily: 'chrome' });
        const ctx = requestContext('/_auth/users/me', new Map([[COOKIE_NAMES.SESSION, sealed]]), FIREFOX);

        await generalAuthInterceptor.request?.(ctx, next);

        expect((ctx.abort?.body as { __type: string }).__type).toBe('SessionContextChangedError');
        expect(ctx.abort?.setCookies?.map(cookie => cookie.name)).toEqual([
            COOKIE_NAMES.SESSION,
            COOKIE_NAMES.SESSION_KEY_ID,
            COOKIE_NAMES.CSRF,
        ]);
    });

    it('bound, no user-agent (a server component calling the RPC proxy): passed through, cookies kept', async () =>
    {
        const { sealed } = await sealedSession({ binding: 'passkey', keyExpiresAt: Date.now() + 3_600_000, uaFamily: 'chrome' });
        const ctx = requestContext('/_auth/users/me', new Map([[COOKIE_NAMES.SESSION, sealed]]));
        const forwarded = vi.fn(next);

        await generalAuthInterceptor.request?.(ctx, forwarded);

        expect(forwarded).toHaveBeenCalledOnce();
        expect(ctx.abort).toBeUndefined();
    });

    it('unbound, the user-agent family does not match: passed through, and nothing is logged', async () =>
    {
        const { authLogger } = await import('../../server/logger');
        const warn = vi.spyOn(authLogger.interceptor.general, 'warn').mockImplementation(() => undefined);
        const { sealed } = await sealedSession({ uaFamily: 'chrome' });
        const ctx = requestContext('/_auth/users/me', new Map([[COOKIE_NAMES.SESSION, sealed]]), FIREFOX);

        await generalAuthInterceptor.request?.(ctx, next);

        expect(ctx.abort).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it('bound, backend answers some other 401: 401 passed through and the cookies are cleared', async () =>
    {
        const ctx = responseContext('/_auth/users/me', 401, { __type: 'InvalidTokenError', message: 'no' }, {
            metadata: { sessionValid: true, sessionBound: true },
        });

        await generalAuthInterceptor.response?.(ctx, next);

        expect(ctx.setCookies.filter(cookie => cookie.value === '').map(cookie => cookie.name)).toEqual([
            COOKIE_NAMES.SESSION,
            COOKIE_NAMES.SESSION_KEY_ID,
            COOKIE_NAMES.CSRF,
        ]);
    });

    it('unbound, backend answers 401 KeyExpiredError: 401 passed through and the cookies are cleared, exactly as today', async () =>
    {
        const ctx = responseContext('/_auth/users/me', 401, { __type: 'KeyExpiredError', message: 'Public key has expired' }, {
            metadata: { sessionValid: true },
        });

        await generalAuthInterceptor.response?.(ctx, next);

        expect((ctx.response.body as { __type: string }).__type).toBe('KeyExpiredError');
        expect(ctx.setCookies.filter(cookie => cookie.value === '').map(cookie => cookie.name)).toEqual([
            COOKIE_NAMES.SESSION,
            COOKIE_NAMES.SESSION_KEY_ID,
            COOKIE_NAMES.CSRF,
        ]);
    });

    it('a sign-in response without the two fields: the session is sealed unbound', async () =>
    {
        const ctx = responseContext('/_auth/login', 200, { userId: '7' }, {
            metadata: { privateKey: 'k', keyId: 'key-1', algorithm: 'ES256' },
            userAgent: CHROME,
        });

        await loginRegisterInterceptor.response?.(ctx, next);

        const session = await queuedSession(ctx.setCookies);
        expect(session.binding).toBeUndefined();
        expect(session.keyExpiresAt).toBeUndefined();
        expect(session.uaFamily).toBeUndefined();
    });

    it('a sign-in response with the two fields: the session carries binding, keyExpiresAt and the inbound family', async () =>
    {
        const ctx = responseContext('/_auth/login', 200, { userId: '7', ...BOUND }, {
            metadata: { privateKey: 'k', keyId: 'key-1', algorithm: 'ES256' },
            userAgent: CHROME,
        });

        await loginRegisterInterceptor.response?.(ctx, next);

        expect(await queuedSession(ctx.setCookies)).toMatchObject({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
    });

    it('bound, keys/rotate answers 200: the new cookie inherits both fields and the family', async () =>
    {
        const { sealed } = await sealedSession({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
        const request = requestContext('/_auth/keys/rotate', new Map([[COOKIE_NAMES.SESSION, sealed]]));
        await keyRotationInterceptor.request?.(request, next);

        const ctx = responseContext('/_auth/keys/rotate', 200, { success: true }, { metadata: request.metadata });
        await keyRotationInterceptor.response?.(ctx, next);

        expect(await queuedSession(ctx.setCookies)).toMatchObject({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
    });

    it('bound, the OAuth finalize interceptor: the sealed session carries both fields', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const pending = await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        });
        const ctx = responseContext('/_auth/oauth/finalize', 200, { userId: '7', keyId: keyPair.keyId, ...BOUND }, {
            cookies: new Map([[COOKIE_NAMES.OAUTH_PENDING, pending]]),
            userAgent: CHROME,
        });

        await oauthFinalizeInterceptor.response?.(ctx, next);

        expect(await queuedSession(ctx.setCookies)).toMatchObject({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
    });

    it('bound, shouldRefreshSession fires: the re-seal preserves all three fields', async () =>
    {
        const { sealed } = await sealedSession({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
        const session = await unsealSession(sealed);
        const ctx = responseContext('/_auth/users/me', 200, { ok: true }, {
            metadata: { refreshSession: true, sessionData: session, sessionValid: true, keyId: session.keyId },
        });

        await generalAuthInterceptor.response?.(ctx, next);

        expect(await queuedSession(ctx.setCookies)).toMatchObject({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
    });

    it('session/binding answers 200 with mode passkey: the cookie is re-sealed with both fields', async () =>
    {
        const { sealed } = await sealedSession();
        const ctx = responseContext('/_auth/session/binding', 200, { mode: 'passkey', keyExpiresAtMillis: BOUND.keyExpiresAtMillis }, {
            cookies: new Map([[COOKIE_NAMES.SESSION, sealed]]),
            userAgent: CHROME,
        });

        await sessionBindingInterceptor.response?.(ctx, next);

        expect(await queuedSession(ctx.setCookies)).toMatchObject({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
    });

    it('bound, password/reset/complete: the cookie the reset seals carries all three fields', async () =>
    {
        // A reset is a sign-in for cookie purposes — same interceptor, same path
        // list — and on a bound account it registers a 24-hour key. A cookie
        // without the fields would skip the user-agent check for that key's whole
        // life and be cleared rather than renewed when it ran out.
        const ctx = responseContext('/_auth/password/reset/complete', 200, { userId: '7', ...BOUND }, {
            metadata: { privateKey: 'k', keyId: 'key-1', algorithm: 'ES256' },
            userAgent: CHROME,
        });

        await loginRegisterInterceptor.response?.(ctx, next);

        expect(await queuedSession(ctx.setCookies)).toMatchObject({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
    });

    it('session/binding answers 200 but the session cannot be re-sealed: 500, no 200 body, and the three cookies cleared', async () =>
    {
        // The setting is already committed and the cookie cannot be made to agree
        // with it. Answering the route's 200 would leave the browser holding a
        // session that contradicts the account — bound key with an unbound cookie,
        // or the reverse — so the answer is the failure and the jar is emptied.
        const ctx = responseContext('/_auth/session/binding', 200, { mode: 'passkey', keyExpiresAtMillis: BOUND.keyExpiresAtMillis }, {
            cookies: new Map([[COOKIE_NAMES.SESSION, 'not-a-sealed-session']]),
            userAgent: CHROME,
        });

        await sessionBindingInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(500);
        expect(ctx.response.ok).toBe(false);
        expect(ctx.response.body).toMatchObject({
            __type: 'SessionResealFailedError',
            error: { code: 'SessionResealFailedError' },
        });
        expect(ctx.setCookies.map(cookie => cookie.name)).toEqual([
            COOKIE_NAMES.SESSION,
            COOKIE_NAMES.SESSION_KEY_ID,
            COOKIE_NAMES.CSRF,
        ]);
        expect(ctx.setCookies.every(cookie => cookie.value === '')).toBe(true);
    });

    it('session/binding answers 200 with mode none: the cookie is re-sealed with the fields removed', async () =>
    {
        const { sealed } = await sealedSession({
            binding: 'passkey',
            keyExpiresAt: BOUND.keyExpiresAtMillis,
            uaFamily: 'chrome',
        });
        const ctx = responseContext('/_auth/session/binding', 200, { mode: 'none' }, {
            cookies: new Map([[COOKIE_NAMES.SESSION, sealed]]),
            userAgent: CHROME,
        });

        await sessionBindingInterceptor.response?.(ctx, next);

        const session = await queuedSession(ctx.setCookies);
        expect(session.binding).toBeUndefined();
        expect(session.keyExpiresAt).toBeUndefined();
        expect(session.uaFamily).toBeUndefined();
    });

    it('a 401 the proxy minted: the body carries __type and error.code, and the client restores the class', () =>
    {
        const bodies = [new SessionRenewalRequiredError(), new SessionContextChangedError(), new SessionResealFailedError()]
            .map(error => ({ ...error.toJSON(), error: { code: error.name, message: error.message, requestId: 'x' } }));

        for (const body of bodies)
        {
            expect(body).toMatchObject({ __type: expect.any(String), error: { code: body.__type } });
            expect(authErrorRegistry.deserialize(body as never)).toBeInstanceOf(Error);
        }

        expect(authErrorRegistry.deserialize(bodies[0] as never)).toBeInstanceOf(SessionRenewalRequiredError);
        expect(authErrorRegistry.deserialize(bodies[1] as never)).toBeInstanceOf(SessionContextChangedError);
    });
});

describe('the renewal request shape the proxy builds (case table 6d, browser rows)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('signs both renewal calls with the expiring key, so the backend reads the key id off the JWT', async () =>
    {
        for (const path of ['/_auth/session/renew/options', '/_auth/session/renew/verify'])
        {
            const { sealed, keyId } = await sealedSession({ binding: 'passkey', keyExpiresAt: Date.now() - 1_000 });
            const ctx = requestContext(path, new Map([[COOKIE_NAMES.SESSION, sealed]]), CHROME);
            const forwarded = vi.fn(next);

            await generalAuthInterceptor.request?.(ctx, forwarded);

            expect(forwarded).toHaveBeenCalledOnce();
            expect(ctx.abort).toBeUndefined();
            expect(ctx.headers['Authorization']).toMatch(/^Bearer \S+$/);
            expect(ctx.headers['X-Key-Id']).toBe(keyId);
            // The key id is nowhere in the body — there is no body field left for
            // it, and a caller who could write one would gain nothing by it.
            expect(ctx.body).toBeUndefined();
        }
    });

    it('matches only the two renewal paths, so nothing else tolerates an expired key', () =>
    {
        expect(SESSION_RENEW_PATH_PATTERN.test('/_auth/session/renew/options')).toBe(true);
        expect(SESSION_RENEW_PATH_PATTERN.test('/_auth/session/renew/verify')).toBe(true);
        expect(SESSION_RENEW_PATH_PATTERN.test('/_auth/session/binding')).toBe(false);
        expect(SESSION_RENEW_PATH_PATTERN.test('/_auth/login')).toBe(false);
    });

    it('puts renew/verify on the login interceptor\'s list, so the proxy mints the key pair and seals the session', () =>
    {
        const pattern = loginRegisterInterceptor.pathPattern as RegExp;

        expect(pattern.test('/_auth/session/renew/verify')).toBe(true);
        expect(pattern.test('/_auth/session/renew/options')).toBe(false);
    });
});

describe('a server component rendering a bound session that needs renewing (case table 6c)', () =>
{
    afterEach(() =>
    {
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('getAuthSessionData answers renewal-required rather than null, so the guard does not read it as signed out', async () =>
    {
        vi.doMock('@spfn/auth', () => ({
            authApi: {
                getAuthSession: { call: async () => Promise.reject(new SessionRenewalRequiredError()) },
            },
        }));

        const { getAuthSessionData, RENEWAL_REQUIRED } = await import('../../nextjs/guards/auth-utils');

        expect(await getAuthSessionData()).toBe(RENEWAL_REQUIRED);
    });

    it('getAuthSessionData still answers null for an ordinary refusal', async () =>
    {
        vi.doMock('@spfn/auth', () => ({
            authApi: {
                getAuthSession: { call: async () => Promise.reject(new Error('Unauthorized')) },
            },
        }));

        const { getAuthSessionData } = await import('../../nextjs/guards/auth-utils');

        expect(await getAuthSessionData()).toBeNull();
    });
});
