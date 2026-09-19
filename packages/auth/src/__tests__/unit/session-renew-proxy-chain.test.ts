/**
 * @spfn/auth - renewing a bound session through the real interceptor chain (#99)
 *
 * The sibling suite `session-binding-proxy.test.ts` drives one interceptor at a
 * time, which is precisely why it could not see this: `POST
 * /_auth/session/renew/verify` matches *two* registered rules, and the defect
 * lives in what they both write to the one `metadata` object the proxy shares
 * between them. So these rows go through `filterMatchingInterceptors` and the two
 * chain executors — the same three functions `createRpcProxy` calls — against the
 * shipped `authInterceptors` array in its shipped order. Nothing here names an
 * interceptor it wants to run; the matcher decides, as it does in production.
 *
 * On beta.25 the first row fails: `loginRegisterInterceptor.request` stored the
 * replacement key under `metadata.keyId`, `generalAuthInterceptor.request`
 * overwrote it with the id of the expiring key it signs the request with, and the
 * response phase then sealed the new private key around the retired id. The
 * renewal answered 200 and the next request was a 401.
 *
 * There is no database and no backend here. The backend's half — an assertion it
 * refuses, a retired key it will not admit — is covered by
 * `integration/session-renewal.test.ts`, which owns those facts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

import { authInterceptors } from '../../nextjs/interceptors';
import { generalAuthInterceptor } from '../../nextjs/interceptors/general-auth';
import { sealSession, unsealSession } from '../../server/lib/session';
import { generateClientToken, generateKeyPair } from '../../server/lib/crypto';
import { verifyClientToken } from '../../server/helpers/jwt';
import { COOKIE_NAMES } from '../../server/lib/config';
import { CSRF_HEADER, deriveCsrfToken } from '../../server/lib/csrf';

const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const RENEW_VERIFY = '/_auth/session/renew/verify';

/** The session cookie's own life, well clear of the 24h refresh window. */
const SEVEN_DAYS = 7 * 24 * 3600;

/** The jar a browser carries for a bound session whose key has just run out. */
async function expiringJar(cookieTtlSeconds = SEVEN_DAYS): Promise<{ jar: Map<string, string>; keyId: string }>
{
    const keyPair = generateKeyPair('ES256');
    const sealed = await sealSession({
        userId: '7',
        privateKey: keyPair.privateKey,
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
        binding: 'passkey',
        keyExpiresAt: Date.now() - 1_000,
        uaFamily: 'chrome',
    }, cookieTtlSeconds);

    const jar = new Map([
        [COOKIE_NAMES.SESSION, sealed],
        [COOKIE_NAMES.SESSION_KEY_ID, keyPair.keyId],
        [COOKIE_NAMES.CSRF, await deriveCsrfToken(keyPair.keyId)],
    ]);

    return { jar, keyId: keyPair.keyId };
}

/** `buildRequestContext`'s shape, for the one request these rows care about. */
function requestContext(path: string, body: unknown, jar: Map<string, string>, csrf: string): RequestInterceptorContext
{
    return {
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' } as Record<string, string>,
        body,
        query: {},
        cookies: jar,
        request: { headers: new Headers({ 'user-agent': CHROME, [CSRF_HEADER]: csrf }) },
        metadata: {} as Record<string, unknown>,
    } as unknown as RequestInterceptorContext;
}

/** `buildResponseContext`'s shape — note that `metadata` is the request's own object. */
function responseContext(
    requestCtx: RequestInterceptorContext,
    status: number,
    body: unknown,
): ResponseInterceptorContext
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

/**
 * Run a request through every rule that matches it, then its answer back through
 * every rule that matches — exactly as `createRpcProxy` does, matcher included.
 *
 * `backend` is handed the request context the chain produced, so a row can answer
 * with the very key id the proxy just asked the backend to register.
 */
