/**
 * @spfn/auth - The account row is the one lock for its credential state
 * (PR #315 review round 2)
 *
 * Every transaction that writes an account's credential state takes the
 * account lock (`usersRepository.lockAccount`) first, so two such writers queue
 * on one row instead of locking child rows in opposite orders:
 *
 * - D1: an OAuth re-sign-in that writes the users row (attach by e-mail, the
 *   e-mail backfill) and then re-registers the key it already holds, racing an
 *   operator's suspension and a sign-out everywhere — on the web callback and
 *   on native sign-in. Neither side aborts; the suspension commits and the key
 *   is dead afterwards.
 * - D2: `mfa/verify` paused after the activation, racing a suspension. The
 *   suspension commits; the verify is refused or its key is dead.
 * - L1: a suspension held uncommitted while a sign-in reaches the lock — the
 *   sign-in waits, reads the committed suspension, and writes no key.
 * - L2: a repository writer of credential state refuses to run, under test,
 *   in a transaction that does not hold the account lock.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { clearTables, getTestDb, isDatabaseAvailable, setupTestDb, teardownTestDb } from '../helpers/db';
import { createTestUser, mountAuthApp, resetMemoryRateLimitStore, TEST_PASSWORD } from '../helpers/oauth2';
import { mfaTotp, userPublicKeys, userSocialAccounts, users } from '@/server/entities';
import { keysRepository, mfaVerificationsRepository, usersRepository } from '@/server/repositories';
import { generateClientToken, generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { setAccountStatus } from '@/server/services/user.service';
import { registerPublicKeyService, revokeAllKeysService } from '@/server/services/key.service';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: vi.fn().mockResolvedValue({ success: true }), sendSMS: vi.fn().mockResolvedValue({ success: true }) };
});

const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Codes (web) and id_tokens (native) name the identity they establish. */
const identities = new Map<string, NormalizedIdentity>();

function kakaoStandIn(): OAuthProvider
{
    return {
        id: 'kakao',
        isEnabled: () => true,
        pkce: 'S256',
        getAuthUrl: (state: string) => `https://kauth.lock.example/authorize?state=${state}`,
        exchangeCodeForTokens: async (code: string) =>
            ({ accessToken: `access-${code}`, expiresIn: 86400, identity: identities.get(code) }),
        getUserInfo: async () =>
        {
            throw new Error('the stand-in answers identity from the token response');
        },
        verifyNativeIdToken: async (idToken: string) => identities.get(idToken)!,
    };
}

function gate(): { open: () => void; opened: Promise<void> }
{
    let open!: () => void;
    const opened = new Promise<void>(resolve =>
    {
        open = resolve;
    });

    return { open, opened };
}

