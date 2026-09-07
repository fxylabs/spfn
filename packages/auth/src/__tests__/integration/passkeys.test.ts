/**
 * @spfn/auth - Passkey Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one test per row of the
 * case table in the passkey design (issue fxylabs/spfn#76): E for enrollment,
 * L for sign-in, M for management.
 *
 * The authenticator is real software (`helpers/webauthn-fixture`) holding a real
 * P-256 key, so the happy paths run the library's actual CBOR, COSE and ECDSA
 * verification. Every refusal reachable by changing an input — a wrong origin, a
 * wrong rpId, a regressed counter, a tampered signature — is produced the same
 * way rather than stubbed.
 *
 * These run against the bare router, without the Next.js proxy interceptor, so
 * the device-key fields it injects are supplied directly in the body.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { passkeys, userPublicKeys, users, userSocialAccounts, webauthnChallenges } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { authLoginEvent, passkeyEnrolledEvent, passkeyRevokedEvent } from '@/server/events';
import { authLogger } from '@/server/logger';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

/** A session: what to sign requests with, and the device key it is carried by. */
interface Session
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('Passkeys (WebAuthn)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        // Explicit rather than derived: other suites in this process set
        // SPFN_APP_URL for their own reasons, and row C5 is what makes an
        // http://localhost origin legal.
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
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
        await db.insert(users).values({
            email: 'other@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
        // No passwordHash: the OAuth-only account rows (E5, M6, M7) need an
        // account a password can never speak for.
        await db.insert(users).values({
            email: 'social@test.com',
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

    /** Exactly what a client does: hand over a public key at login, sign with the private half. */
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

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    /**
     * A session on an account with no password, for the rows about accounts a
     * password cannot speak for. Signed in by registering the key directly,
     * because there is no credential to log in with.
     */
    async function sessionWithoutPassword(email: string): Promise<Session>
    {
        const db = getTestDb();
        const user = await userRow(email);
        const keyPair = generateKeyPair('ES256');

        await db.insert(userPublicKeys).values({
            userId: user.id,
            keyId: keyPair.keyId,
            publicKey: keyPair.publicKey,
            fingerprint: keyPair.fingerprint,
            algorithm: 'ES256',
        });

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    async function userRow(email: string)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, email)).limit(1);

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

    /** The device-key fields the Next.js interceptor would have injected. */
    function deviceKeyBody(): Record<string, string>
    {
        const keyPair = generateKeyPair('ES256');

        return {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        };
    }

    // ========================================================================
    // Ceremonies
    // ========================================================================

    async function registerOptions(session: Session, body: Record<string, unknown> = {})
    {
        return post('/_auth/passkeys/register/options', body, session.authorization);
    }

    async function loginOptions(body: Record<string, unknown> = {})
    {
        return post('/_auth/passkeys/login/options', body);
    }

    /** The challenge an options response handed out. */
    async function challengeOf(response: Response): Promise<string>
    {
        expect(response.status).toBe(200);

        return (await response.json()).challenge;
    }

    interface CeremonyOverrides
    {
        origin?: string;
        rpId?: string;
    }

    /** Run a full enrollment and return the verify response. */
    async function enroll(
        session: Session,
        authenticator: FixtureAuthenticator,
        body: Record<string, unknown> = {},
    ): Promise<Response>
    {
        const challenge = await challengeOf(await registerOptions(session));

        return post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
            ...body,
        }, session.authorization);
    }

    /** Enroll and answer with the row that was written. */
    async function enrolled(session: Session, label?: string)
    {
        const authenticator = await FixtureAuthenticator.create();
        const response = await enroll(session, authenticator, label === undefined ? {} : { label });

        expect(response.status).toBe(200);

        return { authenticator, passkeyId: (await response.json()).passkeyId as string };
    }

    /** Run a full sign-in and return the verify response. */
    async function signInWithPasskey(
        authenticator: FixtureAuthenticator,
        options: CeremonyOverrides & { counter?: number; tamper?: boolean; body?: Record<string, unknown> } = {},
    ): Promise<Response>
    {
        const challenge = await challengeOf(await loginOptions());

        return post('/_auth/passkeys/login/verify', {
            response: authenticator.assert({
                challenge,
                origin: options.origin ?? ORIGIN,
                rpId: options.rpId ?? RP_ID,
                counter: options.counter ?? 1,
                tamper: options.tamper,
            }),
            ...deviceKeyBody(),
            ...options.body,
        });
    }

    // ========================================================================
    // Reading the database back
    // ========================================================================

    async function passkeyRows(email: string)
    {
        const user = await userRow(email);

        return getTestDb().select().from(passkeys).where(eq(passkeys.userId, user.id));
    }

    async function challengeRows()
    {
        return getTestDb().select().from(webauthnChallenges);
    }

    async function deviceKeyCount(email: string): Promise<number>
    {
        const user = await userRow(email);
        const rows = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, user.id));

        return rows.length;
    }

    /** Collect one event's payloads for the duration of a test. */
    function captureEvent<TPayload>(
        event: { subscribe: (handler: (payload: TPayload) => void) => unknown },
    ): TPayload[]
    {
        const seen: TPayload[] = [];
        event.subscribe((payload) => 
        {
            seen.push(payload); 
        });

        return seen;
    }

    /**
     * The refusal body with the fields that differ per request removed, so two
     * refusals can be compared for being byte-identical to a caller.
     */
    async function comparableRefusal(response: Response): Promise<unknown>
    {
        const body = await response.clone().json() as { error: Record<string, unknown>; stack?: string };
        const { requestId: _requestId, ...error } = body.error;
        const { stack: _stack, ...rest } = body;

        return { ...rest, error };
    }

    // ========================================================================
    // E — Enrollment
    // ========================================================================

    describe('E — enrollment', () =>
    {
        it('row E1: a fresh session with no passkeys gets options, an empty exclude list and a challenge of its own', async () =>
        {
            const session = await signIn('owner@test.com');

            const response = await registerOptions(session);
            expect(response.status).toBe(200);

            const options = await response.json();
            expect(options.excludeCredentials).toEqual([]);
            expect(options.rp.id).toBe(RP_ID);
            expect(options.authenticatorSelection.residentKey).toBe('required');

            const user = await userRow('owner@test.com');
            const [challenge] = await challengeRows();
            expect(challenge.kind).toBe('registration');
            expect(challenge.userId).toBe(user.id);
            expect(challenge.consumedAt).toBeNull();
        });

        it('row E2: a session key 11 minutes old and no password is refused RECENT_AUTH_REQUIRED', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);

            const response = await registerOptions(session);

            expect(response.status).toBe(403);
            expect((await response.json()).code).toBe('RECENT_AUTH_REQUIRED');
            expect(await challengeRows()).toHaveLength(0);
        });

        it('row E3: a session key 11 minutes old with the correct password is let through', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);

            expect((await registerOptions(session, { currentPassword: PASSWORD })).status).toBe(200);
        });

        it('row E4: the wrong password is the same refusal, with no distinct message', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);

            const wrong = await registerOptions(session, { currentPassword: 'NotThePassword1!' });
            const missing = await registerOptions(session);

            expect(wrong.status).toBe(403);
            expect(await comparableRefusal(wrong)).toEqual(await comparableRefusal(missing));
        });

        it('row E5: an account with no password cannot satisfy the gate with one', async () =>
        {
            const session = await sessionWithoutPassword('social@test.com');
            await ageSession(session, 11);

            const response = await registerOptions(session, { currentPassword: PASSWORD });

            expect(response.status).toBe(403);
            expect((await response.json()).code).toBe('RECENT_AUTH_REQUIRED');
        });

        it('row E6: a valid attestation is kept, the challenge is spent, and the enrolment is announced', async () =>
        {
            const enrolledEvents = captureEvent(passkeyEnrolledEvent);
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();

            const response = await enroll(session, authenticator, { label: 'Laptop' });
            expect(response.status).toBe(200);

            const body = await response.json();
            expect(body).toMatchObject({ label: 'Laptop' });
            expect(body.passkeyId).toMatch(/^[0-9]+$/);

            const [row] = await passkeyRows('owner@test.com');
            expect(row.credentialId).toBe(authenticator.credentialId);
            expect(row.counter).toBe(0);
            expect(row.transports).toEqual(['internal', 'hybrid']);
            expect(row.deviceType).toBe('singleDevice');
            expect(row.backedUp).toBe(false);
            expect(row.revokedAt).toBeNull();

            const [challenge] = await challengeRows();
            expect(challenge.consumedAt).not.toBeNull();

            expect(enrolledEvents).toEqual([
                { userId: String(row.userId), passkeyId: String(row.id), label: 'Laptop' },
            ]);
        });

        it('row E7: presenting the same challenge twice is refused the second time, and writes one row', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(session));
            const body = { response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }) };

            expect((await post('/_auth/passkeys/register/verify', body, session.authorization)).status).toBe(200);
            expect((await post('/_auth/passkeys/register/verify', body, session.authorization)).status).toBe(401);

            expect(await passkeyRows('owner@test.com')).toHaveLength(1);
        });

        it('row E8: a challenge older than its TTL is refused', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(session));

            await getTestDb()
                .update(webauthnChallenges)
                .set({ expiresAt: new Date(Date.now() - 1_000) });

            const response = await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
            }, session.authorization);

            expect(response.status).toBe(401);
            expect(await passkeyRows('owner@test.com')).toHaveLength(0);
        });

        it('row E9: another account\'s challenge is refused even though its kind matches', async () =>
        {
            const owner = await signIn('owner@test.com');
            const other = await signIn('other@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(owner));

            const response = await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
            }, other.authorization);

            expect(response.status).toBe(401);
            expect(await passkeyRows('other@test.com')).toHaveLength(0);
        });

        it('row E10: a sign-in challenge presented to enrolment is refused, and left alone', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await loginOptions());

            const response = await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
            }, session.authorization);

            expect(response.status).toBe(401);

            // The other ceremony's row is not what this request could spend.
            const [row] = await challengeRows();
            expect(row.kind).toBe('authentication');
            expect(row.consumedAt).toBeNull();
        });

        it('row E11: a credential already on another account is refused 409', async () =>
        {
            const owner = await signIn('owner@test.com');
            const other = await signIn('other@test.com');
            const authenticator = await FixtureAuthenticator.create();

            expect((await enroll(owner, authenticator)).status).toBe(200);

            const response = await enroll(other, authenticator);
            expect(response.status).toBe(409);
            expect((await response.json()).__type).toBe('PasskeyAlreadyRegisteredError');
            expect(await passkeyRows('other@test.com')).toHaveLength(0);
        });

        it('row E12: an attestation from an origin that is not configured is refused', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(session));

            const response = await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge, origin: 'https://evil.example.com', rpId: RP_ID }),
            }, session.authorization);

            expect(response.status).toBe(401);
            expect((await response.json()).__type).toBe('PasskeyVerificationError');
            expect(await passkeyRows('owner@test.com')).toHaveLength(0);
        });

        it('row E13: an attestation whose rpId hash is for another domain is refused', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(session));

            const response = await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge, origin: ORIGIN, rpId: 'evil.example.com' }),
            }, session.authorization);

            expect(response.status).toBe(401);
            expect(await passkeyRows('owner@test.com')).toHaveLength(0);
        });

        it('row E14: the exclude list names both of the caller\'s live passkeys', async () =>
        {
            const session = await signIn('owner@test.com');
            const first = await enrolled(session);
            const second = await enrolled(session);

            const options = await (await registerOptions(session)).json();

            expect(options.excludeCredentials.map((credential: { id: string }) => credential.id).sort())
                .toEqual([first.authenticator.credentialId, second.authenticator.credentialId].sort());
        });

        it('row E15: a label longer than 64 characters, or empty, is a validation error', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(session));
            const attestation = authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID });

            expect((await post('/_auth/passkeys/register/verify',
                { response: attestation, label: 'x'.repeat(65) }, session.authorization)).status).toBe(400);
            expect((await post('/_auth/passkeys/register/verify',
                { response: attestation, label: '' }, session.authorization)).status).toBe(400);

            // Validation runs before the handler, so nothing was spent.
            const [row] = await challengeRows();
            expect(row.consumedAt).toBeNull();
        });

        it('row E16: two concurrent verifies of one challenge produce one success and one row', async () =>
        {
            const session = await signIn('owner@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const challenge = await challengeOf(await registerOptions(session));
            const body = { response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }) };

            const [first, second] = await Promise.all([
                post('/_auth/passkeys/register/verify', body, session.authorization),
                post('/_auth/passkeys/register/verify', body, session.authorization),
            ]);

            expect([first.status, second.status].sort()).toEqual([200, 401]);
            expect(await passkeyRows('owner@test.com')).toHaveLength(1);
        });
    });

    // ========================================================================
    // L — Sign-in
    // ========================================================================

    describe('L — sign-in', () =>
    {
        it('row L1: options take nothing, offer no credentials, and name no account', async () =>
        {
            const response = await loginOptions();
            expect(response.status).toBe(200);

            const options = await response.json();
            expect(options.allowCredentials).toEqual([]);
            expect(options.rpId).toBe(RP_ID);
            expect(options.userVerification).toBe('preferred');

            const [challenge] = await challengeRows();
            expect(challenge.kind).toBe('authentication');
            expect(challenge.userId).toBeNull();
        });

        it('row L2: an identifier in the options body is refused — no identifier is accepted', async () =>
        {
            expect((await loginOptions({ email: 'owner@test.com' })).status).toBe(400);
            expect(await challengeRows()).toHaveLength(0);
        });

        it('row L3: a valid assertion signs in exactly as a password login does', async () =>
        {
            const loginEvents = captureEvent(authLoginEvent);
            const session = await signIn('owner@test.com');
            const { authenticator, passkeyId } = await enrolled(session);
            const keysBefore = await deviceKeyCount('owner@test.com');

            const response = await signInWithPasskey(authenticator);
            expect(response.status).toBe(200);

            const user = await userRow('owner@test.com');
            expect(await response.json()).toEqual({
                userId: String(user.id),
                publicId: user.publicId,
                email: 'owner@test.com',
                passwordChangeRequired: false,
            });

            const [row] = await passkeyRows('owner@test.com');
            expect(String(row.id)).toBe(passkeyId);
            expect(row.counter).toBe(1);
            expect(row.lastUsedAt).not.toBeNull();

            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore + 1);
            expect(loginEvents).toContainEqual(expect.objectContaining({
                userId: String(user.id), provider: 'passkey', email: 'owner@test.com',
            }));
        });

        it('row L3: the answer is the same shape a password login gives', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);

            const viaPasskey = await (await signInWithPasskey(authenticator)).json();
            const viaPassword = await (await post('/_auth/login', {
                email: 'owner@test.com', password: PASSWORD, ...deviceKeyBody(),
            })).json();

            expect(Object.keys(viaPasskey).sort()).toEqual(Object.keys(viaPassword).sort());
            expect(viaPasskey).toEqual(viaPassword);
        });

        it('row L4/L5: a revoked credential and one that was never here answer identically', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator, passkeyId } = await enrolled(session);

            await getTestDb().update(passkeys)
                .set({ revokedAt: new Date(), revokedReason: 'test' })
                .where(eq(passkeys.id, Number(passkeyId)));

            const revoked = await signInWithPasskey(authenticator);
            const unknown = await signInWithPasskey(await FixtureAuthenticator.create());

            expect(revoked.status).toBe(401);
            expect(unknown.status).toBe(401);
            expect(await comparableRefusal(revoked)).toEqual(await comparableRefusal(unknown));
        });

        it('row L6: a challenge already spent registers no device key', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const challenge = await challengeOf(await loginOptions());
            const assertion = authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 });

            expect((await post('/_auth/passkeys/login/verify',
                { response: assertion, ...deviceKeyBody() })).status).toBe(200);

            const keysAfterFirst = await deviceKeyCount('owner@test.com');
            const replay = await post('/_auth/passkeys/login/verify', { response: assertion, ...deviceKeyBody() });

            expect(replay.status).toBe(401);
            expect(await deviceKeyCount('owner@test.com')).toBe(keysAfterFirst);
        });

        it('row L7: an expired challenge registers no device key', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const challenge = await challengeOf(await loginOptions());
            const keysBefore = await deviceKeyCount('owner@test.com');

            await getTestDb().update(webauthnChallenges)
                .set({ expiresAt: new Date(Date.now() - 1_000) })
                .where(eq(webauthnChallenges.kind, 'authentication'));

            const response = await post('/_auth/passkeys/login/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
                ...deviceKeyBody(),
            });

            expect(response.status).toBe(401);
            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore);
        });

        it('row L8: an enrolment challenge presented to sign-in is refused', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const challenge = await challengeOf(await registerOptions(session));
            const keysBefore = await deviceKeyCount('owner@test.com');

            const response = await post('/_auth/passkeys/login/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
                ...deviceKeyBody(),
            });

            expect(response.status).toBe(401);
            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore);
        });

        it('row L9: an assertion the key did not sign is refused, and moves no counter', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const keysBefore = await deviceKeyCount('owner@test.com');

            const response = await signInWithPasskey(authenticator, { tamper: true });

            expect(response.status).toBe(401);
            expect((await passkeyRows('owner@test.com'))[0].counter).toBe(0);
            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore);
        });

        it('row L10: a counter that went backwards is refused, logged by passkey id, and the row is left alone', async () =>
        {
            const warn = vi.spyOn(authLogger.service, 'warn').mockImplementation(() => 
            {});
            const session = await signIn('owner@test.com');
            const { authenticator, passkeyId } = await enrolled(session);

            await getTestDb().update(passkeys).set({ counter: 5 }).where(eq(passkeys.id, Number(passkeyId)));

            const response = await signInWithPasskey(authenticator, { counter: 3 });
            expect(response.status).toBe(401);

            const [row] = await passkeyRows('owner@test.com');
            expect(row.counter).toBe(5);
            expect(row.revokedAt).toBeNull();
            expect(row.lastUsedAt).toBeNull();
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('counter'),
                expect.objectContaining({ passkeyId: row.id }),
            );
        });

        it('row L11: a synced passkey reporting 0 both times signs in', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);

            expect((await signInWithPasskey(authenticator, { counter: 0 })).status).toBe(200);
            expect((await passkeyRows('owner@test.com'))[0].counter).toBe(0);
        });

        it('row L12: a disabled account is refused exactly as a password login refuses it', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const keysBefore = await deviceKeyCount('owner@test.com');

            await getTestDb().update(users).set({ status: 'inactive' }).where(eq(users.email, 'owner@test.com'));

            const response = await signInWithPasskey(authenticator);

            expect(response.status).toBe(403);
            expect((await response.json()).__type).toBe('AccountDisabledError');
            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore);
        });

        it('row L13: an account pending deletion is refused with the same error the password path gives', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);

            await getTestDb().update(users).set({ status: 'pending_deletion' }).where(eq(users.email, 'owner@test.com'));

            const response = await signInWithPasskey(authenticator);

            expect(response.status).toBe(403);
            expect((await response.json()).__type).toBe('AccountPendingDeletionError');
        });

        it('row L14: a body with no device key fails validation and leaves the challenge live', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const challenge = await challengeOf(await loginOptions());

            const response = await post('/_auth/passkeys/login/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
            });

            expect(response.status).toBe(400);

            // The check runs before the transaction opens, so nothing was spent
            // and the ceremony is retryable.
            const [row] = (await challengeRows()).filter(entry => entry.kind === 'authentication');
            expect(row.consumedAt).toBeNull();

            expect((await post('/_auth/passkeys/login/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
                ...deviceKeyBody(),
            })).status).toBe(200);
        });

        it('row L15: an old key named in the body is revoked as the new one is registered', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const newKey = deviceKeyBody();

            const response = await signInWithPasskey(authenticator, {
                body: { ...newKey, oldKeyId: session.keyId },
            });
            expect(response.status).toBe(200);

            const db = getTestDb();
            const [old] = await db.select().from(userPublicKeys).where(eq(userPublicKeys.keyId, session.keyId));
            const [fresh] = await db.select().from(userPublicKeys).where(eq(userPublicKeys.keyId, newKey.keyId));

            expect(old.isActive).toBe(false);
            expect(old.revokedAt).not.toBeNull();
            expect(fresh.isActive).toBe(true);
        });

        it('row L16: two concurrent verifies of one assertion register one device key', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const challenge = await challengeOf(await loginOptions());
            const assertion = authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 });
            const keysBefore = await deviceKeyCount('owner@test.com');

            const [first, second] = await Promise.all([
                post('/_auth/passkeys/login/verify', { response: assertion, ...deviceKeyBody() }),
                post('/_auth/passkeys/login/verify', { response: assertion, ...deviceKeyBody() }),
            ]);

            expect([first.status, second.status].sort()).toEqual([200, 401]);
            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore + 1);
        });

        it('row L17: an assertion made at another origin is refused', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator } = await enrolled(session);
            const keysBefore = await deviceKeyCount('owner@test.com');

            const response = await signInWithPasskey(authenticator, { origin: 'https://evil.example.com' });

            expect(response.status).toBe(401);
            expect((await response.json()).__type).toBe('PasskeyVerificationError');
            expect(await deviceKeyCount('owner@test.com')).toBe(keysBefore);
            expect((await passkeyRows('owner@test.com'))[0].counter).toBe(0);
        });
    });

    // ========================================================================
    // M — Management
    // ========================================================================

    describe('M — management', () =>
    {
        function list(session: Session)
        {
            return post('/_auth/passkeys/list', {}, session.authorization);
        }

        function rename(session: Session, passkeyId: string, label: string)
        {
            return post('/_auth/passkeys/rename', { passkeyId, label }, session.authorization);
        }

        function revoke(session: Session, passkeyId: string, body: Record<string, unknown> = {})
        {
            return post('/_auth/passkeys/revoke', { passkeyId, ...body }, session.authorization);
        }

        it('row M1: the list shows only live passkeys, and never the credential itself', async () =>
        {
            const session = await signIn('owner@test.com');
            await enrolled(session, 'One');
            await enrolled(session, 'Two');
            const gone = await enrolled(session, 'Gone');

            await getTestDb().update(passkeys).set({ revokedAt: new Date() })
                .where(eq(passkeys.id, Number(gone.passkeyId)));

            const { passkeys: listed } = await (await list(session)).json();

            expect(listed).toHaveLength(2);
            expect(listed.map((entry: { label: string }) => entry.label).sort()).toEqual(['One', 'Two']);
            expect(Object.keys(listed[0]).sort()).toEqual(
                ['backedUp', 'createdAt', 'deviceType', 'label', 'lastUsedAt', 'passkeyId', 'transports'],
            );
        });

        it('row M2: another account\'s passkey is a 404 from both rename and revoke', async () =>
        {
            const owner = await signIn('owner@test.com');
            const other = await signIn('other@test.com');
            const { passkeyId } = await enrolled(owner);

            expect((await rename(other, passkeyId, 'Mine now')).status).toBe(404);
            expect((await revoke(other, passkeyId)).status).toBe(404);
            expect((await passkeyRows('owner@test.com'))[0].revokedAt).toBeNull();
        });

        it('row M3: renaming a live passkey updates its label', async () =>
        {
            const session = await signIn('owner@test.com');
            const { passkeyId } = await enrolled(session, 'Old name');

            const response = await rename(session, passkeyId, 'New name');

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ passkeyId, label: 'New name' });
            expect((await passkeyRows('owner@test.com'))[0].label).toBe('New name');
        });

        it('row M4: an account with a password may revoke its only passkey, and it is announced', async () =>
        {
            const revokedEvents = captureEvent(passkeyRevokedEvent);
            const session = await signIn('owner@test.com');
            const { passkeyId } = await enrolled(session);

            const response = await revoke(session, passkeyId);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ passkeyId });

            const [row] = await passkeyRows('owner@test.com');
            expect(row.revokedAt).not.toBeNull();
            expect(revokedEvents).toEqual([
                { userId: String(row.userId), passkeyId, reason: 'user' },
            ]);
        });

        it('row M5: a session key 11 minutes old with no password is refused RECENT_AUTH_REQUIRED', async () =>
        {
            const session = await signIn('owner@test.com');
            const { passkeyId } = await enrolled(session);
            await ageSession(session, 11);

            const response = await revoke(session, passkeyId);

            expect(response.status).toBe(403);
            expect((await response.json()).code).toBe('RECENT_AUTH_REQUIRED');
            expect((await passkeyRows('owner@test.com'))[0].revokedAt).toBeNull();
        });

        it('row M6: the last passkey of an account with no password and no social account is refused', async () =>
        {
            const session = await sessionWithoutPassword('social@test.com');
            const { passkeyId } = await enrolled(session);

            const response = await revoke(session, passkeyId);

            expect(response.status).toBe(409);
            expect((await response.json()).code).toBe('LAST_RECOVERY_CREDENTIAL');
            expect((await passkeyRows('social@test.com'))[0].revokedAt).toBeNull();
        });

        it('row M7: a linked social account is a way back in, so the last passkey may go', async () =>
        {
            const session = await sessionWithoutPassword('social@test.com');
            const { passkeyId } = await enrolled(session);
            const user = await userRow('social@test.com');

            await getTestDb().insert(userSocialAccounts).values({
                userId: user.id,
                provider: 'google',
                providerUserId: 'google-1',
            });

            expect((await revoke(session, passkeyId)).status).toBe(200);
            expect((await passkeyRows('social@test.com'))[0].revokedAt).not.toBeNull();
        });

        it('row M8: with two passkeys and no password, one may go', async () =>
        {
            const session = await sessionWithoutPassword('social@test.com');
            const first = await enrolled(session);
            await enrolled(session);

            expect((await revoke(session, first.passkeyId)).status).toBe(200);

            const live = (await passkeyRows('social@test.com')).filter(row => row.revokedAt === null);
            expect(live).toHaveLength(1);
        });

        it('row M9: revoking one that is already revoked is a 404', async () =>
        {
            const session = await signIn('owner@test.com');
            const { passkeyId } = await enrolled(session);
            await enrolled(session);

            expect((await revoke(session, passkeyId)).status).toBe(200);
            expect((await revoke(session, passkeyId)).status).toBe(404);
        });

        it('row M10: a revoked credential cannot be enrolled again, not even by its owner', async () =>
        {
            const session = await signIn('owner@test.com');
            const { authenticator, passkeyId } = await enrolled(session);
            await enrolled(session);

            expect((await revoke(session, passkeyId)).status).toBe(200);

            const response = await enroll(session, authenticator);
            expect(response.status).toBe(409);
            expect((await response.json()).__type).toBe('PasskeyAlreadyRegisteredError');
        });
    });
});
