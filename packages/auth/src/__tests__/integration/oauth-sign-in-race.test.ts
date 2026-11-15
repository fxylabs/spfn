/**
 * @spfn/auth - A first sign-in that loses a race for its identity signs in to
 * the winner's account (PR #314 review, F2)
 *
 * The reviewer's probe, made deterministic: while a first sign-in is between
 * "no link exists" and its insert, the app's `beforeRegister` hook commits the
 * same identity's link to another account on a connection of its own. The
 * insert then writes nothing. Without the rows below, that loser answered a
 * plain `Error` — 500 on native, `reason=failed` on the web — for a sign-in that
 * clicking again would have completed.
 *
 * R1 (web) and R2 (native): the sign-in is run once more and lands on the
 * winner's account; one account holds the identity, and the loser's half-made
 * account is gone with its transaction. R3: when the second attempt is
 * contended too, the answer is the typed refusal, never a 500 or `failed`.
 *
 * Round 2 (rv314b): the same cause on the address. R4: the winner holds the
 * identity's verified email — a double click — so the loser's account insert
 * breaks `users_email_unique` instead (P1/P2); it too lands on the winner's
 * account. R5: a linked sign-in's email backfill waits on another sign-up's
 * uncommitted insert of the address, which then commits (P3); the sign-in
 * succeeds and the address is not written. R6: a refusal is not run again.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { userSocialAccounts, users } from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { configureAuth } from '@/server/lib/config';
import { socialAccountsRepository, usersRepository } from '@/server/repositories';
import { RegistrationRejectedError } from '@/errors';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;

/** A first sign-in: no link, and an email no account holds. */
const RACER: NormalizedIdentity = { providerUserId: 'kakao-racer', email: 'racer@race.test', emailVerified: true };

const kakaoStandIn: OAuthProvider = {
    id: 'kakao',
    isEnabled: () => true,
    pkce: 'S256',
    getAuthUrl: (state: string) => `https://kauth.race.example/authorize?state=${state}`,
    exchangeCodeForTokens: async () => ({ accessToken: 'access-racer', expiresIn: 86400, identity: RACER }),
    getUserInfo: async () =>
    {
        throw new Error('the stand-in answers identity from the token response');
    },
    verifyNativeIdToken: async () => RACER,
};

