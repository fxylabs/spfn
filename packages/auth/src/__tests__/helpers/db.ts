/**
 * Test Database Setup
 *
 * Sets up and tears down test database for integration tests
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, closeDatabase } from '@spfn/core/db';

// Integration tests run against the local PostgreSQL instance, one logical
// database per package. Override with TEST_DATABASE_URL to point elsewhere.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://authtest:authtest123@localhost:5432/spfn_auth_test';

// The package's committed migrations (./migrations), resolved from this file.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

let testDb: ReturnType<typeof drizzle> | null = null;
let testClient: ReturnType<typeof postgres> | null = null;
let dbAvailable: boolean | null = null;

/**
 * Check if test database is available
 *
 * @returns true if DB is available, false otherwise
 */
export async function isDatabaseAvailable(): Promise<boolean>
{
    if (dbAvailable !== null)
    {
        return dbAvailable;
    }

    try
    {
        const client = postgres(TEST_DATABASE_URL, {
            max: 1,
            connect_timeout: 3, // 3 seconds timeout
        });

        // Try to connect
        await client`SELECT 1`;
        await client.end();

        dbAvailable = true;

        return true;
    }
    catch (error)
    {
        console.log('[Test] ⚠️  Test database not available. Integration tests will be skipped.');
        console.log(`[Test]    Expected database: ${TEST_DATABASE_URL}`);
        console.log(`[Test]    Error: ${(error as Error).message}`);
        dbAvailable = false;

        return false;
    }
}

/**
 * Initialize test database connection
 *
 * @throws Error if database is not available
 */
export async function setupTestDb()
{
    if (testDb)
    {
        return testDb;
    }

    // Check if DB is available first
    const available = await isDatabaseAvailable();
    if (!available)
    {
        throw new Error('Test database not available');
    }

    testClient = postgres(TEST_DATABASE_URL);
    testDb = drizzle({ client: testClient });

    // Set DATABASE_URL environment variable for @spfn/core/db
    process.env.DATABASE_URL = TEST_DATABASE_URL;

    // Initialize @spfn/core/db with test database
    await initDatabase();

    // Apply the package's committed migrations (replaces hand-written DDL)
    await applyMigrations(testDb);

    return testDb;
}

/**
 * Clean up test database
 */
export async function teardownTestDb()
{
    // Close @spfn/core/db instance first
    await closeDatabase();

    if (testDb && testClient)
    {
        await testClient.end();
        testDb = null;
        testClient = null;
    }
}

/**
 * Clear all tables (for test isolation)
 */
export async function clearTables(db: ReturnType<typeof drizzle>)
{
    // Clear in reverse dependency order
    await db.execute(sql`TRUNCATE TABLE spfn_auth.user_permissions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.role_permissions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.user_invitations CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.account_deletion_requests CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.users CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.permissions CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.roles CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.user_public_keys CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.user_social_accounts CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.verification_codes CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.signup_link_tokens CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.passkeys CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.webauthn_challenges CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.device_authorizations CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.auth_metadata CASCADE`);
    await db.execute(sql`TRUNCATE TABLE spfn_auth.ops_tokens CASCADE`);
}

/**
 * Apply the package's committed migrations to the test database.
 *
 * Replaces the previous hand-written DDL, which silently drifted from the
 * Drizzle entities (missing columns like public_id / username / metadata).
 * The migrations in ./migrations are the same ones shipped to consumers and are
 * verified in sync with the entities, so the test schema can no longer fall
 * behind. Starts from a clean schema each run so a reused database keeps no
 * stale state.
 *
 * Layout is drizzle-kit 1.0: one directory per migration, named
 * `<utc-timestamp>_<label>`, each holding `migration.sql`. The timestamp prefix
 * is fixed width, so sorting the directory names sorts the migrations.
 */
async function applyMigrations(db: ReturnType<typeof drizzle>)
{
    // Clean slate: drop the auth schema and the migrator's own bookkeeping so
    // every run re-applies the full migration set from scratch.
    await db.execute(sql`DROP SCHEMA IF EXISTS spfn_auth CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);

    const directories = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .filter(name => /^\d{14}_[A-Za-z0-9_-]+$/.test(name))
        .sort();

    if (directories.length === 0)
    {
        throw new Error(`No migrations found in ${MIGRATIONS_FOLDER}`);
    }

    const migrations = directories.map((name) =>
    {
        const content = readFileSync(resolve(MIGRATIONS_FOLDER, name, 'migration.sql'), 'utf8');

        return {
            statements: content
                .split('--> statement-breakpoint')
                .map(statement => statement.trim())
                .filter(Boolean),
        };
    });

    await db.transaction(async (tx) =>
    {
        for (const migration of migrations)
        {
            for (const statement of migration.statements)
            {
                await tx.execute(sql.raw(statement));
            }
        }
    });
}

/**
 * Get test database instance
 */
export function getTestDb()
{
    if (!testDb)
    {
        throw new Error('Test database not initialized. Call setupTestDb() first.');
    }

    return testDb;
}
