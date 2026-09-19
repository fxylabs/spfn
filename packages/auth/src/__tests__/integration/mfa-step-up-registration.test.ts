/**
 * @spfn/auth - New-Device Step-Up Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one `it` per row of case
 * table 6b in the #95 design, in table order and named for the row.
 *
 * The first row is the one the whole feature is answerable to: an account with
 * no second factor registers a device exactly as it did before, on every
 * channel. The rest are about which channels stop an enrolled account's new
 * device and which do not — and about what a 202 must NOT have moved, since a
 * login event or a `lastLoginAt` produced by a stolen password is the opposite
 * of the notice this feature exists to give.
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaChallenges, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { createOAuthState } from '@/server/lib/oauth/state';
import { registerOAuthProvider, type OAuthProvider } from '@/server/lib/oauth';
import { authDeviceRegisteredEvent, authLoginEvent, authRegisterEvent } from '@/server/events';
import { authenticate } from '@/server/middleware/authenticate';
import { sweepMfaChallengesService } from '@/server/services/mfa.service';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args) };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'Password456!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 9).toString('base64')}`;
const PROVIDER = 'superself';

/** A session: what to sign requests with, and the device key it is carried by. */
interface Session
{
    authorization: string;
    keyId: string;
    privateKey: string;
    publicKey: string;
    fingerprint: string;
}

/**
 * The provider the OAuth rows below sign in through. Verifies nothing real.
 *
 * A verified email is what makes `createOrLinkUser` link to the account already
 * in the table rather than create a second one — which is the difference between
 * the "existing user" row and the "brand-new account" row.
 */
function mockProvider(providerUserId: string, email: string | null): OAuthProvider
{
    return {
        id: PROVIDER,
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://mock.example.com/auth?state=${state}`,
        exchangeCodeForTokens: async () => ({ accessToken: 'mock-access', expiresIn: 3600 }),
        getUserInfo: async () => ({ providerUserId, email, emailVerified: email !== null }),
    };
}