async function throughTheChain(
    path: string,
    body: unknown,
    jar: Map<string, string>,
    backend: (requestCtx: RequestInterceptorContext) => { status: number; body: unknown },
): Promise<{ requestCtx: RequestInterceptorContext; responseCtx: ResponseInterceptorContext }>
{
    const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');
    const requestCtx = requestContext(path, body, jar, jar.get(COOKIE_NAMES.CSRF) ?? '');

    await executeRequestInterceptors(
        requestCtx,
        matching.map(rule => rule.request).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    expect(requestCtx.abort).toBeUndefined();

    const answer = backend(requestCtx);
    const responseCtx = responseContext(requestCtx, answer.status, answer.body);

    await executeResponseInterceptors(
        responseCtx,
        matching.map(rule => rule.response).filter((phase): phase is NonNullable<typeof phase> => !!phase),
    );

    return { requestCtx, responseCtx };
}

/** What the renewal service answers on success, for the pair the proxy just minted. */
function renewedBody(requestCtx: RequestInterceptorContext): { status: number; body: unknown }
{
    return {
        status: 200,
        body: {
            mfaRequired: false,
            userId: '7',
            publicId: 'pub_7',
            keyId: (requestCtx.body as { keyId: string }).keyId,
            passwordChangeRequired: false,
            sessionBinding: 'passkey',
            keyExpiresAtMillis: Date.now() + 86_400_000,
        },
    };
}

/** The browser applying a `Set-Cookie` batch to the jar it already holds. */
function applyCookies(jar: Map<string, string>, setCookies: SetCookie[]): Map<string, string>
{
    const next = new Map(jar);

    for (const cookie of setCookies)
    {
        if (cookie.options?.maxAge === 0 || !cookie.value)
        {
            next.delete(cookie.name);
        }
        else
        {
            next.set(cookie.name, cookie.value);
        }
    }

    return next;
}

/** The last write of the session cookie — the one the browser keeps. */
function sessionCookie(setCookies: SetCookie[]): SetCookie | undefined
{
    return [...setCookies].reverse().find(cookie => cookie.name === COOKIE_NAMES.SESSION);
}

describe('a bound session renewing through the matching interceptor chain (#99)', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        // Enforce rather than the default `warn`, so the rows prove the renewal
        // survives the CSRF check a real browser meets rather than skirting it.
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('both rules match, and each writes its own credentials: the request is signed with the expiring key and asks for a different one', async () =>
    {
        const { jar, keyId: expiringKeyId } = await expiringJar();

        const { requestCtx } = await throughTheChain(RENEW_VERIFY, { response: {} }, jar, renewedBody);

        // Two rules matched — this is the collision's precondition, and the row
        // is worth nothing if the matcher ever stops producing it.
        expect(filterMatchingInterceptors(authInterceptors, RENEW_VERIFY, 'POST').length).toBeGreaterThan(1);

        const sent = requestCtx.body as { keyId: string; publicKey: string; algorithm: string };
        expect(requestCtx.headers['X-Key-Id']).toBe(expiringKeyId);
        expect(sent.keyId).not.toBe(expiringKeyId);
        expect(sent.algorithm).toBe('ES256');
    });

    it('seals the new private key with its own key id and algorithm, not the retired ones', async () =>
    {
        const { jar, keyId: expiringKeyId } = await expiringJar();

        const { requestCtx, responseCtx } = await throughTheChain(RENEW_VERIFY, { response: {} }, jar, renewedBody);

        const sent = requestCtx.body as { keyId: string; publicKey: string };
        const session = await unsealSession(sessionCookie(responseCtx.setCookies)!.value);

        expect(session.keyId).toBe(sent.keyId);
        expect(session.algorithm).toBe('ES256');
        expect(session.keyId).not.toBe(expiringKeyId);

        // The sealed private key really is the new pair's half: sign with it and
        // verify against the public key the backend was asked to register, which
        // is the check `authenticate` makes on the next request.
        const proof = verifyClientToken(
            generateClientToken(
                { userId: session.userId, keyId: session.keyId, timestamp: Date.now() },
                session.privateKey,
                session.algorithm,
                { expiresIn: '15m' },
            ),
            sent.publicKey,
            'ES256',
        );

        expect(proof.keyId).toBe(sent.keyId);

        // And the binding survives, so the renewed session is still a bound one.
        expect(session.binding).toBe('passkey');
        expect(session.uaFamily).toBe('chrome');
    });

    it('leaves the retired key id in none of the cookies it returns', async () =>
    {
        const { jar, keyId: expiringKeyId } = await expiringJar();

        const { requestCtx, responseCtx } = await throughTheChain(RENEW_VERIFY, { response: {} }, jar, renewedBody);

        const newKeyId = (requestCtx.body as { keyId: string }).keyId;
        const keyIdCookie = [...responseCtx.setCookies].reverse().find(cookie => cookie.name === COOKIE_NAMES.SESSION_KEY_ID);
        const csrfCookie = [...responseCtx.setCookies].reverse().find(cookie => cookie.name === COOKIE_NAMES.CSRF);

        expect(keyIdCookie?.value).toBe(newKeyId);
        expect(keyIdCookie?.value).not.toBe(expiringKeyId);
        expect(csrfCookie?.value).toBe(await deriveCsrfToken(newKeyId));
        expect(csrfCookie?.value).not.toBe(await deriveCsrfToken(expiringKeyId));
    });

    it('the cookies it returns carry the next authenticated request, signed with the replacement key', async () =>
    {
        const { jar, keyId: expiringKeyId } = await expiringJar();

        const { requestCtx, responseCtx } = await throughTheChain(RENEW_VERIFY, { response: {} }, jar, renewedBody);

        const sent = requestCtx.body as { keyId: string; publicKey: string };
        const renewedJar = applyCookies(jar, responseCtx.setCookies);

        const nextCtx = {
            path: '/_auth/users/me',
            method: 'GET',
            headers: {} as Record<string, string>,
            body: undefined,
            query: {},
            cookies: renewedJar,
            request: { headers: new Headers({ 'user-agent': CHROME }) },
            metadata: {} as Record<string, unknown>,
        } as unknown as RequestInterceptorContext;

        await generalAuthInterceptor.request?.(nextCtx, async () => undefined);

        expect(nextCtx.abort).toBeUndefined();
        expect(nextCtx.headers['X-Key-Id']).toBe(sent.keyId);
        expect(nextCtx.headers['X-Key-Id']).not.toBe(expiringKeyId);

        // The backend's own check, run here: the bearer verifies against the
        // public key that was registered for the replacement.
        const bearer = nextCtx.headers['Authorization'].replace('Bearer ', '');
        expect(verifyClientToken(bearer, sent.publicKey, 'ES256').keyId).toBe(sent.keyId);
    });

    it('a cookie within a day of its own expiry is not re-sealed over the replacement', async () =>
    {
        // The other half of the same collision. `generalAuthInterceptor` marks a
        // nearly-expired cookie for refresh on the way in and re-seals it on the
        // way out — and its response phase runs after the one that just installed
        // the renewed session, so without the guard the last write of the session
        // cookie would be the *expiring* session all over again.
        const { jar, keyId: expiringKeyId } = await expiringJar(3600);

        const { requestCtx, responseCtx } = await throughTheChain(RENEW_VERIFY, { response: {} }, jar, renewedBody);

        const sent = requestCtx.body as { keyId: string };
        expect(requestCtx.metadata.refreshSession).toBe(true);

        const session = await unsealSession(sessionCookie(responseCtx.setCookies)!.value);
        expect(session.keyId).toBe(sent.keyId);
        expect(session.keyId).not.toBe(expiringKeyId);
    });

    it('a refused verify installs no session at all, and leaves the jar alone', async () =>
    {
        const { jar } = await expiringJar();

        const { responseCtx } = await throughTheChain(RENEW_VERIFY, { response: {} }, jar, () => ({
            status: 401,
            body: { __type: 'SessionRenewalRefusedError', message: 'refused' },
        }));

        // No replacement sealed — a proof the backend refused buys no session —
        // and no cookie cleared either: the session is still renewable.
        expect(sessionCookie(responseCtx.setCookies)).toBeUndefined();
        expect(responseCtx.setCookies).toHaveLength(0);
    });
});

