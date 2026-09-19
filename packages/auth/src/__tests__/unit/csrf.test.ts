/**
 * @spfn/auth - CSRF protection for cookie-session mutations (issue #81)
 *
 * The check lives in the Next.js proxy because only the proxy knows a request's
 * credential was ambient: the backend sees a bearer token whether it came from a
 * session cookie or from a real bearer client. These tests walk the design's case
 * table one row at a time, plus the traps that make this kind of check quietly
 * useless — comparing the cookie to the header, reading the header from the
 * forwarded (allowlisted) set, and hashing a missing secret.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';

import { generalAuthInterceptor } from '../../nextjs/interceptors/general-auth';
import { loginRegisterInterceptor } from '../../nextjs/interceptors/login-register';
import { keyRotationInterceptor } from '../../nextjs/interceptors/key-rotation';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession, type SessionData } from '../../server/lib/session';
import { CSRF_HEADER, deriveCsrfToken, timingSafeEqualString } from '../../server/lib/csrf';
import { COOKIE_NAMES, configureAuth, getCsrfMode, type CsrfMode } from '../../server/lib/config';
import { authLogger } from '../../server/logger';

const MUTATION_PATH = '/orders';

/** `next` for an interceptor run outside the proxy chain. */
async function noop(): Promise<void>
{
}

/** A session as generalAuthInterceptor will find it: sealed cookie + its data. */
async function makeSession(): Promise<{ data: SessionData; cookie: string }>
{
    const keyPair = generateKeyPair('ES256');
    const data: SessionData = {
        userId: 'user-1',
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
    };

    return { data, cookie: await sealSession(data, 3600) };
}

interface ContextOptions
{
    method?: string;
    path?: string;
    sessionCookie?: string;
    header?: string;
    /** Readable CSRF cookie as the browser presented it (attacker-controlled). */
    csrfCookie?: string;
}

/**
 * Build the context the proxy hands an interceptor.
 *
 * `headers` deliberately holds only what buildProxyHeaders() forwards to the
 * backend — that allowlist has no CSRF header on it — while `request` carries the
 * browser's real headers. A check that reads the wrong one refuses everything.
 */
function requestContext(options: ContextOptions): RequestInterceptorContext
{
    const cookies = new Map<string, string>();

    if (options.sessionCookie)
    {
        cookies.set(COOKIE_NAMES.SESSION, options.sessionCookie);
    }

    if (options.csrfCookie)
    {
        cookies.set(COOKIE_NAMES.CSRF, options.csrfCookie);
    }

    const browserHeaders = new Headers();

    if (options.header !== undefined)
    {
        browserHeaders.set(CSRF_HEADER, options.header);
    }

    return {
        path: options.path ?? MUTATION_PATH,
        method: options.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
        body: {},
        query: {},
        cookies,
        request: { headers: browserHeaders } as unknown as NextRequest,
        metadata: {},
    };
}

/** Run the interceptor; report whether the chain continued. */
async function run(ctx: RequestInterceptorContext): Promise<{ continued: boolean }>
{
    let continued = false;

    await generalAuthInterceptor.request!(ctx, async () =>
    {
        continued = true;
    });

    return { continued };
}

function setMode(mode: CsrfMode | undefined): void
{
    configureAuth({ csrf: mode ? { mode } : undefined });
}

