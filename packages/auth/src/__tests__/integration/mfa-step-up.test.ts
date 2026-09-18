/**
 * @spfn/auth - Step-Up Window Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one `it` per row of case
 * table 6d in the #95 design, in table order and named for the row.
 *
 * The first two rows are the ones the whole feature is answerable to: an account
 * with no second factor sees exactly today's behaviour on every route the gate
 * was added to. The rest are about the enrolled account and the window its
 * device keeps.
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaVerifications, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate } from '@/server/middleware/authenticate';

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

/** A session: what to sign requests with, and the device key it is carried by. */
interface Session
{
    authorization: string;
    keyId: string;
    privateKey: string;
}

describe.skipIf(!dbAvailable)('MFA step-up window (case table 6d)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

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

    function bearerFor(keyId: string, privateKey: string): string
    {
        return `Bearer ${generateClientToken({ keyId }, privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    async function signIn(email = 'owner@test.com'): Promise<Session>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(response.status).toBe(200);

        return {
            authorization: bearerFor(keyPair.keyId, keyPair.privateKey),
            keyId: keyPair.keyId,
            privateKey: keyPair.privateKey,
        };
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
        const confirm = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);

        expect(confirm.status).toBe(200);

        return secret;
    }

    /** Move this device's verification back in time, or remove it entirely. */
    async function ageVerification(session: Session, minutes: number | null): Promise<void>
    {
        const db = getTestDb();

        if (minutes === null)
        {
            await db.delete(mfaVerifications).where(eq(mfaVerifications.keyId, session.keyId));

            return;
        }

        await db
            .update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(mfaVerifications.keyId, session.keyId));
    }

    async function ageSession(session: Session, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(userPublicKeys.keyId, session.keyId));
    }

    async function verificationRow(keyId: string)
    {
        const [row] = await getTestDb()
            .select()
            .from(mfaVerifications)
            .where(eq(mfaVerifications.keyId, keyId))
            .limit(1);

        return row;
    }

    /** A second session on the same account, registered through the device-code flow. */
    async function signInByDeviceCode(approver: Session): Promise<Session>
    {
        const device = generateKeyPair('ES256');
        const started = await post('/_auth/device/start', {
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
        });
        const { deviceCode, userCode } = await started.json();

        expect((await post('/_auth/device/approve', { userCode }, approver.authorization)).status).toBe(200);
        expect((await post('/_auth/device/poll', { deviceCode })).status).toBe(200);

        return {
            authorization: bearerFor(device.keyId, device.privateKey),
            keyId: device.keyId,
            privateKey: device.privateKey,
        };
    }

    /** A session started by a passkey sign-in, which registers a device key of its own. */
    async function signInByPasskey(session: Session): Promise<Session>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const registration = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
            }),
        }, session.authorization);

        expect(registration.status).toBe(200);

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

        return {
            authorization: bearerFor(device.keyId, device.privateKey),
            keyId: device.keyId,
            privateKey: device.privateKey,
        };
    }

    // ========================================================================
    // 6d — the window
    // ========================================================================

    it('row: unenrolled — changePassword and revokeAllKeys answer exactly as today, with no gate', async () =>
    {
        const session = await signIn();
        // Well outside every window there is, so nothing can be passing by luck.
        await ageSession(session, 60);

        expect((await post('/_auth/keys/revoke-all', {}, session.authorization)).status).toBe(200);
        expect((await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, session.authorization)).status).toBe(204);
    });

    it('row: unenrolled — revoking a passkey outside the window is still 403 RECENT_AUTH_REQUIRED', async () =>
    {
        const session = await signIn();
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const registration = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
            }),
        }, session.authorization);
        const { passkeyId } = await registration.json();

        await ageSession(session, 11);

        const response = await post('/_auth/passkeys/revoke', { passkeyId }, session.authorization);

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('RECENT_AUTH_REQUIRED');
    });

    it('row: enrolled, verified five minutes ago — changePassword is 200', async () =>
    {
        const session = await signIn();
        await enrolled(session);
        await ageVerification(session, 5);

        const response = await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, session.authorization);

        expect(response.status).toBe(204);
    });

    it('row: enrolled, never verified on this device though signed in a minute ago — changePassword is 403 STEP_UP_REQUIRED', async () =>
    {
        const session = await signIn();
        await enrolled(session);
        await ageVerification(session, null);

        const response = await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, session.authorization);

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
    });

    it('row: enrolled, outside the window — the current password does not buy changePassword back', async () =>
    {
        const session = await signIn();
        await enrolled(session);
        await ageVerification(session, 30);

        const response = await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, session.authorization);

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
    });

    it('row: enrolled, outside the window — revokeAllKeys is 403 STEP_UP_REQUIRED', async () =>
    {
        const session = await signIn();
        await enrolled(session);
        await ageVerification(session, 30);

        const response = await post('/_auth/keys/revoke-all', {}, session.authorization);

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
    });

    it('row: enrolled, verified and then rotated — the window carries onto the new key, so changePassword is 200', async () =>
    {
        const session = await signIn();
        await enrolled(session);

        const replacement = generateKeyPair('ES256');
        // The old key is the one the request is signed with, so the body names
        // only the new one — the shape the proxy interceptor injects.
        const rotated = await post('/_auth/keys/rotate', {
            publicKey: replacement.publicKey,
            keyId: replacement.keyId,
            fingerprint: replacement.fingerprint,
            algorithm: replacement.algorithm,
        }, session.authorization);

        expect(rotated.status).toBe(200);
        expect(await verificationRow(session.keyId)).toBeUndefined();
        expect(await verificationRow(replacement.keyId)).toBeDefined();

        const response = await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, bearerFor(replacement.keyId, replacement.privateKey));

        expect(response.status).toBe(204);
    });

    it('row: enrolled, just registered by device code — revokeAllKeys is 403, then 200 after mfa/step-up', async () =>
    {
        const session = await signIn();
        const secret = await enrolled(session);
        const tv = await signInByDeviceCode(session);

        const refused = await post('/_auth/keys/revoke-all', {}, tv.authorization);

        expect(refused.status).toBe(403);
        expect((await refused.json()).code).toBe('STEP_UP_REQUIRED');

        // The approval was a second factor for the *registration*, not for a
        // sensitive change — which is what the step-up route exists to answer.
        const steppedUp = await post('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, tv.authorization);

        expect(steppedUp.status).toBe(204);
        expect((await post('/_auth/keys/revoke-all', {}, tv.authorization)).status).toBe(200);
    });

    it('row: enrolled, just registered by a passkey sign-in — revoking a passkey is 403, then allowed after mfa/step-up', async () =>
    {
        const session = await signIn();
        const secret = await enrolled(session);
        const fresh = await signInByPasskey(session);

        const listed = await post('/_auth/passkeys/list', {}, fresh.authorization);
        const { passkeys: [credential] } = await listed.json();

        const refused = await post('/_auth/passkeys/revoke', { passkeyId: credential.passkeyId }, fresh.authorization);

        expect(refused.status).toBe(403);
        expect((await refused.json()).code).toBe('STEP_UP_REQUIRED');

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, fresh.authorization)).status).toBe(204);

        const allowed = await post('/_auth/passkeys/revoke', { passkeyId: credential.passkeyId }, fresh.authorization);

        expect(allowed.status).toBe(200);
    });

    it('row: enrolled, inside the window — mfa/step-up is 204 and refreshes it, and the eleventh call in a minute is 429', async () =>
    {
        const session = await signIn();
        const secret = await enrolled(session);
        await ageVerification(session, 5);

        const before = await verificationRow(session.keyId);
        const response = await post('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, session.authorization);
        const after = await verificationRow(session.keyId);

        expect(response.status).toBe(204);
        expect(after.verifiedAt.getTime()).toBeGreaterThan(before.verifiedAt.getTime());

        // `confirm` shares the policy, so the window already holds two calls.
        // Wrong codes fill the rest; the one past the limit is refused before
        // the code is looked at, rather than answering 401 like the others.
        const statuses: number[] = [];

        for (let attempt = 1; attempt <= 12; attempt += 1)
        {
            statuses.push((await post('/_auth/mfa/step-up', { code: '000000' }, session.authorization)).status);
        }

        expect(statuses).toContain(401);
        expect(statuses).toContain(429);
        // Once refused, it stays refused for the rest of the window.
        expect(statuses.indexOf(429)).toBeLessThan(statuses.lastIndexOf(429));
        expect(statuses.lastIndexOf(401)).toBeLessThan(statuses.indexOf(429));
    });

    it('row: mfa/step-up with two inputs, or with none, is a 400 rather than a refusal', async () =>
    {
        const session = await signIn();
        const secret = await enrolled(session);

        const both = await post('/_auth/mfa/step-up', {
            code: codeFor(secret, 1),
            recoveryCode: 'AAAAA-BBBBB',
        }, session.authorization);
        const neither = await post('/_auth/mfa/step-up', {}, session.authorization);

        expect(both.status).toBe(400);
        expect(neither.status).toBe(400);
    });
});