/** Until some backend of this database waits on a lock. */
async function someoneWaitsOnALock(): Promise<void>
{
    for (let i = 0; i < 200; i++)
    {
        const rows = await getTestDb().execute(sql`
            SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE NOT l.granted AND a.datname = current_database()`);
        if (Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0)
        {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('no lock wait observed');
}

function failures(results: PromiseSettledResult<unknown>[]): string[]
{
    return results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => String((r.reason as Error)?.message ?? r.reason));
}

describe.skipIf(!dbAvailable)('The account row is the one lock for its credential state', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 7).toString('base64')}`;
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        registerOAuthProvider(kakaoProvider);
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        registerOAuthProvider(kakaoStandIn());
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        identities.clear();
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Fixtures and drivers
    // ========================================================================

    /** An account whose e-mail is unverified, signed in on one device. */
    async function accountWithLiveKey(email: string): Promise<{ userId: number; key: KeyPair }>
    {
        const userId = await createTestUser(email, (await getRoleByName('user'))!.id);
        await getTestDb().update(users).set({ emailVerifiedAt: null }).where(eq(users.id, userId));
        const key = generateKeyPair('ES256');
        await registerPublicKeyService({
            userId,
            keyId: key.keyId,
            publicKey: key.publicKey,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            channel: 'password',
        });

        return { userId, key };
    }

    async function keyAuthenticates(key: KeyPair): Promise<boolean>
    {
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });
        const response = await app.request('/_auth/session', { headers: { Authorization: `Bearer ${token}` } });

        return response.status === 200;
    }

    /**
     * The sign-in's next users-row write pauses, after it ran, until `resume`:
     * `updateById` (attach by e-mail) or `fillEmailIfUnheld` (the backfill).
     */
    function pauseAfterUsersWrite(paused: () => void, resume: Promise<void>, write: 'updateById' | 'fillEmailIfUnheld' = 'updateById'): void
    {
        const original = usersRepository[write].bind(usersRepository) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(usersRepository, write).mockImplementationOnce((async (...args: unknown[]) =>
        {
            const result = await original(...args);
            paused();
            await resume;

            return result;
        }) as never);
    }

    /** A Kakao web sign-in through the real callback, on the device's existing key. */
    async function webSignIn(code: string, key: KeyPair): Promise<string>
    {
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'kakao',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            nonce,
        });
        const response = await app.request(`/_auth/oauth/kakao/callback?${new URLSearchParams({ code, state })}`, {
            headers: { Cookie: `${buildStartCookieName('csrf', key.keyId)}=${nonce}` },
        });
        const location = new URL(response.headers.get('location') ?? '/', APP_URL);
        if (response.status !== 302 || location.pathname === '/auth/error')
        {
            throw new Error(`web sign-in refused: ${response.status} ${location.search}`);
        }

        return location.searchParams.get('userId') ?? '';
    }

    /** A Kakao native sign-in, on the device's existing key. */
    async function nativeSignIn(idToken: string, key: KeyPair): Promise<number>
    {
        const response = await app.request('/_auth/oauth/kakao/native', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '198.51.100.7' },
            body: JSON.stringify({
                idToken,
                nonce: key.fingerprint,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });
        if (response.status !== 200)
        {
            throw new Error(`native sign-in refused: ${response.status} ${await response.text()}`);
        }

        return response.status;
    }

    const flows: Array<[string, (token: string, key: KeyPair) => Promise<unknown>]> = [
        ['native', nativeSignIn],
        ['web', webSignIn],
    ];

    const writers: Array<[string, (userId: number) => Promise<unknown>]> = [
        ['setAccountStatus(suspended)', userId => setAccountStatus(userId, 'suspended', { from: 'any', reason: 'operator' })],
        ['revoke-all', userId => revokeAllKeysService({ userId, includeCurrent: true, reason: 'sign out everywhere' })],
    ];

    const cases = flows.flatMap(([flow, signIn]) => writers.map(([writer, write]) => [flow, writer, signIn, write] as const));

    // ========================================================================
    // D1
    // ========================================================================

    it.each(cases)('D1 %s OAuth attach + re-sign-in on its live key, racing %s: neither side aborts, the key is dead after', async (_flow, writerName, signIn, write) =>
    {
        const email = `d1-${Math.random().toString(36).slice(2)}@lock.test`;
        const { userId, key } = await accountWithLiveKey(email);
        identities.set('d1-token', { providerUserId: `kakao-${email}`, email, emailVerified: true });
        expect(await keyAuthenticates(key)).toBe(true);

        const paused = gate();
        const resume = gate();
        pauseAfterUsersWrite(paused.open, resume.opened);

        const signedIn = signIn('d1-token', key);
        await paused.opened;
        const written = write(userId);
        await someoneWaitsOnALock().finally(resume.open);

        expect(failures(await Promise.allSettled([signedIn, written]))).toEqual([]);
        const [account] = await getTestDb().select().from(users).where(eq(users.id, userId));
        expect(account!.emailVerifiedAt).not.toBeNull();
        expect(account!.status).toBe(writerName === 'revoke-all' ? 'active' : 'suspended');
        expect(await keyAuthenticates(key)).toBe(false);
    }, 20_000);

    it('D1 native re-sign-in through an existing link with the e-mail backfill, racing setAccountStatus(suspended): neither side aborts, the key is dead after', async () =>
    {
        const email = `d1b-${Math.random().toString(36).slice(2)}@lock.test`;
        const { userId, key } = await accountWithLiveKey(email);
        await getTestDb().update(users).set({ email: null }).where(eq(users.id, userId));
        await getTestDb().insert(userSocialAccounts).values({ userId, provider: 'kakao', providerUserId: `kakao-${email}`, providerEmail: email });
        identities.set('d1b-token', { providerUserId: `kakao-${email}`, email, emailVerified: true });

        const paused = gate();
        const resume = gate();
        pauseAfterUsersWrite(paused.open, resume.opened, 'fillEmailIfUnheld');

        const signedIn = nativeSignIn('d1b-token', key);
        await paused.opened;
        const suspended = setAccountStatus(userId, 'suspended', { from: 'any', reason: 'operator' });
        await someoneWaitsOnALock().finally(resume.open);

        expect(failures(await Promise.allSettled([signedIn, suspended]))).toEqual([]);
        const [account] = await getTestDb().select().from(users).where(eq(users.id, userId));
        expect(account).toMatchObject({ email, status: 'suspended' });
        expect(await keyAuthenticates(key)).toBe(false);
    }, 20_000);

    // ========================================================================
    // D2
    // ========================================================================

    it('D2 mfa/verify paused after the activation, racing setAccountStatus(suspended): the suspension commits, the verified key is dead', async () =>
    {
        const email = `d2-${Math.random().toString(36).slice(2)}@lock.test`;
        const userId = await createTestUser(email, (await getRoleByName('user'))!.id);
        const post = (path: string, body: unknown, authorization?: string) => app.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '203.0.113.9', ...(authorization ? { Authorization: authorization } : {}) },
            body: JSON.stringify(body),
        });
        const login = async () =>
        {
            const key = generateKeyPair('ES256');
            const response = await post('/_auth/login', { email, password: TEST_PASSWORD, publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm });

            return { response, key, authorization: `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}` };
        };
        const code = (secret: string) => hotp(decodeBase32(secret), totpStep(Date.now()));

        const first = await login();
        expect(first.response.status).toBe(200);
        const enrolled = await (await post('/_auth/mfa/totp/enroll', {}, first.authorization)).json();
        const secret = enrolled.secret as string;
        expect((await post('/_auth/mfa/totp/confirm', { code: code(secret) }, first.authorization)).status).toBe(200);
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });
        const second = await login();
        expect(second.response.status).toBe(202);
        const challenge = (await second.response.json()).challenge.secret as string;

        const paused = gate();
        const resume = gate();
        const record = mfaVerificationsRepository.record.bind(mfaVerificationsRepository);
        vi.spyOn(mfaVerificationsRepository, 'record').mockImplementationOnce(async (...args) =>
        {
            paused.open();
            await resume.opened;

            return await record(...args);
        });

        const verify = post('/_auth/mfa/verify', { challenge, code: code(secret) });
        await paused.opened;
        const suspend = setAccountStatus(userId, 'suspended', { from: 'any', reason: 'operator' });
        await someoneWaitsOnALock().finally(resume.open);

        const [verified, suspended] = await Promise.allSettled([verify, suspend]);

        expect(failures([suspended])).toEqual([]);
        expect(verified.status).toBe('fulfilled');
        expect([200, 401]).toContain((verified as PromiseFulfilledResult<Response>).value.status);
        const [account] = await getTestDb().select().from(users).where(eq(users.id, userId));
        expect(account!.status).toBe('suspended');
        expect(await keyAuthenticates(second.key)).toBe(false);
    }, 20_000);

    // ========================================================================
    // L1 — a sign-in waits for a suspension held uncommitted
    // ========================================================================

    it('L1 a sign-in that reaches the lock while a suspension is uncommitted waits for it, and is refused with no key written', async () =>
    {
        const email = `l1-${Math.random().toString(36).slice(2)}@lock.test`;
        const userId = await createTestUser(email, (await getRoleByName('user'))!.id);
        const held = gate();
        const release = gate();
        const reached = gate();

        const suspension = runInTransaction(async () =>
        {
            await setAccountStatus(userId, 'suspended', { from: 'any', reason: 'operator' });
            held.open();
            await release.opened;
        }, { context: 'test:held-suspension' });
        await held.opened;

        const lockAccount = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementation(async (id) =>
        {
            reached.open();

            return await lockAccount(id);
        });

        const key = generateKeyPair('ES256');
        const signIn = app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '203.0.113.10' },
            body: JSON.stringify({ email, password: TEST_PASSWORD, publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm }),
        });
        await reached.opened;
        await someoneWaitsOnALock().finally(release.open);

        const [response] = await Promise.all([signIn, suspension]);

        // Refused under the lock as a wrong password is (#364).
        expect(response.status).toBe(401);
        expect((await response.json()).error.code).toBe('InvalidCredentialsError');
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, key.keyId))).toEqual([]);
    }, 20_000);

    // ========================================================================
    // L2 — the writers refuse to run without the lock, under test
    // ========================================================================

    it('L2 a credential writer in a transaction without the account lock throws; with it, it runs', async () =>
    {
        const { userId, key } = await accountWithLiveKey(`l2-${Math.random().toString(36).slice(2)}@lock.test`);

        await expect(runInTransaction(() => keysRepository.revokeAllActiveByUserId(userId, 'no lock'), { context: 'test:no-lock' }))
            .rejects.toThrow(/without its lock/);
        await expect(keysRepository.markReauthenticated(key.keyId, userId))
            .rejects.toThrow(/without its lock/);
        await expect(runInTransaction(async () =>
        {
            await usersRepository.lockAccount(userId + 1);

            return keysRepository.revokeByKeyIdAndUserId(key.keyId, userId, 'another account locked');
        }, { context: 'test:wrong-lock' })).rejects.toThrow(/without its lock/);
        expect(await keyAuthenticates(key)).toBe(true);

        await runInTransaction(async () =>
        {
            await usersRepository.lockAccount(userId);
            await keysRepository.revokeAllActiveByUserId(userId, 'locked');
        }, { context: 'test:locked' });
        expect(await keyAuthenticates(key)).toBe(false);
    }, 20_000);
});
