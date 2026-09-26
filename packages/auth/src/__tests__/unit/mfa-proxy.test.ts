/**
 * @spfn/auth - the proxy half of new-device step-up (design #95, case table 6e)
 *
 * One `it` per row, driving the interceptors and the OAuth callback handler
 * directly with a hand-built context — the way `oauth-callback-handler.test.ts`
 * and `session-binding-proxy.test.ts` drive theirs. No database and no backend:
 * what these rows are about is what the Next.js proxy does with a 202 it was
 * handed and a cookie it baked itself.
 *
 * Every cookie here is real. The pending cookies are produced by
 * `sealPendingMfaSession`/`sealPendingSession` and read back through the
 * interceptor, and the sessions by `sealSession`/`unsealSession`, so a row that
 * says "the two do not overwrite each other" is asserting what is actually in
 * the two JWEs rather than what a stub agreed to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

const pendingOAuthCookie = { value: '' };

vi.mock('next/headers.js', () => ({
    cookies: async () => ({
        get: (name: string) =>
            (name.startsWith('spfn_oauth_pending') ? { name, value: pendingOAuthCookie.value } : undefined),
    }),
}));

import { NextRequest } from 'next/server';

import { loginRegisterInterceptor } from '../../nextjs/interceptors/login-register';
import { mfaVerifyInterceptor } from '../../nextjs/interceptors/mfa-verify';
import { oauthFinalizeInterceptor, oauthUrlInterceptor } from '../../nextjs/interceptors/oauth';
import { authInterceptors } from '../../nextjs/interceptors';
import { createOAuthCallbackHandler } from '../../nextjs/oauth-handlers';
import { runOAuthCallback } from '../../nextjs/components/oauth-callback-flow';
import { sealPendingMfaSession, sealPendingSession, unsealPendingMfaSession } from '../../nextjs/session-helpers';
import { unsealSession, type SessionData } from '../../server/lib/session';
import { hashCredential } from '../../server/lib/link-credentials';
import { generateKeyPair } from '../../server/lib/crypto';
import { COOKIE_NAMES } from '../../server/lib/config';
import { authErrorRegistry, SessionPendingMismatchError } from '../../errors';
import { routeMap } from '../../generated/route-map';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const APP = 'https://app.example';
const CHALLENGE = 'challenge-secret-that-is-long-enough-to-pass';
const OTHER_CHALLENGE = 'a-different-challenge-secret-entirely-here';

function responseContext(
    path: string,
    status: number,
    body: unknown,
    options: { cookies?: Map<string, string>; metadata?: Record<string, unknown> } = {},
): ResponseInterceptorContext
{
    return {
        path,
        method: 'POST',
        request: { headers: {}, body: {} },
        response: { ok: status < 400, status, statusText: '', headers: new Headers(), body },
        cookies: options.cookies ?? new Map(),
        setCookies: [] as SetCookie[],
        metadata: options.metadata ?? {},
    } as unknown as ResponseInterceptorContext;
}

const next = async (): Promise<void> => undefined;

/** The device key the proxy minted for a sign-in. */
function mintedKey(): Record<string, unknown>
{
    const keyPair = generateKeyPair('ES256');

    return { privateKey: keyPair.privateKey, keyId: keyPair.keyId, algorithm: keyPair.algorithm };
}

/**
 * That key as shared metadata holds it.
 *
 * `loginRegisterInterceptor` reserves the `new` names for the credentials it is
 * installing: `generalAuthInterceptor` matches the same requests and writes the
 * *inbound* session's `keyId`, so the two may not share a name (#99).
 */
function asMintedMetadata(key: Record<string, unknown>): Record<string, unknown>
{
    return { newPrivateKey: key.privateKey, newKeyId: key.keyId, newAlgorithm: key.algorithm };
}

/** What a sign-in that was stopped for a second factor answers with. */
function stepUpBody(secret = CHALLENGE): Record<string, unknown>
{
    return { mfaRequired: true, challenge: { secret, expiresAtMillis: Date.now() + 600_000 } };
}

/** What `verify` answers with, as the interceptor reads it. */
function verifiedBody(keyId: string, secret = CHALLENGE): Record<string, unknown>
{
    return { mfaRequired: false, userId: '7', keyId, challengeHash: hashCredential(secret) };
}

function cookieNamed(setCookies: SetCookie[], name: string): SetCookie | undefined
{
    return [...setCookies].reverse().find(entry => entry.name === name);
}

async function queuedSession(setCookies: SetCookie[]): Promise<SessionData>
{
    return await unsealSession(cookieNamed(setCookies, COOKIE_NAMES.SESSION)!.value);
}

