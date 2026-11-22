/**
 * Test database setup for CMS repository integration tests.
 */

import { closeDatabase, initDatabase, readMigrationEntries } from '@spfn/core/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// Integration tests run against the local PostgreSQL instance, one logical
// database per package. Override with TEST_DATABASE_URL to point elsewhere.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
    || 'postgresql://cmstest:cmstest123@localhost:5432/spfn_cms_test';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

let testDb: ReturnType<typeof drizzle> | null = null;
let testClient: ReturnType<typeof postgres> | null = null;

export async function setupTestDb()
{
    if (testDb)
    {
        return testDb;
    }

    testClient = postgres(TEST_DATABASE_URL);
    testDb = drizzle({ client: testClient });

    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await initDatabase();
    await applyMigrations(testDb);

    return testDb;
}

export async function teardownTestDb()
{
    await closeDatabase();

    if (testClient)
    {
        await testClient.end();
        testClient = null;
        testDb = null;
    }
}

export async function clearTables(db: ReturnType<typeof drizzle>)
{
    await db.execute(sql`
        TRUNCATE TABLE
            spfn_cms.label_values,
            spfn_cms.published_cache,
            spfn_cms.labels
        RESTART IDENTITY CASCADE
    `);
}

export function getTestDb()
{
    if (!testDb)
    {
        throw new Error('Test database not initialized. Call setupTestDb() first.');
    }

    return testDb;
}

async function applyMigrations(db: ReturnType<typeof drizzle>)
{
    await db.execute(sql`DROP SCHEMA IF EXISTS spfn_cms CASCADE`);
    await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);

    // Read as `spfn db migrate` reads them: the journal's migrations, and not
    // the other files of the folder (privileges.json).
    for (const migration of readMigrationEntries(MIGRATIONS_FOLDER, '@spfn/cms'))
    {
        for (const statement of migration.statements)
        {
            await db.execute(sql.raw(statement));
        }
    }
}
