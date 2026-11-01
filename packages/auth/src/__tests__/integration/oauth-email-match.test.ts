/**
 * @spfn/auth - What a first social sign-in does when its email matches an
 * existing account (GitHub fxylabs/spfn#156)
 *
 * One test per row of the #156 design's case table §6: E for the web callback,
 * N for native sign-in. Rows S1-S3 are in unit/oauth-email-match-config.test.ts.
 *
 * Driven the same way as oauth-link-policy.test.ts: real requests against the
 * mounted auth router and the real `createOrLinkUser`, Kakao a stand-in whose
 * authorization codes (and native id_tokens) name the identity they establish.
 * The real Kakao provider is put back after the file.
 *
 * Every "unchanged" column is asserted: row counts of users and social rows,
 * the existing account's row field by field, the key rows, and the events.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { userPublicKeys, userSocialAccounts, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { configureAuth, type OAuthEmailMatch } from '@/server/lib/config';
import { authLoginEvent, authRegisterEvent } from '@/server/events';
import { RegistrationRejectedError } from '@spfn/auth/errors';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const OWNER_EMAIL = 'owner@em156.test';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const MODES: OAuthEmailMatch[] = ['attach', 'reject', 'separate'];

const VERIFIED: NormalizedIdentity = {
    providerUserId: 'em156-verified', email: OWNER_EMAIL, emailVerified: true, name: 'Verified Kakao',
};
const UNVERIFIED: NormalizedIdentity = {
    providerUserId: 'em156-unverified', email: OWNER_EMAIL, emailVerified: false, name: 'Unverified Kakao',
};

const identities = new Map<string, NormalizedIdentity>([
    ['code-verified', VERIFIED],
    ['code-unverified', UNVERIFIED],
    ...MODES.map((mode): [string, NormalizedIdentity] => [`code-fresh-${mode}`, {
        providerUserId: `em156-fresh-${mode}`, email: `fresh-${mode}@em156.test`, emailVerified: true,
    }]),
]);

function kakaoStandIn(): OAuthProvider
{
    return {
        id: 'kakao',
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://kauth.em156.example/authorize?state=${state}`,
        exchangeCodeForTokens: async (code: string) =>
            ({ accessToken: `access-${code}`, expiresIn: 86400, identity: identities.get(code) }),
        getUserInfo: async () =>
        {
            throw new Error('the stand-in answers identity from the token response');
        },
        verifyNativeIdToken: async (idToken: string) => identities.get(idToken)!,
    };
}

describe.skipIf(!dbAvailable)('First social sign-in on an email an existing account holds (#156)', () =>
{
    let app: Hono;
    let ownerId: number;
    let ipCounter = 0;
    const beforeRegister = vi.fn();
    const logins: { userId: string }[] = [];
    const registers: { userId: string }[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
        authLoginEvent.subscribe((payload) =>
        {
            logins.push(payload);
        });
        authRegisterEvent.subscribe((payload) =>
        {
            registers.push(payload);
        });
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
        beforeRegister.mockReset();
        configureAuth({ beforeRegister });

        ownerId = await createOwner();
        logins.length = 0;
        registers.length = 0;
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        configureAuth({ oauthEmailMatch: undefined, beforeRegister: undefined });
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    /** The existing account: an email sign-up whose email was never verified. */
    async function createOwner(): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email: OWNER_EMAIL,
            passwordHash: await hashPassword('Password123!'),
            roleId: userRole!.id,
            emailVerifiedAt: null,
        }).returning({ id: users.id });

        return Number(row!.id);
    }

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.156.${ipCounter % 250 + 1}`;
    }

    /** A whole Kakao sign-in through the real callback; where it redirected. */
    async function signIn(code: string): Promise<URL>
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
        const response = await app.request(`/_auth/oauth/kakao/callback?${new URLSearchParams({ code, state })}`, {
            headers: { Cookie: `${buildStartCookieName('csrf', key.keyId)}=${nonce}` },
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    function nativeSignIn(code: string, key: KeyPair = generateKeyPair('ES256')): Promise<Response>
    {
        return Promise.resolve(app.request('/_auth/oauth/kakao/native', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': nextIp() },
            body: JSON.stringify({
                idToken: code,
                nonce: key.fingerprint,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        }));
    }

    async function userRow(userId: number)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.id, userId));

        return row;
    }

    async function socialRows()
    {
        return getTestDb().select().from(userSocialAccounts);
    }

    /** Everything a refused sign-in must leave as it was. */
    async function snapshot()
    {
        return {
            users: (await getTestDb().select().from(users)).length,
            socialRows: (await socialRows()).length,
            keys: (await getTestDb().select().from(userPublicKeys)).length,
            owner: await userRow(ownerId),
        };
    }

    function errorReasonOf(location: URL): string | null
    {
        expect(location.pathname).toBe('/auth/error');

        return location.searchParams.get('reason');
    }

    /** The refusal names nothing about the existing account. */
    function expectNoEnumeration(text: string): void
    {
        expect(text).not.toContain(OWNER_EMAIL);
        expect(text).not.toContain(encodeURIComponent(OWNER_EMAIL));
        expect(text).not.toMatch(/userId/i);
        expect(text).not.toMatch(/password|credential/i);
    }

    function signedInUserOf(location: URL): { userId: number; isNewUser: string | null }
    {
        expect(location.pathname, location.searchParams.get('error') ?? '').not.toBe('/auth/error');

        return { userId: Number(location.searchParams.get('userId')), isNewUser: location.searchParams.get('isNewUser') };
    }

    /** E5/E6: one new account, without the email, holding the social row; the owner untouched. */
    async function expectSeparateAccount(location: URL, identity: NormalizedIdentity, before: Awaited<ReturnType<typeof snapshot>>)
    {
        const { userId, isNewUser } = signedInUserOf(location);
        const created = await userRow(userId);
        const rows = await socialRows();

        expect(userId).not.toBe(ownerId);
        expect(isNewUser).toBe('true');
        expect(created).toMatchObject({ email: null, emailVerifiedAt: null });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ userId, provider: 'kakao', providerUserId: identity.providerUserId, providerEmail: OWNER_EMAIL });
        expect((await snapshot()).users).toBe(before.users + 1);
        expect(await userRow(ownerId)).toEqual(before.owner);
        expect(beforeRegister).toHaveBeenCalledTimes(1);
        expect(beforeRegister).toHaveBeenCalledWith({
            channel: 'oauth', provider: 'kakao', email: OWNER_EMAIL, emailVerified: identity.emailVerified, metadata: undefined,
        });
        expect(registers.map(payload => payload.userId)).toEqual([String(userId)]);
        expect(logins).toEqual([]);
    }

    // ========================================================================
    // 6-2. The web callback
    // ========================================================================

    describe('6-2 web callback', () =>
    {
        it('E1: with nothing set, a verified matching email signs in to the existing account as in 0.3.0-beta.50', async () =>
        {
            const before = await snapshot();

            const { userId, isNewUser } = signedInUserOf(await signIn('code-verified'));
            const rows = await socialRows();

            expect(userId).toBe(ownerId);
            expect(isNewUser).toBe('false');
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ userId: ownerId, providerUserId: VERIFIED.providerUserId });
            expect((await snapshot()).users).toBe(before.users);
            expect((await userRow(ownerId))!.emailVerifiedAt).not.toBeNull();
            expect(logins.map(payload => payload.userId)).toEqual([String(ownerId)]);
            expect(registers).toEqual([]);
            expect(beforeRegister).not.toHaveBeenCalled();
        });

        it('E2: with nothing set, an unverified matching email is refused with reason failed', async () =>
        {
            const before = await snapshot();

            expect(errorReasonOf(await signIn('code-unverified'))).toBe('failed');
            expect(await snapshot()).toEqual(before);
            expect(logins).toEqual([]);
            expect(registers).toEqual([]);
        });

        it('E3: reject refuses a verified matching email with reason email_in_use and writes nothing', async () =>
        {
            configureAuth({ oauthEmailMatch: 'reject' });
            const before = await snapshot();

            const location = await signIn('code-verified');

            expect(errorReasonOf(location)).toBe('email_in_use');
            expect([...location.searchParams.keys()]).toEqual(['error', 'reason']);
            expectNoEnumeration(location.toString());
            expect(await snapshot()).toEqual(before);
            expect(before.owner!.emailVerifiedAt).toBeNull();
            expect(logins).toEqual([]);
            expect(registers).toEqual([]);
            expect(beforeRegister).not.toHaveBeenCalled();
        });

        it('E4: reject refuses an unverified matching email the same way', async () =>
        {
            configureAuth({ oauthEmailMatch: 'reject' });
            const before = await snapshot();

            const location = await signIn('code-unverified');

            expect(errorReasonOf(location)).toBe('email_in_use');
            expect([...location.searchParams.keys()]).toEqual(['error', 'reason']);
            expectNoEnumeration(location.toString());
            expect(await snapshot()).toEqual(before);
            expect(before.owner!.emailVerifiedAt).toBeNull();
            expect(logins).toEqual([]);
            expect(registers).toEqual([]);
        });

        it('E5: separate makes a new account without the email for a verified matching email', async () =>
        {
            configureAuth({ oauthEmailMatch: 'separate' });
            const before = await snapshot();

            await expectSeparateAccount(await signIn('code-verified'), VERIFIED, before);
        });

        it('E6: separate makes a new account without the email for an unverified matching email', async () =>
        {
            configureAuth({ oauthEmailMatch: 'separate' });
            const before = await snapshot();

            await expectSeparateAccount(await signIn('code-unverified'), UNVERIFIED, before);
        });

        it('E7: separate whose beforeRegister refuses ends on the error page with no account and no social row', async () =>
        {
            configureAuth({ oauthEmailMatch: 'separate' });
            beforeRegister.mockRejectedValue(new RegistrationRejectedError());
            const before = await snapshot();

            expect(errorReasonOf(await signIn('code-verified'))).toBe('failed');
            expect(await snapshot()).toEqual(before);
            expect(beforeRegister).toHaveBeenCalledTimes(1);
            expect(registers).toEqual([]);
        });

        it('E8: in every mode, an email no account holds makes a new account carrying the verified email', async () =>
        {
            for (const mode of MODES)
            {
                configureAuth({ oauthEmailMatch: mode });

                const { userId, isNewUser } = signedInUserOf(await signIn(`code-fresh-${mode}`));

                expect(isNewUser, mode).toBe('true');
                expect(await userRow(userId), mode).toMatchObject({ email: `fresh-${mode}@em156.test` });
                expect((await userRow(userId))!.emailVerifiedAt, mode).not.toBeNull();
            }

            expect(beforeRegister).toHaveBeenCalledTimes(MODES.length);
            expect(registers).toHaveLength(MODES.length);
        });

        it('E9: in every mode, an identity already linked signs in to its account — reject does not stop it', async () =>
        {
            signedInUserOf(await signIn('code-verified'));

            for (const mode of MODES)
            {
                configureAuth({ oauthEmailMatch: mode });
                const before = await snapshot();

                const { userId, isNewUser } = signedInUserOf(await signIn('code-verified'));

                expect(userId, mode).toBe(ownerId);
                expect(isNewUser, mode).toBe('false');
                expect((await snapshot()).users, mode).toBe(before.users);
                expect((await snapshot()).socialRows, mode).toBe(before.socialRows);
            }

            expect(registers).toEqual([]);
        });

        it('E10: an account separate made signs in again to itself, its email still empty', async () =>
        {
            configureAuth({ oauthEmailMatch: 'separate' });
            const first = signedInUserOf(await signIn('code-verified'));
            const before = await snapshot();

            const again = signedInUserOf(await signIn('code-verified'));

            expect(again.userId).toBe(first.userId);
            expect(again.isNewUser).toBe('false');
            expect(await userRow(first.userId)).toMatchObject({ email: null, emailVerifiedAt: null });
            expect(await userRow(ownerId)).toEqual(before.owner);
            expect((await snapshot()).users).toBe(before.users);
        });

        it('E11: reject answers email_in_use, not account_unavailable, when the matching account is suspended', async () =>
        {
            await getTestDb().update(users).set({ status: 'suspended' }).where(eq(users.id, ownerId));
            configureAuth({ oauthEmailMatch: 'reject' });
            const before = await snapshot();

            const location = await signIn('code-verified');

            expect(errorReasonOf(location)).toBe('email_in_use');
            expect([...location.searchParams.keys()]).toEqual(['error', 'reason']);
            expectNoEnumeration(location.toString());
            expect(await snapshot()).toEqual(before);
        });
    });

    // ========================================================================
    // 6-3. Native sign-in
    // ========================================================================

    describe('6-3 native sign-in', () =>
    {
        it('N1: reject answers 409 OAUTH_EMAIL_IN_USE, registers no key, and names only the provider', async () =>
        {
            configureAuth({ oauthEmailMatch: 'reject' });
            const before = await snapshot();

            const response = await nativeSignIn('code-verified');
            const body = await response.text();

            expect(response.status).toBe(409);
            expect(JSON.parse(body).code).toBe('OAUTH_EMAIL_IN_USE');
            expectNoEnumeration(body);
            expect(JSON.parse(body).details).toEqual({ provider: 'kakao' });
            expect(await snapshot()).toEqual(before);
            expect(before.keys).toBe(0);
            expect(logins).toEqual([]);
            expect(registers).toEqual([]);
        });

        it('N2: separate answers 200 with isNewUser true and an account without the email', async () =>
        {
            configureAuth({ oauthEmailMatch: 'separate' });
            const before = await snapshot();

            const response = await nativeSignIn('code-verified');
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.isNewUser).toBe(true);
            expect(Number(body.userId)).not.toBe(ownerId);
            expect(await userRow(Number(body.userId))).toMatchObject({ email: null, emailVerifiedAt: null });
            expect(await userRow(ownerId)).toEqual(before.owner);
            expect(beforeRegister).toHaveBeenCalledTimes(1);
            expect(registers.map(payload => payload.userId)).toEqual([body.userId]);
        });
    });
});
