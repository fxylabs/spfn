/**
 * Transaction Context Integration Tests
 *
 * Tests AsyncLocalStorage-based transaction propagation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
    getTransactionContext,
    getTransaction,
    getTransactionId,
    runWithTransaction,
    type TransactionDB,
} from '../context';
import { testUsers } from '../../__tests__/fixtures/test-schema';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';

describe('Transaction Context (Integration)', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(async () =>
    {
        await dbFixture.setup();

        if (dbFixture.isAvailable)
        {
            // Drop tables if exist to ensure clean state
            await dbFixture.execute('DROP TABLE IF EXISTS test_posts CASCADE');
            await dbFixture.execute('DROP TABLE IF EXISTS test_users CASCADE');

            // Create test tables
            await dbFixture.execute(`
                CREATE TABLE test_users (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP DEFAULT NOW() NOT NULL
                )
            `);

            await dbFixture.execute(`
                CREATE TABLE test_posts (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES test_users(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    content TEXT,
                    created_at TIMESTAMP DEFAULT NOW() NOT NULL
                )
            `);
        }
    });

    afterAll(async () =>
    {
        await dbFixture.execute('DROP TABLE IF EXISTS test_posts CASCADE');
        await dbFixture.execute('DROP TABLE IF EXISTS test_users CASCADE');
        await dbFixture.teardown();
    });

    beforeEach(() => dbFixture.cleanTable('test_posts', 'test_users'));

    describe('AsyncLocalStorage Context', () =>
    {
        it('should return null when not in transaction context', () =>
        {
            // This test doesn't need DB, so it always runs
            // This ensures beforeAll is executed
            if (!dbFixture.isAvailable) 
            {
                return; // Skip silently if DB not available
            }

            const context = getTransactionContext();
            const tx = getTransaction();
            const txId = getTransactionId();

            expect(context).toBeNull();
            expect(tx).toBeNull();
            expect(txId).toBeNull();
        });

        it('should provide transaction context within runWithTransaction', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                await runWithTransaction(tx as TransactionDB, 'test-tx-1', async () =>
                {
                    const context = getTransactionContext();
                    const transaction = getTransaction();
                    const txId = getTransactionId();

                    expect(context).toBeDefined();
                    expect(context?.tx).toBe(tx);
                    expect(context?.txId).toBe('test-tx-1');
                    expect(context?.level).toBe(1);
                    expect(transaction).toBe(tx);
                    expect(txId).toBe('test-tx-1');
                });
            });
        });

        it('should propagate transaction across async operations', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                await runWithTransaction(tx as TransactionDB, 'test-tx-2', async () =>
                {
                    // Simulate async operation
                    await new Promise(resolve => setTimeout(resolve, 10));

                    const txId = getTransactionId();
                    expect(txId).toBe('test-tx-2');

                    // Another async operation
                    await Promise.resolve();

                    const txId2 = getTransactionId();
                    expect(txId2).toBe('test-tx-2');
                });
            });
        });

        it('should isolate transaction context between concurrent transactions', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            const results: string[] = [];

            // Run two concurrent transactions
            await Promise.all([
                dbFixture.db.transaction(async (tx1) =>
                {
                    await runWithTransaction(tx1 as TransactionDB, 'concurrent-tx-1', async () =>
                    {
                        await new Promise(resolve => setTimeout(resolve, 20));
                        const txId = getTransactionId();
                        results.push(txId!);
                    });
                }),
                dbFixture.db.transaction(async (tx2) =>
                {
                    await runWithTransaction(tx2 as TransactionDB, 'concurrent-tx-2', async () =>
                    {
                        await new Promise(resolve => setTimeout(resolve, 10));
                        const txId = getTransactionId();
                        results.push(txId!);
                    });
                }),
            ]);

            expect(results).toHaveLength(2);
            expect(results).toContain('concurrent-tx-1');
            expect(results).toContain('concurrent-tx-2');
        });

        it('should clear context after transaction completes', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                await runWithTransaction(tx as TransactionDB, 'test-tx-3', async () =>
                {
                    expect(getTransactionId()).toBe('test-tx-3');
                });
            });

            // Context should be cleared after transaction
            expect(getTransactionId()).toBeNull();
        });
    });

    describe('Nested Transactions', () =>
    {
        it('should detect nested transactions', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx1) =>
            {
                await runWithTransaction(tx1 as TransactionDB, 'outer-tx', async () =>
                {
                    const outerContext = getTransactionContext();
                    expect(outerContext?.level).toBe(1);
                    expect(outerContext?.txId).toBe('outer-tx');

                    // Simulate nested transaction (savepoint)
                    await dbFixture.db.transaction(async (tx2) =>
                    {
                        await runWithTransaction(tx2 as TransactionDB, 'inner-tx', async () =>
                        {
                            const innerContext = getTransactionContext();
                            expect(innerContext?.level).toBe(2);
                            expect(innerContext?.txId).toBe('inner-tx');
                        });
                    });

                    // After nested transaction, should be back to outer
                    const finalContext = getTransactionContext();
                    expect(finalContext?.level).toBe(1);
                    expect(finalContext?.txId).toBe('outer-tx');
                });
            });
        });

        it('should track multiple levels of nesting', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            const levels: number[] = [];

            await dbFixture.db.transaction(async (tx1) =>
            {
                await runWithTransaction(tx1 as TransactionDB, 'level-1', async () =>
                {
                    levels.push(getTransactionContext()!.level);

                    await dbFixture.db.transaction(async (tx2) =>
                    {
                        await runWithTransaction(tx2 as TransactionDB, 'level-2', async () =>
                        {
                            levels.push(getTransactionContext()!.level);

                            await dbFixture.db.transaction(async (tx3) =>
                            {
                                await runWithTransaction(tx3 as TransactionDB, 'level-3', async () =>
                                {
                                    levels.push(getTransactionContext()!.level);
                                });
                            });
                        });
                    });
                });
            });

            expect(levels).toEqual([1, 2, 3]);
        });
    });

    describe('Transaction Operations', () =>
    {
        it('should execute queries using transaction context', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                await runWithTransaction(tx as TransactionDB, 'query-tx', async () =>
                {
                    const transaction = getTransaction();
                    expect(transaction).toBeDefined();

                    // Use transaction to insert data
                    const [user] = await transaction!.insert(testUsers).values({
                        name: 'Test User',
                        email: 'test@example.com',
                    }).returning();

                    expect(user.id).toBeDefined();
                    expect(user.name).toBe('Test User');

                    // Query using transaction
                    const users = await transaction!.select().from(testUsers);
                    expect(users).toHaveLength(1);
                });
            });

            // Clean up
            await dbFixture.db.delete(testUsers);
        });

        it('should rollback on error', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            try
            {
                await dbFixture.db.transaction(async (tx) =>
                {
                    await runWithTransaction(tx as TransactionDB, 'rollback-tx', async () =>
                    {
                        const transaction = getTransaction();

                        // Insert user
                        await transaction!.insert(testUsers).values({
                            name: 'Rollback User',
                            email: 'rollback@example.com',
                        });

                        // Throw error to trigger rollback
                        throw new Error('Intentional error');
                    });
                });
            }
            catch (error)
            {
                expect(error).toBeInstanceOf(Error);
            }

            // Verify rollback - user should not exist
            const users = await dbFixture.db.select().from(testUsers).where(sql`email = 'rollback@example.com'`);
            expect(users).toHaveLength(0);
        });

        it('should commit on success', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            let userId: number | undefined;

            await dbFixture.db.transaction(async (tx) =>
            {
                await runWithTransaction(tx as TransactionDB, 'commit-tx', async () =>
                {
                    const transaction = getTransaction();

                    // Insert user
                    const [user] = await transaction!.insert(testUsers).values({
                        name: 'Commit User',
                        email: 'commit@example.com',
                    }).returning();

                    userId = user.id;
                });
            });

            // Verify commit - user should exist
            const users = await dbFixture.db.select().from(testUsers).where(sql`id = ${userId}`);
            expect(users).toHaveLength(1);
            expect(users[0].name).toBe('Commit User');

            // Clean up
            await dbFixture.db.delete(testUsers).where(sql`id = ${userId}`);
        });
    });
});
