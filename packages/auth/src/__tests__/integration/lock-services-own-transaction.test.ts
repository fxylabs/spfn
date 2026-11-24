/**
 * @spfn/auth - an exported service that takes the account lock is atomic by itself (#494)
 *
 * Nine exported services took `usersRepository.lockAccount` and left the
 * transaction to their route's `Transactional()`. Every other test reaches
 * them through that route, so the transaction they lean on is always there.
 * These rows call each one as application code does: directly, with no
 * transaction open.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | T1 (×9) | each service, called with no transaction and the suite's lock assertion left on, resolves | a service whose own transaction is removed, or closed before its write: its route's `Transactional()` hides both from every other test |
 * | T2 (×2) | a poll refused after its spend — the app's sign-in guard refusing the polling device at the key write — rejects and leaves the record `approved`, the assertion off as in production | a poll whose spend commits apart from the key registration: `registerPublicKeyService` opens its own transaction and takes its own lock, so the assertion cannot see it |
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { deviceAuthorizations, deviceLinks, mfaTotp, passkeys, userSocialAccounts, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { configureSignIn, resetSignInGuardForTests } from '@/server/lib/sign-in-guard';
import type { PrincipalCredential } from '@/server/services/admission.service';

const { Hono: HonoApp } = await import('hono');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { mainAuthRouter } = await import('@/server/routes');
const { authenticate } = await import('@/server/middleware/authenticate');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const {
    startTotpEnrolmentService,
    regenerateRecoveryCodesService,
    markPasskeySecondFactorService,
} = await import('@/server/services/mfa.service');
const { unlinkOAuthService } = await import('@/server/services/oauth-link.service');
const { pollDeviceAuthService } = await import('@/server/services/device-auth.service');
const {
    redeemDeviceLinkService,
    denyDeviceLinkService,
    cancelDeviceLinkService,
    pollDeviceLinkService,
} = await import('@/server/services/device-link.service');
const { SignInRefusedError } = await import('@spfn/auth/errors');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'owner@own-transaction494.test';
const PASSWORD = 'Password123!';
const SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
const ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 7).toString('base64')}`;

/** A signed-in device: what it signs requests with, and the credential it presents. */
interface SignedIn
{
    authorization: string;
    keyId: string;
    credential: PrincipalCredential;
}

