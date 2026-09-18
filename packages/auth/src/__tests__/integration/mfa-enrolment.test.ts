/**
 * @spfn/auth - Second Factor Enrolment Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one `it` per row of case
 * table 6a in the #95 design, in table order and named for the row.
 *
 * TOTP codes are produced here with the same primitive the server verifies with
 * (`lib/totp`), from the secret the enrol response handed out — so the happy
 * paths run the real HMAC rather than a stub that would agree with whatever we
 * wrote. The passkey rows use the software authenticator the passkey suite uses.
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaRecoveryCodes, mfaTotp, passkeys, userPublicKeys, users } from '@/server/entities';
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
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const GRACE_KEY = `grace:${Buffer.alloc(32, 8).toString('base64')}`;

/** A session: what to sign requests with, and the device key it is carried by. */
interface Session
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('MFA enrolment (case table 6a)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        process.env.SPFN_AUTH_MFA_ISSUER = 'Acme Test';

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
        delete process.env.SPFN_AUTH_MFA_ISSUER;
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

        const userRole = await getRoleByName('user');
        await db.insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
        await db.insert(users).values({
            email: 'other@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
        // No password, no verified email, no social account: the one account
        // `assertNotLastRecoveryCredential` still refuses to strip.
        await db.insert(users).values({ email: 'social@test.com', roleId: userRole!.id });
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

    function get(path: string, authorization: string)
    {
        return app.request(path, { method: 'GET', headers: { ...JSON_HEADERS, Authorization: authorization } });
    }

    function put(path: string, body: unknown, authorization: string)
    {
        return app.request(path, {
            method: 'PUT',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify(body),
        });
    }

    async function signIn(email: string): Promise<Session>
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
            authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`,
            keyId: keyPair.keyId,
        };
    }

    /** A session on an account with no password, registered directly. */
    async function sessionWithoutPassword(email: string): Promise<Session>
    {
        const user = await userRow(email);
        const keyPair = generateKeyPair('ES256');

        await getTestDb().insert(userPublicKeys).values({
            userId: user.id,
            keyId: keyPair.keyId,
            publicKey: keyPair.publicKey,
            fingerprint: keyPair.fingerprint,
            algorithm: 'ES256',
        });

        return {
            authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`,
            keyId: keyPair.keyId,
        };
    }

    async function userRow(email: string)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, email)).limit(1);

        return row;
    }

    async function totpRow(email: string)
    {
        const user = await userRow(email);
        const [row] = await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, user.id)).limit(1);

        return row;
    }

    /** Push a device key's registration moment into the past, ageing the session. */
    async function ageSession(session: Session, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(userPublicKeys.keyId, session.keyId));
    }

    // ========================================================================
    // The second factor itself
    // ========================================================================

    /** The code for a step some offset away from now, from the secret as issued. */
    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    async function enroll(session: Session): Promise<string>
    {
        const response = await post('/_auth/mfa/totp/enroll', {}, session.authorization);

        expect(response.status).toBe(200);

        return (await response.json()).secret as string;
    }

    /** Enrol and confirm, answering the recovery codes the confirm handed out. */
    async function enrolled(session: Session): Promise<{ secret: string; recoveryCodes: string[] }>
    {
        const secret = await enroll(session);
        const response = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);

        expect(response.status).toBe(200);

        return { secret, recoveryCodes: (await response.json()).recoveryCodes };
    }

    async function status(session: Session)
    {
        const response = await get('/_auth/mfa/status', session.authorization);

        expect(response.status).toBe(200);

        return await response.json();
    }

    /** Prove the second factor on this device with a marked passkey. */
    async function stepUpWithPasskey(
        session: Session,
        authenticator: FixtureAuthenticator,
        counter: number,
    ): Promise<void>
    {
        const options = await post('/_auth/mfa/step-up/options', {}, session.authorization);
        const challenge = (await options.json()).challenge;
        const response = await post('/_auth/mfa/step-up', {
            response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter }),
        }, session.authorization);

        expect(response.status).toBe(204);
    }

    /** Enrol a live passkey and mark it as the account's second factor. */
    async function enrollPasskey(session: Session): Promise<{ passkeyId: string; authenticator: FixtureAuthenticator }>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const challenge = (await options.json()).challenge;
        const verified = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
        }, session.authorization);

        expect(verified.status).toBe(200);

        return { passkeyId: (await verified.json()).passkeyId, authenticator };
    }

    // ========================================================================
    // 6a — enrolment, removal, configuration
    // ========================================================================

    it('row: unenrolled with a recent login key — totp/enroll answers 200 with a secret and a URI', async () =>
    {
        const session = await signIn('owner@test.com');
        const response = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(body.otpauthUri).toContain('otpauth://totp/');
        expect(body.otpauthUri).toContain(encodeURIComponent('Acme Test'));
        // The row carries the ciphertext, never the value it was handed out as.
        expect((await totpRow('owner@test.com')).secretEnc).not.toContain(body.secret);
        expect(await status(session)).toMatchObject({ enrolled: false, methods: [] });
    });

    it('row: unenrolled on an app with no passkey configuration — enroll and changePassword both 200', async () =>
    {
        const session = await signIn('owner@test.com');
        const restore = process.env.SPFN_AUTH_PASSKEY_ORIGINS;

        // An origin that is not the relying party ID, which is a configuration
        // no ceremony could be run with. That is the point of the row: neither
        // route may reach it, so neither may notice.
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = 'https://somewhere-else.example.com';

        try
        {
            const { getPasskeyConfig } = await import('@/server/lib/config');
            expect(() => getPasskeyConfig()).toThrow();

            expect((await post('/_auth/mfa/totp/enroll', {}, session.authorization)).status).toBe(200);
            expect((await put('/_auth/password', {
                currentPassword: PASSWORD,
                newPassword: NEW_PASSWORD,
            }, session.authorization)).status).toBe(204);
        }
        finally
        {
            process.env.SPFN_AUTH_PASSKEY_ORIGINS = restore;
        }
    });

    it('row: OAuth-only account, key older than ten minutes — setting a first password is 200, as today', async () =>
    {
        const session = await sessionWithoutPassword('social@test.com');
        await ageSession(session, 30);

        const response = await put('/_auth/password', { newPassword: NEW_PASSWORD }, session.authorization);

        expect(response.status).toBe(204);
    });

    it('row: unconfirmed — a second enroll replaces the secret', async () =>
    {
        const session = await signIn('owner@test.com');
        const first = await enroll(session);
        const second = await enroll(session);

        expect(second).not.toBe(first);
        // The old secret is gone, so only the new one confirms.
        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(first) }, session.authorization)).status)
            .toBe(401);
        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(second) }, session.authorization)).status)
            .toBe(200);
    });

    it('row: unconfirmed — confirm with the current or a ±1 step code is 200, ten recovery codes, enrolled', async () =>
    {
        for (const offset of [0, -1, 1])
        {
            const session = await signIn('owner@test.com');
            const secret = await enroll(session);
            const response = await post(
                '/_auth/mfa/totp/confirm',
                { code: codeFor(secret, offset) },
                session.authorization,
            );
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.recoveryCodes).toHaveLength(10);
            expect(body.recoveryCodes.every((code: string) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(code))).toBe(true);
            expect(await status(session)).toMatchObject({
                enrolled: true,
                methods: ['totp'],
                recoveryCodesRemaining: 10,
            });

            await getTestDb().delete(mfaTotp);
            await getTestDb().delete(mfaRecoveryCodes);
        }
    });

    it('row: unconfirmed — confirm with a ±2 step code is 401', async () =>
    {
        const session = await signIn('owner@test.com');
        const secret = await enroll(session);

        for (const offset of [-2, 2])
        {
            const response = await post(
                '/_auth/mfa/totp/confirm',
                { code: codeFor(secret, offset) },
                session.authorization,
            );

            expect(response.status).toBe(401);
        }

        expect((await totpRow('owner@test.com')).confirmedAt).toBeNull();
    });

    it('row: unconfirmed — a code carrying spaces and dashes is 200', async () =>
    {
        const session = await signIn('owner@test.com');
        const secret = await enroll(session);
        const code = codeFor(secret);
        const spaced = ` ${code.slice(0, 3)}-${code.slice(3)} `;

        expect((await post('/_auth/mfa/totp/confirm', { code: spaced }, session.authorization)).status).toBe(200);
    });

    it('row: unconfirmed — five failed confirms delete the row, and the sixth says nothing is enrolled', async () =>
    {
        const session = await signIn('owner@test.com');
        await enroll(session);

        for (let attempt = 1; attempt <= 5; attempt += 1)
        {
            const response = await post('/_auth/mfa/totp/confirm', { code: '000000' }, session.authorization);

            expect(response.status).toBe(401);
        }

        expect(await totpRow('owner@test.com')).toBeUndefined();

        const sixth = await post('/_auth/mfa/totp/confirm', { code: '000000' }, session.authorization);

        expect(sixth.status).toBe(400);
        expect((await sixth.json()).error.code).toBe('MfaNotEnrolledError');

        // A fresh enrol is the remedy, and it resets the counter.
        const secret = await enroll(session);
        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization)).status)
            .toBe(200);
    });

    it('row: enrolled — enroll is a 409 rather than a replaced secret', async () =>
    {
        const session = await signIn('owner@test.com');
        await enrolled(session);

        expect((await post('/_auth/mfa/totp/enroll', {}, session.authorization)).status).toBe(409);
    });

    it('row: enrolled inside the window — disable answers 204 and removes everything', async () =>
    {
        const session = await signIn('owner@test.com');
        await enrolled(session);
        const { passkeyId } = await enrollPasskey(session);

        expect((await post('/_auth/mfa/passkey/mark', { passkeyId, secondFactor: true }, session.authorization)).status)
            .toBe(200);

        const response = await post('/_auth/mfa/disable', {}, session.authorization);

        expect(response.status).toBe(204);
        expect(await totpRow('owner@test.com')).toBeUndefined();
        expect(await status(session)).toEqual({ enrolled: false, methods: [], recoveryCodesRemaining: 0 });

        // The credential itself survives — only its second-factor mark went.
        const [row] = await getTestDb().select().from(passkeys).where(eq(passkeys.id, Number(passkeyId)));
        expect(row.revokedAt).toBeNull();
        expect(row.secondFactor).toBe(false);
    });

    it('row: enrolled outside the window — disable is 403 STEP_UP_REQUIRED', async () =>
    {
        const session = await signIn('owner@test.com');
        await enrolled(session);
        await ageVerification(session, 30);

        const response = await post('/_auth/mfa/disable', {}, session.authorization);

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
        expect((await totpRow('owner@test.com')).confirmedAt).not.toBeNull();
    });

    it('row: one passkey, unenrolled — passkey/mark true enrols with methods [passkey]', async () =>
    {
        const session = await signIn('owner@test.com');
        const { passkeyId } = await enrollPasskey(session);

        const response = await post(
            '/_auth/mfa/passkey/mark',
            { passkeyId, secondFactor: true },
            session.authorization,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ enrolled: true, methods: ['passkey'], recoveryCodesRemaining: 0 });
    });

    it('row: somebody else\'s passkey — mark is a 404', async () =>
    {
        const owner = await signIn('owner@test.com');
        const other = await signIn('other@test.com');
        const { passkeyId } = await enrollPasskey(other);

        const response = await post(
            '/_auth/mfa/passkey/mark',
            { passkeyId, secondFactor: true },
            owner.authorization,
        );

        expect(response.status).toBe(404);
    });

    it('row: the only second factor is one passkey — mark false is 200, unenrolled, credential kept', async () =>
    {
        const session = await signIn('owner@test.com');
        const { passkeyId, authenticator } = await enrollPasskey(session);

        await post('/_auth/mfa/passkey/mark', { passkeyId, secondFactor: true }, session.authorization);

        // Marking a credential is not proving it, so the device has to step up
        // before it may change the second factor again.
        await stepUpWithPasskey(session, authenticator, 1);

        const response = await post(
            '/_auth/mfa/passkey/mark',
            { passkeyId, secondFactor: false },
            session.authorization,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ enrolled: false, methods: [] });

        const [row] = await getTestDb().select().from(passkeys).where(eq(passkeys.id, Number(passkeyId)));
        expect(row.revokedAt).toBeNull();
    });

    it('row: the only second factor is one passkey — passkeys/revoke still refuses, an independent guard', async () =>
    {
        const session = await sessionWithoutPassword('social@test.com');
        const { passkeyId, authenticator } = await enrollPasskey(session);

        await post('/_auth/mfa/passkey/mark', { passkeyId, secondFactor: true }, session.authorization);
        await stepUpWithPasskey(session, authenticator, 1);

        // The step-up is satisfied, so what refuses this is the other guard —
        // which is the point of the row.
        const response = await post('/_auth/passkeys/revoke', { passkeyId }, session.authorization);

        expect(response.status).toBe(409);
        expect((await response.json()).code).toBe('LAST_RECOVERY_CREDENTIAL');
    });

    it('row: enrolled — regenerate issues ten new codes and the old ones stop verifying', async () =>
    {
        const session = await signIn('owner@test.com');
        const { recoveryCodes } = await enrolled(session);

        const response = await post('/_auth/mfa/recovery/regenerate', {}, session.authorization);
        const { recoveryCodes: replacements } = await response.json();

        expect(response.status).toBe(200);
        expect(replacements).toHaveLength(10);
        expect(replacements).not.toEqual(expect.arrayContaining(recoveryCodes));

        const stale = await post('/_auth/mfa/step-up', { recoveryCode: recoveryCodes[0] }, session.authorization);
        expect(stale.status).toBe(401);

        const fresh = await post('/_auth/mfa/step-up', { recoveryCode: replacements[0] }, session.authorization);
        expect(fresh.status).toBe(204);

        // Spent for good: the same code a second time is the same 401 as a code
        // from the old generation.
        expect((await post('/_auth/mfa/step-up', { recoveryCode: replacements[0] }, session.authorization)).status)
            .toBe(401);
        expect((await status(session)).recoveryCodesRemaining).toBe(9);
    });

    it('row: enrolled — status carries no secret and reports ten codes remaining', async () =>
    {
        const session = await signIn('owner@test.com');
        const { secret, recoveryCodes } = await enrolled(session);

        const body = await status(session);
        const serialized = JSON.stringify(body);

        expect(body).toEqual({ enrolled: true, methods: ['totp'], recoveryCodesRemaining: 10 });
        expect(serialized).not.toContain(secret);
        recoveryCodes.forEach(code => expect(serialized).not.toContain(code));
    });

    it('row: the keyring no longer holds the key id a row was sealed with — confirm and step-up are 500 MfaConfigError', async () =>
    {
        const session = await signIn('owner@test.com');
        const secret = await enroll(session);

        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = GRACE_KEY;

        const confirm = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);
        expect(confirm.status).toBe(500);

        // And on the verify side, once the row is confirmed under a live keyring.
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = GRACE_KEY;

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret) }, session.authorization)).status).toBe(500);
    });

    it('row: SPFN_AUTH_TOKEN_ENCRYPTION_KEYS unset — enroll is MfaConfigError, not a 401', async () =>
    {
        const session = await signIn('owner@test.com');
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;

        const response = await post('/_auth/mfa/totp/enroll', {}, session.authorization);

        expect(response.status).toBe(500);
        expect(await totpRow('owner@test.com')).toBeUndefined();
    });

    it('row: a row sealed with a key that has since been retired — a successful step-up re-encrypts it', async () =>
    {
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = GRACE_KEY;
        const session = await signIn('owner@test.com');
        const { secret } = await enrolled(session);

        expect((await totpRow('owner@test.com')).secretEnc.startsWith('enc:v2:grace:')).toBe(true);

        // Rotation: a new active key, the old one kept as a grace key.
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `${ACTIVE_KEY},${GRACE_KEY}`;

        // One step on, so the code is not the one confirm already spent. The
        // code is computed for that step rather than by moving the clock, which
        // the database connection would not follow.
        const response = await post(
            '/_auth/mfa/step-up',
            { code: codeFor(secret, 1) },
            session.authorization,
        );

        expect(response.status).toBe(204);

        // The rewrite is queued for after the commit and fired without being
        // awaited, so the row is read once that queue has drained.
        await new Promise(resolve => setTimeout(resolve, 50));

        expect((await totpRow('owner@test.com')).secretEnc.startsWith('enc:v2:active:')).toBe(true);
    });

    it('row: all eight second-factor routes are on mainAuthRouter and in the generated route map', async () =>
    {
        const { routeMap } = await import('@/generated/route-map');
        const expected = {
            mfaTotpEnroll: { method: 'POST', path: '/_auth/mfa/totp/enroll' },
            mfaTotpConfirm: { method: 'POST', path: '/_auth/mfa/totp/confirm' },
            mfaDisable: { method: 'POST', path: '/_auth/mfa/disable' },
            mfaMarkPasskey: { method: 'POST', path: '/_auth/mfa/passkey/mark' },
            mfaRegenerateRecoveryCodes: { method: 'POST', path: '/_auth/mfa/recovery/regenerate' },
            mfaStatus: { method: 'GET', path: '/_auth/mfa/status' },
            mfaStepUp: { method: 'POST', path: '/_auth/mfa/step-up' },
            mfaStepUpOptions: { method: 'POST', path: '/_auth/mfa/step-up/options' },
        };

        for (const [name, info] of Object.entries(expected))
        {
            expect(routeMap[name], `route map is missing ${name}`).toEqual(info);
            expect(mainAuthRouter.routes, `mainAuthRouter is missing ${name}`).toHaveProperty(name);
        }
    });

    /** Push this device's second-factor verification into the past. */
    async function ageVerification(session: Session, minutes: number): Promise<void>
    {
        const { mfaVerifications } = await import('@/server/entities');

        await getTestDb()
            .update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(mfaVerifications.keyId, session.keyId));
    }
});
