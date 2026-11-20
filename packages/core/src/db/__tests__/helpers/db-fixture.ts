/**
 * Database Test Fixture
 *
 * Reusable helper for integration tests that need database access.
 * Provides type-safe database instance without null checks.
 */

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { TestContext } from 'vitest';
import { initDatabase, getDatabase, closeDatabase } from '../../manager';

/**
 * Connection string for the local test database.
 *
 * Integration tests run against the machine's own PostgreSQL, one logical
 * database per package — see scripts/test-services.sh. Override with
 * TEST_DATABASE_URL to point elsewhere.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
    || 'postgresql://testuser:testpass@localhost:5432/spfn_test';

export interface DbTestFixture
{
    /**
     * Database instance (only available when isAvailable is true)
     * @throws Error if accessed when database is not available
     */
    readonly db: PostgresJsDatabase;

    /**
     * Whether the database is available for testing
     */
    readonly isAvailable: boolean;

    /**
     * Skip the row, with the reason, when the database is not available — so
     * the reporter counts it skipped, never passed. Call it from `beforeEach`
     * or first thing in a row.
     */
    skipIfUnavailable(context: TestContext): void;

    /**
     * Initialize database connection
     * Call this in beforeAll()
     */
    setup(): Promise<void>;

    /**
     * Close database connection
     * Call this in afterAll()
     */
    teardown(): Promise<void>;

    /**
     * Truncate specified table(s)
     * Call this in beforeEach() to clean test data
     */
    cleanTable(...tableNames: string[]): Promise<void>;

    /**
     * Execute raw SQL (only when database is available)
     */
    execute(sql: string): Promise<void>;
}

/**
 * Create a database test fixture for integration tests
 *
 * @example
 * ```typescript
 * describe('My Integration Test', () => {
 *     const dbFixture = createDbTestFixture();
 *
 *     beforeAll(() => dbFixture.setup());
 *     afterAll(() => dbFixture.teardown());
 *     beforeEach((context) => dbFixture.skipIfUnavailable(context));
 *     beforeEach(() => dbFixture.cleanTable('test_users'));
 *
 *     // Not `it.skipIf(!dbFixture.isAvailable)`: that is read while the file
 *     // is collected, before `setup()` has run, so it would skip every row.
 *     it('should work', async () => {
 *         // No need for ! or null checks
 *         const users = await dbFixture.db.select().from(testUsers);
 *     });
 * });
 * ```
 */
export function createDbTestFixture(): DbTestFixture
{
    let _db!: PostgresJsDatabase;
    let _isAvailable = false;

    return {
        get db()
        {
            if (!_isAvailable)
            {
                throw new Error(
                    'Database not initialized. Did you call setup() in beforeAll()?',
                );
            }

            return _db;
        },

        get isAvailable()
        {
            return _isAvailable;
        },

        skipIfUnavailable(context)
        {
            context.skip(!_isAvailable, 'PostgreSQL not available at TEST_DATABASE_URL');
        },

        async setup()
        {
            try
            {
                process.env.DATABASE_URL = TEST_DATABASE_URL;
                await initDatabase();
                _db = getDatabase();
                _isAvailable = true;
            }
            catch (error)
            {
                _isAvailable = false;
                console.log('\n⚠️  PostgreSQL not available - skipping integration tests');
                console.log('   To run integration tests:');
                console.log('   1. Run: ./scripts/test-services.sh start');
                console.log('   2. Run tests again\n');
            }
        },

        async teardown()
        {
            if (_isAvailable)
            {
                await closeDatabase();
            }
        },

        async cleanTable(...tableNames: string[])
        {
            if (_isAvailable && tableNames.length > 0)
            {
                const tables = tableNames.join(', ');
                await _db.execute(`TRUNCATE TABLE ${tables} CASCADE`);
            }
        },

        async execute(sql: string)
        {
            if (_isAvailable)
            {
                await _db.execute(sql);
            }
        },
    };
}