describe('the proxy and a second-factor step-up (case table 6e)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        pendingOAuthCookie.value = '';
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('row: login 200 — today\'s behaviour, the session is sealed by loginRegisterInterceptor', async () =>
    {
        const key = mintedKey();
        const ctx = responseContext('/_auth/login', 200, { userId: '7' }, { metadata: asMintedMetadata(key) });

        await loginRegisterInterceptor.response?.(ctx, next);
        await mfaVerifyInterceptor.response?.(ctx, next);

        expect((await queuedSession(ctx.setCookies)).keyId).toBe(key.keyId);
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.MFA_PENDING)).toBeUndefined();
    });

    it('row: login 202 — loginRegisterInterceptor is untouched and seals nothing; mfaVerifyInterceptor bakes the pending cookie', async () =>
    {
        const key = mintedKey();
        const ctx = responseContext('/_auth/login', 202, stepUpBody(), { metadata: asMintedMetadata(key) });

        // The existing non-200 early return is what leaves the body here to read.
        // Nothing in that rule changed for #95.
        await loginRegisterInterceptor.response?.(ctx, next);

        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();

        await mfaVerifyInterceptor.response?.(ctx, next);

        const pending = cookieNamed(ctx.setCookies, COOKIE_NAMES.MFA_PENDING)!;
        const unsealed = await unsealPendingMfaSession(pending.value);

        expect(pending.options?.maxAge).toBe(600);
        expect(pending.options?.httpOnly).toBe(true);
        expect(unsealed).toMatchObject({ keyId: key.keyId, challengeHash: hashCredential(CHALLENGE) });
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();
    });

    it('row: verify 200 with a matching cookie — the session is sealed and the pending cookie expires', async () =>
    {
        const key = mintedKey();
        const cookies = new Map([[COOKIE_NAMES.MFA_PENDING, await sealPendingMfaSession({
            privateKey: key.privateKey as string,
            keyId: key.keyId as string,
            algorithm: key.algorithm as 'ES256',
            challengeHash: hashCredential(CHALLENGE),
        })]]);
        const ctx = responseContext('/_auth/mfa/verify', 200, verifiedBody(key.keyId as string), { cookies });

        await mfaVerifyInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(200);
        expect(await queuedSession(ctx.setCookies)).toMatchObject({ userId: '7', keyId: key.keyId });
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION_KEY_ID)?.value).toBe(key.keyId);
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.CSRF)).toBeDefined();
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.MFA_PENDING)?.options?.maxAge).toBe(0);
    });

    it('row: verify 200 whose challengeHash does not match the cookie — no session, the SESSION_PENDING_MISMATCH envelope', async () =>
    {
        const key = mintedKey();
        const cookies = new Map([[COOKIE_NAMES.MFA_PENDING, await sealPendingMfaSession({
            privateKey: key.privateKey as string,
            keyId: key.keyId as string,
            algorithm: key.algorithm as 'ES256',
            challengeHash: hashCredential(OTHER_CHALLENGE),
        })]]);
        const ctx = responseContext('/_auth/mfa/verify', 200, verifiedBody(key.keyId as string), { cookies });

        await mfaVerifyInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(401);
        expect(ctx.response.body).toMatchObject({
            __type: 'SessionPendingMismatchError',
            error: { code: 'SessionPendingMismatchError' },
        });
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();

        // The key really is active at the backend — what failed is this browser's
        // claim to be the one that asked — so the app is told to sign in again
        // through an error class it can restore.
        expect(authErrorRegistry.tryDeserialize(ctx.response.body as Record<string, unknown>))
            .toBeInstanceOf(SessionPendingMismatchError);
    });

    it('row: verify 200 whose keyId does not match the cookie — the same refusal, no session', async () =>
    {
        const key = mintedKey();
        const cookies = new Map([[COOKIE_NAMES.MFA_PENDING, await sealPendingMfaSession({
            privateKey: key.privateKey as string,
            keyId: key.keyId as string,
            algorithm: key.algorithm as 'ES256',
            challengeHash: hashCredential(CHALLENGE),
        })]]);
        const ctx = responseContext('/_auth/mfa/verify', 200, verifiedBody('some-other-key-id'), { cookies });

        await mfaVerifyInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(401);
        expect(ctx.response.body).toMatchObject({ __type: 'SessionPendingMismatchError' });
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();
    });

    it('row: verify 401 — passed through untouched, and the pending cookie stays', async () =>
    {
        const key = mintedKey();
        const sealed = await sealPendingMfaSession({
            privateKey: key.privateKey as string,
            keyId: key.keyId as string,
            algorithm: key.algorithm as 'ES256',
            challengeHash: hashCredential(CHALLENGE),
        });
        const ctx = responseContext('/_auth/mfa/verify', 401, { __type: 'MfaVerificationFailedError' }, {
            cookies: new Map([[COOKIE_NAMES.MFA_PENDING, sealed]]),
        });

        await mfaVerifyInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(401);
        expect(ctx.response.body).toMatchObject({ __type: 'MfaVerificationFailedError' });
        expect(ctx.setCookies).toEqual([]);
    });

    it('row: verify 200 with no pending cookie, ten minutes having passed — the SESSION_PENDING_EXPIRED envelope', async () =>
    {
        const ctx = responseContext('/_auth/mfa/verify', 200, verifiedBody('a-key-id'));

        await mfaVerifyInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(401);
        expect(ctx.response.body).toMatchObject({
            __type: 'SessionPendingExpiredError',
            error: { code: 'SessionPendingExpiredError' },
        });
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();
    });

    it('row: an OAuth start in another tab while a 202 is outstanding — both pending cookies coexist', async () =>
    {
        const key = mintedKey();
        const stepUp = responseContext('/_auth/login', 202, stepUpBody(), { metadata: asMintedMetadata(key) });

        await mfaVerifyInterceptor.response?.(stepUp, next);

        const oauth = responseContext('/_auth/oauth/google/url', 200, { authUrl: 'https://provider.example/auth' }, {
            metadata: { pendingSession: mintedKey() },
        });

        await oauthUrlInterceptor.response?.(oauth, next);

        const mfaPending = cookieNamed(stepUp.setCookies, COOKIE_NAMES.MFA_PENDING)!;
        const oauthPending = cookieNamed(oauth.setCookies, COOKIE_NAMES.OAUTH_PENDING)!;

        expect(mfaPending.name).not.toBe(oauthPending.name);

        // Separate audiences and separate derived keys, so neither opens as the
        // other — which is what stops the second flow sealing a session around
        // the first flow's key.
        await expect(unsealPendingMfaSession(oauthPending.value)).rejects.toThrow();
        expect(await unsealPendingMfaSession(mfaPending.value)).toMatchObject({ keyId: key.keyId });
    });

    it('row: the callback carries mfaChallenge — the handler redirects to the mfa page, keeping the pending cookie', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        pendingOAuthCookie.value = await sealPendingSession({
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
        });

        const url = new URL('/api/auth/callback', APP);
        url.searchParams.set('mfaChallenge', CHALLENGE);
        url.searchParams.set('returnUrl', '/dashboard');

        const handler = createOAuthCallbackHandler({ mfaPath: '/auth/two-factor' });
        const response = await handler(new NextRequest(url));
        const location = new URL(response.headers.get('location')!);

        expect(location.pathname).toBe('/auth/two-factor');
        expect(location.searchParams.get('challenge')).toBe(CHALLENGE);
        expect(location.searchParams.get('returnUrl')).toBe('/dashboard');

        // No session, and nothing expired: the pending cookie holds the private
        // half of the key the challenge would activate.
        expect(response.headers.getSetCookie()).toEqual([]);
    });

    it('row: oauthFinalize answers 202 for an mfaChallenge — passed through unsealed, and the pending cookie is baked', async () =>
    {
        const key = mintedKey();
        const cookies = new Map([[COOKIE_NAMES.OAUTH_PENDING, await sealPendingSession({
            privateKey: key.privateKey as string,
            keyId: key.keyId as string,
            algorithm: key.algorithm as 'ES256',
        })]]);
        const ctx = responseContext('/_auth/oauth/finalize', 202, {
            success: true,
            mfaRequired: true,
            challenge: CHALLENGE,
            returnUrl: '/',
        }, { cookies });

        await oauthFinalizeInterceptor.response?.(ctx, next);

        expect(ctx.response.status).toBe(202);
        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();

        await mfaVerifyInterceptor.response?.(ctx, next);

        const pending = cookieNamed(ctx.setCookies, COOKIE_NAMES.MFA_PENDING)!;

        expect(await unsealPendingMfaSession(pending.value)).toMatchObject({
            keyId: key.keyId,
            challengeHash: hashCredential(CHALLENGE),
        });
    });

    it('row: password/reset/complete answers 202 — no session, the pending cookie instead', async () =>
    {
        const key = mintedKey();
        const ctx = responseContext('/_auth/password/reset/complete', 202, stepUpBody(), { metadata: asMintedMetadata(key) });

        await loginRegisterInterceptor.response?.(ctx, next);
        await mfaVerifyInterceptor.response?.(ctx, next);

        expect(cookieNamed(ctx.setCookies, COOKIE_NAMES.SESSION)).toBeUndefined();
        expect(await unsealPendingMfaSession(cookieNamed(ctx.setCookies, COOKIE_NAMES.MFA_PENDING)!.value))
            .toMatchObject({ keyId: key.keyId });
    });

    it('is registered immediately after loginRegisterInterceptor, which is what leaves the 202 body to read', () =>
    {
        const order = authInterceptors.indexOf(mfaVerifyInterceptor);

        expect(order).toBe(authInterceptors.indexOf(loginRegisterInterceptor) + 1);
    });

    it('the generated route map carries both verify routes, so authApi can call them', () =>
    {
        // The generator parses only the files `routes/index.ts` imports, so a new
        // route file that is not imported there produces a client method that
        // silently does not exist. This is the assertion that would catch it.
        expect(routeMap.mfaVerify).toEqual({ method: 'POST', path: '/_auth/mfa/verify' });
        expect(routeMap.mfaVerifyOptions).toEqual({ method: 'POST', path: '/_auth/mfa/verify/options' });
    });
});