describe('the flows that share the login interceptor keep their behaviour (#99)', () =>
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
    });

    it('a sign-in with no session cookie seals the pair it minted', async () =>
    {
        const { requestCtx, responseCtx } = await throughTheChain(
            '/_auth/login',
            { email: 'a@b.test', password: 'x' },
            new Map(),
            requestContext => ({
                status: 200,
                body: { userId: '7', keyId: (requestContext.body as { keyId: string }).keyId },
            }),
        );

        const sent = requestCtx.body as { keyId: string };
        const session = await unsealSession(sessionCookie(responseCtx.setCookies)!.value);

        expect(session.keyId).toBe(sent.keyId);
        expect(session.userId).toBe('7');
        expect(session.binding).toBeUndefined();
    });

    it('a password reset completed while a session cookie is still in the jar seals the new pair, not the old key', async () =>
    {
        // `password/reset/complete` is an authenticated path as far as
        // `requiresAuth` is concerned, so a browser still holding a session runs
        // the same two rules over the same metadata that renewal does.
        const { jar, keyId: oldKeyId } = await expiringJar();

        const { requestCtx, responseCtx } = await throughTheChain(
            '/_auth/password/reset/complete',
            { password: 'x' },
            jar,
            requestContext => ({
                status: 200,
                body: { userId: '7', keyId: (requestContext.body as { keyId: string }).keyId },
            }),
        );

        const sent = requestCtx.body as { keyId: string };
        const session = await unsealSession(sessionCookie(responseCtx.setCookies)!.value);

        expect(session.keyId).toBe(sent.keyId);
        expect(session.keyId).not.toBe(oldKeyId);
    });
});