describe.skipIf(!dbAvailable)('A first sign-in losing the race for its identity (PR #314 F2)', () =>
{
    let app: Hono;
    let winnerId: number | null;
    let winnerEmail: string | null;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
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
        registerOAuthProvider(kakaoStandIn);
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        winnerId = null;
        winnerEmail = null;
        configureAuth({ beforeRegister: commitWinnerOnce });
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        configureAuth({ beforeRegister: undefined });
    });

    /**
     * The competing first sign-in, committed on the helper's own connection
     * while the one under test holds its transaction open: an account — with
     * `winnerEmail` — and the identity's link. Once — the hook runs again only
     * if the retry makes an account too.
     */
    async function commitWinnerOnce(): Promise<void>
    {
        if (winnerId !== null)
        {
            return;
        }

        const userRole = await getRoleByName('user');
        const [winner] = await getTestDb().insert(users).values({
            email: winnerEmail,
            roleId: userRole!.id,
        }).returning({ id: users.id });
        winnerId = Number(winner!.id);
        await getTestDb().insert(userSocialAccounts).values({
            userId: winnerId,
            provider: 'kakao',
            providerUserId: RACER.providerUserId,
        });
    }

    /** Every look-up of the identity before the insert misses, as if each attempt raced anew. */
    function everyAttemptRaces(): void
    {
        const lookUp = socialAccountsRepository.findByProviderAndProviderId.bind(socialAccountsRepository);
        let calls = 0;

        // Odd calls are an attempt's opening look-up; even ones read the conflict.
        vi.spyOn(socialAccountsRepository, 'findByProviderAndProviderId').mockImplementation(async (...args) =>
        {
            calls += 1;

            return calls % 2 === 1 ? null : await lookUp(...args);
        });
    }

    async function webSignIn(): Promise<URL>
    {
        const key = generateKeyPair('ES256');
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
        const response = await app.request(`/_auth/oauth/kakao/callback?${new URLSearchParams({ code: 'code-racer', state })}`, {
            headers: { Cookie: `${buildStartCookieName('csrf', key.keyId)}=${nonce}` },
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    function nativeSignIn(): Promise<Response>
    {
        const key = generateKeyPair('ES256');

        return Promise.resolve(app.request('/_auth/oauth/kakao/native', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
            body: JSON.stringify({
                idToken: 'id-token-racer',
                nonce: key.fingerprint,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        }));
    }

    /** The accounts holding the identity, and how many accounts exist at all. */
    async function holders(): Promise<{ owners: number[]; accounts: number }>
    {
        const links = await getTestDb().select().from(userSocialAccounts)
            .where(eq(userSocialAccounts.providerUserId, RACER.providerUserId));

        return {
            owners: links.map(link => Number(link.userId)),
            accounts: (await getTestDb().select().from(users)).length,
        };
    }

    it('R1: on the web, the loser signs in to the winner\'s account', async () =>
    {
        const location = await webSignIn();

        expect(location.pathname).toBe('/auth/callback');
        expect(location.searchParams.get('userId')).toBe(String(winnerId));
        expect(await holders()).toEqual({ owners: [winnerId], accounts: 1 });
    });

    it('R2: on native, the loser signs in to the winner\'s account', async () =>
    {
        const response = await nativeSignIn();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.userId).toBe(String(winnerId));
        expect(body.isNewUser).toBe(false);
        expect(await holders()).toEqual({ owners: [winnerId], accounts: 1 });
    });

    it('R3: contended on the retry as well, the answer is the typed refusal on both channels', async () =>
    {
        everyAttemptRaces();

        const location = await webSignIn();

        expect(location.pathname).toBe('/auth/error');
        expect(location.searchParams.get('reason')).toBe('sign_in_contended');

        const response = await nativeSignIn();

        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe('OAUTH_SIGN_IN_CONTENDED');
        expect(await holders()).toEqual({ owners: [winnerId], accounts: 1 });
    });

    it('R4: the winner holds the identity\'s verified email — web and native losers sign in to its account', async () =>
    {
        winnerEmail = RACER.email!;

        const location = await webSignIn();

        expect(location.pathname).toBe('/auth/callback');
        expect(location.searchParams.get('userId')).toBe(String(winnerId));
        expect(await holders()).toEqual({ owners: [winnerId], accounts: 1 });

        await clearTables(getTestDb());
        await initializeAuth();
        winnerId = null;

        const response = await nativeSignIn();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.userId).toBe(String(winnerId));
        expect(body.isNewUser).toBe(false);
        expect(await holders()).toEqual({ owners: [winnerId], accounts: 1 });
    });

    /** An account the identity already signs in to, with no email yet. */
    async function linkedWithoutEmail(status: 'active' | 'suspended' = 'active'): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [linked] = await getTestDb().insert(users).values({ email: null, roleId: userRole!.id, status })
            .returning({ id: users.id });
        await getTestDb().insert(userSocialAccounts).values({
            userId: linked!.id,
            provider: 'kakao',
            providerUserId: RACER.providerUserId,
        });

        return Number(linked!.id);
    }

    /**
     * Another sign-up inserts the identity's address on a connection of its own
     * and holds it uncommitted; the backfill's UPDATE, which cannot see it, then
     * waits on it, and the sign-up commits. Once — the retry's backfill runs as
     * written.
     */
    function signUpCommitsDuringBackfill(): void
    {
        const fill = usersRepository.fillEmailIfUnheld.bind(usersRepository);
        let raced = false;

        vi.spyOn(usersRepository, 'fillEmailIfUnheld').mockImplementation(async (...args) =>
        {
            if (raced)
            {
                return await fill(...args);
            }

            raced = true;
            const userRole = await getRoleByName('user');
            let commit!: () => void;
            let inserted!: () => void;
            const released = new Promise<void>(resolve => commit = resolve);
            const holding = new Promise<void>(resolve => inserted = resolve);
            const signUp = getTestDb().transaction(async (tx) =>
            {
                await tx.insert(users).values({ email: RACER.email, roleId: userRole!.id });
                inserted();
                await released;
            });

            await holding;
            const filling = fill(...args);
            await untilAStatementWaitsOnALock();
            commit();

            return (await Promise.all([signUp, filling]))[1];
        });
    }

    async function untilAStatementWaitsOnALock(): Promise<void>
    {
        for (let polls = 0; polls < 200; polls++)
        {
            const waiting = await getTestDb().execute(sql`SELECT 1 FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`);

            if (waiting.length > 0)
            {
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 25));
        }

        throw new Error('no statement came to wait on the sign-up\'s insert');
    }

    async function emailOf(userId: number): Promise<string | null>
    {
        const [row] = await getTestDb().select({ email: users.email }).from(users).where(eq(users.id, userId));

        return row!.email;
    }

    it('R5: a sign-up commits the address while the backfill waits — the linked sign-in succeeds, the email is not written', async () =>
    {
        const linkedId = await linkedWithoutEmail();
        signUpCommitsDuringBackfill();

        const location = await webSignIn();

        expect(location.pathname).toBe('/auth/callback');
        expect(location.searchParams.get('userId')).toBe(String(linkedId));
        expect(await emailOf(linkedId)).toBeNull();

        await getTestDb().delete(users).where(eq(users.email, RACER.email!));
        vi.restoreAllMocks();
        signUpCommitsDuringBackfill();

        const response = await nativeSignIn();

        expect(response.status).toBe(200);
        expect((await response.json()).userId).toBe(String(linkedId));
        expect(await emailOf(linkedId)).toBeNull();
        expect((await getTestDb().select().from(users)).length).toBe(2);
    });

    /** Counts the identity look-ups — one per attempt. */
    function countLookUps(): { calls: number }
    {
        const counted = { calls: 0 };
        const lookUp = socialAccountsRepository.findByProviderAndProviderId.bind(socialAccountsRepository);

        vi.spyOn(socialAccountsRepository, 'findByProviderAndProviderId').mockImplementation(async (...args) =>
        {
            counted.calls += 1;

            return await lookUp(...args);
        });

        return counted;
    }

    it('R6: a refusal is not run again — the look-up and the hook run once', async () =>
    {
        await linkedWithoutEmail('suspended');
        const lookUps = countLookUps();

        expect((await webSignIn()).searchParams.get('reason')).toBe('account_unavailable');
        expect((await nativeSignIn()).status).toBe(403);
        // One attempt each, which reads the link twice: before the account lock
        // and again under it (`lockLinkedAccount`).
        expect(lookUps.calls).toBe(4);

        await clearTables(getTestDb());
        await initializeAuth();
        const hook = vi.fn(async () =>
        {
            throw new RegistrationRejectedError({ message: 'not here' });
        });
        configureAuth({ beforeRegister: hook });

        expect((await webSignIn()).pathname).toBe('/auth/error');
        expect((await nativeSignIn()).status).toBe(403);
        expect(hook).toHaveBeenCalledTimes(2);
        expect((await getTestDb().select().from(users)).length).toBe(0);
    });
});
