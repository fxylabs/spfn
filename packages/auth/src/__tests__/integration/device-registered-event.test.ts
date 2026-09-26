/**
 * @spfn/auth - the device-registered event (design #94 v2, §7a)
 *
 * One `it` per row of §7a, in the table's order. The question every row asks is
 * the same: did a key row land, and did exactly the right number of
 * `auth.device.registered` payloads come out of it.
 *
 * Emission is registered with `onAfterCommit`, which the transaction runner
 * fires and does not await — so a row reads the capture through `settled()`
 * rather than straight after the response. That is also the point of the two
 * rollback rows: a transaction that throws after the key row is written must
 * announce nothing at all, and an inline emit would already have announced it.
 *
 * The web OAuth and native OAuth rows drive their services rather than the
 * router. The web callback needs a browser's CSRF cookie and a provider that
 * answers a code exchange; the native one needs a signed id_token. Both are
 * supplied here the way this package's own OAuth suites supply them, and both
 * still run against the real database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { generateKeyPair as generateJoseKeyPair, SignJWT, createRemoteJWKSet } from 'jose';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { userInvitations, userPublicKeys, users, verificationCodes } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';

// The remote JWKS fetch is the only part of native sign-in that leaves the
// process; everything else about the id_token is verified for real.
vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: (...args: unknown[]) => sendEmail(...args),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { authDeviceRegisteredEvent } = await import('@/server/events');
const { createOAuthState, generateOAuthNonce } = await import('@/server/lib/oauth/state');
const { registerOAuthProvider } = await import('@/server/lib/oauth');
const { oauthCallbackService } = await import('@/server/services/oauth.service');
const { oauthNativeService } = await import('@/server/services/oauth-native.service');
const { completePasswordResetService } = await import('@/server/services/password-reset.service');
const { pollDeviceAuthService } = await import('@/server/services/device-auth.service');

type DevicePayload = typeof authDeviceRegisteredEvent._payload;

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const NEW_PASSWORD = 'BrandNewPassword456!';
const GOOGLE_ISS = 'https://accounts.google.com';
const USER_AGENT = 'DeviceEventSuite/1.0';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const NATIVE_CLIENT_ID = 'ios.example.com';

describe.skipIf(!dbAvailable)('device-registered event (case table 7a)', () =>
{
    let app: Hono;
    let seen: DevicePayload[];
    let unsubscribe: () => void;
    let testIndex = 0;
    let clientIp: string;
    let jwksPublicKey: CryptoKey;
    let jwksPrivateKey: CryptoKey;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        // The web callback stores the provider's tokens, which are encrypted at rest.
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString('base64')}`;

        // The helper mounts `authenticate` as a server-level middleware, which the
        // rows driving an authenticated route (approve, rotate, enroll) need.
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        sendEmail.mockClear();

        testIndex += 1;
        clientIp = `198.51.100.${testIndex & 0xff}`;

        seen = [];
        unsubscribe = authDeviceRegisteredEvent.subscribe((payload) =>
        {
            seen.push(payload);
        });

        const pair = await generateJoseKeyPair('RS256');
        jwksPrivateKey = pair.privateKey;
        jwksPublicKey = pair.publicKey;
        vi.mocked(createRemoteJWKSet).mockReturnValue((async () => jwksPublicKey) as never);
        vi.stubEnv('SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS', NATIVE_CLIENT_ID);
    });

    afterEach(() =>
    {
        // The event is a module singleton and every suite in this package runs in
        // one fork, so a handler left behind would collect another file's rows.
        unsubscribe();
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function post(path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = {
            ...JSON_HEADERS,
            'x-forwarded-for': clientIp,
            'user-agent': USER_AGENT,
        };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    /**
     * Let the after-commit queue drain.
     *
     * The runner fires those callbacks without awaiting them, deliberately — a
     * subscriber must not be able to hold a request open — so a row that read the
     * capture on the next line would be reading it before the emit ran.
     */
    async function settled(): Promise<void>
    {
        await new Promise((resolve) => setTimeout(resolve, 30));
    }

    function deviceKeyBody(overrides: Record<string, unknown> = {})
    {
        const key = generateKeyPair('ES256');

        return {
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            ...overrides,
        };
    }

    async function seedUser(email: string)
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: userRole!.id,
        }).returning();

        return row;
    }

    /** Register through the six-digit-code flow, as `/_auth/register` requires. */
    async function registerViaCode(email: string, key = generateKeyPair('ES256'))
    {
        await post('/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });

        const [codeRow] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);

        const verified = await post('/_auth/codes/verify', {
            target: email, targetType: 'email', code: codeRow.code, purpose: 'registration',
        });
        const { verificationToken } = await verified.json();

        const response = await post('/_auth/register', {
            email,
            verificationToken,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            deviceName: 'register device',
            platform: 'web',
        });

        return { response, key };
    }

    /** Sign in with a password and answer with what a client would then hold. */
    async function signIn(email: string, body: Record<string, unknown> = {})
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            ...body,
        });

        expect(response.status).toBe(200);

        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { key, authorization: `Bearer ${token}` };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys)
            .where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    /** The token from the most recent mail of a template. */
    function emailedToken(template: string): string
    {
        const sent = sendEmail.mock.calls.filter(([arg]) => arg?.template === template);
        const call = sent[sent.length - 1];

        if (!call)
        {
            throw new Error(`no ${template} email was sent`);
        }

        return new URL(call[0].data.confirmUrl).searchParams.get('token')!;
    }

    /**
     * A provider that answers a code exchange without leaving the process.
     *
     * Registered under `superself`, which no built-in provider occupies: the
     * registry is a module singleton shared by every suite in this fork, so
     * overriding `google` would take native sign-in's real verifier with it.
     */
    function registerMockProvider(email: string | null, providerUserId: string)
    {
        registerOAuthProvider({
            id: 'superself',
            isEnabled: () => true,
            getAuthUrl: (state: string) => `https://mock.example.com/auth?state=${state}`,
            exchangeCodeForTokens: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
            getUserInfo: async () => ({ providerUserId, email, emailVerified: email !== null }),
        });
    }

    /** A native id_token the real verifier accepts, bound to the key it enrolls. */
    async function nativeIdToken(subject: string, email: string, fingerprint: string): Promise<string>
    {
        return await new SignJWT({ email, email_verified: true, nonce: fingerprint })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(GOOGLE_ISS)
            .setAudience(NATIVE_CLIENT_ID)
            .setSubject(subject)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(jwksPrivateKey);
    }

    // ========================================================================
    // 7a — channel x key state
    // ========================================================================

    it('register (createVerifiedAccount <- registerService), new keyId: one emission, channel register, ip and userAgent from the request headers', async () =>
    {
        const { response, key } = await registerViaCode('a1@test.com');
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            keyId: key.keyId,
            channel: 'register',
            ip: clientIp,
            userAgent: USER_AGENT,
            deviceName: 'register device',
            platform: 'web',
            algorithm: 'ES256',
        });
        expect(seen[0].fingerprintPrefix).toBe(key.fingerprint.slice(0, 12));
    });

    it('signup-link (createVerifiedAccount <- completeSignupService), new keyId: one emission, channel signup-link', async () =>
    {
        expect((await post('/_auth/signup/email', { email: 'a2@test.com' })).status).toBe(200);

        const confirmed = await post('/_auth/signup/email/confirm', { token: emailedToken('signup-link') });
        const { setupSecret } = await confirmed.json();
        const body = deviceKeyBody();

        const response = await post('/_auth/signup/password', { setupSecret, password: PASSWORD, ...body });
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: body.keyId, channel: 'signup-link' });
    });

    it('invitation (acceptInvitation, keysRepository.create directly), new keyId: one emission, channel invitation, after the commit', async () =>
    {
        const inviter = await seedUser('a3-inviter@test.com');
        const userRole = await getRoleByName('user');
        const token = '11111111-1111-4111-8111-111111111111';

        await getTestDb().insert(userInvitations).values({
            email: 'a3@test.com',
            token,
            roleId: userRole!.id,
            invitedBy: inviter.id,
            status: 'pending',
            expiresAt: new Date(Date.now() + 86_400_000),
        });

        const body = deviceKeyBody();
        const response = await post('/_auth/invitations/accept', { token, password: PASSWORD, ...body });
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: body.keyId, channel: 'invitation', ip: clientIp });
        // After the commit: the account the key belongs to is readable by now.
        expect(await keyRow(body.keyId)).toBeDefined();
    });

    it('password (loginService), new keyId: one emission, channel password', async () =>
    {
        await seedUser('a4@test.com');

        const { key } = await signIn('a4@test.com');
        await settled();

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: key.keyId, channel: 'password', ip: clientIp });
    });

    it('password with oldKeyId naming the caller\'s own active key: no emission, revokeKeyService returned true', async () =>
    {
        await seedUser('a5@test.com');
        const first = await signIn('a5@test.com');

        seen.length = 0;
        const second = await signIn('a5@test.com', { oldKeyId: first.key.keyId });
        await settled();

        expect(seen).toHaveLength(0);
        expect((await keyRow(second.key.keyId)).isActive).toBe(true);
        expect((await keyRow(first.key.keyId)).isActive).toBe(false);
    });

    it('password with oldKeyId naming someone else\'s key, an already-revoked key or no key at all: one emission each, nothing was revoked so it is not a rotation', async () =>
    {
        await seedUser('a6@test.com');
        await seedUser('a6-other@test.com');

        const other = await signIn('a6-other@test.com');
        const own = await signIn('a6@test.com');
        await post('/_auth/keys/revoke', { keyId: own.key.keyId }, own.authorization);

        seen.length = 0;

        for (const oldKeyId of [other.key.keyId, own.key.keyId, 'no-such-key-id'])
        {
            const { key } = await signIn('a6@test.com', { oldKeyId });
            await settled();

            expect(seen.map((payload) => payload.keyId)).toContain(key.keyId);
        }

        expect(seen).toHaveLength(3);
        expect(seen.every((payload) => payload.channel === 'password')).toBe(true);
        // The key that was not the caller's is still the other account's, live.
        expect((await keyRow(other.key.keyId)).isActive).toBe(true);
    });

    it('passkey with oldKeyId: the login rule, no emission when a key was revoked and one when none was', async () =>
    {
        await seedUser('a7@test.com');
        const session = await signIn('a7@test.com');

        seen.length = 0;

        // Passkey sign-in reaches the same `startSession` tail as a password
        // login, so the rule is exercised through the key service either way —
        // driven here through the login route, which is the tail's other caller,
        // because a WebAuthn ceremony adds nothing to what this row is about.
        const revoking = await signIn('a7@test.com', { oldKeyId: session.key.keyId });
        await settled();
        expect(seen).toHaveLength(0);

        const notRevoking = await signIn('a7@test.com', { oldKeyId: 'never-registered' });
        await settled();

        expect(seen).toHaveLength(1);
        expect(seen[0].keyId).toBe(notRevoking.key.keyId);
        expect((await keyRow(revoking.key.keyId)).isActive).toBe(true);
    });

    it('password, re-registering the caller\'s own active keyId: no emission, the service returns early', async () =>
    {
        await seedUser('a8@test.com');
        const { key } = await signIn('a8@test.com');

        seen.length = 0;
        const response = await post('/_auth/login', {
            email: 'a8@test.com',
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(0);
    });

    it('password, re-registering the caller\'s own expired-but-active keyId: no emission, only the expiry is extended', async () =>
    {
        await seedUser('a9@test.com');
        const { key } = await signIn('a9@test.com');

        const past = new Date(Date.now() - 60_000);
        await getTestDb().update(userPublicKeys).set({ expiresAt: past })
            .where(eq(userPublicKeys.keyId, key.keyId));

        seen.length = 0;
        const response = await post('/_auth/login', {
            email: 'a9@test.com',
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(0);
        expect((await keyRow(key.keyId)).expiresAt!.getTime()).toBeGreaterThan(past.getTime());
    });

    it('oauth (oauthCallbackService), new keyId: one emission, no deviceName or platform, ip of the browser that came back', async () =>
    {
        registerMockProvider('a10@test.com', 'oauth-user-10');

        const key = generateKeyPair('ES256');
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'superself',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: 'ES256',
            nonce,
        });

        await oauthCallbackService({
            provider: 'superself',
            code: 'auth-code',
            state,
            expectedNonce: [nonce],
            ip: clientIp,
            userAgent: USER_AGENT,
        });
        await settled();

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: key.keyId, channel: 'oauth', ip: clientIp });
        // The sealed state carries no device label, so this channel never has one.
        expect(seen[0].deviceName).toBeUndefined();
        expect(seen[0].platform).toBeUndefined();
    });

    it('oauth-native (oauthNativeService), new keyId: one emission, inside runInTransaction so it lands after the commit', async () =>
    {
        const key = generateKeyPair('ES256');

        await oauthNativeService({
            provider: 'google',
            idToken: await nativeIdToken('native-user-11', 'a11@test.com', key.fingerprint),
            nonce: key.fingerprint,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: 'ES256',
            deviceName: 'phone',
            platform: 'ios',
            ip: clientIp,
            userAgent: USER_AGENT,
        });
        await settled();

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
            keyId: key.keyId,
            channel: 'oauth-native',
            deviceName: 'phone',
            platform: 'ios',
        });
        expect(await keyRow(key.keyId)).toBeDefined();
    });

    it('device-code (pollDeviceAuthService), new keyId: one emission, ip of the polling device rather than the approving one', async () =>
    {
        await seedUser('a12@test.com');
        const session = await signIn('a12@test.com');

        const device = generateKeyPair('ES256');
        const started = await post('/_auth/device/start', {
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
            deviceName: 'Living room TV',
            platform: 'desktop',
        });
        const { deviceCode, userCode } = await started.json();

        expect((await post('/_auth/device/approve', { userCode }, session.authorization)).status).toBe(200);

        seen.length = 0;
        clientIp = '203.0.113.77';
        const polled = await post('/_auth/device/poll', { deviceCode });
        await settled();

        expect(polled.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: device.keyId, channel: 'device-code', ip: '203.0.113.77' });
    });

    it('device-link (pollDeviceLinkService), new keyId: one emission, channel device-link, ip of the polling device', async () =>
    {
        await seedUser('a12l@test.com');
        const session = await signIn('a12l@test.com');

        const issued = await post('/_auth/device/link/issue', {}, session.authorization);
        const { linkId, userCode } = await issued.json();

        const device = generateKeyPair('ES256');
        const redeemed = await post('/_auth/device/link/redeem', {
            userCode,
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
            deviceName: 'Pocket phone',
            platform: 'ios',
        });
        const { deviceCode, matchNumber } = await redeemed.json();

        const confirmed = await post('/_auth/device/link/confirm', { linkId, choice: matchNumber }, session.authorization);
        expect(confirmed.status).toBe(200);

        seen.length = 0;
        clientIp = '203.0.113.78';
        const polled = await post('/_auth/device/link/poll', { deviceCode });
        await settled();

        expect(polled.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: device.keyId, channel: 'device-link', ip: '203.0.113.78' });
    });

    it('password-reset (completePasswordResetService), new keyId: one emission, channel password-reset', async () =>
    {
        await seedUser('a13@test.com');

        expect((await post('/_auth/password/reset', { email: 'a13@test.com' })).status).toBe(200);
        const confirmed = await post('/_auth/password/reset/confirm', { token: emailedToken('password-reset') });
        const { setupSecret } = await confirmed.json();

        seen.length = 0;
        const body = deviceKeyBody();
        const response = await post('/_auth/password/reset/complete', { setupSecret, password: NEW_PASSWORD, ...body });
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: body.keyId, channel: 'password-reset' });
    });

    it('password-reset whose transaction rolls back after the key row is written: no emission', async () =>
    {
        await seedUser('a14@test.com');

        expect((await post('/_auth/password/reset', { email: 'a14@test.com' })).status).toBe(200);
        const confirmed = await post('/_auth/password/reset/confirm', { token: emailedToken('password-reset') });
        const { setupSecret } = await confirmed.json();

        seen.length = 0;
        const body = deviceKeyBody();

        // What losing the claim race does, made deterministic: the service runs to
        // the end, writing the key row, and the transaction then rolls back.
        await expect(runInTransaction(async () =>
        {
            await completePasswordResetService({ setupSecret, password: NEW_PASSWORD, ...body });

            throw new Error('rolled back after the key row was written');
        })).rejects.toThrow('rolled back');
        await settled();

        expect(seen).toHaveLength(0);
        expect(await keyRow(body.keyId)).toBeUndefined();
    });

    it('device-code whose poll transaction rolls back after the key row is written: no emission, for the same reason', async () =>
    {
        await seedUser('a15@test.com');
        const session = await signIn('a15@test.com');

        const device = generateKeyPair('ES256');
        const started = await post('/_auth/device/start', {
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
        });
        const { deviceCode, userCode } = await started.json();
        await post('/_auth/device/approve', { userCode }, session.authorization);

        seen.length = 0;

        await expect(runInTransaction(async () =>
        {
            await pollDeviceAuthService({ deviceCode, ip: clientIp, userAgent: USER_AGENT });

            throw new Error('rolled back after the key row was written');
        })).rejects.toThrow('rolled back');
        await settled();

        expect(seen).toHaveLength(0);
        expect(await keyRow(device.keyId)).toBeUndefined();
    });

    it('passkey (finishPasskeyLoginService), new keyId: one emission, channel passkey', async () =>
    {
        const { FixtureAuthenticator } = await import('../helpers/webauthn-fixture');

        await seedUser('a16@test.com');
        const session = await signIn('a16@test.com');

        const authenticator = await FixtureAuthenticator.create();
        const registerChallenge = (await (await post('/_auth/passkeys/register/options', {}, session.authorization)).json()).challenge;

        expect((await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: registerChallenge, origin: ORIGIN, rpId: RP_ID }),
        }, session.authorization)).status).toBe(200);

        const loginChallenge = (await (await post('/_auth/passkeys/login/options', {})).json()).challenge;

        seen.length = 0;
        const body = deviceKeyBody();
        const response = await post('/_auth/passkeys/login/verify', {
            response: authenticator.assert({ challenge: loginChallenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
            ...body,
        });
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ keyId: body.keyId, channel: 'passkey', ip: clientIp });
    });

    it('any channel, a keyId already registered to another account: no emission, KeyIdAlreadyRegisteredError', async () =>
    {
        await seedUser('a17@test.com');
        await seedUser('a17-other@test.com');
        const other = await signIn('a17-other@test.com');

        seen.length = 0;
        const mine = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'a17@test.com',
            password: PASSWORD,
            publicKey: mine.publicKey,
            keyId: other.key.keyId,
            fingerprint: mine.fingerprint,
            algorithm: 'ES256',
        });
        await settled();

        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('KeyIdAlreadyRegisteredError');
        expect(seen).toHaveLength(0);
    });

    it('any channel, a fingerprint or an algorithm that does not match the key: no emission, both checks run before the row is written', async () =>
    {
        await seedUser('a18@test.com');
        const ec = generateKeyPair('ES256');
        const rsa = generateKeyPair('RS256');

        const wrongFingerprint = await post('/_auth/login', {
            email: 'a18@test.com',
            password: PASSWORD,
            publicKey: ec.publicKey,
            keyId: ec.keyId,
            fingerprint: 'f'.repeat(64),
            algorithm: 'ES256',
        });

        const wrongAlgorithm = await post('/_auth/login', {
            email: 'a18@test.com',
            password: PASSWORD,
            publicKey: rsa.publicKey,
            keyId: rsa.keyId,
            fingerprint: rsa.fingerprint,
            algorithm: 'ES256',
        });
        await settled();

        expect((await wrongFingerprint.json()).error.code).toBe('InvalidKeyFingerprintError');
        expect((await wrongAlgorithm.json()).error.code).toBe('KeyAlgorithmMismatchError');
        expect(seen).toHaveLength(0);
    });

    it('rotateKeyService: no emission, rotation does not pass through the registration service at all', async () =>
    {
        await seedUser('a19@test.com');
        const session = await signIn('a19@test.com');

        seen.length = 0;
        const rotated = deviceKeyBody();
        const response = await post('/_auth/keys/rotate', rotated, session.authorization);
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toHaveLength(0);
        expect((await keyRow(rotated.keyId as string)).isActive).toBe(true);
    });

    it('a subscriber that throws: the registration still answers 200 and the error is logged, not raised', async () =>
    {
        const unsubscribeThrower = authDeviceRegisteredEvent.subscribe(() =>
        {
            throw new Error('subscriber exploded');
        });

        try
        {
            await seedUser('a20@test.com');
            const { key } = await signIn('a20@test.com');
            await settled();

            expect((await keyRow(key.keyId)).isActive).toBe(true);
            expect(seen).toHaveLength(1);
        }
        finally
        {
            unsubscribeThrower();
        }
    });

    it('every channel: userId is carried as String(userId)', async () =>
    {
        await seedUser('a21@test.com');
        await signIn('a21@test.com');
        await settled();

        const [user] = await getTestDb().select().from(users).where(eq(users.email, 'a21@test.com')).limit(1);

        expect(seen).toHaveLength(1);
        expect(typeof seen[0].userId).toBe('string');
        expect(seen[0].userId).toBe(String(user.id));
        expect(typeof seen[0].createdAtMillis).toBe('number');
    });
});
