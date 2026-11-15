/**
 * @spfn/auth - Every credential writer under the account lock (PR #315 review round 3)
 *
 * The writers are derived (`AccountStateRepository`), so these rows are the
 * races review found among writers nobody had listed, and the rules the lock
 * itself gained:
 *
 * - R1 (B1): a password change racing a device-link issue from the same key.
 * - R2 (B3): the fifth wrong proof dropping the pending key, racing the right
 *   proof on the same challenge.
 * - R3 (B2): a passkey revoked while its sign-in waits before the lock.
 * - R4: a held account lock answers the waiter `AccountBusyError` within the bound,
 *   with `Retry-After`.
 * - R5: an OAuth link that moves between the unlocked read and the lock — the
 *   sign-in ends on the right account or the typed refusal, never two locks.
 * - R6: the challenge sweep, one account per transaction under its lock.
 * - R7: two first passwords set at once — the second is a conflict.
 * - R8: an unclassified write on a credential table is refused under test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { clearTables, getTestDb, isDatabaseAvailable, setupTestDb, teardownTestDb } from '../helpers/db';
import { createTestUser, mountAuthApp, resetMemoryRateLimitStore, TEST_PASSWORD } from '../helpers/oauth2';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaChallenges, mfaTotp, passkeys, userPublicKeys, userSocialAccounts, users } from '@/server/entities';
import {
    deviceLinksRepository,
    mfaChallengesRepository,
    passkeysRepository,
    socialAccountsRepository,
    usersRepository,
} from '@/server/repositories';
import { AccountStateRepository } from '@/server/repositories/account-state.repository';
import { ACCOUNT_LOCK_TIMEOUT_MS } from '@/server/repositories/users.repository';
import { generateClientToken, generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
// The server throws the package's own error classes, from its entry.
import { OAuthSignInContendedError } from '@spfn/auth/errors';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: vi.fn().mockResolvedValue({ success: true }), sendSMS: vi.fn().mockResolvedValue({ success: true }) };
});

const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { lockLinkedAccount, retryContendedSignIn } = await import('@/server/services/oauth.service');
const { sweepMfaChallengesService } = await import('@/server/services/mfa.service');

const dbAvailable = await isDatabaseAvailable();
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

function gate(): { open: () => void; opened: Promise<void> }
{
    let open!: () => void;
    const opened = new Promise<void>(resolve =>
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
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('no lock wait observed');
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

describe.skipIf(!dbAvailable)('Every credential writer under the account lock', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 7).toString('base64')}`;
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
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
    });

    afterEach(() => vi.restoreAllMocks());

    function send(method: string, path: string, body: unknown, authorization?: string, ip = '203.0.113.9')
    {
        return app.request(path, {
            method,
            headers: { ...JSON_HEADERS, 'x-forwarded-for': ip, ...(authorization ? { Authorization: authorization } : {}) },
            body: JSON.stringify(body),
        });
    }

    function deviceKeyBody(key: KeyPair = generateKeyPair('ES256'))
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    function bearer(key: KeyPair): string
    {
        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    async function signedInAccount(): Promise<{ email: string; userId: number; key: KeyPair }>
    {
        const email = `lock-${Math.random().toString(36).slice(2)}@lock.test`;
        const userId = await createTestUser(email, (await getRoleByName('user'))!.id);
        const key = generateKeyPair('ES256');
        expect((await send('POST', '/_auth/login', { email, password: TEST_PASSWORD, ...deviceKeyBody(key) })).status).toBe(200);

        return { email, userId, key };
    }

    it('R1 (B1) a password change racing a device-link issue from the same key: both succeed, one after the other', async () =>
    {
        const { key } = await signedInAccount();
        expect((await send('POST', '/_auth/device/link/issue', {}, bearer(key))).status).toBe(200);

        const locked = gate();
        const goOn = gate();
        const expireLive = deviceLinksRepository.expireLiveByIssuerKey.bind(deviceLinksRepository);
        vi.spyOn(deviceLinksRepository, 'expireLiveByIssuerKey').mockImplementationOnce(async (...args) =>
        {
            // The issue holds the account lock here.
            locked.open();
            await goOn.opened;

            return await expireLive(...args);
        });

        const issued = send('POST', '/_auth/device/link/issue', {}, bearer(key));
        await locked.opened;
        const changed = send('PUT', '/_auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'N3w-Passw0rd!x' }, bearer(key));
        await someoneWaitsOnALock().finally(goOn.open);

        const [i, c] = await Promise.all([issued, changed]);
        const bodies = [await i.text(), await c.text()];

        expect({ issue: i.status, change: c.status, deadlock: /deadlock/i.test(bodies.join(' ')) })
            .toEqual({ issue: 200, change: 204, deadlock: false });
    }, 30_000);

    it('R2 (B3) the fifth wrong proof and the right proof on one challenge: the right one 200, the wrong one 401, no deadlock', async () =>
    {
        const { email, key } = await signedInAccount();
        const code = (secret: string) => hotp(decodeBase32(secret), totpStep(Date.now()));
        const secret = (await (await send('POST', '/_auth/mfa/totp/enroll', {}, bearer(key))).json()).secret as string;
        expect((await send('POST', '/_auth/mfa/totp/confirm', { code: code(secret) }, bearer(key))).status).toBe(200);
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });

        const second = await send('POST', '/_auth/login', { email, password: TEST_PASSWORD, ...deviceKeyBody() });
        expect(second.status).toBe(202);
        const challenge = (await second.json()).challenge.secret as string;
        await getTestDb().update(mfaChallenges).set({ attempts: 4 });

        const atMark = gate();
        const goMark = gate();
        const markVerified = mfaChallengesRepository.markVerified.bind(mfaChallengesRepository);
        vi.spyOn(mfaChallengesRepository, 'markVerified').mockImplementationOnce(async (row) =>
        {
            // The right proof holds the account lock here.
            atMark.open();
            await goMark.opened;

            return await markVerified(row);
        });

        const right = send('POST', '/_auth/mfa/verify', { challenge, code: code(secret) });
        await atMark.opened;
        const wrong = send('POST', '/_auth/mfa/verify', { challenge, code: code(secret) === '000000' ? '111111' : '000000' }, undefined, '203.0.113.20');
        // The wrong proof's count and drop wait for the lock instead of taking
        // the key and challenge rows in the other order.
        await someoneWaitsOnALock().finally(goMark.open);

        const [r, w] = await Promise.all([right, wrong]);
        const bodies = [await r.text(), await w.text()];
        const [activated] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.isActive, true)).orderBy(sql`id desc`).limit(1);

        expect({ right: r.status, wrong: w.status, deadlock: /deadlock/i.test(bodies.join(' ')) })
            .toEqual({ right: 200, wrong: 401, deadlock: false });
        // The drop is scoped to a key still pending: the one just activated stays.
        expect(activated!.pendingMfaChallengeId).toBeNull();
    }, 30_000);

    it('R3 (B2) a passkey revoked while its sign-in waits before the lock does not sign in: 401, no key, counter unwritten', async () =>
    {
        const { key } = await signedInAccount();
        const authenticator = await FixtureAuthenticator.create();
        const registration = (await (await send('POST', '/_auth/passkeys/register/options', {}, bearer(key))).json()).challenge;
        const enrolled = await send('POST', '/_auth/passkeys/register/verify', { response: authenticator.attest({ challenge: registration, origin: ORIGIN, rpId: RP_ID }) }, bearer(key));
        expect(enrolled.status).toBe(200);
        const { passkeyId } = await enrolled.json();

        const paused = gate();
        const resume = gate();
        const findLive = passkeysRepository.findLiveByCredentialId.bind(passkeysRepository);
        vi.spyOn(passkeysRepository, 'findLiveByCredentialId').mockImplementationOnce(async (id: string) =>
        {
            const row = await findLive(id);
            paused.open();
            await resume.opened;

            return row;
        });

        const challenge = (await (await send('POST', '/_auth/passkeys/login/options', {})).json()).challenge;
        const deviceKey = generateKeyPair('ES256');
        const signIn = send('POST', '/_auth/passkeys/login/verify', {
            response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
            ...deviceKeyBody(deviceKey),
        });
        await paused.opened;
        expect((await send('POST', '/_auth/passkeys/revoke', { passkeyId }, bearer(key))).status).toBe(200);
        resume.open();

        const response = await signIn;
        const [row] = await getTestDb().select().from(passkeys).where(eq(passkeys.id, Number(passkeyId)));
        const registered = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, deviceKey.keyId));

        expect({ status: response.status, keys: registered.length, counter: row!.counter, revoked: row!.revokedAt !== null })
            .toEqual({ status: 401, keys: 0, counter: 0, revoked: true });
    }, 30_000);

    it('R4 a held account lock answers the waiter AccountBusyError (503) within the bound, not a connection error', async () =>
    {
        const { userId, key } = await signedInAccount();
        const release = gate();
        const holder = holdAccountLock(userId, release.opened);
        await holder.held;

        const started = Date.now();
        const response = await Promise.resolve(send('POST', '/_auth/device/link/issue', {}, bearer(key))).finally(release.open);
        const waited = Date.now() - started;
        await holder.done;

        expect({ status: response.status, code: (await response.json()).error?.code, retryAfter: response.headers.get('retry-after') })
            .toEqual({ status: 503, code: 'AccountBusyError', retryAfter: '1' });
        expect(waited).toBeGreaterThanOrEqual(ACCOUNT_LOCK_TIMEOUT_MS - 100);
        expect(waited).toBeLessThan(ACCOUNT_LOCK_TIMEOUT_MS + 5_000);
    }, 30_000);

    describe('R5 an OAuth link that moves between the unlocked read and the lock', () =>
    {
        const providerUserId = 'kakao-r5';

        async function linkedPair(): Promise<{ from: number; to: number }>
        {
            const roleId = (await getRoleByName('user'))!.id;
            const from = await createTestUser('r5-from@lock.test', roleId);
            const to = await createTestUser('r5-to@lock.test', roleId);
            await getTestDb().insert(userSocialAccounts).values({ userId: from, provider: 'kakao', providerUserId });

            return { from, to };
        }

        /**
         * The unlocked read of each of the first `times` attempts answers, and
         * then the link moves to the other account — before the lock.
         * `lockLinkedAccount` reads twice an attempt: unlocked, then locked.
         */
        function moveAfterUnlockedRead(pair: { from: number; to: number }, times: number): void
        {
            const read = socialAccountsRepository.findByProviderAndProviderId.bind(socialAccountsRepository);
            let reads = 0;

            vi.spyOn(socialAccountsRepository, 'findByProviderAndProviderId').mockImplementation(async (provider, id) =>
            {
                const link = await read(provider, id);
                const attempt = reads++;

                if (link && attempt % 2 === 0 && attempt / 2 < times)
                {
                    const other = link.userId === pair.from ? pair.to : pair.from;
                    await getTestDb().update(userSocialAccounts).set({ userId: other }).where(eq(userSocialAccounts.id, link.id));
                }

                return link;
            });
        }

        function signIn(): Promise<number>
        {
            return retryContendedSignIn('kakao', () => runInTransaction(async () => (await lockLinkedAccount('kakao', providerUserId))!.userId));
        }

        it('once: the sign-in runs again and ends on the account the link moved to, holding one account lock', async () =>
        {
            const pair = await linkedPair();
            const locked = vi.spyOn(usersRepository, 'lockAccount');
            moveAfterUnlockedRead(pair, 1);

            await expect(signIn()).resolves.toBe(pair.to);
            // One lock per attempt: the stale one rolled back, the second
            // attempt locked the account the link moved to. A second account's
            // lock in one transaction throws `SecondAccountLockError`.
            expect(locked.mock.calls.map(([id]) => id)).toEqual([pair.from, pair.to]);
        });

        it('twice: the typed refusal, OAuthSignInContendedError', async () =>
        {
            moveAfterUnlockedRead(await linkedPair(), 2);

            await expect(signIn()).rejects.toBeInstanceOf(OAuthSignInContendedError);
        });
    });

    it('R6 the challenge sweep takes each account under its own lock; a busy account is left for the next run', async () =>
    {
        const first = await signedInAccount();
        const second = await signedInAccount();
        const expired = new Date(Date.now() - 60_000);

        for (const account of [first, second])
        {
            const pending = generateKeyPair('ES256');
            await getTestDb().insert(userPublicKeys).values({ userId: account.userId, keyId: pending.keyId, publicKey: pending.publicKey, fingerprint: pending.fingerprint, algorithm: 'ES256', isActive: false });
            const [row] = await getTestDb().insert(mfaChallenges).values({ userId: account.userId, keyId: pending.keyId, challengeHash: `h-${pending.keyId}`, channel: 'password', keyEpoch: 0, expiresAt: expired }).returning();
            await getTestDb().update(userPublicKeys).set({ pendingMfaChallengeId: row!.id }).where(eq(userPublicKeys.keyId, pending.keyId));
        }

        const release = gate();
        const holder = holdAccountLock(second.userId, release.opened);
        await holder.held;
        const swept = await sweepMfaChallengesService().finally(release.open);
        await holder.done;

        const left = await getTestDb().select({ userId: mfaChallenges.userId }).from(mfaChallenges);
        expect({ deleted: swept.deleted, left: left.map(row => row.userId) }).toEqual({ deleted: 1, left: [second.userId] });

        expect((await sweepMfaChallengesService()).deleted).toBe(1);
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.isActive, false))).toEqual([]);
    }, 30_000);

    it('R7 two first passwords set at once on an account that had none: the second answers 409, not "incorrect"', async () =>
    {
        const { userId, key } = await signedInAccount();
        await getTestDb().update(users).set({ passwordHash: null }).where(eq(users.id, userId));

        const locked = gate();
        const goOn = gate();
        const updatePassword = usersRepository.updatePassword.bind(usersRepository);
        vi.spyOn(usersRepository, 'updatePassword').mockImplementationOnce(async (...args) =>
        {
            locked.open();
            await goOn.opened;

            return await updatePassword(...args);
        });

        const first = send('PUT', '/_auth/password', { newPassword: 'F1rst-Passw0rd!' }, bearer(key));
        await locked.opened;
        const second = send('PUT', '/_auth/password', { newPassword: 'S3cond-Passw0rd!' }, bearer(key));
        await someoneWaitsOnALock().finally(goOn.open);

        const [a, b] = await Promise.all([first, second]);

        expect({ first: a.status, second: b.status, code: (await b.json()).error?.code })
            .toEqual({ first: 204, second: 409, code: 'ConflictError' });
    }, 30_000);

    it('R8 a write on a credential table from a method no accountWrites names is refused', async () =>
    {
        class Unclassified extends AccountStateRepository
        {
            async touch(userId: number)
            {
                await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
            }
        }

        const { userId } = await signedInAccount();

        await expect(runInTransaction(async () =>
        {
            await usersRepository.lockAccount(userId);
            await new Unclassified().touch(userId);
        })).rejects.toThrow(/Unclassified\.touch writes users .* not classified in accountWrites/);
    });
});