describe('the confirm path on the oauthFinalize 202 (#107)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        pendingOAuthCookie.value = '';
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    function finalizeChallengeBody(): Record<string, unknown>
    {
        return { success: true, mfaRequired: true, challenge: CHALLENGE, returnUrl: '/' };
    }

    /** The body `mfaVerifyInterceptor` leaves on an answer, after it ran. */
    async function bodyAfter(path: string, status: number, body: unknown): Promise<unknown>
    {
        const ctx = responseContext(path, status, body, { metadata: asMintedMetadata(mintedKey()) });

        await mfaVerifyInterceptor.response?.(ctx, next);

        return ctx.response.body;
    }

    /** Where `createOAuthCallbackHandler`, with no option, sends a callback carrying a challenge. */
    async function handlerRedirectPath(): Promise<string>
    {
        const url = new URL('/api/auth/callback', APP);
        url.searchParams.set('mfaChallenge', CHALLENGE);

        const response = await createOAuthCallbackHandler()(new NextRequest(url));

        return new URL(response.headers.get('location')!).pathname;
    }

    it('env unset: the 202 carries /auth/mfa', async () =>
    {
        expect(await bodyAfter('/_auth/oauth/finalize', 202, finalizeChallengeBody()))
            .toEqual({ ...finalizeChallengeBody(), mfaPath: '/auth/mfa' });
    });

    it('env /signin/2fa: the 202 carries it, and the callback page navigates there', async () =>
    {
        vi.stubEnv('SPFN_AUTH_MFA_CONFIRM_PATH', '/signin/2fa');

        const body = await bodyAfter('/_auth/oauth/finalize', 202, finalizeChallengeBody());

        expect(body).toEqual({ ...finalizeChallengeBody(), mfaPath: '/signin/2fa' });

        const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 202 }));
        const outcome = await runOAuthCallback(`?mfaChallenge=${CHALLENGE}`, { apiBasePath: '/api/rpc', fetch: fetchStub });

        expect(outcome).toEqual({ kind: 'navigate', to: `/signin/2fa?challenge=${CHALLENGE}&returnUrl=%2F` });
    });

    it.each([
        ['/signin/2fa', '/signin/2fa'],
        ['https://evil.test/p', '/p'],
    ])('env %s: createOAuthCallbackHandler and the interceptor agree on %s', async (configured, expected) =>
    {
        vi.stubEnv('SPFN_AUTH_MFA_CONFIRM_PATH', configured);

        const body = await bodyAfter('/_auth/oauth/finalize', 202, finalizeChallengeBody()) as { mfaPath: string };

        expect(body.mfaPath).toBe(expected);
        expect(await handlerRedirectPath()).toBe(expected);
    });

    it.each([
        ['login 202', '/_auth/login', 202, stepUpBody()],
        ['password/reset/complete 202', '/_auth/password/reset/complete', 202, stepUpBody()],
        ['oauth native 202', '/_auth/oauth/google/native', 202, stepUpBody()],
        ['finalize 200', '/_auth/oauth/finalize', 200, { success: true, mfaRequired: false, userId: '7', keyId: 'k', returnUrl: '/' }],
        ['finalize 202 without mfaRequired', '/_auth/oauth/finalize', 202, { success: true, challenge: CHALLENGE }],
        ['finalize 400', '/_auth/oauth/finalize', 400, { message: 'returnUrl must be a relative path within the app' }],
        ['verify 401', '/_auth/mfa/verify', 401, { message: 'Invalid code' }],
    ])('%s: the body passes through unchanged', async (_name, path, status, body) =>
    {
        vi.stubEnv('SPFN_AUTH_MFA_CONFIRM_PATH', '/signin/2fa');

        expect(await bodyAfter(path, status, structuredClone(body))).toEqual(body);
    });
});
