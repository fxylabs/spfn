/**
 * @spfn/auth - The verified-email backfill writes only an address no account
 * holds, and never leaves the sign-in's transaction aborted (PR #314 review, F3)
 *
 * The Codex probe: a linked account without an email signs in, and the provider
 * now reports a verified email another account holds. The backfill used to try
 * the UPDATE, meet the unique constraint, and swallow the error inside the
 * sign-in's transaction — which PostgreSQL had already aborted. The rule is now
 * the statement: one conditional UPDATE that writes nothing when the address is
 * held in any stored form.
 *
 * B1 (web) / B2 (native): the sign-in succeeds, the email is not written, the
 * holder is untouched, and the key registered after the backfill commits — the
 * transaction was not aborted. Without them, a swallowed violation passes (or a
 * dropped condition fails) unseen. B3: a failure of the statement itself
 * refuses the sign-in and writes nothing — without it, a catch could return.
 * B0: an address no one holds is filled, so the condition is not simply false.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { userPublicKeys, userSocialAccounts, users } from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { usersRepository } from '@/server/repositories';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const HELD_EMAIL = 'taken@backfill.test';

/** The linked identity; what it reports is set per row. */
let reported: NormalizedIdentity;

const kakaoStandIn: OAuthProvider = {
    id: 'kakao',
    isEnabled: () => true,
    pkce: 'S256',
    getAuthUrl: (state: string) => `https://kauth.backfill.example/authorize?state=${state}`,
    exchangeCodeForTokens: async () => ({ accessToken: 'fresh-access', expiresIn: 86400, identity: reported }),
    getUserInfo: async () =>
    {
        throw new Error('the stand-in answers identity from the token response');
    },
    verifyNativeIdToken: async () => reported,
};

describe.skipIf(!dbAvailable)('Verified-email backfill on a linked sign-in (PR #314 F3)', () =>
{
    let app: Hono;
    let linkedId: number;
    let holderId: number;

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
        holderId = await createAccount(HELD_EMAIL);
        linkedId = await createAccount(null);
        await getTestDb().insert(userSocialAccounts).values({
            userId: linkedId,
            provider: 'kakao',
            providerUserId: 'kakao-backfill',
            accessToken: null,
        });
        // The held address in another case: the rule folds, as sign-up does.
        reported = { providerUserId: 'kakao-backfill', email: 'Taken@Backfill.test', emailVerified: true };
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    async function createAccount(email: string | null): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({ email, roleId: userRole!.id }).returning({ id: users.id });

        return Number(row!.id);
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
        const response = await app.request(`/_auth/oauth/kakao/callback?${new URLSearchParams({ code: 'code', state })}`, {
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
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.9' },
            body: JSON.stringify({
                idToken: 'id-token',
                nonce: key.fingerprint,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        }));
    }

    async function account(id: number)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.id, id));

        return row!;
    }

    async function keysOf(id: number): Promise<number>
    {
        return (await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, id))).length;
    }

    async function snapshot(): Promise<string>
    {
        const db = getTestDb();

        return JSON.stringify({
            users: await db.select().from(users).orderBy(asc(users.id)),
            socialAccounts: await db.select().from(userSocialAccounts).orderBy(asc(userSocialAccounts.id)),
            keys: await db.select().from(userPublicKeys).orderBy(asc(userPublicKeys.id)),
        });
    }

    it('B0: an address no account holds is filled and marked verified', async () =>
    {
        reported = { ...reported, email: 'free@backfill.test' };

        expect((await webSignIn()).pathname).toBe('/auth/callback');
        expect(await account(linkedId)).toMatchObject({ email: 'free@backfill.test', emailVerifiedAt: expect.any(Date) });
    });

    it('B1: on the web, a held address is not written, the holder is untouched, and the sign-in commits', async () =>
    {
        const holderBefore = await account(holderId);

        const location = await webSignIn();

        expect(location.pathname).toBe('/auth/callback');
        expect(location.searchParams.get('userId')).toBe(String(linkedId));
        expect(await account(linkedId)).toMatchObject({ email: null, emailVerifiedAt: null });
        expect(await account(holderId)).toEqual(holderBefore);
        expect(await keysOf(linkedId)).toBe(1);
    });

    it('B2: on native, the same', async () =>
    {
        const holderBefore = await account(holderId);

        const response = await nativeSignIn();

        expect(response.status).toBe(200);
        expect((await response.json()).userId).toBe(String(linkedId));
        expect(await account(linkedId)).toMatchObject({ email: null, emailVerifiedAt: null });
        expect(await account(holderId)).toEqual(holderBefore);
        expect(await keysOf(linkedId)).toBe(1);
    });

    it('B3: a failure of the statement refuses the sign-in and writes nothing', async () =>
    {
        vi.spyOn(usersRepository, 'fillEmailIfUnheld').mockRejectedValue(new Error('the statement failed'));
        const before = await snapshot();

        const location = await webSignIn();

        expect(location.pathname).toBe('/auth/error');
        expect(location.searchParams.get('reason')).toBe('failed');
        expect((await nativeSignIn()).status).toBe(500);
        expect(await snapshot()).toBe(before);
    });
});
