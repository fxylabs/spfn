/**
 * @spfn/auth - a failing `onPurge` does not put the account's contact in the log
 *
 * The purge hands `onPurge` the account's email and phone. What the hook throws
 * may quote them — an app's "handoff failed for <address>", a constraint error
 * from its outbox write — and the purge rolls back, so the transaction runner
 * logs the rollback and the sweep logs the failure. Neither may print the hook's
 * error: the purge rethrows it as `PurgeHookFailedError`, whose message names
 * the hook and the request only.
 *
 * | Row | Checks                                                              | Unnoticed without it                              |
 * |-----|---------------------------------------------------------------------|---------------------------------------------------|
 * | L1a | a hook whose outbox write fails on a constraint quoting the         | a deleted account's address in the log of its own |
 * |     | address: no log line of the sweep, at any level, has the address or | deletion                                          |
 * |     | phone; the rollback line is the wrapper's, the sweep's names it     |                                                   |
 * | L1b | a hook throwing "handoff failed for <address>" over that write: no  | the same, from the app's own error                |
 * |     | line but core's rollback line has them; that line is the wrapper's, |                                                   |
 * |     | and still prints the hook's message as its cause (core, see below)  |                                                   |
 * | L1c | L1b for an immediate request, whose purge runs after its commit:    | the address at `error`, in core's "afterCommit    |
 * |     | the failure is the package's line, not core's after-commit one      | callback failed" line                             |
 * | L2  | the purge rejects with `PurgeHookFailedError`, its `cause` the      | an app that catches upstream left without the     |
 * |     | hook's own error, which a response body does not carry              | hook's error, or the error in a response body     |
 *
 * The logger's level is fixed when it is imported, so this file sets it to
 * `debug` before anything loads: the runner logs a rollback at `debug`.
 *
 * Core's transaction runner logs the rollback with the error
 * (`db/transaction/runner.ts`, "Transaction rolled back" at `debug`, "Slow
 * transaction rolled back" at `warn`), and `describeError` keeps the message of
 * every link of a cause chain that is not a database error, which the console
 * prints as `Caused by:`. A database error's description keeps no bound values,
 * so L1a holds whole; the app's own message in L1b reaches that one line. L1b
 * pins it, so the row fails once core stops printing cause messages and can
 * then hold whole too.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';

vi.hoisted(() =>
{
    process.env.SPFN_LOG_LEVEL = 'debug';
});

const { BaseRepository } = await import('@spfn/core/db');
const { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } = await import('../helpers/db');
const { createTestUser } = await import('../helpers/oauth2');
const { users, accountDeletionRequests } = await import('@/server/entities');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { __resetDeletionForTests, configureDeletion } = await import('@/server/lib/deletion-config');
const { sweepDuePurges, purgeUserService, requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
const { PurgeHookFailedError } = await import('@spfn/auth/errors');

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

/** The same write, failed, under the app's own error naming the address. */
async function handoffFails(account: HandedAccount): Promise<void>
{
    const failure = await noticeOutboxRepository.add(account).catch((error: unknown) => error);
    throw new Error(`handoff failed for ${account.email} / ${account.phone}`, { cause: failure });
}

describe.skipIf(!dbAvailable)('account deletion - a failing onPurge and the log', () =>
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
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) =>
        {
            capture(String(chunk));

            return true;
        });
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        __resetDeletionForTests();
    });

    /** An account with a deletion request past its grace period. */
    async function dueAccount(): Promise<{ userId: number; requestId: number }>
    {
        const userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        await getTestDb().update(users).set({ phone: PHONE }).where(eq(users.id, userId));
        const { requestId } = await requestAccountDeletionService(userId, { requestedBy: 'admin' });
        await getTestDb().update(accountDeletionRequests)
            .set({ purgeScheduledAt: new Date(Date.now() - 1000) })
            .where(eq(accountDeletionRequests.id, requestId));

        return { userId, requestId };
    }

    /** Every line written so far, once the logger's transports have run. */
    async function logLines(): Promise<string[]>
    {
        await new Promise((resolve) => setTimeout(resolve, 50));

        return [...written];
    }

    /** The log of one sweep whose hook throws, once its rollback and its failure are written. */
    async function sweepLog(onPurge: (account: HandedAccount) => Promise<void>)
    {
        configureDeletion({ onPurge });
        const { requestId } = await dueAccount();
        written.length = 0;

        expect(await sweepDuePurges()).toEqual({ processed: 1, purged: 0, skipped: 1 });

        const lines = await logLines();
        const rollback = lines.find(line => line.includes('Transaction rolled back'));
        expect(rollback?.split('\n')[1]).toBe(`PurgeHookFailedError: deletion.onPurge failed for deletion request ${requestId}`);
        expect(lines.find(line => line.includes('purge failed, will retry next sweep'))).toContain(`[requestId=${requestId}]`);
        expect(lines.find(line => line.includes('purge failed, will retry next sweep'))).toContain('[error=PurgeHookFailedError]');

        return { rollback: rollback!, leaking: lines.filter(line => line.includes(EMAIL) || line.includes(PHONE)) };
    }

    it('L1a: a hook whose outbox write fails on a constraint quoting the address leaves it in no log line', async () =>
    {
        const { leaking } = await sweepLog(writeFails);

        expect(leaking).toEqual([]);
    });

    it('L1b: a hook naming the address in its own error leaves it in no line but core\'s rollback line, which prints it as the cause', async () =>
    {
        const { rollback, leaking } = await sweepLog(handoffFails);

        expect(leaking).toEqual([rollback]);
        expect(rollback).toContain(`Caused by: Error: handoff failed for ${EMAIL}`);
    });

    it('L1c: an immediate request whose hook names the address logs the failure as the package\'s line, not core\'s after-commit one', async () =>
    {
        configureDeletion({ onPurge: handoffFails });
        const userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        await getTestDb().update(users).set({ phone: PHONE }).where(eq(users.id, userId));
        written.length = 0;

        const { requestId } = await requestAccountDeletionService(userId, { requestedBy: 'admin', immediate: true });

        await vi.waitFor(() => expect(written.find(line => line.includes('purge failed, will retry next sweep'))).toContain(`[requestId=${requestId}]`));
        const lines = await logLines();
        const rollback = lines.find(line => line.includes('Transaction rolled back'));
        expect(rollback?.split('\n')[1]).toBe(`PurgeHookFailedError: deletion.onPurge failed for deletion request ${requestId}`);
        expect(lines.filter(line => line.includes('afterCommit callback failed'))).toEqual([]);
        expect(lines.filter(line => line.includes(EMAIL) || line.includes(PHONE))).toEqual([rollback]);
    });

    it('L2: the purge rejects with PurgeHookFailedError, the hook\'s error as its cause and not in its body', async () =>
    {
        const hookError = new Error(`handoff failed for ${EMAIL}`);
        configureDeletion({ onPurge: () => Promise.reject(hookError) });
        const { userId, requestId } = await dueAccount();

        const failure = await purgeUserService(userId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PurgeHookFailedError);
        expect(failure).toMatchObject({ message: `deletion.onPurge failed for deletion request ${requestId}`, requestId, statusCode: 500 });
        expect((failure as Error).cause).toBe(hookError);
        expect((failure as InstanceType<typeof PurgeHookFailedError>).toJSON()).toEqual({
            __type: 'PurgeHookFailedError',
            message: `deletion.onPurge failed for deletion request ${requestId}`,
            requestId,
        });
    });
});