describe('CSRF - case table', () =>
{
    let session: { data: SessionData; cookie: string };
    let validToken: string;

    beforeEach(async () =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        setMode('enforce');
        session = await makeSession();
        validToken = await deriveCsrfToken(session.data.keyId);
    });

    afterEach(() =>
    {
        setMode(undefined);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('GET with a session and no header passes untouched', async () =>
    {
        const ctx = requestContext({ method: 'GET', sessionCookie: session.cookie });

        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        expect(ctx.headers['Authorization']).toMatch(/^Bearer /);
    });

    it('POST with a session and the valid header passes', async () =>
    {
        const ctx = requestContext({ sessionCookie: session.cookie, header: validToken });

        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        expect(ctx.headers['Authorization']).toMatch(/^Bearer /);
    });

    it('POST with a session and no header is refused with 403', async () =>
    {
        const ctx = requestContext({ sessionCookie: session.cookie });

        const { continued } = await run(ctx);

        expect(ctx.abort?.status).toBe(403);
        expect(ctx.abort?.body).toEqual({ error: 'Forbidden', message: 'CSRF token missing or invalid' });
        expect(continued).toBe(false);
        // Refused before the backend was ever addressed
        expect(ctx.headers['Authorization']).toBeUndefined();
        // …and carrying the value a retry needs — see "the refusal repairs the browser"
        expect(ctx.abort?.setCookies).toHaveLength(1);
    });

    it('POST with another session\'s token is refused', async () =>
    {
        const other = await makeSession();
        const ctx = requestContext({
            sessionCookie: session.cookie,
            header: await deriveCsrfToken(other.data.keyId),
        });

        await run(ctx);

        expect(ctx.abort?.status).toBe(403);
    });

    it('POST with a token stale after key rotation is refused', async () =>
    {
        // Rotation gives the session a new key id; the token derives from it.
        const beforeRotation = await deriveCsrfToken('key-before-rotation');
        const rotated = await makeSession();

        expect(await deriveCsrfToken(rotated.data.keyId)).not.toBe(beforeRotation);

        const ctx = requestContext({ sessionCookie: rotated.cookie, header: beforeRotation });

        await run(ctx);

        expect(ctx.abort?.status).toBe(403);
    });

    it('POST with a garbage token is refused', async () =>
    {
        const ctx = requestContext({ sessionCookie: session.cookie, header: 'not-a-token' });

        await run(ctx);

        expect(ctx.abort?.status).toBe(403);
    });

    it('POST to an exempt path passes without a header', async () =>
    {
        configureAuth({ csrf: { mode: 'enforce', exemptPaths: ['/webhooks/stripe'] } });

        const ctx = requestContext({ path: '/webhooks/stripe', sessionCookie: session.cookie });

        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
    });

    it('POST to a path that merely starts with an exempt one is still refused', async () =>
    {
        // Exemption is an exact match, and has to stay one: a prefix rule would
        // make `exemptPaths: ['/webhooks/stripe']` open up every path beneath it,
        // which is not what anyone listing a single webhook receiver is asking for.
        configureAuth({ csrf: { mode: 'enforce', exemptPaths: ['/webhooks/stripe'] } });

        const ctx = requestContext({ path: '/webhooks/stripe/extra', sessionCookie: session.cookie });

        const { continued } = await run(ctx);

        expect(ctx.abort?.status).toBe(403);
        expect(continued).toBe(false);
    });

    it.each(['HEAD', 'OPTIONS'])('%s with a session and no header passes untouched', async (method) =>
    {
        // Safe by method, like GET. In the proxy these never even reach the check
        // — generalAuthInterceptor's rule lists GET/POST/PUT/PATCH/DELETE — but
        // the check must not depend on that filter to stay correct.
        const ctx = requestContext({ method, sessionCookie: session.cookie });

        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        expect(ctx.headers['Authorization']).toMatch(/^Bearer /);
    });

    it('POST without a session is untouched — a refusal must not reveal that nobody is signed in', async () =>
    {
        const ctx = requestContext({});

        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        // Existing behaviour: no Authorization, the backend answers 401
        expect(ctx.headers['Authorization']).toBeUndefined();
    });

    it('refuses a header forged from a tossed cookie — the value is recomputed, never compared to the cookie', async () =>
    {
        // A sibling-subdomain attacker can write our cookies but cannot read the
        // session. Double-submit would accept this; recomputation does not.
        const tossed = 'a'.repeat(64);
        const ctx = requestContext({
            sessionCookie: session.cookie,
            csrfCookie: tossed,
            header: tossed,
        });

        await run(ctx);

        expect(ctx.abort?.status).toBe(403);
    });

    it('accepts the real token when the header also carries a tossed candidate', async () =>
    {
        // The browser cannot tell which of two same-named cookies is ours, so the
        // client sends both. Accepting a match among them is no weaker: the
        // attacker's candidate still has to equal a value recomputed here.
        const ctx = requestContext({
            sessionCookie: session.cookie,
            header: `${'f'.repeat(64)},${validToken}`,
        });

        await run(ctx);

        expect(ctx.abort).toBeUndefined();
    });

    it('refuses when every candidate in the header is wrong', async () =>
    {
        const ctx = requestContext({
            sessionCookie: session.cookie,
            header: `${'f'.repeat(64)},${'e'.repeat(64)}`,
        });

        await run(ctx);

        expect(ctx.abort?.status).toBe(403);
    });

    it('accepts the real token last in a header flooded to the client\'s limit', async () =>
    {
        // A cookie-tossing attacker floods the jar; the client sends what it kept,
        // up to its cap of 32, and the genuine value can be the very last of them.
        // The server's cap must be ≥ the client's, or this request is a 403 and
        // the user is locked out of every mutation until the flood clears.
        const flood = Array.from({ length: 31 }, (_, i) => `${i}`.padStart(64, 'a'));
        const ctx = requestContext({
            sessionCookie: session.cookie,
            header: [...flood, validToken].join(','),
        });

        await run(ctx);

        expect(ctx.abort).toBeUndefined();
    });

    it('reads the header from the browser request, not from the allowlisted set forwarded to the backend', async () =>
    {
        const ctx = requestContext({ sessionCookie: session.cookie, header: validToken });

        // Precondition: the forwarded set is what buildProxyHeaders() built, and
        // the CSRF header is not on its allowlist.
        expect(ctx.headers[CSRF_HEADER]).toBeUndefined();

        await run(ctx);

        expect(ctx.abort).toBeUndefined();
        // Still proxy-terminated: nothing added it to the backend request either.
        expect(ctx.headers[CSRF_HEADER]).toBeUndefined();
    });
});

describe('CSRF - requests the proxy does not cookie-authenticate', () =>
{
    // enforce throughout: these callers must be untouched at the strictest setting.
    beforeEach(() =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        setMode('enforce');
    });

    afterEach(() =>
    {
        setMode(undefined);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    /**
     * Credentials that reach the proxy in something other than the session cookie.
     *
     * These are the shapes representable at this layer: a header the caller
     * supplied and no session cookie. What kind of credential it is — direct
     * bearer, ops token, machine token, clientProofV1 — is the backend's business;
     * the proxy's only question is whether it authenticated the request itself.
     */
    const NON_COOKIE_CREDENTIALS: Array<[string, Record<string, string>]> = [
        ['a direct bearer token', { Authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.body.sig' }],
        ['an ops token', { Authorization: 'Bearer spfn_ops_0123456789abcdef' }],
        ['a machine token', { Authorization: 'Bearer spfn_machine_0123456789abcdef' }],
        ['a clientProofV1 mobile caller', { 'X-Client-Proof': 'v1.key-mobile.sig', 'X-Key-Id': 'key-mobile' }],
    ];

    it.each(NON_COOKIE_CREDENTIALS)('leaves %s byte-identical', async (_label, credential) =>
    {
        const ctx = requestContext({});
        Object.assign(ctx.headers, credential);

        const headersBefore = { ...ctx.headers };
        const bodyBefore = ctx.body;

        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        expect(ctx.headers).toEqual(headersBefore);
        expect(ctx.body).toBe(bodyBefore);
        // Nothing was learned about the caller, so nothing was recorded about them
        expect(ctx.metadata).toEqual({});
    });

    it('does not log a CSRF line for any of them', async () =>
    {
        const warn = vi.spyOn(authLogger.interceptor.csrf, 'warn');
        const error = vi.spyOn(authLogger.interceptor.csrf, 'error');

        for (const [, credential] of NON_COOKIE_CREDENTIALS)
        {
            const ctx = requestContext({});
            Object.assign(ctx.headers, credential);
            await run(ctx);
        }

        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });
});

describe('CSRF - a deployment that cannot derive the token', () =>
{
    let session: { data: SessionData; cookie: string };

    beforeEach(async () =>
    {
        // Reachable in production, not just in a test: getSessionSecretKey() hashes
        // whatever it is given, so with SKIP_ENV_VALIDATION and no secret the proxy
        // still unseals sessions happily — it is only the CSRF subkey derivation
        // that refuses. A deployment in exactly that state looks healthy.
        vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
        vi.stubEnv('SESSION_SECRET', '');
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', '');
        session = await makeSession();
    });

    afterEach(() =>
    {
        setMode(undefined);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it.each(['warn', 'enforce'] as CsrfMode[])('refuses a mutation in %s mode, and says why once', async (mode) =>
    {
        // warn is the DEFAULT. Degrading a configuration error into "invalid token"
        // and then letting warn wave it through leaves a misconfigured deployment
        // silently unprotected, with logs indistinguishable from a healthy one's.
        setMode(mode);
        const error = vi.spyOn(authLogger.interceptor.csrf, 'error');
        const warn = vi.spyOn(authLogger.interceptor.csrf, 'warn');

        const ctx = requestContext({ sessionCookie: session.cookie });
        const { continued } = await run(ctx);

        expect(ctx.abort).toEqual({
            status: 403,
            body: { error: 'Forbidden', message: 'CSRF token missing or invalid' },
            setCookies: [],
        });
        expect(continued).toBe(false);
        expect(error).toHaveBeenCalledTimes(1);
        // A distinct line: this is not "the caller sent the wrong token"
        expect(String(error.mock.calls[0][0])).toContain('regardless of mode');
        expect(warn).not.toHaveBeenCalled();
    });

    it('refuses even when the caller presents a well-formed token', async () =>
    {
        setMode('warn');

        const ctx = requestContext({ sessionCookie: session.cookie, header: 'a'.repeat(64) });

        await run(ctx);

        expect(ctx.abort?.status).toBe(403);
    });

    it('issues no cookie on that refusal — there is no value to issue', async () =>
    {
        setMode('enforce');

        const ctx = requestContext({ sessionCookie: session.cookie });

        await run(ctx);

        expect(ctx.abort?.setCookies).toEqual([]);
    });

    it('still honours `off`, the documented way to turn the check away', async () =>
    {
        setMode('off');

        const ctx = requestContext({ sessionCookie: session.cookie });
        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
    });
});

describe('CSRF - the refusal repairs the browser', () =>
{
    let session: { data: SessionData; cookie: string };

    beforeEach(async () =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        setMode('enforce');
        session = await makeSession();
    });

    afterEach(() =>
    {
        setMode(undefined);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('carries a fresh, correct CSRF cookie on the 403, so the retry succeeds', async () =>
    {
        // A refusal skips the backend and every response interceptor, so this is
        // the only chance to hand the browser what the next attempt needs.
        const refused = requestContext({ sessionCookie: session.cookie });

        await run(refused);

        const cookie = refused.abort!.setCookies!.find(c => c.name === COOKIE_NAMES.CSRF)!;

        expect(cookie.value).toBe(await deriveCsrfToken(session.data.keyId));

        // Replay the same mutation with what the refusal handed back
        const retried = requestContext({ sessionCookie: session.cookie, header: cookie.value });
        const { continued } = await run(retried);

        expect(retried.abort).toBeUndefined();
        expect(continued).toBe(true);
    });

    it('still refuses with 403 when the cookie cannot be built', async () =>
    {
        // The TTL the reissued cookie needs is parsed from configuration and
        // throws on a malformed value. Attaching the repair therefore happens
        // after `abort` is already set: generalAuthInterceptor catches whatever
        // this throws and calls next() anyway, so a refusal built the other way
        // round would evaporate and the caller would get the backend's answer
        // instead of this 403. The chain continuing is fine — the proxy returns
        // `abort` if it is set, and nothing on this path added an Authorization
        // header for the backend to honour.
        configureAuth({ sessionTtl: 'a fortnight' });

        const ctx = requestContext({ sessionCookie: session.cookie });

        try
        {
            await run(ctx);

            expect(ctx.abort?.status).toBe(403);
            expect(ctx.abort?.setCookies ?? []).toHaveLength(0);
            expect(ctx.headers['Authorization']).toBeUndefined();
        }
        finally
        {
            configureAuth({ sessionTtl: undefined });
        }
    });

    it('does not weaken the refusal — still 403, same body', async () =>
    {
        const ctx = requestContext({ sessionCookie: session.cookie, header: 'wrong' });

        const { continued } = await run(ctx);

        expect(ctx.abort?.status).toBe(403);
        expect(ctx.abort?.body).toEqual({ error: 'Forbidden', message: 'CSRF token missing or invalid' });
        expect(continued).toBe(false);
        expect(ctx.headers['Authorization']).toBeUndefined();
    });

    it('issues it readable, and mirroring the session cookie otherwise', async () =>
    {
        const ctx = requestContext({ sessionCookie: session.cookie });

        await run(ctx);

        const options = ctx.abort!.setCookies![0].options!;

        expect(options.httpOnly).toBe(false);
        expect(options.sameSite).toBe('lax');
        expect(options.path).toBe('/');
        expect(options.maxAge).toBeGreaterThan(0);
    });

    it('reveals nothing a cross-site attacker could use', async () =>
    {
        // The value is derived from the session the attacker cannot read, and the
        // browser will not store a SameSite=Lax cookie from a cross-site
        // subresource response — but even if it did, the attacker's origin cannot
        // read the victim's jar. What must not appear here is the key id itself.
        const ctx = requestContext({ sessionCookie: session.cookie });

        await run(ctx);

        expect(JSON.stringify(ctx.abort)).not.toContain(session.data.keyId);
    });
});

describe('CSRF - modes', () =>
{
    let session: { data: SessionData; cookie: string };

    beforeEach(async () =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        session = await makeSession();
    });

    afterEach(() =>
    {
        setMode(undefined);
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('warn mode lets the request through and logs exactly one line', async () =>
    {
        setMode('warn');
        const warn = vi.spyOn(authLogger.interceptor.csrf, 'warn');

        const ctx = requestContext({ sessionCookie: session.cookie });
        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('off mode is silent', async () =>
    {
        setMode('off');
        const warn = vi.spyOn(authLogger.interceptor.csrf, 'warn');

        const ctx = requestContext({ sessionCookie: session.cookie });
        const { continued } = await run(ctx);

        expect(ctx.abort).toBeUndefined();
        expect(continued).toBe(true);
        expect(warn).not.toHaveBeenCalled();
    });

    it('the log never carries the token or the key id it derives from', async () =>
    {
        setMode('enforce');
        const warn = vi.spyOn(authLogger.interceptor.csrf, 'warn');

        await run(requestContext({ sessionCookie: session.cookie, header: 'wrong' }));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls[0])).not.toContain(session.data.keyId);
    });

    it('defaults to warn when nothing is configured', () =>
    {
        setMode(undefined);

        expect(getCsrfMode()).toBe('warn');
    });

    it('falls back to SPFN_AUTH_CSRF, case-insensitively', () =>
    {
        setMode(undefined);
        vi.stubEnv('SPFN_AUTH_CSRF', ' Enforce ');

        expect(getCsrfMode()).toBe('enforce');
    });

    it('configureAuth wins over the environment', () =>
    {
        setMode('off');
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');

        expect(getCsrfMode()).toBe('off');
    });

    it('a misspelled mode enforces rather than silently dropping protection, and says so once', () =>
    {
        setMode(undefined);
        vi.stubEnv('SPFN_AUTH_CSRF', 'enfoce');
        const error = vi.spyOn(authLogger.interceptor.csrf, 'error');

        expect(getCsrfMode()).toBe('enforce');
        expect(getCsrfMode()).toBe('enforce');

        // A typo in the setting is deployment-wide, and this runs on every
        // mutation: the notice belongs to the process, not to the request.
        expect(error).toHaveBeenCalledTimes(1);
    });
});

describe('CSRF - token derivation', () =>
{
    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('is stable per key id and differs between key ids', async () =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');

        expect(await deriveCsrfToken('key-a')).toBe(await deriveCsrfToken('key-a'));
        expect(await deriveCsrfToken('key-a')).not.toBe(await deriveCsrfToken('key-b'));
        expect(await deriveCsrfToken('key-a')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes with the session secret, and never reveals it', async () =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        const first = await deriveCsrfToken('key-a');

        vi.stubEnv('SESSION_SECRET', 'another-secret-with-at-least-32-characters-for-testing-here');
        const second = await deriveCsrfToken('key-a');

        expect(first).not.toBe(second);
        expect(first).not.toContain('test-secret');
    });

    it('refuses to derive anything without a session secret, rather than hashing nothing', async () =>
    {
        // SKIP_ENV_VALIDATION is what makes this reachable: the env layer stops
        // throwing and hands back undefined, which would otherwise hash to a value
        // every deployment could compute.
        vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
        vi.stubEnv('SESSION_SECRET', '');
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', '');

        await expect(deriveCsrfToken('key-a')).rejects.toThrow(/SPFN_AUTH_SESSION_SECRET is required/);
    });

    it('compares in constant time, without an early exit on the first differing character', () =>
    {
        const token = 'a'.repeat(64);

        expect(timingSafeEqualString(token, token)).toBe(true);
        expect(timingSafeEqualString(token, `b${token.slice(1)}`)).toBe(false);
        expect(timingSafeEqualString(token, token.slice(0, 63))).toBe(false);
    });

    it('is not on the package barrel, where it would shadow node\'s Buffer-based one', async () =>
    {
        // @spfn/auth uses node:crypto's timingSafeEqual in the OAuth providers.
        // Two exports of that name, one taking strings and one taking Buffers, is
        // a call-site waiting to pass the wrong type to the wrong one.
        const barrel = await import('../../server/lib/index');

        expect('timingSafeEqualString' in barrel).toBe(false);
        expect('timingSafeEqual' in barrel).toBe(false);
        expect(barrel.deriveCsrfToken).toBeTypeOf('function');
        expect(barrel.matchesCsrfToken).toBeTypeOf('function');
    });
});

describe('CSRF - readable cookie', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    function responseContext(overrides: Partial<ResponseInterceptorContext>): ResponseInterceptorContext
    {
        return {
            path: '/_auth/login',
            method: 'POST',
            request: { headers: {} },
            response: { ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: {} },
            cookies: new Map(),
            setCookies: [],
            metadata: {},
            ...overrides,
        } as ResponseInterceptorContext;
    }

    it('is set when a session is established, readable, and mirrors the session cookie', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const ctx = responseContext({
            response: { ok: true, status: 200, statusText: 'OK', headers: new Headers(), body: { userId: 'user-1' } },
            metadata: {
                newPrivateKey: keyPair.privateKey,
                newKeyId: keyPair.keyId,
                newAlgorithm: keyPair.algorithm,
            },
        });

        await loginRegisterInterceptor.response!(ctx, noop);

        const sessionCookie = ctx.setCookies.find(c => c.name === COOKIE_NAMES.SESSION)!;
        const csrfCookie = ctx.setCookies.find(c => c.name === COOKIE_NAMES.CSRF)!;

        expect(csrfCookie.value).toBe(await deriveCsrfToken(keyPair.keyId));
        expect(csrfCookie.value).not.toContain(keyPair.keyId);
        expect(csrfCookie.options?.httpOnly).toBe(false);
        expect(csrfCookie.options?.sameSite).toBe(sessionCookie.options?.sameSite);
        expect(csrfCookie.options?.secure).toBe(sessionCookie.options?.secure);
        expect(csrfCookie.options?.path).toBe(sessionCookie.options?.path);
        expect(csrfCookie.options?.maxAge).toBe(sessionCookie.options?.maxAge);
    });

    it('is renewed whenever the proxy renews the session', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const ctx = responseContext({
            path: '/orders',
            metadata: {
                refreshSession: true,
                sessionData: {
                    userId: 'user-1',
                    privateKey: keyPair.privateKey,
                    keyId: keyPair.keyId,
                    algorithm: keyPair.algorithm,
                },
            },
        });

        await generalAuthInterceptor.response!(ctx, noop);

        const csrfCookie = ctx.setCookies.find(c => c.name === COOKIE_NAMES.CSRF)!;

        expect(csrfCookie.value).toBe(await deriveCsrfToken(keyPair.keyId));
    });

    it('is reissued, bound to the new key id, when the proxy rotates the session key', async () =>
    {
        // Rotation is what invalidates the old token, so the response that
        // rotates has to carry the replacement — otherwise rotating a key logs
        // the user out of every mutation until the session is renewed.
        const rotated = generateKeyPair('ES256');
        const ctx = responseContext({
            path: '/_auth/keys/rotate',
            metadata: {
                userId: 'user-1',
                newPrivateKey: rotated.privateKey,
                newKeyId: rotated.keyId,
                newAlgorithm: rotated.algorithm,
            },
        });

        await keyRotationInterceptor.response!(ctx, noop);

        const sessionCookie = ctx.setCookies.find(c => c.name === COOKIE_NAMES.SESSION)!;
        const csrfCookie = ctx.setCookies.find(c => c.name === COOKIE_NAMES.CSRF)!;

        expect(csrfCookie.value).toBe(await deriveCsrfToken(rotated.keyId));
        expect(csrfCookie.options?.httpOnly).toBe(false);
        expect(csrfCookie.options?.maxAge).toBe(sessionCookie.options?.maxAge);
    });

    it('is issued to a session that predates CSRF protection, on its first authenticated response', async () =>
    {
        // Otherwise everyone already signed in would be refused every mutation
        // until their session came within a day of expiry.
        const keyPair = generateKeyPair('ES256');
        const ctx = responseContext({
            path: '/orders',
            method: 'GET',
            metadata: { sessionValid: true, keyId: keyPair.keyId },
        });

        await generalAuthInterceptor.response!(ctx, noop);

        expect(ctx.setCookies.find(c => c.name === COOKIE_NAMES.CSRF)?.value)
            .toBe(await deriveCsrfToken(keyPair.keyId));
    });

    it('is not re-issued when the request already carried the right one', async () =>
    {
        const ctx = responseContext({
            path: '/orders',
            method: 'GET',
            cookies: new Map([[COOKIE_NAMES.CSRF, await deriveCsrfToken('key-1')]]),
            metadata: { sessionValid: true, keyId: 'key-1' },
        });

        await generalAuthInterceptor.response!(ctx, noop);

        expect(ctx.setCookies).toHaveLength(0);
    });

    it('is re-issued when the request carried a stale one', async () =>
    {
        // The recovery path the docs promise. A cookie that is merely *present*
        // is not proof it is right: a key rotated somewhere that did not reissue,
        // or a jar an extension half-cleared, leaves a value that will be refused
        // on every mutation. Treating present-as-correct left that broken until
        // the session came within a day of expiry.
        const ctx = responseContext({
            path: '/orders',
            method: 'GET',
            cookies: new Map([[COOKIE_NAMES.CSRF, 'stale-from-a-previous-key']]),
            metadata: { sessionValid: true, keyId: 'key-1' },
        });

        await generalAuthInterceptor.response!(ctx, noop);

        expect(ctx.setCookies.find(c => c.name === COOKIE_NAMES.CSRF)?.value)
            .toBe(await deriveCsrfToken('key-1'));
    });

    it('does not turn an underivable token into a 500 on every authenticated response', async () =>
    {
        // The request side already refuses these (fail closed). The response side
        // has nothing useful to add by throwing out of the interceptor chain.
        vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
        vi.stubEnv('SESSION_SECRET', '');
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', '');
        const error = vi.spyOn(authLogger.interceptor.csrf, 'error');

        const ctx = responseContext({
            path: '/orders',
            method: 'GET',
            metadata: { sessionValid: true, keyId: 'key-1' },
        });

        await expect(generalAuthInterceptor.response!(ctx, noop)).resolves.toBeUndefined();

        expect(ctx.setCookies).toHaveLength(0);
        expect(error).toHaveBeenCalledTimes(1);
    });

    it('is not re-issued after logout cleared it', async () =>
    {
        const ctx = responseContext({ path: '/_auth/logout', metadata: { sessionValid: true, keyId: 'key-1' } });

        await generalAuthInterceptor.response!(ctx, noop);

        const csrfCookies = ctx.setCookies.filter(c => c.name === COOKIE_NAMES.CSRF);

        expect(csrfCookies).toHaveLength(1);
        expect(csrfCookies[0].value).toBe('');
    });

    it('is cleared on logout, alongside the session', async () =>
    {
        const ctx = responseContext({ path: '/_auth/logout' });

        await generalAuthInterceptor.response!(ctx, noop);

        const csrfCookie = ctx.setCookies.find(c => c.name === COOKIE_NAMES.CSRF)!;

        expect(csrfCookie.value).toBe('');
        expect(csrfCookie.options?.maxAge).toBe(0);
    });
});
