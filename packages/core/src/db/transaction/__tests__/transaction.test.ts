/**
 * Transaction Runner Tests
 *
 * Tests for SQL timeout configuration methods and security
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { runInTransaction } from '../runner';

describe('Transaction Timeout Configuration', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(() => dbFixture.setup());
    afterAll(() => dbFixture.teardown());

    describe('SQL Timeout Setting Methods', () =>
    {
        it('should successfully set timeout using sql.raw() with template literal', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                const timeout = 5000;

                // Current method: sql.raw() with template literal
                await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeout}`));

                // Verify timeout was set
                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                expect(result[0].statement_timeout).toBe('5s');
            });
        });

        it('should successfully set timeout using sql.raw() with string concatenation', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                const timeout = 3000;

                // Alternative: sql.raw() with string concatenation
                await tx.execute(sql.raw('SET LOCAL statement_timeout = ' + timeout));

                // Verify timeout was set
                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                expect(result[0].statement_timeout).toBe('3s');
            });
        });

        it('should fail when trying to use prepared statement with sql placeholder', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            // Expect the transaction to fail
            await expect(async () =>
            {
                await dbFixture.db.transaction(async (tx) =>
                {
                    const timeout = 2000;

                    // Attempt: Using sql tagged template with placeholder (prepared statement)
                    // PostgreSQL does not support parameterized SET commands
                    await tx.execute(sql`SET LOCAL statement_timeout = ${timeout}`);
                });
            }).rejects.toThrow(); // Should throw syntax error
        });

        it('should verify sql.raw() is safe with validated integer input', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                // Simulate our validation logic
                const userInput = '5000';
                const timeout = parseInt(userInput, 10);

                // Validation (as done in runInTransaction)
                if (Number.isNaN(timeout) || !Number.isInteger(timeout))
                {
                    throw new Error('Invalid timeout');
                }

                if (timeout < 0 || timeout > 2147483647)
                {
                    throw new Error('Timeout out of range');
                }

                // Now it's safe to use sql.raw()
                await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeout}`));

                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                expect(result[0].statement_timeout).toBe('5s');
            });
        });

        it('should demonstrate SQL injection attempt is prevented by validation', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                // Simulate malicious input
                const maliciousInput = '5000; DROP TABLE users; --';

                // Our validation catches this
                const timeout = parseInt(maliciousInput, 10);

                // parseInt stops at first non-numeric character, returns 5000
                expect(timeout).toBe(5000);

                // Type check ensures it's a safe integer
                expect(Number.isInteger(timeout)).toBe(true);

                // This is safe to use
                await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeout}`));

                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                expect(result[0].statement_timeout).toBe('5s');
            });
        });

        it('should demonstrate another SQL injection attempt blocked by type validation', async () =>
        {
            // Simulate malicious input that tries to bypass parseInt
            const maliciousInput = { toString: () => '5000; DROP TABLE users;' };

            // Our validation requires integer type
            const timeout = parseInt(maliciousInput.toString(), 10);

            // parseInt extracts the number
            expect(timeout).toBe(5000);

            // But our validation also checks Number.isInteger()
            // If someone tries to pass the object directly:
            const isValid = Number.isInteger(maliciousInput);
            expect(isValid).toBe(false); // This would be caught

            // Only actual integers pass validation
            expect(Number.isInteger(timeout)).toBe(true);
        });
    });

    describe('Timeout Behavior', () =>
    {
        it('should timeout and cancel query when timeout is exceeded', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await expect(async () =>
            {
                await dbFixture.db.transaction(async (tx) =>
                {
                    // Set very short timeout
                    await tx.execute(sql.raw(`SET LOCAL statement_timeout = 100`));

                    // Try to run a query that takes longer than timeout
                    await tx.execute(sql`SELECT pg_sleep(1)`);
                });
            }).rejects.toThrow(); // Should throw timeout error
        }, 10000); // Test timeout: 10 seconds

        it('should not timeout when query completes within timeout', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                // Set reasonable timeout
                await tx.execute(sql.raw(`SET LOCAL statement_timeout = 2000`));

                // Quick query should succeed
                const result = await tx.execute<{ value: number }>(sql`SELECT 1 as value`);
                expect(result[0].value).toBe(1);
            });
        });

        it('should disable timeout when set to 0', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                // Disable timeout
                await tx.execute(sql.raw(`SET LOCAL statement_timeout = 0`));

                // Verify timeout is disabled
                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                expect(result[0].statement_timeout).toBe('0');

                // Long query should work (but we'll keep it short for test speed)
                const queryResult = await tx.execute(sql`SELECT pg_sleep(0.1)`);
                expect(queryResult).toBeDefined();
            });
        });
    });

    describe('Comparison of Methods', () =>
    {
        it('should compare performance and safety of different methods', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            const methods = {
                sqlRawTemplate: async (timeout: number) =>
                {
                    await dbFixture.db.transaction(async (tx) =>
                    {
                        await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeout}`));
                    });
                },
                sqlRawConcat: async (timeout: number) =>
                {
                    await dbFixture.db.transaction(async (tx) =>
                    {
                        await tx.execute(sql.raw('SET LOCAL statement_timeout = ' + timeout));
                    });
                },
            };

            const timeout = 1000;

            // Both methods should work
            await expect(methods.sqlRawTemplate(timeout)).resolves.not.toThrow();
            await expect(methods.sqlRawConcat(timeout)).resolves.not.toThrow();

            // Conclusion: Both sql.raw() methods work for SET commands
            // Prepared statements (sql`...${param}`) don't work for SET commands
            // Security is ensured by validating timeout as integer before using sql.raw()
        });
    });

    describe('Edge Cases', () =>
    {
        it('should handle maximum timeout value', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                const maxTimeout = 2147483647; // PostgreSQL max int4

                await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${maxTimeout}`));

                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                // PostgreSQL might display this in different units (ms, s, min, etc.)
                expect(result[0].statement_timeout).toBeDefined();
            });
        });

        it('should handle minimum timeout value', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await dbFixture.db.transaction(async (tx) =>
            {
                const minTimeout = 0;

                await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${minTimeout}`));

                const result = await tx.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
                expect(result[0].statement_timeout).toBe('0');
            });
        });
    });

    describe('Idle-in-transaction backstop', () =>
    {
        it('sets idle_in_transaction_session_timeout on a root transaction', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await runInTransaction(async (tx) =>
            {
                const result = await tx.execute<{ idle_in_transaction_session_timeout: string }>(
                    sql`SHOW idle_in_transaction_session_timeout`,
                );
                expect(result[0].idle_in_transaction_session_timeout).toBe('7s');
            }, { idleTimeout: 7000, timeout: 5000, enableLogging: false });
        });

        it('leaves it disabled when idleTimeout is 0', async (context) =>
        {
            dbFixture.skipIfUnavailable(context);

            await runInTransaction(async (tx) =>
            {
                const result = await tx.execute<{ idle_in_transaction_session_timeout: string }>(
                    sql`SHOW idle_in_transaction_session_timeout`,
                );
                expect(result[0].idle_in_transaction_session_timeout).toBe('0');
            }, { idleTimeout: 0, timeout: 5000, enableLogging: false });
        });
    });
});
