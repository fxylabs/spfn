/**
 * @spfn/auth - A refused web sign-in writes nothing; one identity per provider
 * per account; a link survives a token that no longer decrypts (au5-A2, A3, B5)
 *
 * T1: every reason the web callback can redirect with, read from
 *     `OAUTH_ERROR_REASONS`, has at least one refusal below, and each leaves the
 *     users, social accounts (tokens included) and keys exactly as they were,
 *     with no event fired. A new reason with no refusal here fails the row.
 * T2: a second identity of a provider, arriving by email match, is refused and
 *     the account keeps one link; after the unlink that provider does not sign
 *     in to the account; the migration keeps the most recently used duplicate.
 * T6: a link whose stored token cannot be decrypted still signs in and unlinks.
 *
 * Real requests against the mounted auth router; Kakao is a stand-in whose
 * authorization codes name the identity their token response establishes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { asc, eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { userPublicKeys, userSocialAccounts, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { encryptToken } from '@/server/lib/oauth/token-cipher';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { configureAuth } from '@/server/lib/config';
import { configureChannels, __resetChannelsForTests } from '@/server/lib/channels-config';
import { socialAccountsRepository } from '@/server/repositories';
import { OAUTH_ERROR_REASONS, type OAuthErrorReason } from '@/lib/oauth-error-reason';
import {
    authDeviceRegisteredEvent,
    authLoginEvent,
    authRegisterEvent,
    oauthLinkedEvent,
} from '@/server/events';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const PASSWORD = 'Password123!';
const OWNER_EMAIL = 'owner@refusals.test';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const RETIRED_KEY = `retired:${Buffer.alloc(32, 9).toString('base64')}`;
const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

/** The identity the owner already has linked: no email, like Battle.net's. */
const LINKED: NormalizedIdentity = { providerUserId: 'kakao-linked', email: null, emailVerified: false };
/** A second identity of the same provider, reporting the owner's verified email. */
const SECOND: NormalizedIdentity = { providerUserId: 'kakao-second', email: OWNER_EMAIL, emailVerified: true };
const UNVERIFIED: NormalizedIdentity = { providerUserId: 'kakao-unverified', email: OWNER_EMAIL, emailVerified: false };
const NEWCOMER: NormalizedIdentity = { providerUserId: 'kakao-newcomer', email: 'new@refusals.test', emailVerified: true };

const identities = new Map<string, NormalizedIdentity>([
    ['code-linked', LINKED],
    ['code-second', SECOND],
    ['code-unverified', UNVERIFIED],
    ['code-newcomer', NEWCOMER],
]);

const standIn: OAuthProvider = {
    id: 'kakao',
    isEnabled: () => true,
    pkce: 'S256',
    getAuthUrl: (state: string) => `https://kauth.refusals.example/authorize?state=${state}`,
    exchangeCodeForTokens: async (code: string) =>
    {
        if (!identities.has(code))
        {
            throw new Error('the provider is down');
        }

        return { accessToken: `access-${code}`, expiresIn: 86400, identity: identities.get(code) };
    },
    getUserInfo: async () =>
    {
        throw new Error('the stand-in answers identity from the token response');
    },
};

/** One way a callback is refused: what to set up, and the callback to send. */
interface Refusal
{
    name: string;
    arrange?: () => Promise<void>;
    callback: () => Promise<URL>;
}

