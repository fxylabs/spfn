/**
 * @spfn/auth - a request token has a bounded life, and an expired one says so (au9-N9)
 *
 * Through `authenticate` on a signed route (`GET /_auth/session`), with a
 * token signed by a registered device key:
 *
 * | #   | token                                    | expected                                    |
 * |-----|------------------------------------------|---------------------------------------------|
 * | T6a | `exp` past, by twice the skew allowance   | 401 `TokenExpiredError`, not an invalid one |
 * | T6b | no `exp`                                 | 401 `InvalidTokenError`                     |
 * | T6c | `exp − iat` one second over the maximum  | 401 `InvalidTokenError`                     |
 * | T6d | a 15-minute token                        | 200                                         |
 *
 * And with first-party signing options (`generateClientToken`, 15 minutes)
 * on a signer whose clock is off the server's — the server's clock pinned at
 * 900 ms into a second, so a signer 200 ms ahead is in the next second:
 *
 * | #   | signer's clock                           | expected                                    |
 * |-----|------------------------------------------|---------------------------------------------|
 * | T6e | +200 ms, across a second boundary        | 200                                         |
 * | T6f | +1 s                                     | 200                                         |
 * | T6g | +30 s                                    | 200                                         |
 * | T6h | +5 min                                   | 401 `InvalidTokenError`                     |
 * | T6i | −30 s                                    | 200                                         |
 * | T6j | −15 min 30 s: expired 30 s ago           | 200                                         |
 * | T6k | expired 1 s past the skew allowance      | 401 `TokenExpiredError`                     |
 *
 * And the window that allowance gives at both ends — a token is accepted from
 * `iat − skew` until `exp + skew` by the server's clock, at most 900 + 2 × 60
 * seconds — with `iat = S + 60` and `exp = S + 960`, as far ahead as a token
 * the server takes at S can be:
 *
 * | #   | server's clock  | expected                                    |
 * |-----|-----------------|---------------------------------------------|
 * | T6l | S               | 200                                         |
 * | T6m | S + 1019        | 200                                         |
 * | T6n | S + 1020        | 401 `TokenExpiredError`                     |
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Hono } from 'hono';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, createTestUser, JSON_HEADERS, TEST_PASSWORD, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { REQUEST_TOKEN_CLOCK_SKEW_SECONDS, REQUEST_TOKEN_MAX_LIFETIME_SECONDS as MAX_LIFETIME_SECONDS } from '@/server/helpers/jwt';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)('request token lifetime through authenticate (T6)', () =>
{
    let app: Hono;
    let sign: (claims: { iat: number; exp?: number }) => string;
    const now = () => Math.floor(Date.now() / 1000);

    beforeAll(async () =>
    {
        await setupTestDb();
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

        const role = await getRoleByName('user');
        await createTestUser('t6@example.com', role!.id);
        const key = generateKeyPair('ES256');
        const login = await app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.46' },
            body: JSON.stringify({
                email: 't6@example.com',
                password: TEST_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });
        expect(login.status).toBe(200);

        const privateKey = crypto.createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
        sign = claims => jwt.sign({ keyId: key.keyId, ...claims }, privateKey, {
            algorithm: 'ES256',
            issuer: 'spfn-client',
        });
    });

    const session = (token: string) => app.request('/_auth/session', { headers: { Authorization: `Bearer ${token}` } });

    it('T6a an expired token answers 401 TokenExpiredError', async () =>
    {
        const response = await session(sign({ iat: now() - MAX_LIFETIME_SECONDS, exp: now() - 2 * REQUEST_TOKEN_CLOCK_SKEW_SECONDS }));

        expect(response.status).toBe(401);
        expect((await response.json()).__type).toBe('TokenExpiredError');
    });

    it('T6b a token without exp answers 401 InvalidTokenError', async () =>
    {
        const response = await session(sign({ iat: now() }));

        expect(response.status).toBe(401);
        expect((await response.json()).__type).toBe('InvalidTokenError');
    });

    it('T6c a token living longer than the maximum answers 401 InvalidTokenError', async () =>
    {
        const iat = now();
        const response = await session(sign({ iat, exp: iat + MAX_LIFETIME_SECONDS + 1 }));

        expect(response.status).toBe(401);
        expect((await response.json()).__type).toBe('InvalidTokenError');
    });

    it('T6d a 15-minute token answers 200', async () =>
    {
        const iat = now();
        const response = await session(sign({ iat, exp: iat + MAX_LIFETIME_SECONDS }));

        expect(response.status).toBe(200);
    });
});

describe.skipIf(!dbAvailable)('request token signed on a clock off the server\'s (T6, clock skew)', () =>
{
    let app: Hono;
    let signWithSkew: (skewMs: number) => string;
    let signClaims: (claims: { iat: number; exp: number }) => string;
    let clock: MockInstance<() => number>;
    let serverNow: number;

    beforeAll(async () =>
    {
        await setupTestDb();
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

        const role = await getRoleByName('user');
        await createTestUser('t6-skew@example.com', role!.id);
        const key = generateKeyPair('ES256');
        const login = await app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.47' },
            body: JSON.stringify({
                email: 't6-skew@example.com',
                password: TEST_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });
        expect(login.status).toBe(200);

        // The server's clock stands still at 900 ms into the current second for the row.
        serverNow = Math.floor(Date.now() / 1000) * 1000 + 900;
        clock = vi.spyOn(Date, 'now').mockReturnValue(serverNow);
        signWithSkew = (skewMs) =>
        {
            clock.mockReturnValue(serverNow + skewMs);
            const token = generateClientToken(
                { userId: 1, keyId: key.keyId, timestamp: serverNow },
                key.privateKey,
                'ES256',
                { expiresIn: '15m' },
            );
            clock.mockReturnValue(serverNow);

            return token;
        };

        const privateKey = crypto.createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
        signClaims = claims => jwt.sign({ keyId: key.keyId, ...claims }, privateKey, {
            algorithm: 'ES256',
            issuer: 'spfn-client',
        });
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    const answer = (token: string) => app.request('/_auth/session', { headers: { Authorization: `Bearer ${token}` } });

    it.each([
        ['T6e', '+200 ms, across a second boundary', 200],
        ['T6f', '+1 s', 1000],
        ['T6g', '+30 s', 30_000],
        ['T6i', '−30 s', -30_000],
        ['T6j', '−15 min 30 s (the token expired 30 s ago)', -(MAX_LIFETIME_SECONDS + 30) * 1000],
    ])('%s a signer at %s answers 200', async (_row, _clock, skewMs) =>
    {
        expect((await answer(signWithSkew(skewMs))).status).toBe(200);
    });

    it('T6h a signer 5 minutes ahead answers 401 InvalidTokenError', async () =>
    {
        const response = await answer(signWithSkew(5 * 60_000));

        expect(response.status).toBe(401);
        expect((await response.json()).__type).toBe('InvalidTokenError');
    });

    it('T6k a token expired one second past the skew allowance answers 401 TokenExpiredError', async () =>
    {
        const response = await answer(signWithSkew(-(MAX_LIFETIME_SECONDS + REQUEST_TOKEN_CLOCK_SKEW_SECONDS + 1) * 1000));

        expect(response.status).toBe(401);
        expect((await response.json()).__type).toBe('TokenExpiredError');
    });

    describe('the accepted window, iat − skew to exp + skew (T6l–T6n)', () =>
    {
        const S = () => Math.floor(serverNow / 1000);
        const farthestAhead = () => signClaims({
            iat: S() + REQUEST_TOKEN_CLOCK_SKEW_SECONDS,
            exp: S() + REQUEST_TOKEN_CLOCK_SKEW_SECONDS + MAX_LIFETIME_SECONDS,
        });
        // 900 + 2 × 60, the window the JSDoc of REQUEST_TOKEN_CLOCK_SKEW_SECONDS and the README state.
        const window = 1020;
        const answerAt = (secondsAfterS: number, token: string) =>
        {
            clock.mockReturnValue(serverNow + secondsAfterS * 1000);

            return answer(token);
        };

        it('T6l is accepted at S', async () =>
        {
            expect((await answerAt(0, farthestAhead())).status).toBe(200);
        });

        it('T6m is accepted at S + 1019, the last second of the window', async () =>
        {
            expect((await answerAt(window - 1, farthestAhead())).status).toBe(200);
        });

        it('T6n is refused at S + 1020 as expired', async () =>
        {
            const response = await answerAt(window, farthestAhead());

            expect(response.status).toBe(401);
            expect((await response.json()).__type).toBe('TokenExpiredError');
        });
    });
});
