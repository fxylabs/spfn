/**
 * @spfn/auth - Credential spends under the account lock (PR #315 review round 4)
 *
 * - R9 (B1): a consent from a session whose password was changed while the
 *   consent waited before the lock: refused, no live grant, no code.
 * - R10 (B2): a recovery code checked before a regeneration commits is not
 *   spent after it.
 * - R11 (B3): a correct first TOTP code confirms while a key rotation rewrites
 *   the enrolment's ciphertext.
 * - R12 (B4): two passkey assertions verified against one counter: exactly one
 *   signs in, and the stored counter never moves backwards.
 * - R13: `mfa/verify` with a passkey while the account lock is held answers 503
 *   with `Retry-After`, and the same assertion succeeds once it is released.
 * - R14: a second account's lock in one transaction is refused outside the
 *   test assertion too.
 * - R15: a sweep run past its time budget starts no further account, and says
 *   so in one summary line.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';

import { clearTables, getTestDb, isDatabaseAvailable, setupTestDb, teardownTestDb } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    decideAuthorize,
    mountAuthApp,
    registerLoopbackClient,
    resetMemoryRateLimitStore,
    TEST_PASSWORD,
} from '../helpers/oauth2';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaRecoveryCodes, mfaTotp, oauth2AuthorizationCodes, oauth2Grants, passkeys, users } from '@/server/entities';
import { passkeysRepository, usersRepository } from '@/server/repositories';
import { ACCOUNT_LOCK_TIMEOUT_MS } from '@/server/repositories/users.repository';
import { generateClientToken, generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { decryptMfaSecret, encryptMfaSecret } from '@/server/lib/mfa-cipher';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authLogger } from '@/server/logger';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: vi.fn().mockResolvedValue({ success: true }), sendSMS: vi.fn().mockResolvedValue({ success: true }) };
});

const { runInTransaction } = await import('@spfn/core/db');
const { SecondAccountLockError } = await import('@/server/repositories/account-lock');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { regenerateRecoveryCodesService } = await import('@/server/services/mfa.service');
const { sweepEachAccount } = await import('@/server/services/account-sweep.service');

const dbAvailable = await isDatabaseAvailable();
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const ACTIVE_KEYRING = `active:${Buffer.alloc(32, 7).toString('base64')}`;

function gate(): { open: () => void; opened: Promise<void> }
{
    let open!: () => void;
    const opened = new Promise<void>(resolve =>
    {
        open = resolve;
    });

    return { open, opened };
}

/** Hold the account's lock on a connection of the test's own until `release` opens. */
function holdAccountLock(userId: number, release: Promise<void>): { held: Promise<void>; done: Promise<void> }
{
    const held = gate();
    const done = getTestDb().transaction(async (tx) =>
    {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update');
        held.open();
        await release;
    });

    return { held: held.opened, done };
}

