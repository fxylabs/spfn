/**
 * Nested Transaction Integration Tests
 *
 * One describe per row of the SAVEPOINT nesting case table (issue #82):
 * a nested `runInTransaction` takes a SAVEPOINT on the outer transaction's
 * connection, and `requiresNew: true` opts back out into an independent one.
 *
 * The load-bearing assertion is `pg_backend_pid()`: a SAVEPOINT runs on the
 * connection the outer transaction already holds, so the backend pid is EQUAL
 * at every nesting level. Differing pids mean a second pooled connection, which
 * makes outer writes invisible, deadlocks same-row updates, and lets a service
 * escape a route's `Transactional()`.
 *
 * The root (no ambient transaction) cases in the table are pinned by the
 * existing suites — transaction.test.ts, context.integration.test.ts,
 * hooks.integration.test.ts, middleware.integration.test.ts — and are not
 * duplicated here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { Logger } from '@spfn/core/logger';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { createNestedFrameGate, getTransaction, getTransactionContext, onBeforeCommit, onAfterCommit, onAfterRollback } from '../context';
import { Transactional } from '../middleware';
import { runInTransaction } from '../runner';

describe('Nested transactions (Integration)', () =>
{
    const dbFixture = createDbTestFixture();

    /** Nesting behavior is under test here, not log output */
    const quiet = { enableLogging: false };

    /**
     * Give the fire-and-forget afterCommit hooks a turn before asserting.
     * afterRollback needs no flush — the runner awaits it.
     */
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

    /** Backend pid of the connection the ambient transaction is running on */
    const backendPid = async (): Promise<number> =>
    {
        const rows = await getTransaction()!.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);

        return rows[0].pid;
    };

    const insertRow = async (label: string): Promise<void> =>
    {
        await getTransaction()!.execute(sql`INSERT INTO test_nested_rows (label) VALUES (${label})`);
    };

    /** Labels visible to the ambient transaction, including its own uncommitted writes */
    const labelsInTransaction = async (): Promise<string[]> =>
    {
        const rows = await getTransaction()!.execute<{ label: string }>(
            sql`SELECT label FROM test_nested_rows ORDER BY id`,
        );

        return rows.map(row => row.label);
    };

    /** Labels durably committed, read on a fresh connection */
    const storedLabels = async (): Promise<string[]> =>
    {
        const rows = await dbFixture.db.execute<{ label: string }>(
            sql`SELECT label FROM test_nested_rows ORDER BY id`,
        );

        return rows.map(row => row.label);
    };

    beforeAll(async () =>
    {
        await dbFixture.setup();

        if (dbFixture.isAvailable)
        {
            await dbFixture.execute('DROP TABLE IF EXISTS test_nested_rows CASCADE');
            await dbFixture.execute(`
                CREATE TABLE test_nested_rows (
                    id SERIAL PRIMARY KEY,
                    label TEXT NOT NULL
                )
            `);
        }
    });

    afterAll(async () =>
    {
        await dbFixture.execute('DROP TABLE IF EXISTS test_nested_rows CASCADE');
        await dbFixture.teardown();
    });

    beforeEach(() => dbFixture.cleanTable('test_nested_rows'));

    afterEach(() => void vi.restoreAllMocks());

    describe('ambient: yes | requiresNew: no | nested success', () =>
    {
        it('runs on the outer transaction\'s connection, sees its uncommitted writes, and commits with it', async () =>
        {
            if (!dbFixture.isAvailable) return;

            let rootPid = 0;
            let nestedPid = -1;
            let seenFromNested: string[] = [];

            await runInTransaction(async () =>
            {
                rootPid = await backendPid();

                await insertRow('root-before');

                await runInTransaction(async () =>
                {
                    // THE probe: equal pids mean one connection, i.e. a SAVEPOINT
                    // and not a second transaction.
                    nestedPid = await backendPid();

                    // The outer INSERT is uncommitted; only the same transaction
                    // can see it
                    seenFromNested = await labelsInTransaction();

                    await insertRow('nested');
                }, quiet);

                await insertRow('root-after');
            }, quiet);

            expect(nestedPid).toBe(rootPid);
            expect(seenFromNested).toEqual(['root-before']);

            // One commit, at the root boundary, carrying all three rows
            expect(await storedLabels()).toEqual(['root-before', 'nested', 'root-after']);
        });

        it('inherits the outer transaction\'s statement_timeout and ignores its own', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            let nestedTimeout = '';

            await runInTransaction(async () =>
            {
                await runInTransaction(async (tx) =>
                {
                    const rows = await tx.execute<{ statement_timeout: string }>(
                        sql`SHOW statement_timeout`,
                    );

                    nestedTimeout = rows[0].statement_timeout;
                    // Logging on for this call: the ignored-timeout warning is
                    // part of what is under test
                }, { timeout: 1000, enableLogging: true });
            }, { timeout: 7000, enableLogging: false });

            // The root's SET LOCAL is in force on the shared connection — the
            // nested call's own 1000ms never reached the database
            expect(nestedTimeout).toBe('7s');
            expect(warn).toHaveBeenCalledWith(
                'Timeout ignored in nested transaction',
                expect.objectContaining({ requestedTimeout: '1000ms' }),
            );
        });

        it('stays quiet about the timeout when the caller never passed one', async () =>
        {
            if (!dbFixture.isAvailable) return;

            // The default timeout is 30s, so warning whenever one is in force
            // meant warning on every nested call — noise an operator cannot act
            // on, since inheriting the root's timeout is the documented design
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            await runInTransaction(async () =>
            {
                await runInTransaction(() => insertRow('nested'), { enableLogging: true });
            }, quiet);

            expect(warn).not.toHaveBeenCalledWith(
                'Timeout ignored in nested transaction',
                expect.anything(),
            );
        });
    });

    describe('ambient: yes | requiresNew: no | nested throws, caller catches', () =>
    {
        it('rolls back to the savepoint, keeps prior outer writes, commits the root, and fires only the nested afterRollback', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            let rootPid = 0;
            let nestedPid = -1;

            await runInTransaction(async () =>
            {
                rootPid = await backendPid();

                onAfterRollback(() => void fired.push('root afterRollback'));

                await insertRow('root-before');

                await expect(runInTransaction(async () =>
                {
                    onAfterRollback(() => void fired.push('nested afterRollback'));

                    // Pinned: without this the row passes on the old behavior too,
                    // where the nested write vanished because an INDEPENDENT
                    // transaction rolled back rather than a savepoint
                    nestedPid = await backendPid();

                    await insertRow('nested');

                    throw new Error('nested failed');
                }, quiet)).rejects.toThrow('nested failed');

                await insertRow('root-after');

                onAfterCommit(() => void fired.push('afterCommit'));
            }, quiet);

            await flush();

            expect(nestedPid).toBe(rootPid);

            // ROLLBACK TO savepoint dropped only the nested write
            expect(await storedLabels()).toEqual(['root-before', 'root-after']);

            // The savepoint rolled back, so its own afterRollback fired there;
            // the root survived, so the root's stayed silent
            expect(fired).toEqual(['nested afterRollback', 'afterCommit']);
        });

        it('leaves the root able to issue statements after a failed STATEMENT inside the savepoint (25P02)', async () =>
        {
            if (!dbFixture.isAvailable) return;

            let rootPid = 0;
            let nestedPid = -1;

            await runInTransaction(async () =>
            {
                rootPid = await backendPid();

                await insertRow('root-before');

                // A statement error, not a thrown JS error: this is the case that
                // aborts a plain transaction into 25P02. Inside a SAVEPOINT the
                // abort unwinds only to the savepoint — the pid check is what
                // makes that the claim under test, rather than the old behavior's
                // trivially-unaffected second connection.
                await expect(runInTransaction(async (tx) =>
                {
                    nestedPid = await backendPid();

                    await tx.execute(sql`SELECT 1 / 0`);
                }, quiet)).rejects.toThrow();

                expect(nestedPid).toBe(rootPid);

                // The proof: the root connection still accepts statements
                await insertRow('root-after');

                expect(await labelsInTransaction()).toEqual(['root-before', 'root-after']);
            }, quiet);

            expect(await storedLabels()).toEqual(['root-before', 'root-after']);
        });
    });

    describe('ambient: yes | requiresNew: no | nested throws, propagates', () =>
    {
        it('rolls the root back and fires afterRollback exactly once', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const nestedError = new Error('nested failed');
            let rootPid = 0;
            let nestedPid = -1;

            await expect(runInTransaction(async () =>
            {
                onAfterRollback(() => void fired.push('root'));

                rootPid = await backendPid();

                await insertRow('root-before');

                await runInTransaction(async () =>
                {
                    onAfterRollback(() => void fired.push('nested'));

                    nestedPid = await backendPid();

                    await insertRow('nested');

                    throw nestedError;
                }, quiet);
            }, quiet)).rejects.toBe(nestedError);

            await flush();

            expect(nestedPid).toBe(rootPid);
            expect(await storedLabels()).toEqual([]);

            // Once per callback, not once per nesting level: the savepoint ran
            // its own queue as it rolled back, then the root ran its own
            expect(fired).toEqual(['nested', 'root']);
        });
    });

    describe('ambient: yes | requiresNew: no | hooks registered inside nested', () =>
    {
        it('runs a nested beforeCommit inside the transaction at the ROOT commit', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            let pidInsideBeforeCommit = -1;
            let rootPid = 0;
            let nestedPid = -1;

            await runInTransaction(async () =>
            {
                rootPid = await backendPid();

                await runInTransaction(async () =>
                {
                    nestedPid = await backendPid();

                    onBeforeCommit(async () =>
                    {
                        // Still inside the root transaction, on its connection —
                        // the savepoint it was registered in is long released
                        pidInsideBeforeCommit = await backendPid();

                        await insertRow('from-beforeCommit');
                        fired.push('beforeCommit');
                    });
                    onAfterCommit(() => void fired.push('afterCommit'));
                }, quiet);

                // The nested call returned without firing anything of its own
                expect(fired).toEqual([]);

                await insertRow('root');
            }, quiet);

            await flush();

            expect(fired).toEqual(['beforeCommit', 'afterCommit']);
            expect(nestedPid).toBe(rootPid);
            expect(pidInsideBeforeCommit).toBe(rootPid);

            // The beforeCommit write joined the root's single commit
            expect(await storedLabels()).toEqual(['root', 'from-beforeCommit']);
        });

        it('fires a nested afterRollback when the ROOT fails after the nested call succeeded', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const rootError = new Error('root failed');

            await expect(runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    // Compensation registered from a nested call is truthful:
                    // the nested writes live or die with the root, so the root's
                    // fate is the fate worth compensating for
                    onAfterRollback(() => void fired.push('nested afterRollback'));

                    await insertRow('nested');
                }, quiet);

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            expect(fired).toEqual(['nested afterRollback']);
            expect(await storedLabels()).toEqual([]);
        });
    });

    describe('ambient: yes | requiresNew: no | same-row update outer then nested', () =>
    {
        // The deadlock case. On a second connection the nested UPDATE waited on a
        // row lock the outer transaction held and the outer transaction waited on
        // the nested call — broken only by statement_timeout. On one connection
        // there is nothing to wait for. The short timeout turns a regression into
        // a fast failure instead of a hung suite.
        it('updates a row the outer transaction already locked without deadlocking', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await dbFixture.db.execute(sql`INSERT INTO test_nested_rows (label) VALUES ('original')`);

            await runInTransaction(async () =>
            {
                await getTransaction()!.execute(
                    sql`UPDATE test_nested_rows SET label = 'outer' WHERE label = 'original'`,
                );

                await runInTransaction(async () =>
                {
                    await getTransaction()!.execute(
                        sql`UPDATE test_nested_rows SET label = 'nested' WHERE label = 'outer'`,
                    );
                }, quiet);
            }, { ...quiet, timeout: 3000 });

            expect(await storedLabels()).toEqual(['nested']);
        }, 15000);
    });

    describe('ambient: yes | requiresNew: no | concurrent siblings', () =>
    {
        /** Yields the event loop for real, the way non-DB work inside a callback does */
        const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

        it('serializes sibling frames, so one sibling\'s rollback cannot take the other\'s writes', async () =>
        {
            if (!dbFixture.isAvailable) return;

            // The reviewer's scenario. Concurrently, A's second write lands
            // AFTER B took its savepoint, so B's ROLLBACK TO — which unwinds the
            // connection, not a branch of it — discarded A's rows too, silently:
            // A resolved successfully and its data was gone.
            const order: string[] = [];
            let settled: PromiseSettledResult<void>[] = [];

            // The contention notice is emitted once per PROCESS, and this is the
            // first test in the file that contends — a reordering that puts
            // another contending test ahead of it would take the notice away
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            await runInTransaction(async () =>
            {
                await insertRow('root-before');

                settled = await Promise.allSettled([
                    runInTransaction(async () =>
                    {
                        order.push('A-start');

                        await insertRow('A-1');
                        await pause(60);
                        await insertRow('A-2');

                        order.push('A-end');
                    }, quiet),

                    runInTransaction(async () =>
                    {
                        order.push('B-start');

                        await pause(30);
                        await insertRow('B-1');

                        order.push('B-end');

                        throw new Error('B failed');
                    }, quiet),
                ]);

                await insertRow('root-after');
            }, quiet);

            expect(settled.map(r => r.status)).toEqual(['fulfilled', 'rejected']);

            // B never overlapped A: its savepoint was taken after A's frame closed
            expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);

            // Both of A's rows survived; only B's row was rolled back
            expect(await storedLabels()).toEqual(['root-before', 'A-1', 'A-2', 'root-after']);

            // Serialization is silent per call, but says so once when it bites
            expect(warn).toHaveBeenCalledWith(
                'Concurrent nested transactions are serialized',
                expect.objectContaining({ hint: expect.stringContaining('requiresNew') }),
            );
        });

        it('keeps running the frames queued behind one that failed', async () =>
        {
            if (!dbFixture.isAvailable) return;

            // The queue swallows a frame's rejection for the frames behind it and
            // nowhere else: B must still open, and A's error must still reach A's
            // own caller
            const order: string[] = [];
            let settled: PromiseSettledResult<void>[] = [];

            await runInTransaction(async () =>
            {
                settled = await Promise.allSettled([
                    runInTransaction(async () =>
                    {
                        order.push('A');

                        await insertRow('A');
                        await pause(30);

                        throw new Error('A failed');
                    }, quiet),

                    runInTransaction(async () =>
                    {
                        order.push('B');

                        await insertRow('B');
                    }, quiet),
                ]);
            }, quiet);

            expect(settled.map(r => r.status)).toEqual(['rejected', 'fulfilled']);
            expect(order).toEqual(['A', 'B']);
            expect(await storedLabels()).toEqual(['B']);
        });

        it('deadlocks when a frame awaits a sibling queued behind it (documented misuse)', async () =>
        {
            // The one shape the queue cannot save, pinned at the gate so it costs
            // no connection and cannot hang the suite. A is queued first and holds
            // the gate while awaiting B, which can only open once A returns. If a
            // cycle guard is ever added, this test is what says the README's
            // "documented as misuse" stance is out of date.
            const gate = createNestedFrameGate();

            let b!: Promise<string>;

            const a = gate.run(async () => b);

            b = gate.run(async () => 'B');

            const outcome = await Promise.race([
                Promise.all([a, b]).then(() => 'completed'),
                pause(150).then(() => 'hung'),
            ]);

            expect(outcome).toBe('hung');
        });

        it('does not serialize requiresNew siblings against each other', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const order: string[] = [];
            const pids: number[] = [];
            let rootPid = 0;

            await runInTransaction(async () =>
            {
                rootPid = await backendPid();

                const branch = (name: string) => runInTransaction(async () =>
                {
                    pids.push(await backendPid());

                    order.push(`${name}-start`);
                    await pause(60);
                    order.push(`${name}-end`);

                    await insertRow(name);
                }, { ...quiet, requiresNew: true });

                await Promise.all([branch('A'), branch('B')]);
            }, quiet);

            // Overlapped, not queued: the second branch started before the first
            // one finished. (Which branch reaches its BEGIN first is a race, so
            // the claim is the overlap, not a fixed order.)
            const first = order[0] === 'A-start' ? 'A' : 'B';
            const second = first === 'A' ? 'B' : 'A';

            expect(order.indexOf(`${second}-start`)).toBeLessThan(order.indexOf(`${first}-end`));

            // Three connections: the root's and one per branch
            expect(new Set([...pids, rootPid]).size).toBe(3);

            expect((await storedLabels()).sort()).toEqual(['A', 'B']);
        });

        it('does not make a requiresNew frame wait for a concurrent savepoint frame', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const order: string[] = [];

            await runInTransaction(async () =>
            {
                await Promise.all([
                    runInTransaction(async () =>
                    {
                        order.push('savepoint-start');
                        await pause(60);
                        order.push('savepoint-end');
                    }, quiet),

                    runInTransaction(async () =>
                    {
                        order.push('requiresNew-start');
                        await pause(20);
                        order.push('requiresNew-end');
                    }, { ...quiet, requiresNew: true }),
                ]);
            }, quiet);

            // The gate belongs to the savepoint frames; the independent
            // transaction never takes it, so it ran to completion while the
            // savepoint frame was still open. Serialized, it could not have
            // started before 'savepoint-end'.
            expect(order.indexOf('requiresNew-start')).toBeLessThan(order.indexOf('savepoint-end'));
            expect(order.indexOf('requiresNew-end')).toBeLessThan(order.indexOf('savepoint-end'));
        });
    });

    describe('ambient: yes | requiresNew: yes | independent success, root later fails', () =>
    {
        it('keeps its writes when the root rolls back, on its own connection, with its own hook queues', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const rootError = new Error('root failed');
            let rootPid = 0;
            let independentPid = 0;
            let independentLevel = 0;

            await expect(runInTransaction(async () =>
            {
                rootPid = await backendPid();

                onAfterRollback(() => void fired.push('root afterRollback'));

                await insertRow('root');

                await runInTransaction(async () =>
                {
                    // A real BEGIN: a second pooled connection, hence a different
                    // backend pid — the mirror image of the savepoint assertion
                    independentPid = await backendPid();

                    // Enters as a root however deeply it sits lexically: the
                    // ambient context is hidden from it, so it is level 1 and its
                    // hook queues below are its own
                    independentLevel = getTransactionContext()!.level;

                    // Own queues: this commits at ITS boundary, before the root
                    // has decided anything
                    onAfterCommit(() => void fired.push('requiresNew afterCommit'));
                    onAfterRollback(() => void fired.push('requiresNew afterRollback'));

                    await insertRow('independent');
                }, { ...quiet, requiresNew: true });

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            await flush();

            expect(independentPid).not.toBe(rootPid);
            expect(independentLevel).toBe(1);

            // The independent transaction committed and the root's rollback did
            // not reach it
            expect(await storedLabels()).toEqual(['independent']);

            // Each transaction's hooks answered its OWN outcome
            expect(fired).toEqual(['requiresNew afterCommit', 'root afterRollback']);
        });
    });

    describe('ambient: yes | requiresNew: yes | requiresNew fails, caught', () =>
    {
        it('leaves the root unaffected', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await insertRow('root-before');

                await expect(runInTransaction(async () =>
                {
                    onAfterRollback(() => void fired.push('requiresNew afterRollback'));

                    await insertRow('independent');

                    throw new Error('independent failed');
                }, { ...quiet, requiresNew: true })).rejects.toThrow('independent failed');

                await insertRow('root-after');
            }, quiet);

            await flush();

            // The independent transaction rolled itself back and fired its own
            // rollback hook; the root committed both of its rows
            expect(await storedLabels()).toEqual(['root-before', 'root-after']);
            expect(fired).toEqual(['requiresNew afterRollback']);
        });
    });

    describe('depth 3 | mixed', () =>
    {
        it('nests a savepoint inside a savepoint on one connection, promoting resolved hooks to the root', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const pids: number[] = [];
            const levels: number[] = [];
            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                pids.push(await backendPid());
                levels.push(getTransactionContext()!.level);
                await insertRow('level-1');

                await runInTransaction(async () =>
                {
                    pids.push(await backendPid());
                    levels.push(getTransactionContext()!.level);
                    await insertRow('level-2');

                    await runInTransaction(async () =>
                    {
                        pids.push(await backendPid());
                        levels.push(getTransactionContext()!.level);
                        await insertRow('level-3');

                        onBeforeCommit(() => void fired.push('beforeCommit'));
                        onAfterCommit(() => void fired.push('afterCommit'));
                    }, quiet);

                    // Neither inner level fired a hook: each resolved, so each
                    // handed its queue one level up
                    expect(fired).toEqual([]);
                }, quiet);

                expect(fired).toEqual([]);
            }, quiet);

            await flush();

            // One connection all the way down
            expect(new Set(pids).size).toBe(1);
            expect(pids).toHaveLength(3);

            // Savepoint depth counts up, root = 1
            expect(levels).toEqual([1, 2, 3]);

            // Registered at depth 3, promoted twice, fired once at the root boundary
            expect(fired).toEqual(['beforeCommit', 'afterCommit']);

            expect(await storedLabels()).toEqual(['level-1', 'level-2', 'level-3']);
        });

        it('rolls the innermost savepoint back without disturbing the two levels above it', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const pids: number[] = [];

            await runInTransaction(async () =>
            {
                pids.push(await backendPid());

                await insertRow('level-1');

                await runInTransaction(async () =>
                {
                    pids.push(await backendPid());

                    await insertRow('level-2');

                    await expect(runInTransaction(async () =>
                    {
                        pids.push(await backendPid());

                        await insertRow('level-3');

                        throw new Error('level-3 failed');
                    }, quiet)).rejects.toThrow('level-3 failed');

                    // Level 2 keeps issuing statements after the inner unwind
                    await insertRow('level-2-after');
                }, quiet);
            }, quiet);

            // One connection: the unwind was ROLLBACK TO, not a second
            // transaction rolling itself back
            expect(new Set(pids).size).toBe(1);
            expect(await storedLabels()).toEqual(['level-1', 'level-2', 'level-2-after']);
        });

        it('mixes a requiresNew transaction into the middle of the savepoint chain', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const pids: number[] = [];
            let independentPid = 0;

            await expect(runInTransaction(async () =>
            {
                pids.push(await backendPid());
                await insertRow('level-1');

                await runInTransaction(async () =>
                {
                    pids.push(await backendPid());
                    await insertRow('level-2');

                    await runInTransaction(async () =>
                    {
                        independentPid = await backendPid();

                        await insertRow('independent');
                    }, { ...quiet, requiresNew: true });
                }, quiet);

                throw new Error('root failed');
            }, quiet)).rejects.toThrow('root failed');

            // Levels 1 and 2 shared a connection; the requiresNew call did not
            expect(new Set(pids).size).toBe(1);
            expect(independentPid).not.toBe(pids[0]);

            // Only the independent transaction's row survived the root rollback
            expect(await storedLabels()).toEqual(['independent']);
        });

        it('savepoints a nested call onto the requiresNew transaction, not the root', async () =>
        {
            if (!dbFixture.isAvailable) return;

            // The other ordering: requiresNew OUTSIDE the savepoint. The inner
            // call has to nest onto the transaction that is actually ambient —
            // the independent one — or its writes would land on the root's
            // connection and die with the root.
            let rootPid = 0;
            let independentPid = 0;
            let innerPid = -1;
            let innerLevel = 0;

            await expect(runInTransaction(async () =>
            {
                rootPid = await backendPid();
                await insertRow('root');

                await runInTransaction(async () =>
                {
                    independentPid = await backendPid();
                    await insertRow('independent');

                    await runInTransaction(async () =>
                    {
                        innerPid = await backendPid();
                        innerLevel = getTransactionContext()!.level;

                        await insertRow('independent-nested');
                    }, quiet);
                }, { ...quiet, requiresNew: true });

                throw new Error('root failed');
            }, quiet)).rejects.toThrow('root failed');

            // A SAVEPOINT on the requiresNew connection: level 2 of a chain whose
            // root is the independent transaction, not the outer one
            expect(independentPid).not.toBe(rootPid);
            expect(innerPid).toBe(independentPid);
            expect(innerLevel).toBe(2);

            // Both rows committed with the independent transaction; the root's died
            expect(await storedLabels()).toEqual(['independent', 'independent-nested']);
        });
    });

    /**
     * `Transactional()` reaches the runner by spreading its options, so both rows
     * hold only as long as `requiresNew` keeps riding that spread. A middleware
     * that picked its options field-by-field would drop the flag and still
     * type-check — these two tests are what would notice.
     */
    describe('Transactional() middleware | requiresNew plumbing', () =>
    {
        /** A route whose handler records its connection and writes one row */
        const routeUnder = (options: Parameters<typeof Transactional>[0], onPid: (pid: number) => void) =>
        {
            const app = new Hono();

            app.get('/work', Transactional(options), async (c) =>
            {
                onPid(await backendPid());

                await insertRow('handler');

                return c.json({ ok: true });
            });

            return app;
        };

        it('defaults a nested middleware run to a SAVEPOINT on the outer connection', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const rootError = new Error('root failed');
            let rootPid = 0;
            let handlerPid = -1;

            const app = routeUnder(quiet, (pid) => void (handlerPid = pid));

            await expect(runInTransaction(async () =>
            {
                rootPid = await backendPid();

                expect((await app.request('/work')).status).toBe(200);

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            // Same connection, and the handler's write died with the root
            expect(handlerPid).toBe(rootPid);
            expect(await storedLabels()).toEqual([]);
        });

        it('gives a nested middleware run its own transaction under requiresNew', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const rootError = new Error('root failed');
            let rootPid = 0;
            let handlerPid = 0;

            const app = routeUnder({ ...quiet, requiresNew: true }, (pid) => void (handlerPid = pid));

            await expect(runInTransaction(async () =>
            {
                rootPid = await backendPid();

                expect((await app.request('/work')).status).toBe(200);

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            // Second connection, and the handler's write outlived the root
            expect(handlerPid).not.toBe(rootPid);
            expect(await storedLabels()).toEqual(['handler']);
        });
    });
});
