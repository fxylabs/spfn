/**
 * Test database setup for notification integration tests.
 *
 * Shares the core package's local database; only the spfn_notification schema
 * is dropped and rebuilt from the committed migrations.
 */

import { closeDatabase, getDatabase, initDatabase } from '@spfn/core/db';
import { sql } from 'drizzle-orm';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
        TRUNCATE TABLE spfn_notification.tracking_events, spfn_notification.history
        RESTART IDENTITY CASCADE
    `);
}

async function applyMigrations(): Promise<void>
{
    const db = getDatabase('write');

    await db.execute(sql`DROP SCHEMA IF EXISTS spfn_notification CASCADE`);

    const files = readdirSync(MIGRATIONS_FOLDER)
        .filter(file => file.endsWith('.sql'))
        .sort();

    for (const file of files)
    {
        const statements = readFileSync(resolve(MIGRATIONS_FOLDER, file), 'utf8')
            .split('--> statement-breakpoint')
            .map(statement => statement.trim())
            .filter(Boolean);

        for (const statement of statements)
        {
            await db.execute(sql.raw(statement));
        }
    }
}