describe.skipIf(!dbAvailable)('OAuth web callback refusals and one identity per provider (au5-A2, A3, B5)', () =>
{
    let app: Hono;
    let ownerId: number;
    const fired: string[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
        authRegisterEvent.subscribe(() => record('auth.register'));
        authLoginEvent.subscribe(() => record('auth.login'));
        authDeviceRegisteredEvent.subscribe(() => record('auth.device.registered'));
        oauthLinkedEvent.subscribe(() => record('auth.oauth.linked'));
    });

    function record(event: string): void
    {
        fired.push(event);
    }

    afterAll(async () =>
    {
        registerOAuthProvider(kakaoProvider);
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        registerOAuthProvider(standIn);
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        await freshWorld();
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        resetPolicy();
    });

    /** The owner, with a password and the LINKED identity, and nothing else. */
    async function freshWorld(): Promise<void>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        ownerId = await createOwner();
        await linkOwner(LINKED.providerUserId, 'stored-access-token');
        fired.length = 0;
    }

    function resetPolicy(): void
    {
        configureAuth({ oauthEmailMatch: undefined, oauthProviders: undefined });
        __resetChannelsForTests();
    }

    // ========================================================================
    // Driving the router
    // ========================================================================

    async function createOwner(): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email: OWNER_EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: null,
        }).returning({ id: users.id });

        return Number(row!.id);
    }

    async function linkOwner(providerUserId: string, accessToken: string | null): Promise<void>
    {
        await getTestDb().insert(userSocialAccounts).values({
            userId: ownerId,
            provider: 'kakao',
            providerUserId,
            accessToken,
            refreshToken: null,
            tokenExpiresAt: new Date(Date.now() + 3_600_000),
        });
    }

    /** A sign-in start as the interceptor makes it, and the callback the provider sends back. */
    async function kakaoCallback(
        query: Record<string, string>,
        options: { withCookie?: boolean; fingerprint?: string; beforeCallback?: () => void } = {},
    ): Promise<URL>
    {
        const key = generateKeyPair('ES256');
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'kakao',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: options.fingerprint ?? key.fingerprint,
            algorithm: key.algorithm,
            nonce,
        });
        options.beforeCallback?.();

        return await callbackWith(new URLSearchParams({ state, ...query }), options.withCookie === false
            ? null
            : `${buildStartCookieName('csrf', key.keyId)}=${nonce}`);
    }

    async function callbackWith(params: URLSearchParams, cookie: string | null): Promise<URL>
    {
        const response = await app.request(`/_auth/oauth/kakao/callback?${params}`, {
            headers: cookie ? { Cookie: cookie } : {},
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    function setOwnerStatus(status: 'suspended'): Promise<unknown>
    {
        return getTestDb().update(users).set({ status }).where(eq(users.id, ownerId));
    }

    /** Every row a sign-in can write, tokens included. */
    async function snapshot(): Promise<string>
    {
        const db = getTestDb();

        return JSON.stringify({
            users: await db.select().from(users).orderBy(asc(users.id)),
            socialAccounts: await db.select().from(userSocialAccounts).orderBy(asc(userSocialAccounts.id)),
            keys: await db.select().from(userPublicKeys).orderBy(asc(userPublicKeys.id)),
        });
    }

    async function ownerSession(): Promise<string>
    {
        const key = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: OWNER_EMAIL,
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    function unlinkKakao(authorization: string): Promise<Response>
    {
        return Promise.resolve(app.request('/_auth/oauth/kakao/unlink', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authorization },
            body: JSON.stringify({}),
        }));
    }

    /** Another account holding the identity, committed before the sign-in. */
    async function linkElsewhere(providerUserId: string): Promise<void>
    {
        const userRole = await getRoleByName('user');
        const [other] = await getTestDb().insert(users).values({ email: null, roleId: userRole!.id }).returning({ id: users.id });
        await getTestDb().insert(userSocialAccounts).values({ userId: Number(other!.id), provider: 'kakao', providerUserId });
    }

    /**
     * Each attempt's opening look-up of the identity misses, as if the other
     * account linked it after that look-up; the conflict read that follows sees
     * it. Both attempts race, so the retry cannot settle it.
     */
    function everyLookUpMissesFirst(): void
    {
        const lookUp = socialAccountsRepository.findByProviderAndProviderId.bind(socialAccountsRepository);
        let calls = 0;

        vi.spyOn(socialAccountsRepository, 'findByProviderAndProviderId').mockImplementation(async (...args) =>
        {
            calls += 1;

            return calls % 2 === 1 ? null : await lookUp(...args);
        });
    }

    async function ownerKakaoRows()
    {
        return await getTestDb().select().from(userSocialAccounts).where(eq(userSocialAccounts.userId, ownerId));
    }

    // ========================================================================
    // T1: every refusal reason writes nothing
    // ========================================================================

    const REFUSALS: Record<OAuthErrorReason, Refusal[]> = {
        cancelled: [{ name: 'declined at the provider', callback: () => kakaoCallback({ error: 'access_denied' }) }],
        expired: [{
            name: 'state past its ten minutes',
            callback: () => kakaoCallback({ code: 'code-second' }, {
                beforeCallback: () => vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ['Date'] }),
            }),
        }],
        invalid_state: [{
            name: 'a state that does not open',
            callback: () => callbackWith(new URLSearchParams({ code: 'code-second', state: 'forged' }), null),
        }],
        no_cookie: [{ name: 'no CSRF cookie', callback: () => kakaoCallback({ code: 'code-second' }, { withCookie: false }) }],
        provider_error: [{ name: 'the code exchange fails', callback: () => kakaoCallback({ code: 'code-unknown' }) }],
        account_unavailable: [
            {
                name: 'email match onto a suspended account (attach + emailVerifiedAt written first)',
                arrange: async () =>
                {
                    await getTestDb().delete(userSocialAccounts);
                    await setOwnerStatus('suspended');
                },
                callback: () => kakaoCallback({ code: 'code-second' }),
            },
            {
                name: 'the linked identity of a suspended account (fresh tokens written first)',
                arrange: async () =>
                {
                    await setOwnerStatus('suspended');
                },
                callback: () => kakaoCallback({ code: 'code-linked' }),
            },
        ],
        link_only: [{
            name: 'the provider is link-only',
            arrange: async () => configureAuth({ oauthProviders: { kakao: { signIn: false } } }),
            callback: () => kakaoCallback({ code: 'code-linked' }),
        }],
        email_in_use: [{
            name: "oauthEmailMatch: 'reject'",
            arrange: async () =>
            {
                await getTestDb().delete(userSocialAccounts);
                configureAuth({ oauthEmailMatch: 'reject' });
            },
            callback: () => kakaoCallback({ code: 'code-second' }),
        }],
        signup_disabled: [{
            name: 'sign-up closed and the identity would make an account',
            arrange: async () => configureChannels({ signup: false }),
            callback: () => kakaoCallback({ code: 'code-newcomer' }),
        }],
        provider_already_linked: [{
            name: 'email match onto an account holding another identity of the provider',
            callback: () => kakaoCallback({ code: 'code-second' }),
        }],
        sign_in_contended: [{
            name: 'a first sign-in whose identity another account linked meanwhile, on the first attempt and the retry',
            arrange: async () =>
            {
                await linkElsewhere(NEWCOMER.providerUserId);
                everyLookUpMissesFirst();
            },
            callback: () => kakaoCallback({ code: 'code-newcomer' }),
        }],
        failed: [
            {
                name: 'a first sign-in whose key registration fails (the account was created first)',
                callback: () => kakaoCallback({ code: 'code-newcomer' }, { fingerprint: generateKeyPair('ES256').fingerprint }),
            },
            {
                name: 'an unverified email matching an account',
                arrange: async () =>
                {
                    await getTestDb().delete(userSocialAccounts);
                },
                callback: () => kakaoCallback({ code: 'code-unverified' }),
            },
        ],
    };

    describe('T1: a refused web sign-in leaves every row as it was and fires no event', () =>
    {
        it.each([...OAUTH_ERROR_REASONS])('reason=%s', async (reason) =>
        {
            const refusals = REFUSALS[reason];

            expect(refusals, `no refusal exercises reason=${reason}; add one to REFUSALS`).toBeDefined();

            for (const refusal of refusals)
            {
                await freshWorld();
                resetPolicy();
                await refusal.arrange?.();
                const before = await snapshot();

                const location = await refusal.callback();
                vi.useRealTimers();

                expect(location.pathname, refusal.name).toBe('/auth/error');
                expect(location.searchParams.get('reason'), refusal.name).toBe(reason);
                expect(await snapshot(), refusal.name).toBe(before);
                expect(fired, refusal.name).toEqual([]);
            }
        });
    });

    // ========================================================================
    // T2: one identity per provider per account
    // ========================================================================

    describe('T2: one identity per provider per account', () =>
    {
        it('a second identity of the provider arriving by email match is refused; after the unlink the provider no longer signs in to the account', async () =>
        {
            const refused = await kakaoCallback({ code: 'code-second' });

            expect(refused.searchParams.get('reason')).toBe('provider_already_linked');
            expect((await ownerKakaoRows()).map(row => row.providerUserId)).toEqual([LINKED.providerUserId]);

            expect((await unlinkKakao(await ownerSession())).status).toBe(200);
            expect(await ownerKakaoRows()).toEqual([]);

            const signedIn = await kakaoCallback({ code: 'code-linked' });

            expect(signedIn.pathname).toBe('/auth/callback');
            expect(signedIn.searchParams.get('userId')).not.toBe(String(ownerId));
            expect(await ownerKakaoRows()).toEqual([]);
        });

        it('the migration keeps, of several rows of one provider on one account, the most recently used one', async () =>
        {
            const { remove, constrain } = uniqueProviderMigration();
            const db = getTestDb();
            await db.execute(sql`DROP INDEX "spfn_auth"."user_social_accounts_user_provider_unique_idx"`);
            const at = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);
            await db.insert(userSocialAccounts).values([
                { userId: ownerId, provider: 'kakao', providerUserId: 'kakao-old', updatedAt: at(60) },
                { userId: ownerId, provider: 'kakao', providerUserId: 'kakao-newest', updatedAt: at(1) },
                { userId: ownerId, provider: 'github', providerUserId: 'github-only', updatedAt: at(90) },
            ]);
            await db.update(userSocialAccounts)
                .set({ updatedAt: at(30) })
                .where(eq(userSocialAccounts.providerUserId, LINKED.providerUserId));

            await db.execute(sql.raw(remove));
            await db.execute(sql.raw(constrain));

            const kept = await db.select().from(userSocialAccounts).orderBy(asc(userSocialAccounts.provider));
            expect(kept.map(row => [row.provider, row.providerUserId])).toEqual([['github', 'github-only'], ['kakao', 'kakao-newest']]);
        });
    });

    /** The two statements of the migration that adds the `(user_id, provider)` constraint. */
    function uniqueProviderMigration(): { remove: string; constrain: string }
    {
        const statements = readdirSync(MIGRATIONS)
            .filter(name => /^\d{14}_/.test(name))
            .flatMap(name => readFileSync(new URL(`${name}/migration.sql`, MIGRATIONS), 'utf8').split('--> statement-breakpoint'))
            .map(statement => statement.trim());
        const constrain = statements.find(statement => statement.includes('"user_social_accounts_user_provider_unique_idx" ON'))!;
        const remove = statements[statements.indexOf(constrain) - 1]!;

        expect(remove).toMatch(/^DELETE FROM "spfn_auth"\."user_social_accounts"/);

        return { remove, constrain };
    }

    // ========================================================================
    // T6: a token that no longer decrypts does not lock the link
    // ========================================================================

    describe('T6: a link whose stored token cannot be decrypted', () =>
    {
        it('still signs in, and still unlinks', async () =>
        {
            vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', RETIRED_KEY);
            const sealed = await encryptToken('old-refresh', { provider: 'kakao', providerUserId: LINKED.providerUserId, tokenType: 'refresh' });
            vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', ACTIVE_KEY);
            await getTestDb().update(userSocialAccounts)
                .set({ accessToken: sealed, refreshToken: sealed })
                .where(eq(userSocialAccounts.userId, ownerId));

            const signedIn = await kakaoCallback({ code: 'code-linked' });

            expect(signedIn.pathname).toBe('/auth/callback');
            expect(signedIn.searchParams.get('userId')).toBe(String(ownerId));

            expect((await unlinkKakao(await ownerSession())).status).toBe(200);
            expect(await ownerKakaoRows()).toEqual([]);
        });
    });
});
