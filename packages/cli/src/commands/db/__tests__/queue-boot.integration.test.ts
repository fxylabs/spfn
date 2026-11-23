/**
 * The server's boot rule and the owner step on one queue schema, two roles
 * (#171, PRs 2 and 3)
 *
 * The owner is TEST_DATABASE_URL; the app role, which `initBoss` connects as,
 * is the one the gating helper's `appUrl()` connects as. A scratch project —
 * a migration, its manifest, and a package.json declaring the queue schema —
 * is migrated with `spfn db migrate`, as the boot's refusal says to. What the
 * row keeps from passing unnoticed:
 *
 * - P1 the boot naming, for a queue the owner installed at an older version
 *   than pg-boss's, a command whose owner step does not migrate it: the two
 *   PRs contradicting each other again, the boot refused for good after the
 *   command it named ran; or not naming the role that owns the queue, which
 *   that command has to connect as.
 *
 * Skipped, with the reason, where the app role cannot connect; a failure under
 * CI. The row works in its own schemas and drops them; no role is created or
 * altered.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import PgBoss from 'pg-boss';
import { initBoss, JobQueueSchemaError, QUEUE_SCHEMA_VERSION, queueInstallSql, stopBoss } from '@spfn/core/job';

import { appUrl, OWNER_URL, requireDatabase, twoRoleUnavailability } from './helpers/test-database.js';

const { dbMigrate } = await import('../migrate.js');

const QUEUE = 'i171c_boot_queue';
const PROJECT = 'i171c_boot_app';
const PROJECT_SQL = `CREATE SCHEMA ${PROJECT};\n--> statement-breakpoint\nCREATE TABLE ${PROJECT}.notes (id serial PRIMARY KEY, body text);\n`;
const MANIFEST = `${JSON.stringify({
    $comment: 'Generated from the entities\' appPrivileges() declarations. Do not edit: regenerate.',
    version: 1,
    default: ['select', 'insert', 'update', 'delete'],
    tables: [{ schema: PROJECT, table: 'notes', privileges: 'default' }],
}, null, 4)}\n`;

describe('the boot rule and the owner step', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    let twoRoles: string | undefined = 'beforeAll has not run';
    let root: string;
    let previousCwd: string;

    beforeAll(async () =>
    {
        const reachable = await requireDatabase(owner, 'queue boot integration tests');

        twoRoles = reachable ? await twoRoleUnavailability(owner, app) : 'PostgreSQL not available';
    });

    afterAll(async () =>
    {
        if (twoRoles === undefined)
        {
            await dropSchemas();
        }
        await Promise.all([owner.end(), app.end()]);
    });

    beforeEach(async ({ skip }) =>
    {
        skip(twoRoles !== undefined, twoRoles);

        await dropSchemas();
        root = mkdtempSync(join(__dirname, 'tmp-queue-boot-'));
        previousCwd = process.cwd();
        process.chdir(root);
        writeProject();
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(async () =>
    {
        if (twoRoles !== undefined)
        {
            return;
        }

        await stopBoss();
        process.chdir(previousCwd);
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    async function dropSchemas(): Promise<void>
    {
        for (const schema of [QUEUE, PROJECT, 'drizzle'])
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
    }

    function writeProject(): void
    {
        const folder = join(root, 'src', 'server', 'drizzle');

        mkdirSync(join(folder, '20260101000000_init'), { recursive: true });
        writeFileSync(join(folder, '20260101000000_init', 'migration.sql'), PROJECT_SQL);
        writeFileSync(join(folder, 'privileges.json'), MANIFEST);
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'i171c-boot', private: true, spfn: { jobs: { schema: QUEUE } } }));
    }

    it('P1 an owner-installed queue older than pg-boss\'s: the boot names spfn db migrate, which migrates it, and the boot then starts', async () =>
    {
        // pg-boss's rollback store finds the version with ===: a number, whatever its types say
        await owner.unsafe(`${queueInstallSql(QUEUE)}; ${PgBoss.getRollbackPlans(QUEUE, QUEUE_SCHEMA_VERSION as unknown as string)}`);

        const [{ role }] = await app`SELECT current_user AS role`;
        const [{ role: ownerRole }] = await owner`SELECT current_user AS role`;

        await owner.unsafe(`GRANT USAGE ON SCHEMA ${QUEUE} TO ${role}; GRANT SELECT ON ${QUEUE}.version TO ${role}`);

        const refused = await initBoss({ connectionString: appUrl(), schema: QUEUE }).then(() => undefined, (error: unknown) => error as JobQueueSchemaError);

        expect(refused).toBeInstanceOf(JobQueueSchemaError);
        expect(refused?.step).toBe('owner');
        expect(refused?.message).toContain(`Run spfn db migrate (or spfn db push) with DATABASE_OWNER_URL connecting as ${ownerRole}, which owns the schema and every object in it`);

        await dbMigrate();

        expect(process.exit).not.toHaveBeenCalled();
        expect(await initBoss({ connectionString: appUrl(), schema: QUEUE })).toBeInstanceOf(PgBoss);
    });
});
