/**
 * Test database setup for notification integration tests.
 *
 * Shares the core package's local database; only the spfn_notification schema
 * is dropped and rebuilt from the committed migrations.
 */

import { closeDatabase, getDatabase, initDatabase, readMigrationEntries } from '@spfn/core/db';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

// Override with TEST_DATABASE_URL to point elsewhere.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
    || 'postgresql://testuser:testpass@localhost:5432/spfn_test';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

export async function setupTestDb(): Promise<void>
{
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    await initDatabase();
    await applyMigrations();
}

export async function teardownTestDb(): Promise<void>
{
    await closeDatabase();
}

export async function clearTables(): Promise<void>
{
    await getDatabase('write').execute(sql`
        TRUNCATE TABLE spfn_notification.tracking_events, spfn_notification.history, spfn_notification.push_devices
        RESTART IDENTITY CASCADE
    `);
}

async function applyMigrations(): Promise<void>
{
    const db = getDatabase('write');

    await db.execute(sql`DROP SCHEMA IF EXISTS spfn_notification CASCADE`);

    // Read as `spfn db migrate` reads them: the migrations, and not the other
    // files of the folder (privileges.json).
    for (const migration of readMigrationEntries(MIGRATIONS_FOLDER, '@spfn/notification'))
    {
        for (const statement of migration.statements)
        {
            await db.execute(sql.raw(statement));
        }
    }
}
