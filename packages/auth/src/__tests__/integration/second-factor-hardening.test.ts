/**
 * @spfn/auth - Second-factor hardening (bundle 6, superself w-qhtq0)
 *
 * Real HTTP requests against the mounted auth router, one `it` per row, named
 * for the row. Each row names the failure that would otherwise pass unnoticed.
 *
 * | Row | Checks | Unnoticed without it |
 * |-----|--------|----------------------|
 * | T1  | `mfa/step-up`: wrong codes up to the limit, then the right code is refused too; `auth.mfa.locked` once | au7-A2 |
 * | T2  | several new-device challenges, a wrong code at each: the total stops at the account's limit; step-up and verify share it | a budget re-granted per attempt or per route |
 * | T3  | concurrent requests with one proof: exactly one succeeds — a TOTP code, a recovery code, a verification code | the read-then-write gap |
 * | T4  | TOTP confirm twice at once: one recovery-code generation | two recovery-code sets |
 * | T5  | a passkey without user verification: new device 202, no mark, refused at verify and step-up; with it exempt / accepted | au7-A4 |
 * | T6  | full-width digits, non-digits, wrong length: 401 and counted | malformed input escaping the count through a 500 |
 * | T7  | after the lock window the right code passes | an owner locked out for good |
 * | T8  | an application-profile session: confirm 200, step-up 204, held by the profile; never by the device key it reports | the 500 and the misattributed record |
 * | T10 | six bodies at `mfa/step-up` that are no passkey assertion: five 401s, counted, the sixth meets the lock (429); three at `mfa/verify`: 401, counted | malformed proofs escaping the count through a 500 (B1) |
 * | T11 | the same bodies at passkey sign-in and registration: their own 401 `PasskeyVerificationError`, never 500 | a 500 where the body is not judged a proof (B1) |
 * | T12 | 1 wrong proof, 3 just before fifteen minutes pass, 4 after: the fifth inside fifteen minutes locks | more tries than the budget around a fixed window's edge (N2) |
 * | T13 | a verification code at its attempt limit: the right code and a wrong one get identical answers | an oracle for the right code once the tries are spent (N3) |
 * | T14 | a TOTP code checked against the old secret, the enrolment replaced while it waits on the account lock: 401, nothing spent on the new one | a stale proof spent on the secret enrolled in between (N4) |
 * | T15 | a profile session reporting a device key's id, the key freshly stepped up, the profile not: deletion request 403 `STEP_UP_REQUIRED` | step-up borrowed across credentials on the deletion route (R1) |
 * | T16 | a TOTP confirm with the first pending secret's code, a second `enroll` landing while it waits on the account lock: refused, the new enrolment unconfirmed | a stale code confirming the secret enrolled in between (M2) |
 * | PA1 | a profile session reporting a freshly signed-in device key's id, no password: `passkeys/register/options` 403, as for an id nobody signed in with | recent authentication borrowed from another credential's sign-in (M1) |
 * | PA2 | the same at `deletion/request`: 403 | a profile session scheduling the account's deletion on a device key's sign-in (M1) |
 * | PA3 | the same profile presenting the password: both 200 | a profile session left with no way to prove itself |
 *
 * T9 (counter regression → the clone warning) is row L10 of `passkeys.test.ts`,
 * which drives the verification with a lowered counter.
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { pinClockInsideTotpStep } from '../helpers/totp-clock';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import {
    mfaAttemptBudgets,
    mfaRecoveryCodes,
    mfaTotp,
    mfaVerifications,
    users,
    verificationCodes,
} from '@/server/entities';
import { configureChannels } from '@/server/lib/channels-config';
import { hashPassword } from '@/server/helpers/password';
import { encryptMfaSecret } from '@/server/lib/mfa-cipher';
import { usersRepository } from '@/server/repositories';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate } from '@/server/middleware/authenticate';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { mfaLockedEvent } from '@/server/events';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { runInTransaction } = await import('@spfn/core/db');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'owner@test.com';
const NEW_EMAIL = 'newcomer@test.com';
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 6).toString('base64')}`;
const PROFILE = 'a06HardeningProfile';
const PROFILE_KEY_HEADER = 'x-a06-profile-key';

/** Bodies at `response` that are no passkey assertion (the reviewers' probes). */
const NOT_AN_ASSERTION: unknown[] = [{}, null, 5, [], { response: {} }, { id: 'x', response: { clientDataJSON: 5 } }];