describe.skipIf(!dbAvailable)('new-device step-up (case table 6b)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        process.env.SPFN_APP_URL = ORIGIN;

        registerOAuthProvider(mockProvider('social-owner', 'owner@test.com'));

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        delete process.env.SPFN_APP_URL;
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();

        const userRole = await getRoleByName('user');
        await db.insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function post(path: string, body: unknown, authorization?: string)
    {
        return app.request(path, {
            method: 'POST',
            headers: authorization ? { ...JSON_HEADERS, Authorization: authorization } : JSON_HEADERS,
            body: JSON.stringify(body),
        });
    }

    function put(path: string, body: unknown, authorization: string)
    {
        return app.request(path, {
            method: 'PUT',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify(body),
        });
    }

    function sessionFor(keyPair: ReturnType<typeof generateKeyPair>): Session
    {
        return {
            authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
                expiresIn: '5m',
            })}`,
            keyId: keyPair.keyId,
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            fingerprint: keyPair.fingerprint,
        };
    }

    /** A password sign-in, on a fresh device key unless one is handed in. */
    async function signIn(overrides: { keyPair?: ReturnType<typeof generateKeyPair>; oldKeyId?: string } = {})
    {
        const keyPair = overrides.keyPair ?? generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'owner@test.com',
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            ...(overrides.oldKeyId ? { oldKeyId: overrides.oldKeyId } : {}),
        });

        return { response, session: sessionFor(keyPair) };
    }

    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    /** Enrol a TOTP second factor; the confirming device is verified by it. */
    async function enrolled(session: Session): Promise<string>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);

        expect(enroll.status).toBe(200);

        const secret = (await enroll.json()).secret as string;

        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization)).status)
            .toBe(200);

        return secret;
    }

    function capture<TPayload>(event: { subscribe: (handler: (payload: TPayload) => void) => unknown }): TPayload[]
    {
        const seen: TPayload[] = [];
        event.subscribe((payload) => void seen.push(payload));

        return seen;
    }

    /** Events are emitted after commit, which is a tick later than the response. */
    function settle(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, 40));
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId));

        return row;
    }

    async function userRow()
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, 'owner@test.com'));

        return row;
    }

    /** Drive the web OAuth callback the way a provider redirect would. */
    async function oauthCallback(keyPair: ReturnType<typeof generateKeyPair>): Promise<Response>
    {
        const nonce = 'csrf-nonce-for-the-callback';
        const state = await createOAuthState({
            provider: PROVIDER,
            returnUrl: '/',
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            nonce,
        });

        return await app.request(`/_auth/oauth/${PROVIDER}/callback?code=x&state=${encodeURIComponent(state)}`, {
            headers: { Cookie: `spfn_oauth_csrf=${nonce}` },
        });
    }

    // ========================================================================
    // 6b — which channels stop a new device
    // ========================================================================

    it('row: unenrolled, every channel, a new key — exactly today\'s answer, events carry mfaEnrolled false', async () =>
    {
        const logins = capture<Record<string, unknown>>(authLoginEvent);
        const devices = capture<Record<string, unknown>>(authDeviceRegisteredEvent);

        const password = await signIn();
        expect(password.response.status).toBe(200);
        expect((await password.response.json()).mfaRequired).toBe(false);

        const oauth = await oauthCallback(generateKeyPair('ES256'));
        expect(oauth.status).toBe(302);
        expect(oauth.headers.get('location')).not.toContain('mfaChallenge');

        await settle();

        expect(logins.every(event => event.mfaEnrolled === false)).toBe(true);
        expect(devices.every(event => event.mfaEnrolled === false)).toBe(true);
        expect(await keyRow(password.session.keyId)).toMatchObject({ isActive: true, pendingMfaChallengeId: null });
    });

    it('row: enrolled, password, a new key — 202, key inactive, no login event, lastLoginAt unmoved, no device event', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const before = (await userRow()).lastLoginAt;
        const logins = capture<Record<string, unknown>>(authLoginEvent);
        const devices = capture<Record<string, unknown>>(authDeviceRegisteredEvent);

        const second = await signIn();

        expect(second.response.status).toBe(202);

        const body = await second.response.json();
        expect(body.mfaRequired).toBe(true);
        expect(typeof body.challenge.secret).toBe('string');
        expect(body.challenge.expiresAtMillis).toBeGreaterThan(Date.now());
        expect(body.userId).toBeUndefined();

        await settle();

        expect(await keyRow(second.session.keyId)).toMatchObject({ isActive: false });
        expect((await keyRow(second.session.keyId)).pendingMfaChallengeId).not.toBeNull();
        expect(logins).toHaveLength(0);
        expect(devices).toHaveLength(0);
        expect((await userRow()).lastLoginAt?.getTime()).toBe(before?.getTime());
    });

    it('row: enrolled, password, re-registering an existing active key — 200', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const first = await signIn({ keyPair });
        await enrolled(first.session);

        // The same device signing in again. Its key is already active, so there is
        // no new device to challenge and the early return answers as it always did.
        const again = await signIn({ keyPair });

        expect(again.response.status).toBe(200);
        expect((await again.response.json()).mfaRequired).toBe(false);
    });

    it('row: enrolled, password with oldKeyId naming their own key, a new key — 200 (a rotation)', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const rotated = await signIn({ oldKeyId: first.session.keyId });

        expect(rotated.response.status).toBe(200);
        expect((await rotated.response.json()).mfaRequired).toBe(false);
        expect(await keyRow(rotated.session.keyId)).toMatchObject({ isActive: true });
    });

    it('row: enrolled, password retried with the same keyId while the challenge lives — 202, the same challenge', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const keyPair = generateKeyPair('ES256');
        const opened = await signIn({ keyPair });
        const retried = await signIn({ keyPair });

        expect(opened.response.status).toBe(202);
        expect(retried.response.status).toBe(202);

        // The same row, not a second one and not a 409: the retry inherits the
        // expiry already ticking and the attempts already spent. Only the secret
        // is new, because the first was never stored.
        const rows = await getTestDb().select().from(mfaChallenges);
        expect(rows).toHaveLength(1);
        expect((await retried.response.json()).challenge.expiresAtMillis)
            .toBe((await opened.response.json()).challenge.expiresAtMillis);
    });

    it('row: enrolled, oauth-native, a new key — 202', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const keyPair = generateKeyPair('ES256');
        const provider = mockProvider('social-owner', 'owner@test.com');

        provider.verifyNativeIdToken = async () => ({
            providerUserId: 'social-owner',
            email: 'owner@test.com',
            emailVerified: true,
        });
        registerOAuthProvider(provider);

        const response = await post(`/_auth/oauth/${PROVIDER}/native`, {
            idToken: 'id.token.value',
            nonce: keyPair.fingerprint,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(response.status).toBe(202);
        expect((await response.json()).mfaRequired).toBe(true);
    });

    it('row: enrolled, web oauth on an existing user, a new key — 302 carrying mfaChallenge, no events', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const logins = capture<Record<string, unknown>>(authLoginEvent);
        const devices = capture<Record<string, unknown>>(authDeviceRegisteredEvent);
        const keyPair = generateKeyPair('ES256');

        const response = await oauthCallback(keyPair);
        const location = new URL(response.headers.get('location')!, ORIGIN);

        expect(response.status).toBe(302);
        expect(location.searchParams.get('mfaChallenge')).toBeTruthy();
        expect(location.searchParams.get('userId')).toBeNull();
        expect(location.searchParams.get('keyId')).toBeNull();

        await settle();

        expect(logins).toHaveLength(0);
        expect(devices).toHaveLength(0);
        expect(await keyRow(keyPair.keyId)).toMatchObject({ isActive: false });
    });

    it('row: a newly created oauth account on either flow — today\'s answer, one register event', async () =>
    {
        const registers = capture<Record<string, unknown>>(authRegisterEvent);
        const keyPair = generateKeyPair('ES256');

        registerOAuthProvider(mockProvider('brand-new-social', null));

        const response = await oauthCallback(keyPair);
        const location = new URL(response.headers.get('location')!, ORIGIN);

        // A user row `createOrLinkUser` has just written has no second factor to
        // ask for, so the new-account branch needs no exemption of its own.
        expect(location.searchParams.get('mfaChallenge')).toBeNull();
        expect(location.searchParams.get('userId')).toBeTruthy();

        await settle();

        expect(registers).toHaveLength(1);
        expect(await keyRow(keyPair.keyId)).toMatchObject({ isActive: true });

        registerOAuthProvider(mockProvider('social-owner', 'owner@test.com'));
    });

    it('row: enrolled, device-code, a new key — 200, because the approving device is the second factor', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const device = generateKeyPair('ES256');
        const started = await post('/_auth/device/start', {
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
        });
        const { deviceCode, userCode } = await started.json();

        expect((await post('/_auth/device/approve', { userCode }, first.session.authorization)).status).toBe(200);

        const polled = await post('/_auth/device/poll', { deviceCode });

        expect(polled.status).toBe(200);
        expect(await keyRow(device.keyId)).toMatchObject({ isActive: true });
    });

    it('row: enrolled, passkey, a new key — 200, because the assertion is itself a second factor', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, first.session.authorization);

        expect((await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
            }),
        }, first.session.authorization)).status).toBe(200);

        const loginOptions = await post('/_auth/passkeys/login/options', {});
        const device = generateKeyPair('ES256');
        const login = await post('/_auth/passkeys/login/verify', {
            response: authenticator.assert({
                challenge: (await loginOptions.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: 1,
            }),
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
        });

        expect(login.status).toBe(200);
        expect((await login.json()).mfaRequired).toBe(false);
    });

    it('row: enrolled, register / signup-link / invitation, a new key — 200, an account being created has nothing enrolled', async () =>
    {
        // Registration channels create the account, so the account they register
        // a key for is by construction unenrolled. The rule is enforced by the
        // channel list rather than by timing, which is what this pins.
        const { MFA_CHALLENGE_CHANNELS } = await import('@/server/entities/mfa-challenges');

        expect(MFA_CHALLENGE_CHANNELS).not.toContain('register');
        expect(MFA_CHALLENGE_CHANNELS).not.toContain('signup-link');
        expect(MFA_CHALLENGE_CHANNELS).not.toContain('invitation');

        const first = await signIn();
        await enrolled(first.session);

        // And a fresh account still registers normally beside the enrolled one.
        const codes = await post('/_auth/codes', {
            target: 'newcomer@test.com',
            targetType: 'email',
            purpose: 'registration',
        });

        expect(codes.status).toBe(200);
    });

    it('row: enrolled, password-reset, a new key — 202, and the revoke-all has already run', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        expect((await post('/_auth/password/reset', { email: 'owner@test.com' })).status).toBe(200);

        const confirmed = await post('/_auth/password/reset/confirm', { token: emailedToken() });

        expect(confirmed.status).toBe(200);

        const keyPair = generateKeyPair('ES256');
        const completed = await post('/_auth/password/reset/complete', {
            setupSecret: (await confirmed.json()).setupSecret,
            password: NEW_PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(completed.status).toBe(202);
        expect((await completed.json()).mfaRequired).toBe(true);

        // Signed out everywhere with the reset unfinished — the documented state.
        // The revoke-all runs before the key is registered and is not rolled back
        // by a step-up nobody completes.
        expect(await keyRow(first.session.keyId)).toMatchObject({ isActive: false });
        expect(await keyRow(keyPair.keyId)).toMatchObject({ isActive: false });
    });

    it('row: enrolled, a global revocation after the 202 — the pending key is deleted, its challenge expired, verify 401', async () =>
    {
        const first = await signIn();
        const secret = await enrolled(first.session);

        // `revokeAllKeys`, the signed sign-out-everywhere link and a password
        // reset all run the same `revokeActive` statement, so one of them stands
        // for the set; `changePassword` is the second caller and follows it.
        // Both are made from `first`, which revoke-all spares by default and
        // which the enrolment already stepped up.
        const viaRevokeAll = await signIn();
        const revokeAllChallenge = (await viaRevokeAll.response.json()).challenge.secret;

        expect((await post('/_auth/keys/revoke-all', {}, first.session.authorization)).status).toBe(200);
        expect(await keyRow(viaRevokeAll.session.keyId)).toBeUndefined();
        expect((await post('/_auth/mfa/verify', { challenge: revokeAllChallenge, code: codeFor(secret, 1) })).status)
            .toBe(401);

        const viaChangePassword = await signIn();
        const changePasswordChallenge = (await viaChangePassword.response.json()).challenge.secret;

        expect((await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, first.session.authorization)).status).toBe(204);

        expect(await keyRow(viaChangePassword.session.keyId)).toBeUndefined();
        expect((await post('/_auth/mfa/verify', {
            challenge: changePasswordChallenge,
            code: codeFor(secret, 2),
        })).status).toBe(401);
    });

    it('row: enrolled, ten minutes after the 202 — the sweep takes the pending key and its challenge', async () =>
    {
        const first = await signIn();
        await enrolled(first.session);

        const abandoned = await signIn();
        expect(abandoned.response.status).toBe(202);

        const db = getTestDb();
        await db.update(mfaChallenges).set({ expiresAt: new Date(Date.now() - 1000) });

        const { deleted } = await sweepMfaChallengesService();

        expect(deleted).toBe(1);
        expect(await keyRow(abandoned.session.keyId)).toBeUndefined();
        expect(await db.select().from(mfaChallenges)).toHaveLength(0);
    });

    /** The plaintext token out of the most recent password-reset mail. */
    function emailedToken(): string
    {
        const sent = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset');
        const url = new URL(sent[sent.length - 1][0].data.confirmUrl);

        return url.searchParams.get('token')!;
    }
});
