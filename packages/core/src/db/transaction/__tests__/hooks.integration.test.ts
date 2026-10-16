/**
 * Transaction Hook Integration Tests
 *
 * Covers onBeforeCommit / onAfterCommit / onAfterRollback on the commit path,
 * on the rollback path, across nesting, and outside any transaction.
 *
 * Hooks belong to the FRAME — root or savepoint — that registered them. One
 * test per row, named `D<n> …`, in "Hooks belong to the frame":
 *
 * | #   | situation                                                          | expected                                                   |
 * | --- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
 * | D1  | afterCommit in savepoint S; S resolves; root commits               | runs once after the root commit, between the root's hooks  |
 * | D2  | afterCommit in S; S throws, root catches and commits               | never runs                                                 |
 * | D3  | afterCommit in S; S resolves; root throws                          | never runs; the root's afterRollback runs                  |
 * | D4  | beforeCommit in S; S throws, root catches and commits              | never runs; the root commits                               |
 * | D5  | beforeCommit in S; S resolves                                      | runs before the root COMMIT, inside the transaction        |
 * | D6  | afterCommit in S2 inside S; S2 resolves; S throws, root commits    | never runs (S2 → S, then S discards)                       |
 * | D7  | afterCommit in S2 inside S; everything resolves                    | runs once after the root commit                            |
 * | D8  | afterRollback in S; S throws, root catches and commits             | runs once at the savepoint rollback, in the parent context |
 * | D9  | afterRollback in S; S resolves; root throws                        | runs once at the root rollback                             |
 * | D10 | afterRollback in S throws (D8 shape)                               | logged; the nested call rejects with the original error    |
 * | D11 | requiresNew inside S; S throws, root catches                       | the inner roots' hooks fire on their own outcome           |
 * | D12 | Transactional() handler nested in a root, throws; root commits     | its beforeCommit/afterCommit dropped, afterRollback ran    |
 * | D13 | a hook registered by a beforeCommit callback of S                  | not run for this commit (the snapshot rule)                |
 * | D14 | afterRollback in S compensates with runInTransaction; root commits | completes; the compensation's afterCommit runs at the root |
 * | D15 | siblings S1, S2 under Promise.all; S1's slow afterRollback throws  | S2 opens only after S1's afterRollback pass has finished   |
 * | D16 | root, S, root register beforeCommit/afterRollback in that order    | each queue runs in registration order (S appended)         |
 * | D17 | detached work in S registers afterCommit after S has settled       | dropped: never runs, though the root commits               |
 * | D18 | a statement in S's afterRollback fails; root catches, continues    | the root rejects (at COMMIT, with that error) and its writes are gone |
 * | D18b| as D18, but the root runs one more statement after catching       | that statement and the root reject with 25P02; no rows     |
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { Logger } from '@spfn/core/logger';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { getTransaction, getTransactionContext, onBeforeCommit, onAfterCommit, onAfterRollback } from '../context';
import { Transactional } from '../middleware';
import { runInTransaction } from '../runner';

describe('Transaction Hooks (Integration)', () =>
{
    const dbFixture = createDbTestFixture();

    /** Hook behavior is under test here, not log output */
    const quiet = { enableLogging: false };

    /**
     * Give the fire-and-forget hooks a turn to run before asserting on them:
     * afterCommit, and both immediate hooks outside a transaction, are queued
     * on a microtask. afterRollback needs no flush — the runner awaits it.
     */
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

    const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

    const insertRow = async (label: string): Promise<void> =>
    {
        await getTransaction()!.execute(sql`INSERT INTO test_hook_rows (label) VALUES (${label})`);
    };

    const storedLabels = async (): Promise<string[]> =>
    {
        const rows = await dbFixture.db.execute<{ label: string }>(
            sql`SELECT label FROM test_hook_rows ORDER BY id`,
        );

        return rows.map(row => row.label);
    };

    /** The rows as the current transaction sees them, uncommitted writes included */
    const labelsInTransaction = async (): Promise<string[]> =>
    {
        const rows = await getTransaction()!.execute<{ label: string }>(
            sql`SELECT label FROM test_hook_rows ORDER BY id`,
        );

        return rows.map(row => row.label);
    };

    beforeAll(async () =>
    {
        await dbFixture.setup();

        if (dbFixture.isAvailable)
        {
            await dbFixture.execute('DROP TABLE IF EXISTS test_hook_rows CASCADE');
            await dbFixture.execute(`
                CREATE TABLE test_hook_rows (
                    id SERIAL PRIMARY KEY,
                    label TEXT NOT NULL
                )
            `);
        }
    });

    afterAll(async () =>
    {
        await dbFixture.execute('DROP TABLE IF EXISTS test_hook_rows CASCADE');
        await dbFixture.teardown();
    });

    beforeEach(() => dbFixture.cleanTable('test_hook_rows'));

    afterEach(() => void vi.restoreAllMocks());

    describe('Commit path', () =>
    {
        it('runs beforeCommit inside the transaction, then commits, then afterCommit; afterRollback never runs', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            let txInsideBeforeCommit: unknown = 'never ran';
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            await runInTransaction(async () =>
            {
                onBeforeCommit(() =>
                {
                    txInsideBeforeCommit = getTransaction();
                    fired.push('beforeCommit');
                });
                onAfterCommit(() => void fired.push('afterCommit'));
                onAfterRollback(() => void fired.push('afterRollback'));

                fired.push('handler');
            }, quiet);

            // beforeCommit ran inside the transaction, so getTransaction() saw a tx
            expect(txInsideBeforeCommit).not.toBeNull();

            await flush();

            // Order proves beforeCommit ran before the commit that released afterCommit
            expect(fired).toEqual(['handler', 'beforeCommit', 'afterCommit']);

            // Normal transactional use is quiet: the no-transaction warnings on
            // onBeforeCommit / onAfterRollback must not fire here
            expect(warn).not.toHaveBeenCalled();
        });

        it('runs a snapshot of the beforeCommit queue, so a self-registering callback terminates', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const ran: string[] = [];
            let registrations = 0;

            // Re-registers itself. Iterating the live queue would grow the array
            // mid-pass and never finish, inside an open transaction that
            // statement_timeout cannot reach. The cap keeps a regression here a
            // failed assertion instead of a hung suite.
            const selfRegistering = (): void =>
            {
                ran.push('self-registering');

                if (registrations++ < 50)
                {
                    onBeforeCommit(selfRegistering);
                }
            };

            await runInTransaction(async () =>
            {
                onBeforeCommit(selfRegistering);
                onBeforeCommit(() => void ran.push('second'));
            }, quiet);

            // One pass over the snapshot, registration order intact: what the
            // callback registered is not part of this commit
            expect(ran).toEqual(['self-registering', 'second']);
        });

        it('commits rows written by a beforeCommit callback as part of the same transaction', async () =>
        {
            if (!dbFixture.isAvailable) return;

            await runInTransaction(async () =>
            {
                await insertRow('handler');

                onBeforeCommit(() => insertRow('beforeCommit'));
            }, quiet);

            expect(await storedLabels()).toEqual(['handler', 'beforeCommit']);
        });
    });

    describe('Rollback path', () =>
    {
        it('rolls back when a beforeCommit callback throws, skips afterCommit, and fires afterRollback', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await expect(runInTransaction(async () =>
            {
                await insertRow('handler');

                onBeforeCommit(() =>
                {
                    throw new Error('beforeCommit failed');
                });
                onAfterCommit(() => void fired.push('afterCommit'));
                onAfterRollback(() => void fired.push('afterRollback'));
            }, quiet)).rejects.toThrow('beforeCommit failed');

            expect(await storedLabels()).toEqual([]);

            // Flushed so a wrongly-queued afterCommit would have shown up by now
            await flush();

            expect(fired).toEqual(['afterRollback']);
        });

        it('fires afterRollback outside the transaction context and propagates the handler error unchanged', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const handlerError = new Error('handler failed');
            let txInsideAfterRollback: unknown = 'never ran';

            await expect(runInTransaction(async () =>
            {
                await insertRow('handler');

                onAfterRollback(() =>
                {
                    txInsideAfterRollback = getTransaction();
                });

                throw handlerError;
            }, quiet)).rejects.toBe(handlerError);

            // No flush: the runner awaits the callbacks before rethrowing
            expect(txInsideAfterRollback).toBeNull();
            expect(await storedLabels()).toEqual([]);
        });

        it('logs a failing afterRollback callback and still propagates the original error', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const handlerError = new Error('handler failed');
            const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            const fired: string[] = [];

            await expect(runInTransaction(async () =>
            {
                onAfterRollback(() =>
                {
                    throw new Error('cleanup failed');
                });
                onAfterRollback(() => void fired.push('second'));

                throw handlerError;
            }, quiet)).rejects.toBe(handlerError);

            // The failure is logged, and it stops neither the next callback nor
            // the original error
            expect(logged).toHaveBeenCalledWith(
                'afterRollback callback failed',
                expect.objectContaining({ error: 'cleanup failed' }),
            );
            expect(fired).toEqual(['second']);
        });

        it('propagates the original error even when logging an afterRollback failure throws', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const handlerError = new Error('handler failed');

            vi.spyOn(Logger.prototype, 'error').mockImplementation(() =>
            {
                throw new Error('logger down');
            });

            await expect(runInTransaction(async () =>
            {
                onAfterRollback(() =>
                {
                    throw new Error('cleanup failed');
                });

                throw handlerError;
            }, quiet)).rejects.toBe(handlerError);
        });

        it('still runs afterRollback and propagates the original error when rollback-status logging throws', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const handlerError = new Error('handler failed');
            const fired: string[] = [];

            // Logging ON: the runner's own "Transaction rolled back" line runs
            // before the callback stage, so a broken logger there must neither
            // swallow the callbacks nor replace the error
            const brokenLogger = (): never =>
            {
                throw new Error('logger down');
            };

            vi.spyOn(Logger.prototype, 'error').mockImplementation(brokenLogger);
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(brokenLogger);

            await expect(runInTransaction(async () =>
            {
                onAfterRollback(() => void fired.push('afterRollback'));

                throw handlerError;
            }, { enableLogging: true })).rejects.toBe(handlerError);

            expect(fired).toEqual(['afterRollback']);
        });

        it('runs beforeCommit callbacks in registration order and skips the rest once one throws', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const ran: string[] = [];

            await expect(runInTransaction(async () =>
            {
                onBeforeCommit(() => void ran.push('first'));
                onBeforeCommit(() =>
                {
                    ran.push('second');

                    throw new Error('second failed');
                });
                onBeforeCommit(() => void ran.push('third'));

                await insertRow('handler');
            }, quiet)).rejects.toThrow('second failed');

            expect(ran).toEqual(['first', 'second']);
            expect(await storedLabels()).toEqual([]);
        });

        it('fires afterRollback when a statement timeout rolls the transaction back', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await expect(runInTransaction(async (tx) =>
            {
                onAfterRollback(() => void fired.push('afterRollback'));

                await tx.execute(sql`SELECT pg_sleep(1)`);
            }, { ...quiet, timeout: 100 })).rejects.toThrow();

            expect(fired).toEqual(['afterRollback']);
        });
    });

    describe('Nested transactions', () =>
    {
        it('fires hooks registered in a nested transaction once, at the root boundary', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    onBeforeCommit(() => void fired.push('beforeCommit'));
                    onAfterCommit(() => void fired.push('afterCommit'));
                    onAfterRollback(() => void fired.push('afterRollback'));
                }, quiet);

                // The nested call finished without firing anything of its own
                expect(fired).toEqual([]);
            }, quiet);

            await flush();

            // Exactly one entry per hook: the root boundary fired each queue once
            expect(fired).toEqual(['beforeCommit', 'afterCommit']);
        });

        it('fires afterRollback exactly once when a beforeCommit callback registered nested throws', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await expect(runInTransaction(async () =>
            {
                onAfterRollback(() => void fired.push('root'));

                await runInTransaction(async () =>
                {
                    onAfterRollback(() => void fired.push('nested'));
                    onBeforeCommit(() =>
                    {
                        throw new Error('beforeCommit failed');
                    });
                }, quiet);
            }, quiet)).rejects.toThrow('beforeCommit failed');

            // Once per callback, not once per nesting level: the nested call
            // resolved and handed its queue to the root, whose catch fires it
            expect(fired).toEqual(['root', 'nested']);
        });

        it('fires the nested afterRollback at the savepoint, and not the root\'s, when a nested transaction fails but the root commits', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                onAfterRollback(() => void fired.push('root afterRollback'));

                // The root catches the nested failure and carries on to commit
                await expect(runInTransaction(async () =>
                {
                    onAfterRollback(() => void fired.push('nested afterRollback'));

                    throw new Error('nested failed');
                }, quiet)).rejects.toThrow('nested failed');

                await insertRow('root');
                onAfterCommit(() => void fired.push('afterCommit'));
            }, quiet);

            await flush();

            // The savepoint's own rollback fired its own callback; the root
            // survived, so the root's callback stays silent
            expect(fired).toEqual(['nested afterRollback', 'afterCommit']);
            expect(await storedLabels()).toEqual(['root']);
        });
    });

    describe('Hooks belong to the frame', () =>
    {
        const nestedFailure = new Error('nested failed');

        /** A savepoint that runs `work`, then rolls back; the caller catches */
        const failingSavepoint = async (work: () => void | Promise<unknown>): Promise<void> =>
        {
            await expect(runInTransaction(async () =>
            {
                await work();

                throw nestedFailure;
            }, quiet)).rejects.toBe(nestedFailure);
        };

        it('D1 runs an afterCommit of a resolved savepoint once after the root commit, between the root\'s own', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                onAfterCommit(() => void fired.push('root-before'));

                await runInTransaction(async () =>
                {
                    onAfterCommit(() => void fired.push('nested'));
                }, quiet);

                onAfterCommit(() => void fired.push('root-after'));
            }, quiet);

            await flush();

            // Promotion appends at the moment the savepoint resolves
            expect(fired).toEqual(['root-before', 'nested', 'root-after']);
        });

        it('D2 never runs an afterCommit of a savepoint that rolled back, though the root commits', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await failingSavepoint(() => onAfterCommit(() => void fired.push('nested afterCommit')));

                onAfterCommit(() => void fired.push('root afterCommit'));
            }, quiet);

            await flush();

            expect(fired).toEqual(['root afterCommit']);
        });

        it('D3 never runs an afterCommit of a resolved savepoint when the root throws', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const rootError = new Error('root failed');

            await expect(runInTransaction(async () =>
            {
                onAfterRollback(() => void fired.push('root afterRollback'));

                await runInTransaction(async () =>
                {
                    onAfterCommit(() => void fired.push('nested afterCommit'));
                }, quiet);

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            await flush();

            expect(fired).toEqual(['root afterRollback']);
        });

        it('D4 never runs a beforeCommit of a savepoint that rolled back, and the root commits', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await failingSavepoint(() => onBeforeCommit(() =>
                {
                    fired.push('nested beforeCommit');

                    throw new Error('would abort the root');
                }));

                await insertRow('root');
            }, quiet);

            expect(fired).toEqual([]);
            expect(await storedLabels()).toEqual(['root']);
        });

        it('D5 runs a beforeCommit of a resolved savepoint before the root COMMIT, inside the transaction', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            let levelInsideBeforeCommit = 0;

            await runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    onBeforeCommit(async () =>
                    {
                        fired.push('nested beforeCommit');
                        levelInsideBeforeCommit = getTransactionContext()!.level;
                        await insertRow('nested beforeCommit');
                    });
                }, quiet);

                // Not at the savepoint: the driver never releases one
                expect(fired).toEqual([]);
            }, quiet);

            expect(fired).toEqual(['nested beforeCommit']);

            // It ran in the root's context, and its write is part of the commit
            expect(levelInsideBeforeCommit).toBe(1);
            expect(await storedLabels()).toEqual(['nested beforeCommit']);
        });

        it('D6 never runs an afterCommit of a resolved savepoint whose parent savepoint rolled back', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await failingSavepoint(() => runInTransaction(async () =>
                {
                    onAfterCommit(() => void fired.push('S2 afterCommit'));
                }, quiet));

                onAfterCommit(() => void fired.push('root afterCommit'));
            }, quiet);

            await flush();

            expect(fired).toEqual(['root afterCommit']);
        });

        it('D7 runs an afterCommit of a savepoint two levels deep once, after the root commit', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    await runInTransaction(async () =>
                    {
                        onAfterCommit(() => void fired.push('S2 afterCommit'));
                    }, quiet);
                }, quiet);

                expect(fired).toEqual([]);
            }, quiet);

            await flush();

            expect(fired).toEqual(['S2 afterCommit']);
        });

        it('D8 runs an afterRollback of a savepoint once, at the savepoint rollback, inside the parent context', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            let levelInsideAfterRollback = 0;

            await runInTransaction(async () =>
            {
                onAfterRollback(() => void fired.push('root afterRollback'));

                await failingSavepoint(() => onAfterRollback(async () =>
                {
                    // A pass that is not awaited would let the nested call
                    // reject before anything below has happened
                    await pause(20);
                    fired.push('nested afterRollback');
                    levelInsideAfterRollback = getTransactionContext()!.level;
                    await insertRow('compensation');
                }));

                // Awaited before the error left the nested call
                expect(fired).toEqual(['nested afterRollback']);
                expect(await labelsInTransaction()).toEqual(['compensation']);

                onAfterCommit(() => void fired.push('root afterCommit'));
            }, quiet);

            await flush();

            // Once, and the root's own callback stayed silent: the root committed
            expect(fired).toEqual(['nested afterRollback', 'root afterCommit']);

            // The parent's context, so the compensation's write joined the root
            expect(levelInsideAfterRollback).toBe(1);
            expect(await storedLabels()).toEqual(['compensation']);
        });

        it('D9 runs an afterRollback of a resolved savepoint once, at the root rollback', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const rootError = new Error('root failed');

            await expect(runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    onAfterRollback(() => void fired.push('nested afterRollback'));
                }, quiet);

                expect(fired).toEqual([]);

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            expect(fired).toEqual(['nested afterRollback']);
        });

        it('D10 logs a throwing afterRollback of a savepoint and rejects the nested call with the original error', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await failingSavepoint(() =>
                {
                    onAfterRollback(() =>
                    {
                        throw new Error('cleanup failed');
                    });
                    onAfterRollback(() => void fired.push('second'));
                });
            }, quiet);

            expect(logged).toHaveBeenCalledWith(
                'afterRollback callback failed',
                expect.objectContaining({ error: 'cleanup failed' }),
            );
            expect(fired).toEqual(['second']);
        });

        it('D11 fires the hooks of requiresNew roots inside a failing savepoint on their own outcome', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const innerError = new Error('inner root failed');

            await runInTransaction(async () =>
            {
                await failingSavepoint(async () =>
                {
                    await runInTransaction(async () =>
                    {
                        onAfterCommit(() => void fired.push('committing root afterCommit'));
                        onAfterRollback(() => void fired.push('committing root afterRollback'));
                    }, { ...quiet, requiresNew: true });

                    await expect(runInTransaction(async () =>
                    {
                        onAfterCommit(() => void fired.push('failing root afterCommit'));
                        onAfterRollback(() => void fired.push('failing root afterRollback'));

                        throw innerError;
                    }, { ...quiet, requiresNew: true })).rejects.toBe(innerError);
                });
            }, quiet);

            await flush();

            expect(fired).toEqual(['committing root afterCommit', 'failing root afterRollback']);
        });

        it('D12 drops a throwing Transactional() handler\'s commit hooks and runs its afterRollback at the savepoint', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];
            const app = new Hono();

            app.onError((_error, c) => c.json({ ok: false }, 500));
            app.get('/work', Transactional(quiet), async () =>
            {
                onBeforeCommit(() => void fired.push('handler beforeCommit'));
                onAfterCommit(() => void fired.push('handler afterCommit'));
                onAfterRollback(() => void fired.push('handler afterRollback'));

                throw new Error('handler failed');
            });

            await runInTransaction(async () =>
            {
                expect((await app.request('/work')).status).toBe(500);
                expect(fired).toEqual(['handler afterRollback']);

                onAfterCommit(() => void fired.push('root afterCommit'));
            }, quiet);

            await flush();

            expect(fired).toEqual(['handler afterRollback', 'root afterCommit']);
        });

        it('D13 does not run a hook registered by a resolved savepoint\'s beforeCommit callback for this commit', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    onBeforeCommit(() =>
                    {
                        fired.push('nested beforeCommit');
                        onBeforeCommit(() => void fired.push('registered during the pass'));
                    });
                }, quiet);
            }, quiet);

            expect(fired).toEqual(['nested beforeCommit']);
        });

        it('D14 completes a savepoint afterRollback that compensates with runInTransaction', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            const root = runInTransaction(async () =>
            {
                await failingSavepoint(() => onAfterRollback(async () =>
                {
                    // Registered on the pass's context: it belongs to the parent
                    onAfterCommit(() => void fired.push('compensation afterCommit'));

                    await runInTransaction(async () =>
                    {
                        fired.push('compensation ran');
                        await insertRow('compensation');
                    }, quiet);
                }));
            }, quiet).then(() => 'completed', () => 'rejected');

            // A compensation queued on the gate its own frame holds never opens
            const outcome = await Promise.race([root, pause(1500).then(() => 'hung')]);

            await flush();

            expect({ outcome, fired }).toEqual({
                outcome: 'completed',
                fired: ['compensation ran', 'compensation afterCommit'],
            });
            expect(await storedLabels()).toEqual(['compensation']);
        });

        it('D15 opens the next sibling savepoint only after a failed sibling\'s afterRollback pass has finished', async () =>
        {
            if (!dbFixture.isAvailable) return;

            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const order: string[] = [];

            await runInTransaction(async () =>
            {
                const [first, second] = await Promise.allSettled([
                    runInTransaction(async () =>
                    {
                        onAfterRollback(async () =>
                        {
                            await pause(50);
                            order.push('rollback-finished');

                            throw new Error('cleanup failed');
                        });

                        throw nestedFailure;
                    }, quiet),
                    runInTransaction(async () =>
                    {
                        order.push('sibling-started');
                    }, quiet),
                ]);

                expect([first.status, second.status]).toEqual(['rejected', 'fulfilled']);
            }, quiet);

            expect(order).toEqual(['rollback-finished', 'sibling-started']);
        });

        it('D16 appends a resolved savepoint\'s beforeCommit and afterRollback between the root\'s own', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const beforeCommits: string[] = [];
            const afterRollbacks: string[] = [];
            const rootError = new Error('root failed');

            const registerBoth = (label: string): void =>
            {
                onBeforeCommit(() => void beforeCommits.push(label));
                onAfterRollback(() => void afterRollbacks.push(label));
            };

            const registerAround = async (): Promise<void> =>
            {
                registerBoth('root-before');
                await runInTransaction(async () => registerBoth('nested'), quiet);
                registerBoth('root-after');
            };

            await runInTransaction(registerAround, quiet);

            expect(beforeCommits).toEqual(['root-before', 'nested', 'root-after']);

            await expect(runInTransaction(async () =>
            {
                await registerAround();

                throw rootError;
            }, quiet)).rejects.toBe(rootError);

            expect(afterRollbacks).toEqual(['root-before', 'nested', 'root-after']);
        });

        it('D17 drops an afterCommit that detached work registers after its savepoint has settled', async () =>
        {
            if (!dbFixture.isAvailable) return;

            const fired: string[] = [];

            await runInTransaction(async () =>
            {
                await runInTransaction(async () =>
                {
                    onAfterCommit(() => void fired.push('registered in the call chain'));

                    // Not awaited: it registers once the savepoint has returned
                    setTimeout(() => onAfterCommit(() => void fired.push('registered late')), 10);
                }, quiet);
            }, quiet);

            await pause(50);

            expect(fired).toEqual(['registered in the call chain']);
        });

        it('D18 rejects the root with the error of a statement that failed in a savepoint\'s afterRollback', async () =>
        {
            if (!dbFixture.isAvailable) return;

            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            const fired: string[] = [];

            await expect(runInTransaction(async () =>
            {
                await insertRow('root');
                onAfterCommit(() => void fired.push('root afterCommit'));

                await failingSavepoint(() => onAfterRollback(async () =>
                {
                    await getTransaction()!.execute(sql`SELECT 1/0`);
                }));
            }, quiet)).rejects.toThrow('division by zero');

            await flush();

            expect(fired).toEqual([]);
            expect(await storedLabels()).toEqual([]);
        });

        it('D18b fails the root\'s next statement with 25P02 after a statement failed in a savepoint\'s afterRollback', async () =>
        {
            if (!dbFixture.isAvailable) return;

            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            let atNext: unknown = 'none';

            const outcome = await runInTransaction(async () =>
            {
                await insertRow('root');

                await failingSavepoint(() => onAfterRollback(async () =>
                {
                    await getTransaction()!.execute(sql`SELECT 1/0`);
                }));

                await insertRow('after').catch((error: { cause?: { code?: string } }) =>
                {
                    atNext = error.cause?.code;

                    throw error;
                });
            }, quiet).then(() => 'committed', (error: { cause?: { code?: string } }) => error.cause?.code);

            expect({ outcome, atNext, rows: await storedLabels() }).toEqual({ outcome: '25P02', atNext: '25P02', rows: [] });
        });
    });

    describe('Outside any transaction', () =>
    {
        it('runs beforeCommit and afterCommit immediately and warns that afterRollback is a no-op', async () =>
        {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
            const fired: string[] = [];

            onBeforeCommit(() => void fired.push('beforeCommit'));
            onAfterCommit(() => void fired.push('afterCommit'));
            onAfterRollback(() => void fired.push('afterRollback'));

            await flush();

            expect(fired).toEqual(['beforeCommit', 'afterCommit']);
            expect(warn).toHaveBeenCalledWith('afterRollback callback ignored (no transaction)');
        });

        it('warns that a beforeCommit callback registered outside a transaction cannot abort anything', async () =>
        {
            const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

            // The callback's throw is expected here; keep its log off the console
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

            let aborted = false;

            // An aborting check written for the hook: outside a transaction the
            // throw reaches nothing, hence the warning
            onBeforeCommit(() =>
            {
                aborted = true;

                throw new Error('invariant violated');
            });

            await flush();

            expect(aborted).toBe(true);
            expect(warn).toHaveBeenCalledWith(
                'beforeCommit callback ran immediately (no transaction): a throw cannot abort anything',
            );
        });
    });
});