describe.skipIf(!dbAvailable)('Credential spends under the account lock (round 4)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEYRING;
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        configureTestAuthorizationServer();
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEYRING;
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    function send(method: string, path: string, body: unknown, authorization?: string)
    {
        return Promise.resolve(app.request(path, {
            method,
            headers: { ...JSON_HEADERS, 'x-forwarded-for': '203.0.113.40', ...(authorization ? { Authorization: authorization } : {}) },
            body: JSON.stringify(body),
        }));
    }

    function deviceKeyBody(key: KeyPair = generateKeyPair('ES256'))
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    function bearer(key: KeyPair): string
    {
        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    async function newAccount(): Promise<{ email: string; userId: number }>
    {
        const email = `r4-${Math.random().toString(36).slice(2)}@lock.test`;

        return { email, userId: await createTestUser(email, (await getRoleByName('user'))!.id) };
    }

    async function signIn(email: string): Promise<{ response: Response; key: KeyPair }>
    {
        const key = generateKeyPair('ES256');

        return { response: await send('POST', '/_auth/login', { email, password: TEST_PASSWORD, ...deviceKeyBody(key) }), key };
    }

    async function signedIn(email: string): Promise<KeyPair>
    {
        const { response, key } = await signIn(email);
        expect(response.status).toBe(200);

        return key;
    }

    const totpCode = (secret: string) => hotp(decodeBase32(secret), totpStep(Date.now()));

    async function enrolTotp(key: KeyPair): Promise<{ secret: string; recoveryCodes: string[] }>
    {
        const secret = (await (await send('POST', '/_auth/mfa/totp/enroll', {}, bearer(key))).json()).secret as string;
        const confirmed = await send('POST', '/_auth/mfa/totp/confirm', { code: totpCode(secret) }, bearer(key));
        expect(confirmed.status).toBe(200);

        return { secret, recoveryCodes: (await confirmed.json()).recoveryCodes as string[] };
    }

    async function enrolPasskey(key: KeyPair, secondFactor: boolean): Promise<{ authenticator: FixtureAuthenticator; passkeyId: string }>
    {
        const authenticator = await FixtureAuthenticator.create();
        const challenge = (await (await send('POST', '/_auth/passkeys/register/options', {}, bearer(key))).json()).challenge;
        const enrolled = await send('POST', '/_auth/passkeys/register/verify', { response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }) }, bearer(key));
        expect(enrolled.status).toBe(200);
        const { passkeyId } = await enrolled.json();

        if (secondFactor)
        {
            expect((await send('POST', '/_auth/mfa/passkey/mark', { passkeyId, secondFactor: true }, bearer(key))).status).toBe(200);
        }

        return { authenticator, passkeyId };
    }

    /** Hold every `lockAccount` call before it locks, until `release` opens; `reached` opens at the first. */
    function pauseBeforeLock(release: Promise<void>): Promise<void>
    {
        const reached = gate();
        const lock = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementation(async (id: number) =>
        {
            reached.open();
            await release;

            return await lock(id);
        });

        return reached.opened;
    }

    it('R9 (B1) a consent whose session lost its key to a password change while it waited before the lock: 401, no live grant, no code', async () =>
    {
        const { email, userId } = await newAccount();
        const stolen = await signedIn(email);
        const owner = await signedIn(email);
        const clientId = await registerLoopbackClient(app, 'r9 cli', undefined, '203.0.113.41');

        const paused = gate();
        const resume = gate();
        const lock = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementationOnce(async (id: number) =>
        {
            paused.open();
            await resume.opened;

            return await lock(id);
        });

        const consent = decideAuthorize(app, bearer(stolen), { client_id: clientId, approve: true });
        await paused.opened;
        const changed = await send('PUT', '/_auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'N3w-Passw0rd!r9' }, bearer(owner));
        resume.open();
        const response = await consent;

        const live = await getTestDb().select().from(oauth2Grants).where(and(eq(oauth2Grants.user, userId), isNull(oauth2Grants.revokedAt)));
        const codes = await getTestDb().select().from(oauth2AuthorizationCodes);

        expect({ change: changed.status, consent: response.status, code: (await response.json()).error?.code, grants: live.length, codes: codes.length })
            .toEqual({ change: 204, consent: 401, code: 'KeyRevokedError', grants: 0, codes: 0 });
    }, 30_000);

    it('R10 (B2) a recovery code checked before a regeneration commits is refused at its spend', async () =>
    {
        const { email, userId } = await newAccount();
        const key = await signedIn(email);
        const { recoveryCodes } = await enrolTotp(key);

        const release = gate();
        const reached = pauseBeforeLock(release.opened);
        const stepUp = send('POST', '/_auth/mfa/step-up', { recoveryCode: recoveryCodes[0] }, bearer(key));
        await reached;
        vi.mocked(usersRepository.lockAccount).mockRestore();
        // As the route runs it: in its own transaction, which the service locks.
        await runInTransaction(() => regenerateRecoveryCodesService(userId));
        release.open();
        const response = await stepUp;

        const spent = await getTestDb().select().from(mfaRecoveryCodes).where(and(eq(mfaRecoveryCodes.userId, userId), eq(mfaRecoveryCodes.generation, 1)));

        expect({ status: response.status, spentFromRevoked: spent.filter(row => row.usedAt !== null).length })
            .toEqual({ status: 401, spentFromRevoked: 0 });
    }, 30_000);

    it('R11 (B3) a correct first TOTP code confirms while a key rotation rewrites the enrolment\'s ciphertext: 200', async () =>
    {
        const { email, userId } = await newAccount();
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `old:${Buffer.alloc(32, 3).toString('base64')}`;
        const key = await signedIn(email);
        const secret = (await (await send('POST', '/_auth/mfa/totp/enroll', {}, bearer(key))).json()).secret as string;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `new:${Buffer.alloc(32, 4).toString('base64')},old:${Buffer.alloc(32, 3).toString('base64')}`;

        const release = gate();
        const reached = pauseBeforeLock(release.opened);
        const confirm = send('POST', '/_auth/mfa/totp/confirm', { code: totpCode(secret) }, bearer(key));
        await reached;
        // The rewrite `readSecret` queued, landing before the confirm's lock.
        const [row] = await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, userId));
        await getTestDb().update(mfaTotp).set({ secretEnc: encryptMfaSecret(decryptMfaSecret(row!.secretEnc, userId).value, userId) }).where(eq(mfaTotp.userId, userId));
        release.open();
        const response = await confirm;

        const [after] = await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, userId));

        expect({ status: response.status, confirmed: after!.confirmedAt !== null, rotated: after!.secretEnc.startsWith('enc:v2:new:') })
            .toEqual({ status: 200, confirmed: true, rotated: true });
    }, 30_000);

    it('R12 (B4) two assertions with counters 6 and 5, both verified against 4: one signs in, the counter stays 6', async () =>
    {
        const { email, userId } = await newAccount();
        const { authenticator, passkeyId } = await enrolPasskey(await signedIn(email), false);
        await getTestDb().update(passkeys).set({ counter: 4 }).where(eq(passkeys.id, Number(passkeyId)));

        const reads = [gate(), gate()];
        const releases = [gate(), gate()];
        const findLive = passkeysRepository.findLiveByCredentialId.bind(passkeysRepository);
        let call = 0;
        vi.spyOn(passkeysRepository, 'findLiveByCredentialId').mockImplementation(async (id: string) =>
        {
            const mine = call++;
            const row = await findLive(id);
            reads[mine]!.open();
            await releases[mine]!.opened;

            return row;
        });

        async function assertion(counter: number): Promise<Response>
        {
            const challenge = (await (await send('POST', '/_auth/passkeys/login/options', {})).json()).challenge;

            return await send('POST', '/_auth/passkeys/login/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter }),
                ...deviceKeyBody(),
            });
        }

        const six = assertion(6);
        await reads[0]!.opened;
        const five = assertion(5);
        await reads[1]!.opened;
        releases[0]!.open();
        const first = await six;
        releases[1]!.open();
        const second = await five;

        const [row] = await getTestDb().select().from(passkeys).where(eq(passkeys.userId, userId));

        expect({ six: first.status, five: second.status, counter: row!.counter })
            .toEqual({ six: 200, five: 401, counter: 6 });
    }, 30_000);

    it('R13 mfa/verify with a passkey while the account lock is held: 503 with Retry-After; released, the same assertion: 200', async () =>
    {
        const { email, userId } = await newAccount();
        const enrolled = await signedIn(email);
        await enrolTotp(enrolled);
        const { authenticator } = await enrolPasskey(enrolled, true);

        const { response: opened } = await signIn(email);
        expect(opened.status).toBe(202);
        const challenge = (await opened.json()).challenge.secret as string;
        const options = (await (await send('POST', '/_auth/mfa/verify/options', { challenge })).json()).challenge;
        const proof = { challenge, response: authenticator.assert({ challenge: options, origin: ORIGIN, rpId: RP_ID, counter: 1 }) };

        const release = gate();
        const holder = holdAccountLock(userId, release.opened);
        await holder.held;
        const busy = await send('POST', '/_auth/mfa/verify', proof).finally(release.open);
        await holder.done;

        const busyAnswer = { status: busy.status, code: (await busy.json()).error?.code, retryAfter: busy.headers.get('retry-after') };
        const retried = await send('POST', '/_auth/mfa/verify', proof);

        expect({ busy: busyAnswer, retried: retried.status })
            .toEqual({ busy: { status: 503, code: 'AccountBusyError', retryAfter: '1' }, retried: 200 });
    }, ACCOUNT_LOCK_TIMEOUT_MS + 30_000);

    it('R14 a second account\'s lock in one transaction throws SecondAccountLockError with the test assertion off', async () =>
    {
        vi.stubEnv('SPFN_AUTH_ASSERT_ACCOUNT_LOCK', '0');
        const first = await newAccount();
        const second = await newAccount();

        const attempt = runInTransaction(async () =>
        {
            await usersRepository.lockAccount(first.userId);
            await usersRepository.lockAccount(second.userId);
        });

        await expect(attempt).rejects.toBeInstanceOf(SecondAccountLockError);
    });

    it('R15 a sweep run past its time budget starts no further account, and logs one summary line', async () =>
    {
        const accounts = [(await newAccount()).userId, (await newAccount()).userId];
        const sweep = vi.fn().mockResolvedValue(1);
        const info = vi.spyOn(authLogger.service, 'info');

        const rows = await sweepEachAccount(accounts, 'auth:r15', sweep, 0);

        expect({ rows, swept: sweep.mock.calls.length }).toEqual({ rows: 0, swept: 0 });
        expect(info.mock.calls.filter(([message]) => message === 'Sweep run'))
            .toEqual([['Sweep run', { context: 'auth:r15', accounts: 2, rows: 0, swept: 0, busy: 0, deferred: 2 }]]);
    });
});