describe.skipIf(!dbAvailable)('services that take the account lock, called by application code (#494)', () =>
{
    let app: Hono;
    let userId: number;
    let previousSessionSecret: string | undefined;
    let testIndex = 0;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        previousSessionSecret = process.env.SPFN_AUTH_SESSION_SECRET;
        process.env.SPFN_AUTH_SESSION_SECRET = SESSION_SECRET;

        app = new HonoApp();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        if (previousSessionSecret === undefined)
        {
            delete process.env.SPFN_AUTH_SESSION_SECRET;
        }
        else
        {
            process.env.SPFN_AUTH_SESSION_SECRET = previousSessionSecret;
        }

        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', ENCRYPTION_KEYS);

        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();

        testIndex += 1;
        clientIp = `10.94.${testIndex >> 8}.${testIndex & 0xff}`;

        const [row] = await getTestDb().insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });
        userId = Number(row!.id);
    });

    afterEach(() =>
    {
        resetSignInGuardForTests();
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Harness
    // ========================================================================

    async function post(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    async function ok<T>(response: Promise<Response>): Promise<T>
    {
        const answered = await response;
        const text = await answered.text();

        expect(answered.status, text).toBe(200);

        return JSON.parse(text) as T;
    }

    async function signIn(): Promise<SignedIn>
    {
        const keyPair = generateKeyPair('ES256');

        await ok(post('/_auth/login', {
            email: EMAIL,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        }));

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId, credential: { kind: 'deviceKey', keyId: keyPair.keyId } };
    }

    /** A new device's key, as it presents it to start or redeem. */
    function newDeviceKey()
    {
        const keyPair = generateKeyPair('ES256');

        return {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'New phone',
            platform: 'ios' as const,
        };
    }

    /** A device code approved through the routes. */
    async function approvedDeviceCode(): Promise<string>
    {
        const owner = await signIn();
        const started = await ok<{ deviceCode: string; userCode: string }>(post('/_auth/device/start', newDeviceKey()));

        await ok(post('/_auth/device/approve', { userCode: started.userCode }, owner.authorization));

        return started.deviceCode;
    }

    async function issuedLink(): Promise<{ issuer: SignedIn; linkId: string; userCode: string }>
    {
        const issuer = await signIn();
        const link = await ok<{ linkId: string; userCode: string }>(post('/_auth/device/link/issue', {}, issuer.authorization));

        return { issuer, ...link };
    }

    async function redeemedLink()
    {
        const issued = await issuedLink();
        const device = await ok<{ deviceCode: string; matchNumber: number }>(
            post('/_auth/device/link/redeem', { userCode: issued.userCode, ...newDeviceKey() }),
        );

        return { ...issued, ...device };
    }

    async function approvedLink()
    {
        const redeemed = await redeemedLink();

        await ok(post('/_auth/device/link/confirm', { linkId: redeemed.linkId, choice: redeemed.matchNumber }, redeemed.issuer.authorization));

        return redeemed;
    }

    function issuerOf(link: { issuer: SignedIn; linkId: string })
    {
        return { linkId: link.linkId, issuer: { userId, keyId: link.issuer.keyId } };
    }

    /** The app's sign-in guard refusing a polling device where its key would be written. */
    function refuseDeviceSignIn(): void
    {
        configureSignIn({
            admit: (attempt, call) => (attempt.channel === 'device-code' || attempt.channel === 'device-link') && call === 'deciding'
                ? { refuse: { code: 'device-paused' } }
                : undefined,
        });
    }

    // ========================================================================
    // T1 — each service, called with no transaction, the lock assertion on
    // ========================================================================

    describe('T1: called with no transaction open, each service resolves', () =>
    {
        it('startTotpEnrolmentService', async () =>
        {
            const { credential } = await signIn();

            await expect(startTotpEnrolmentService(userId, credential)).resolves.toMatchObject({ secret: expect.any(String) });
        });

        it('regenerateRecoveryCodesService', async () =>
        {
            await getTestDb().insert(mfaTotp).values({ userId, secretEnc: 'not-a-real-secret', confirmedAt: new Date() });

            await expect(regenerateRecoveryCodesService(userId)).resolves.toMatchObject({ recoveryCodes: expect.any(Array) });
        });

        it('markPasskeySecondFactorService', async () =>
        {
            const [passkey] = await getTestDb().insert(passkeys).values({
                userId,
                credentialId: 'own-transaction494-credential',
                publicKey: 'not-a-real-key',
                deviceType: 'singleDevice',
                registeredUserVerified: true,
            }).returning({ id: passkeys.id });

            await expect(markPasskeySecondFactorService({ userId, passkeyId: String(passkey!.id), secondFactor: true }))
                .resolves.toMatchObject({ methods: ['passkey'] });
        });

        it('unlinkOAuthService', async () =>
        {
            const { credential } = await signIn();

            await getTestDb().insert(userSocialAccounts).values({ userId, provider: 'google', providerUserId: 'own-transaction494' });

            await expect(unlinkOAuthService({ provider: 'google', userId, credential })).resolves.toEqual({ provider: 'google' });
        });

        it('pollDeviceAuthService', async () =>
        {
            const deviceCode = await approvedDeviceCode();

            await expect(pollDeviceAuthService({ deviceCode })).resolves.toMatchObject({ status: 'approved' });
        });

        it('redeemDeviceLinkService', async () =>
        {
            const { userCode } = await issuedLink();

            await expect(redeemDeviceLinkService({ userCode, ...newDeviceKey() })).resolves.toMatchObject({ deviceCode: expect.any(String) });
        });

        it('denyDeviceLinkService', async () =>
        {
            const link = await redeemedLink();

            await expect(denyDeviceLinkService(issuerOf(link))).resolves.toMatchObject({ status: 'denied' });
        });

        it('cancelDeviceLinkService', async () =>
        {
            const link = await issuedLink();

            await expect(cancelDeviceLinkService(issuerOf(link))).resolves.toMatchObject({ status: 'expired' });
        });

        it('pollDeviceLinkService', async () =>
        {
            const { deviceCode } = await approvedLink();

            await expect(pollDeviceLinkService({ deviceCode })).resolves.toMatchObject({ status: 'approved' });
        });
    });

    // ========================================================================
    // T2 — a refusal after the spend leaves nothing spent
    // ========================================================================

    describe('T2: a poll refused after its spend leaves the record approved', () =>
    {
        beforeEach(() =>
        {
            // As in production: with the assertion on, a poll outside a transaction is refused before the spend could show.
            vi.stubEnv('SPFN_AUTH_ASSERT_ACCOUNT_LOCK', '0');
        });

        it('pollDeviceAuthService', async () =>
        {
            const deviceCode = await approvedDeviceCode();

            refuseDeviceSignIn();

            await expect(pollDeviceAuthService({ deviceCode })).rejects.toBeInstanceOf(SignInRefusedError);
            expect((await getTestDb().select().from(deviceAuthorizations)).map(record => record.status)).toEqual(['approved']);
        });

        it('pollDeviceLinkService', async () =>
        {
            const { linkId, deviceCode } = await approvedLink();

            refuseDeviceSignIn();

            await expect(pollDeviceLinkService({ deviceCode })).rejects.toBeInstanceOf(SignInRefusedError);
            expect((await getTestDb().select().from(deviceLinks).where(eq(deviceLinks.linkId, linkId))).map(link => link.status))
                .toEqual(['approved']);
        });
    });
});
