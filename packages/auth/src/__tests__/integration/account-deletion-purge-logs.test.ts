/**
 * @spfn/auth - a failing deletion hook does not put the account's contact anywhere
 *
 * `onPurge` and `onBeforePurge` are handed the account's email and phone. What
 * they throw may quote them — an app's "handoff failed for <address>", a
 * constraint error whose `detail` quotes the value from its outbox write — and
 * the package logs the failure, the transaction runner logs the purge's
 * rollback, a caller's job runner stores the rejection. None of them may carry
 * the address: the purge rejects with `PurgeHookFailedError`, which keeps no
 * reference to the hook's error, only its class name and SQLSTATE.
 *
 * | Row | Checks                                                              | Unnoticed without it                              |
 * |-----|---------------------------------------------------------------------|---------------------------------------------------|
 * | L1a | a hook whose outbox write fails on a constraint whose detail quotes | a deleted account's address in the log of its own |
 * |     | the address: no line at any level has the address or phone; the    | deletion                                          |
 * |     | rollback line names the class and SQLSTATE                          |                                                   |
 * | L1b | a hook throwing a plain Error naming the address: no line at any    | the same, from the app's own error, through the   |
 * |     | level has it — core's rollback line included                        | wrapper's cause chain                             |
 * | L1c | an immediate request, whose purge runs after its commit, its hook   | the address at `error`, in core's "afterCommit    |
 * |     | naming the address over a failed write: no line has it, and the     | callback failed" line, or on the rollback line    |
 * |     | failure is the package's line with the SQLSTATE found down the chain|                                                   |
 * | L2  | the rejection holds no reference to the hook's error: no `cause`,   | the address in a response body, or in whatever an |
 * |     | and no serializer (`JSON.stringify`, `util.inspect` with hidden     | app's logger or serializer walks                  |
 * |     | fields, `describeError`, `toJSON`) reaches the address              |                                                   |
 * | L3  | the purge job: its run resolves, so pg-boss stores no failure, and  | the address in a job's stored `output`            |
 * |     | pg-boss's serializer on a rejection an app's own job would store    |                                                   |
 * |     | has no address                                                      |                                                   |
 * | L4  | an `onBeforePurge` throwing an Error naming the address: no line    | the address at `warn` on every sweep              |
 * |     | has it; the warning names the class                                 |                                                   |
 *
 * The logger's level is fixed when it is imported, so this file sets it to
 * `debug` before anything loads: core's transaction runner logs a rollback,
 * with the error and its cause chain, at `debug`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';

vi.hoisted(() =>
{
    process.env.SPFN_LOG_LEVEL = 'debug';
});

const { BaseRepository } = await import('@spfn/core/db');
const { describeError } = await import('@spfn/core/logger');
const { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } = await import('../helpers/db');
const { createTestUser } = await import('../helpers/oauth2');
const { users, accountDeletionRequests } = await import('@/server/entities');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { __resetDeletionForTests, configureDeletion } = await import('@/server/lib/deletion-config');
const { sweepDuePurges, purgeUserService, requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
const { createAuthDeletionPurgeJob } = await import('@/server/jobs/deletion-purge');
const { PurgeHookFailedError } = await import('@spfn/auth/errors');

/** The serializer pg-boss stores a failed job's `output` with, resolved the way core's pg-boss resolves it. */
function pgBossSerializeError(): (error: unknown) => unknown
{
    const fromCore = createRequire(resolve(__dirname, '../../../../core/package.json'));
    const fromPgBoss = createRequire(fromCore.resolve('pg-boss'));

    return fromPgBoss('serialize-error').serializeError;
}

const dbAvailable = await isDatabaseAvailable();

const EMAIL = 'leak-probe-4f1c@example.invalid';
const PHONE = '+15550142857';

/** An app's outbox with one row per address, so a second hand-off of the same address fails on a constraint that quotes it. */
const noticeOutbox = pgSchema('spfn_auth').table('test_purge_log_outbox', {
    id: serial('id').primaryKey(),
    email: text('email'),
    phone: text('phone'),
});

