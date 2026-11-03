/**
 * @spfn/auth - The migration that copies chosen locale and timezone into
 * user_settings (fxylabs/spfn#161, case table rows S17 and S18)
 *
 * `setupTestDb` applies every migration to empty tables, so the backfill has
 * nothing to copy there. These tests seed profiles afterwards and run the
 * migration's own INSERT statements, read from the committed migration.sql,
 * so what is tested is exactly what ships.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asc, sql } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { userProfiles, userSettings, users } from '@/server/entities';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

/** The backfill statements of the migration that creates user_settings */
function backfillStatements(): string[]
{
    const folder = readdirSync(MIGRATIONS_FOLDER)
        .filter(name => readFileSync(join(MIGRATIONS_FOLDER, name, 'migration.sql'), 'utf8')
            .includes('CREATE TABLE "spfn_auth"."user_settings"'));

    expect(folder).toHaveLength(1);

    return readFileSync(join(MIGRATIONS_FOLDER, folder[0], 'migration.sql'), 'utf8')
        .split('--> statement-breakpoint')
        .map(statement => statement.trim())
        .filter(statement => statement.startsWith('INSERT INTO "spfn_auth"."user_settings"'));
}

describe.skipIf(!dbAvailable)('settings migration backfill (case table #161)', () =>
{
    const ids: Record<string, number> = {};

    beforeAll(async () =>
    {
        await setupTestDb();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();

        const roleId = (await getRoleByName('user'))!.id;
        const profiles: Array<[string, string | null, string | null]> = [
            ['chose', 'ko', 'Asia/Seoul'],
            ['english', 'en', 'UTC'],
            ['never', null, null],
            ['blank', null, ''],
            ['spaces', null, '  '],
        ];
        for (const [name, locale, timezone] of profiles)
        {
            const [user] = await db.insert(users).values({ email: `${name}@test.com`, roleId }).returning();
            await db.insert(userProfiles).values({ userId: user.id, locale, timezone });
            ids[name] = user.id;
        }
    });

    async function runBackfill()
    {
        for (const statement of backfillStatements())
        {
            await getTestDb().execute(sql.raw(statement));
        }
    }

    async function settingsRows()
    {
        return await getTestDb()
            .select({
                id: userSettings.id,
                userId: userSettings.userId,
                key: userSettings.key,
                value: userSettings.value,
                updatedBy: userSettings.updatedBy,
                updatedAt: userSettings.updatedAt,
            })
            .from(userSettings)
            .orderBy(asc(userSettings.userId), asc(userSettings.key));
    }

    it('the migration carries exactly two backfill statements', () =>
    {
        expect(backfillStatements()).toHaveLength(2);
    });

    it('S17: a chosen locale (en included) and a non-UTC timezone become rows; UTC, NULL and a blank timezone do not', async () =>
    {
        await runBackfill();

        expect((await settingsRows()).map(({ userId, key, value, updatedBy }) => ({ userId, key, value, updatedBy }))).toEqual([
            { userId: ids.chose, key: 'locale', value: 'ko', updatedBy: ids.chose },
            { userId: ids.chose, key: 'timezone', value: 'Asia/Seoul', updatedBy: ids.chose },
            { userId: ids.english, key: 'locale', value: 'en', updatedBy: ids.english },
        ]);
    });

    it('S18: running the backfill again changes nothing', async () =>
    {
        await runBackfill();
        const first = await settingsRows();

        await runBackfill();

        expect(await settingsRows()).toEqual(first);
    });
});