/** How a request is made: a device key's `Authorization`, or an app profile's headers. */
type Caller = string | Record<string, string>;

describe.skipIf(!dbAvailable)('second-factor hardening (bundle 6)', () =>
{
    let app: Hono;
    let ownerId: number;
    let ipCounter = 0;
    let counter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        // passkeyLogin and selfDeletion are off unless the app states them (#475).
        configureChannels({ passkeyLogin: true, selfDeletion: true });
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

        registerAuthProfile(PROFILE, {
            verify: async c => ({ userId: String(ownerId), keyId: c.req.header(PROFILE_KEY_HEADER)!, scheme: PROFILE }),
        });

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
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();

        const [row] = await getTestDb().insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        ownerId = Number(row!.id);
    });

    afterEach(() =>
    {
        // A row that pinned the clock to a TOTP step lets it go.
        vi.useRealTimers();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function post(path: string, body: unknown, as?: Caller): Promise<Response>
    {
        ipCounter += 1;

        return Promise.resolve(app.request(path, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': `198.51.100.${ipCounter % 250 + 1}`,
                ...(typeof as === 'string' ? { Authorization: as } : as),
            },
            body: JSON.stringify(body),
        }));
    }

    function bearerFor(key: KeyPair): string
    {
        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    function deviceKeyBody(key: KeyPair)
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    function profileOf(keyId: string): Record<string, string>
    {
        return { [CLIENT_PROOF_HEADERS.profile]: PROFILE, [PROFILE_KEY_HEADER]: keyId };
    }

    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    function wrongCode(secret: string): string
    {
        return [codeFor(secret, -1), codeFor(secret), codeFor(secret, 1)].includes('000000') ? '111111' : '000000';
    }

    /** A password sign-in; `expected` 200 for a signed-in device, 202 for a stopped new one. */
    async function passwordSignIn(expected: 200 | 202 = 200): Promise<{ key: KeyPair; body: any }>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', { email: EMAIL, password: PASSWORD, ...deviceKeyBody(key) });

        expect(response.status).toBe(expected);

        return { key, body: await response.json() };
    }

    /** Start and confirm a TOTP enrolment as `as`; the step it spent is forgotten so codes of now verify again. */
    async function enrolTotp(as: Caller): Promise<{ secret: string; recoveryCodes: string[] }>
    {
        const secret = (await (await post('/_auth/mfa/totp/enroll', {}, as)).json()).secret as string;
        const confirm = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, as);

        expect(confirm.status).toBe(200);
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });

        return { secret, recoveryCodes: (await confirm.json()).recoveryCodes };
    }

    /** An enrolled owner and the signed-in device that enrolled. */
    async function enrolledOwner(): Promise<{ device: string; secret: string; recoveryCodes: string[] }>
    {
        const device = bearerFor((await passwordSignIn()).key);

        return { device, ...await enrolTotp(device) };
    }

    async function budgetFailures(): Promise<number | undefined>
    {
        const [row] = await getTestDb().select().from(mfaAttemptBudgets).where(eq(mfaAttemptBudgets.userId, ownerId));

        return row?.failedAt.length;
    }

    /** Move the account's failures and lock `minutes` into the past: time passing, as the budget sees it. */
    async function shiftBudget(minutes: number): Promise<void>
    {
        const by = sql`make_interval(mins => ${minutes})`;

        await getTestDb().update(mfaAttemptBudgets).set({
            failedAt: sql`ARRAY(SELECT failed - ${by} FROM unnest(${mfaAttemptBudgets.failedAt}) AS failed)`,
            lockedUntil: sql`${mfaAttemptBudgets.lockedUntil} - ${by}`,
        });
    }

    async function wrongStepUps(device: string, secret: string, count: number): Promise<number[]>
    {
        const statuses = [];

        for (let attempt = 0; attempt < count; attempt += 1)
        {
            statuses.push((await post('/_auth/mfa/step-up', { code: wrongCode(secret) }, device)).status);
        }

        return statuses;
    }

    /** An enrolled owner whose passkey, registered with user verification, is marked as a second factor. */
    async function ownerWithMarkedPasskey(): Promise<{ device: string; secret: string }>
    {
        const owner = await enrolledOwner();
        const { passkeyId } = await registerPasskey(owner.device, true);

        expect((await post('/_auth/mfa/passkey/mark', { passkeyId, secondFactor: true }, owner.device)).status).toBe(200);

        return owner;
    }

    function gate(): { open: () => void; opened: Promise<void> }
    {
        let open!: () => void;
        const opened = new Promise<void>((resolve) =>
        {
            open = resolve;
        });

        return { open, opened };
    }

    /** Until some backend of this database waits on a lock. */
    async function someoneWaitsOnALock(): Promise<void>
    {
        for (let i = 0; i < 200; i++)
        {
            const rows = await getTestDb().execute(sql`
                SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                WHERE NOT l.granted AND a.datname = current_database()`);
            if (Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0)
            {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('no lock wait observed');
    }

    /**
     * Run `request` while this test holds the owner's account lock; once the
     * request reaches the lock, commit `meanwhile`, see the request wait, then
     * release: what `meanwhile` committed is what the request finds under it.
     */
    async function whileWaitingOnTheLock(request: () => Promise<Response>, meanwhile: () => Promise<unknown>): Promise<Response>
    {
        const held = gate();
        const release = gate();
        const reached = gate();

        const holder = runInTransaction(async () =>
        {
            await usersRepository.lockAccount(ownerId);
            held.open();
            await release.opened;
        }, { context: 'test:held-account-lock' });
        await held.opened;

        const lockAccount = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementation(async (id) =>
        {
            reached.open();

            return await lockAccount(id);
        });

        const response = request();
        await reached.opened;
        await meanwhile();
        await someoneWaitsOnALock().finally(release.open);

        return (await Promise.all([response, holder]))[0];
    }

    async function registerPasskey(device: string, userVerified: boolean): Promise<{ authenticator: FixtureAuthenticator; passkeyId: string }>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await (await post('/_auth/passkeys/register/options', {}, device)).json();
        const response = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID, userVerified }),
        }, device);

        expect(response.status).toBe(200);

        return { authenticator, passkeyId: (await response.json()).passkeyId };
    }

    function assertion(authenticator: FixtureAuthenticator, challenge: string, userVerified: boolean)
    {
        counter += 1;

        return authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter, userVerified });
    }

    async function passkeySignIn(authenticator: FixtureAuthenticator, userVerified: boolean): Promise<Response>
    {
        const { challenge } = await (await post('/_auth/passkeys/login/options', {})).json();

        return await post('/_auth/passkeys/login/verify', {
            response: assertion(authenticator, challenge, userVerified),
            ...deviceKeyBody(generateKeyPair('ES256')),
        });
    }

    async function passkeyStepUp(device: string, authenticator: FixtureAuthenticator, userVerified: boolean): Promise<Response>
    {
        const { challenge } = await (await post('/_auth/mfa/step-up/options', {}, device)).json();

        return await post('/_auth/mfa/step-up', { response: assertion(authenticator, challenge, userVerified) }, device);
    }

    async function passkeyVerify(secret: string, authenticator: FixtureAuthenticator, userVerified: boolean): Promise<Response>
    {
        const { challenge } = await (await post('/_auth/mfa/verify/options', { challenge: secret })).json();

        return await post('/_auth/mfa/verify', { challenge: secret, response: assertion(authenticator, challenge, userVerified) });
    }

    // ========================================================================
    // Rows
    // ========================================================================

    it('T1: mfa/step-up — five wrong codes, then the right one is refused too (429); auth.mfa.locked emitted exactly once', async () =>
    {
        const { device, secret } = await enrolledOwner();
        const locked = vi.spyOn(mfaLockedEvent, 'emit');
        const wrong = [];

        for (let attempt = 0; attempt < 5; attempt += 1)
        {
            wrong.push((await post('/_auth/mfa/step-up', { code: wrongCode(secret) }, device)).status);
        }

        const right = await post('/_auth/mfa/step-up', { code: codeFor(secret) }, device);
        const another = await post('/_auth/mfa/step-up', { code: wrongCode(secret) }, device);

        expect(wrong).toEqual([401, 401, 401, 401, 401]);
        expect(right.status).toBe(429);
        expect(Number(right.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(another.status).toBe(429);
        expect(locked).toHaveBeenCalledTimes(1);
        expect(locked).toHaveBeenCalledWith(expect.objectContaining({ userId: String(ownerId) }));
    });

    it('T2: a fresh sign-in buys no new tries — wrong codes across new-device challenges and step-up stop at the account\'s limit', async () =>
    {
        const { device, secret } = await enrolledOwner();
        const statuses = [];

        for (let signIn = 0; signIn < 3; signIn += 1)
        {
            const { body } = await passwordSignIn(202);

            statuses.push((await post('/_auth/mfa/verify', { challenge: body.challenge.secret, code: wrongCode(secret) })).status);
        }

        statuses.push((await post('/_auth/mfa/step-up', { code: wrongCode(secret) }, device)).status);
        statuses.push((await post('/_auth/mfa/step-up', { code: wrongCode(secret) }, device)).status);

        const { body: fresh } = await passwordSignIn(202);
        const afterLimit = await post('/_auth/mfa/verify', { challenge: fresh.challenge.secret, code: codeFor(secret) });

        expect(statuses).toEqual([401, 401, 401, 401, 401]);
        expect(afterLimit.status).toBe(429);
        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret) }, device)).status).toBe(429);
        expect(await budgetFailures()).toBe(5);
    });

    it('T3: four concurrent requests with one proof — exactly one succeeds, for a TOTP code, a recovery code and a verification code', async () =>
    {
        const { device, secret, recoveryCodes } = await enrolledOwner();
        const code = codeFor(secret);
        const byTotp = await Promise.all([1, 2, 3, 4].map(() => post('/_auth/mfa/step-up', { code }, device)));
        const byRecovery = await Promise.all([1, 2, 3, 4].map(() => post('/_auth/mfa/step-up', { recoveryCode: recoveryCodes[0] }, device)));

        await post('/_auth/codes', { target: NEW_EMAIL, targetType: 'email', purpose: 'registration' });
        const [row] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, NEW_EMAIL), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);
        const byEmailCode = await Promise.all([1, 2, 3, 4].map(() =>
            post('/_auth/codes/verify', { target: NEW_EMAIL, targetType: 'email', code: row!.code, purpose: 'registration' })));

        expect(byTotp.map(response => response.status).sort()).toEqual([204, 401, 401, 401]);
        expect(byRecovery.map(response => response.status).sort()).toEqual([204, 401, 401, 401]);
        expect(byEmailCode.filter(response => response.status === 200)).toHaveLength(1);
    });

    it('T4: TOTP confirm twice at once — one 200, and one recovery-code generation', async () =>
    {
        const device = bearerFor((await passwordSignIn()).key);
        const secret = (await (await post('/_auth/mfa/totp/enroll', {}, device)).json()).secret as string;
        const code = codeFor(secret);

        const confirms = await Promise.all([1, 2].map(() => post('/_auth/mfa/totp/confirm', { code }, device)));
        const codes = await getTestDb().select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, ownerId));

        expect(confirms.map(response => response.status).sort()).toEqual([200, 400]);
        expect(new Set(codes.map(entry => entry.generation)).size).toBe(1);
        expect(codes).toHaveLength(10);
    });

    it('T5: a passkey without user verification is no second factor — new device 202, no mark, refused at verify and step-up; with it exempt and accepted', async () =>
    {
        const { device } = await enrolledOwner();
        const unverified = await registerPasskey(device, false);
        const verified = await registerPasskey(device, true);

        const unverifiedSignIn = await passkeySignIn(unverified.authenticator, false);
        const verifiedSignIn = await passkeySignIn(unverified.authenticator, true);
        const markUnverified = await post('/_auth/mfa/passkey/mark', { passkeyId: unverified.passkeyId, secondFactor: true }, device);
        const markVerified = await post('/_auth/mfa/passkey/mark', { passkeyId: verified.passkeyId, secondFactor: true }, device);

        expect(unverifiedSignIn.status).toBe(202);
        expect((await unverifiedSignIn.json()).mfaRequired).toBe(true);
        expect(verifiedSignIn.status).toBe(200);
        expect((await verifiedSignIn.json()).mfaRequired).toBe(false);
        expect(markUnverified.status).toBe(409);
        expect((await markUnverified.json()).error.code).toBe('PasskeyUserVerificationRequiredError');
        expect(markVerified.status).toBe(200);

        // The marked passkey, used without user verification, proves nothing; with it, it does.
        expect((await passkeyStepUp(device, verified.authenticator, false)).status).toBe(401);
        expect((await passkeyStepUp(device, verified.authenticator, true)).status).toBe(204);

        const { body } = await passwordSignIn(202);

        expect((await passkeyVerify(body.challenge.secret, verified.authenticator, false)).status).toBe(401);
        expect((await passkeyVerify(body.challenge.secret, verified.authenticator, true)).status).toBe(200);
    });

    it('T6: full-width digits, non-digits and the wrong length are 401 and counted, never 500', async () =>
    {
        const { device } = await enrolledOwner();
        const statuses = [];

        for (const code of ['１２３４５６', 'abcdef', '12345'])
        {
            statuses.push((await post('/_auth/mfa/step-up', { code }, device)).status);
        }

        expect(statuses).toEqual([401, 401, 401]);
        expect(await budgetFailures()).toBe(3);
    });

    it('T7: after the lock window the right code passes', async () =>
    {
        const { device, secret } = await enrolledOwner();

        for (let attempt = 0; attempt < 5; attempt += 1)
        {
            await post('/_auth/mfa/step-up', { code: wrongCode(secret) }, device);
        }

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret) }, device)).status).toBe(429);

        await shiftBudget(16);

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret) }, device)).status).toBe(204);
    });

    it('T8: an application-profile session confirms TOTP (200) and steps up (204), the record held by the profile — never by the device key it reports', async () =>
    {
        const profile = profileOf('app-key-1');
        const { secret } = await enrolTotp(profile);

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret) }, profile)).status).toBe(204);

        const device = await passwordSignIn(202);
        const deviceKeyId = device.key.keyId;
        await post('/_auth/mfa/verify', { challenge: device.body.challenge.secret, code: codeFor(secret, 1) });
        await getTestDb().delete(mfaVerifications).where(eq(mfaVerifications.keyId, deviceKeyId));
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret) }, profileOf(deviceKeyId))).status).toBe(204);

        const records = await getTestDb().select().from(mfaVerifications);

        expect(records.map(row => [row.keyId, row.profile, row.profileKeyId])).toHaveLength(2);
        expect(records.map(row => [row.keyId, row.profile, row.profileKeyId])).toEqual(expect.arrayContaining([
            [null, PROFILE, 'app-key-1'],
            [null, PROFILE, deviceKeyId],
        ]));
        expect((await post('/_auth/mfa/recovery/regenerate', {}, bearerFor(device.key))).status).toBe(403);
    });
    it('T10: six bodies at mfa/step-up that are no passkey assertion — five 401s, counted, the sixth meets the lock; three at mfa/verify — 401, counted', async () =>
    {
        const { device } = await ownerWithMarkedPasskey();
        const locked = vi.spyOn(mfaLockedEvent, 'emit');
        const stepUps = [];

        for (const response of NOT_AN_ASSERTION)
        {
            stepUps.push((await post('/_auth/mfa/step-up', { response }, device)).status);
        }

        expect(stepUps).toEqual([401, 401, 401, 401, 401, 429]);
        expect(await budgetFailures()).toBe(5);
        expect(locked).toHaveBeenCalledTimes(1);

        await getTestDb().delete(mfaAttemptBudgets);
        const { body } = await passwordSignIn(202);
        const verifies = [];

        for (const response of NOT_AN_ASSERTION.slice(0, 3))
        {
            verifies.push((await post('/_auth/mfa/verify', { challenge: body.challenge.secret, response })).status);
        }

        expect(verifies).toEqual([401, 401, 401]);
        expect(await budgetFailures()).toBe(3);
    });

    it('T11: the same bodies at passkey sign-in and registration — their own 401 PasskeyVerificationError, never 500', async () =>
    {
        const device = bearerFor((await passwordSignIn()).key);
        const answers = [];

        for (const response of NOT_AN_ASSERTION)
        {
            const signIn = await post('/_auth/passkeys/login/verify', { response, ...deviceKeyBody(generateKeyPair('ES256')) });
            const register = await post('/_auth/passkeys/register/verify', { response }, device);

            answers.push([signIn.status, (await signIn.json()).error?.code], [register.status, (await register.json()).error?.code]);
        }

        expect(answers).toEqual(NOT_AN_ASSERTION.flatMap(() => [
            [401, 'PasskeyVerificationError'],
            [401, 'PasskeyVerificationError'],
        ]));
    });

    it('T12: 1 wrong proof, 3 just before fifteen minutes pass and 4 after — the fifth inside fifteen minutes locks', async () =>
    {
        const { device, secret } = await enrolledOwner();
        const locked = vi.spyOn(mfaLockedEvent, 'emit');

        const first = await wrongStepUps(device, secret, 1);
        await shiftBudget(14);
        const beforeTheEdge = await wrongStepUps(device, secret, 3);
        await shiftBudget(2);
        const afterTheEdge = await wrongStepUps(device, secret, 4);

        // The first failure is 16 minutes old by then; the three are 2 minutes
        // old, so the second failure after the edge is the fifth in fifteen.
        expect([...first, ...beforeTheEdge]).toEqual([401, 401, 401, 401]);
        expect(afterTheEdge).toEqual([401, 401, 429, 429]);
        expect(locked).toHaveBeenCalledTimes(1);
    });

    it('T13: a verification code at its attempt limit — the right code and a wrong one get identical answers', async () =>
    {
        await post('/_auth/codes', { target: NEW_EMAIL, targetType: 'email', purpose: 'registration' });
        const [row] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, NEW_EMAIL), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);
        const wrong = row!.code === '000000' ? '111111' : '000000';
        const verify = async (code: string) =>
        {
            const response = await post('/_auth/codes/verify', { target: NEW_EMAIL, targetType: 'email', code, purpose: 'registration' });
            // The request id is the one part of an answer that differs per request
            const { error: { requestId, ...error }, ...body } = await response.json();

            return { status: response.status, body: { ...body, error } };
        };

        for (let attempt = 0; attempt < 5; attempt += 1)
        {
            expect((await verify(wrong)).status).toBe(400);
        }

        const right = await verify(row!.code);

        expect(right).toEqual(await verify(wrong));
        expect(right.body.error.message).toMatch(/too many attempts/i);
    });

    it('T14: a TOTP code checked against the old secret, the enrolment replaced while it waits on the account lock — 401, nothing spent on the new one', async () =>
    {
        const { device, secret } = await enrolledOwner();

        const response = await whileWaitingOnTheLock(() => post('/_auth/mfa/step-up', { code: codeFor(secret) }, device), async () =>
        {
            await getTestDb().delete(mfaTotp).where(eq(mfaTotp.userId, ownerId));
            await getTestDb().insert(mfaTotp).values({
                userId: ownerId,
                secretEnc: encryptMfaSecret('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', ownerId),
                confirmedAt: new Date(),
            });
        });
        const [enrolment] = await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, ownerId));

        expect(response.status).toBe(401);
        expect(enrolment!.lastUsedStep).toBeNull();
    }, 20_000);

    it('T15: a profile session reporting a device key\'s id, the key freshly stepped up and the profile not — deletion request 403 STEP_UP_REQUIRED', async () =>
    {
        const { key } = await passwordSignIn();
        const device = bearerFor(key);
        await enrolTotp(device);

        const asProfile = await post('/_auth/deletion/request', { password: PASSWORD }, profileOf(key.keyId));

        expect(asProfile.status).toBe(403);
        expect((await asProfile.json()).error.code).toBe('StepUpRequiredError');
        // The device key's own record is fresh: the same request from it passes the step-up.
        expect((await post('/_auth/deletion/request', { password: PASSWORD }, device)).status).toBe(200);
    });

    it('T16: a TOTP confirm with the first pending secret\'s code, a second enroll landing while it waits on the account lock — refused, the new enrolment unconfirmed', async () =>
    {
        pinClockInsideTotpStep();
        const device = bearerFor((await passwordSignIn()).key);
        const first = (await (await post('/_auth/mfa/totp/enroll', {}, device)).json()).secret as string;

        // The confirm's first account lock is the one it decides under. It
        // waits there while a second enroll — from this test, not from inside
        // the confirm's transaction — replaces the pending secret.
        const reached = gate();
        const landed = gate();
        let waited = false;
        const lockAccount = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementation(async (id) =>
        {
            if (!waited)
            {
                waited = true;
                reached.open();
                await landed.opened;
            }

            return await lockAccount(id);
        });

        const confirming = post('/_auth/mfa/totp/confirm', { code: codeFor(first) }, device);
        await reached.opened;
        expect((await post('/_auth/mfa/totp/enroll', {}, device)).status).toBe(200);
        landed.open();

        const confirm = await confirming;
        const [enrolment] = await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, ownerId));

        expect(confirm.status).toBe(400);
        expect((await confirm.json()).error.code).toBe('MfaNotEnrolledError');
        expect(enrolment!.confirmedAt).toBeNull();
        expect(await getTestDb().select().from(mfaRecoveryCodes)).toEqual([]);
    });

    it('PA1: profile session reporting a fresh device key id, no password — passkeys/register/options refused', async () =>
    {
        const { key } = await passwordSignIn();
        const control = await post('/_auth/passkeys/register/options', {}, profileOf('never-signed-in'));
        const borrowed = await post('/_auth/passkeys/register/options', {}, profileOf(key.keyId));
        expect(control.status).toBe(403);
        expect(borrowed.status).toBe(403);
    });

    it('PA2: profile session reporting a fresh device key id, no password — deletion request refused', async () =>
    {
        const { key } = await passwordSignIn();
        const control = await post('/_auth/deletion/request', {}, profileOf('never-signed-in'));
        const borrowed = await post('/_auth/deletion/request', {}, profileOf(key.keyId));
        expect(control.status).toBe(403);
        expect(borrowed.status).toBe(403);
    });

    it('PA3: the same profile session presenting the password — passkeys/register/options 200, deletion request 200', async () =>
    {
        const { key } = await passwordSignIn();
        const options = await post('/_auth/passkeys/register/options', { currentPassword: PASSWORD }, profileOf(key.keyId));
        const deletion = await post('/_auth/deletion/request', { password: PASSWORD }, profileOf(key.keyId));

        expect(options.status).toBe(200);
        expect(deletion.status).toBe(200);
    });
});