class NoticeOutboxRepository extends BaseRepository
{
    async add(account: { email: string | null; phone: string | null }): Promise<void>
    {
        await this.db.insert(noticeOutbox).values({ email: account.email, phone: account.phone });
    }
}

const noticeOutboxRepository = new NoticeOutboxRepository();

type HandedAccount = { email: string | null; phone: string | null };

/** A hook whose outbox write fails on the unique key, whose detail quotes the address; the write's error leaves the hook as it comes. */
const writeFails = (account: HandedAccount) => noticeOutboxRepository.add(account);

/** The app's own error naming the address, over that failed write. */
async function handoffFails(account: HandedAccount): Promise<void>
{
    const failure = await noticeOutboxRepository.add(account).catch((error: unknown) => error);
    throw new Error(`handoff failed for ${account.email} / ${account.phone}`, { cause: failure });
}

/** A plain Error naming the address, and nothing else. */
async function namesAddress(account: HandedAccount): Promise<void>
{
    throw new Error(`could not hand off ${account.email} / ${account.phone}`);
}

/** Whether a text has the account's address or phone. */
const quotesContact = (text: string) => text.includes(EMAIL) || text.includes(PHONE);

describe.skipIf(!dbAvailable)('account deletion - a failing hook and the log', () =>
{
    const written: string[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        await getTestDb().execute(sql`CREATE TABLE spfn_auth.test_purge_log_outbox (id serial PRIMARY KEY, email text UNIQUE, phone text)`);
    });

    afterAll(async () =>
    {
        await getTestDb().execute(sql`DROP TABLE IF EXISTS spfn_auth.test_purge_log_outbox`);
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        await db.execute(sql`TRUNCATE spfn_auth.test_purge_log_outbox`);
        // Already handed off once: the hook's write of the same address fails on the unique key, whose detail quotes it.
        await db.execute(sql`INSERT INTO spfn_auth.test_purge_log_outbox (email, phone) VALUES (${EMAIL}, ${PHONE})`);
        __resetDeletionForTests();

        written.length = 0;
        const capture = (...args: unknown[]): void =>
        {
            written.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
        };
        for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const)
        {
            vi.spyOn(console, channel).mockImplementation(capture);
        }
        for (const stream of [process.stdout, process.stderr])
        {
            vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) =>
            {
                capture(String(chunk));

                return true;
            });
        }
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        __resetDeletionForTests();
    });

    /** An account with its phone set, and a deletion request past its grace period. */
    async function dueAccount(): Promise<{ userId: number; requestId: number }>
    {
        const userId = await accountWithPhone();
        const { requestId } = await requestAccountDeletionService(userId, { requestedBy: 'admin' });
        await getTestDb().update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(eq(accountDeletionRequests.id, requestId));

        return { userId, requestId };
    }

    async function accountWithPhone(): Promise<number>
    {
        const userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        await getTestDb().update(users).set({ phone: PHONE }).where(eq(users.id, userId));

        return userId;
    }

    /** Every line written so far, once the logger's transports have run. */
    async function logLines(): Promise<string[]>
    {
        await new Promise((resolve) => setTimeout(resolve, 50));

        return [...written];
    }

    /** The rollback line and every line quoting the contact, from one sweep whose hook throws. */
    async function sweepLog(onPurge: (account: HandedAccount) => Promise<void>)
    {
        configureDeletion({ onPurge });
        const { requestId } = await dueAccount();
        written.length = 0;

        expect(await sweepDuePurges()).toEqual({ processed: 1, purged: 0, skipped: 1 });

        const lines = await logLines();
        expect(lines.find(line => line.includes('purge failed, will retry next sweep'))).toContain(`[requestId=${requestId}]`);

        return {
            requestId,
            rollback: lines.find(line => line.includes('Transaction rolled back'))!,
            leaking: lines.filter(quotesContact),
        };
    }

    it('L1a: a hook whose outbox write fails on a constraint quoting the address leaves it in no line; the rollback names class and SQLSTATE', async () =>
    {
        const { requestId, rollback, leaking } = await sweepLog(writeFails);

        expect(leaking).toEqual([]);
        expect(rollback.split('\n')[1]).toBe(`PurgeHookFailedError: deletion.onPurge failed for deletion request ${requestId}: DrizzleQueryError (SQLSTATE 23505)`);
    });

    it('L1b: a hook throwing a plain Error naming the address leaves it in no line, core\'s rollback line included', async () =>
    {
        const { requestId, rollback, leaking } = await sweepLog(namesAddress);

        expect(leaking).toEqual([]);
        expect(rollback.split('\n')[1]).toBe(`PurgeHookFailedError: deletion.onPurge failed for deletion request ${requestId}: Error`);
        expect(rollback).not.toContain('Caused by');
    });

    it('L1c: an immediate request whose hook names the address over a failed write leaves it in no line, and the failure is the package\'s line', async () =>
    {
        configureDeletion({ onPurge: handoffFails });
        const userId = await accountWithPhone();
        written.length = 0;

        const { requestId } = await requestAccountDeletionService(userId, { requestedBy: 'admin', immediate: true });

        await vi.waitFor(() => expect(written.find(line => line.includes('purge failed, will retry next sweep'))).toContain(`[requestId=${requestId}]`));
        const lines = await logLines();
        expect(lines.filter(quotesContact)).toEqual([]);
        expect(lines.filter(line => line.includes('afterCommit callback failed'))).toEqual([]);
        expect(lines.find(line => line.includes('purge failed, will retry next sweep')))
            .toContain(`deletion.onPurge failed for deletion request ${requestId}: Error (SQLSTATE 23505)`);
    });

    it('L2: the rejection holds no reference to the hook\'s error that any serializer reaches', async () =>
    {
        configureDeletion({ onPurge: handoffFails });
        const { userId, requestId } = await dueAccount();

        const failure = await purgeUserService(userId).catch((error: unknown) => error) as InstanceType<typeof PurgeHookFailedError>;

        expect(failure).toBeInstanceOf(PurgeHookFailedError);
        expect(failure).toMatchObject({
            message: `deletion.onPurge failed for deletion request ${requestId}: Error (SQLSTATE 23505)`,
            requestId,
            hookErrorClass: 'Error',
            hookErrorCode: '23505',
            statusCode: 500,
        });
        expect('cause' in failure).toBe(false);
        const serialized = [
            JSON.stringify(failure),
            JSON.stringify(failure.toJSON()),
            JSON.stringify(describeError(failure)),
            inspect(failure, { showHidden: true, depth: Infinity }),
            String(failure.stack),
        ];
        expect(serialized.filter(quotesContact)).toEqual([]);
    });

    it('L3: the purge job stores no failure, and pg-boss\'s serializer on a rejection an app\'s job would store has no address', async () =>
    {
        configureDeletion({ onPurge: handoffFails });
        const { userId, requestId } = await dueAccount();
        written.length = 0;

        await expect(createAuthDeletionPurgeJob().run()).resolves.toBeUndefined();
        const failure = await purgeUserService(userId).catch((error: unknown) => error);

        const stored = JSON.stringify(pgBossSerializeError()(failure));
        expect(stored).toContain(`deletion request ${requestId}: Error (SQLSTATE 23505)`);
        expect(quotesContact(stored)).toBe(false);
        expect((await logLines()).filter(quotesContact)).toEqual([]);
    });

    it('L4: an onBeforePurge throwing an Error naming the address leaves it in no line; the warning names the class', async () =>
    {
        configureDeletion({ onBeforePurge: namesAddress });
        const { userId } = await dueAccount();
        written.length = 0;

        expect(await sweepDuePurges()).toEqual({ processed: 1, purged: 0, skipped: 1 });

        const lines = await logLines();
        expect(lines.filter(quotesContact)).toEqual([]);
        const warning = lines.find(line => line.includes('onBeforePurge threw'));
        expect(warning).toContain(`[userId=${userId}]`);
        expect(warning).toContain('[hookErrorClass=Error]');
    });
});
