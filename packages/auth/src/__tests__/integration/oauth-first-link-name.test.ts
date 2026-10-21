/**
 * @spfn/auth - the name a provider reports is kept when a social account is first
 * attached (GitHub fxylabs/spfn#150)
 *
 * Apple sends a person's name once, on the first authorization, and outside the
 * id_token, so a native app forwards it as `/native`'s `profile.name`. Before
 * #150 both the web and the native flow read it into the identity and dropped
 * it. `createOrLinkUser` now keeps it as `user_profiles.display_name` when the
 * account has no profile yet. Apple is played by a local RS256 pair — only
 * jose's remote JWKS lookup is replaced — so signature, audience and the
 * nonce-to-key binding are checked for real.
 *
 * | # | case | outcome |
 * | --- | --- | --- |
 * | P1 | first `/native` with `profile.name` | display_name is the name |
 * | P2 | first `/native` with no `profile` | no profile row |
 * | P3 | first `/native` with a blank name | no profile row |
 * | P4 | first `/native` with a padded name | display_name is the trimmed name |
 * | P5 | a later `/native` for the same Apple account, carrying another name | display_name unchanged |
 * | P6 | a later `/native` carrying a name, for an account first linked with none | no profile row — only the first link writes |
 * | P7 | first `/native` whose verified email is an existing user's, who has a profile | linked; display_name unchanged |
 * | P8 | first `/native` whose verified email is an existing user's, who has no profile | linked; display_name is the name |
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, generateKeyPair as generateJoseKeyPair, SignJWT } from 'jose';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { createTestUser, mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { roles, userProfiles } from '@/server/entities';
import { generateKeyPair, type KeyPair } from '@/server/lib/crypto';

vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

const { registerOAuthProvider } = await import('@/server/lib/oauth');
const { appleProvider } = await import('@/server/lib/oauth/apple-provider');
const { initializeAuth } = await import('@/server/services/rbac.service');

const dbAvailable = await isDatabaseAvailable();

const BUNDLE_ID = 'com.example.app';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

interface NativeAnswer
{
    userId: string;
    isNewUser: boolean;
}

describe.skipIf(!dbAvailable)('the provider-reported name on first link (#150)', () =>
{
    let app: Hono;
    let appleSigningKey: CryptoKey;
    let testIndex = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        app = await mountAuthApp();
        registerOAuthProvider(appleProvider);

        // One pair for the whole file: jwks-verify keeps the first resolver it
        // builds for Apple's JWKS URI, so a pair minted per test would sign
        // tokens that resolver's key no longer verifies.
        const pair = await generateJoseKeyPair('RS256');
        appleSigningKey = pair.privateKey;
        vi.mocked(createRemoteJWKSet).mockReturnValue((async () => pair.publicKey) as never);
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
        testIndex += 1;

        vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', BUNDLE_ID);
        vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', '');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    function email(): string
    {
        return `first-link-${testIndex}@privaterelay.appleid.com`;
    }

    /** Apple's id_token for the bundle id, its nonce the SHA-256 of the key's fingerprint. */
    async function appleIdToken(key: KeyPair): Promise<string>
    {
        return await new SignJWT({
            nonce: createHash('sha256').update(key.fingerprint).digest('hex'),
            email: email(),
            email_verified: 'true',
        })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer('https://appleid.apple.com')
            .setAudience(BUNDLE_ID)
            .setSubject(`apple-first-link-${testIndex}`)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(appleSigningKey);
    }

    async function signIn(profile?: { name?: string }): Promise<NativeAnswer>
    {
        const key = generateKeyPair('ES256');
        const response = await app.request('/_auth/oauth/apple/native', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': `198.51.150.${testIndex & 0xff}` },
            body: JSON.stringify({
                idToken: await appleIdToken(key),
                nonce: key.fingerprint,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: 'ES256',
                ...(profile === undefined ? {} : { profile }),
            }),
        });
        expect(response.status).toBe(200);

        return await response.json() as NativeAnswer;
    }

    async function displayNameOf(userId: string | number): Promise<string | null | undefined>
    {
        const [row] = await getTestDb().select().from(userProfiles)
            .where(eq(userProfiles.userId, Number(userId))).limit(1);

        return row === undefined ? undefined : row.displayName;
    }

    async function existingUser(): Promise<number>
    {
        const [userRole] = await getTestDb().select().from(roles).where(eq(roles.name, 'user')).limit(1);

        return await createTestUser(email(), userRole!.id);
    }

    it('P1: the first /native with profile.name keeps it as the display name', async () =>
    {
        const answer = await signIn({ name: 'Jane Appleseed' });

        expect(answer.isNewUser).toBe(true);
        expect(await displayNameOf(answer.userId)).toBe('Jane Appleseed');
    });

    it('P2: the first /native with no profile creates no profile row', async () =>
    {
        const answer = await signIn();

        expect(await displayNameOf(answer.userId)).toBeUndefined();
    });

    it('P3: a blank name creates no profile row', async () =>
    {
        const answer = await signIn({ name: '   ' });

        expect(await displayNameOf(answer.userId)).toBeUndefined();
    });

    it('P4: a padded name is kept trimmed', async () =>
    {
        const answer = await signIn({ name: '  Jane  ' });

        expect(await displayNameOf(answer.userId)).toBe('Jane');
    });

    it('P5: a later sign-in for the same Apple account does not overwrite the name', async () =>
    {
        const first = await signIn({ name: 'Jane Appleseed' });
        const later = await signIn({ name: 'Someone Else' });

        expect(later).toMatchObject({ userId: first.userId, isNewUser: false });
        expect(await displayNameOf(first.userId)).toBe('Jane Appleseed');
    });

    it('P6: a later sign-in carrying a name, for an account first linked with none, writes nothing', async () =>
    {
        const first = await signIn();
        const later = await signIn({ name: 'Jane Appleseed' });

        expect(later.userId).toBe(first.userId);
        expect(await displayNameOf(first.userId)).toBeUndefined();
    });

    it('P7: linking an existing user who has a profile leaves it as it was', async () =>
    {
        const userId = await existingUser();
        await getTestDb().insert(userProfiles).values({ userId, displayName: 'Kept Name' });

        const answer = await signIn({ name: 'Jane Appleseed' });

        expect(answer).toMatchObject({ userId: String(userId), isNewUser: false });
        expect(await displayNameOf(userId)).toBe('Kept Name');
    });

    it('P8: linking an existing user who has no profile keeps the name', async () =>
    {
        const userId = await existingUser();

        const answer = await signIn({ name: 'Jane Appleseed' });

        expect(answer).toMatchObject({ userId: String(userId), isNewUser: false });
        expect(await displayNameOf(userId)).toBe('Jane Appleseed');
    });
});
