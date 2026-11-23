/**
 * The queue step against a real PostgreSQL, two roles (#171, PR 2)
 *
 * The owner is TEST_DATABASE_URL; the app role is the one the gating helper's
 * `appUrl()` connects as. A scratch project — a migration creating
 * `i171b_app.notes`, its manifest, and a package.json declaring the queue
 * schema `i171b_queue` — is migrated (or granted, for the dry run), and each
 * row asserts what the catalog holds and what the app role can do. What each
 * row keeps from passing unnoticed:
 *
 * - S1 a first install that leaves the queue schema, or any object in it,
 *   owned by another role than the owner, or grants the app role less than
 *   a real pg-boss `start({ migrate: false })`, `send` and `fetch` need: the
 *   core of #171 regressing — the app owning, or being refused on, the queue;
 * - S2 pg-boss's migration path 25 → 26 broken through the step: shown only
 *   on the next pg-boss bump, in production. The schema at 25 is pg-boss's
 *   own: its install plan, then its rollback plan from 26
 *   (`PgBoss.getRollbackPlans`), which drops `job_i6` and restores the
 *   earlier `create_queue`;
 * - S3 pg-boss's lost race not ignored, or the version not read again: a
 *   deploy that boots the app while the migrate job runs fails that job
 *   intermittently. Another owner connection takes pg-boss's advisory lock
 *   and installs, uncommitted, before the step reads the schema; it commits
 *   once the step waits on that lock;
 * - S4 a queue the app role installed (it owns every object there) failing
 *   the command, or blocking the rest of the privileges step: every existing
 *   jobs deployment exiting 1 on upgrade, or its project tables left
 *   ungranted;
 * - S16 a queue schema the app role owns while the owner owns the pg-boss
 *   objects in it — no role owns it whole, so no command can migrate it —
 *   migrated, failing the command, or blocking the project's grants; or its
 *   remedy naming a move that leaves the schema and its objects apart: the
 *   remedy lists the schema alone, so REASSIGN OWNED leaves the owner holding
 *   everything;
 * - S5 `db grant --dry-run` installing the queue: its connection is writable,
 *   so only the step's own check keeps it from writing; or saying nothing of
 *   the queue's privilege statements, which a real run then applies; S5b
 *   listing, for a schema to migrate, statements over the objects as they
 *   are before the migration, which are not the ones the real run applies;
 * - S6 a project that declares no jobs reading, running or printing anything
 *   of the queue;
 * - S7, S8 a refusal the step can know from the database as it is — a queue
 *   schema holding an object that is not pg-boss's (`db migrate`), a queue
 *   schema push manages (`db push`) — made after the project's changes:
 *   the command exits 1 all the same, but leaves migrations applied or
 *   tables created that it never grants;
 * - S9 `db push` in a project without schema files returning before the
 *   queue step: it reports success and installs nothing, and the app, with
 *   no CREATE on the database, cannot start pg-boss;
 * - S10 `db push`'s queue path (the step and the queue in the privileges
 *   target) dropped: no other row runs push with jobs declared;
 * - S12 a queue schema the app role owns, empty, where the owner was granted
 *   CREATE: the catalog's ownership query does not list a schema the
 *   connection may create in, so without the step's own schema check the
 *   owner installs pg-boss there — tables the app role, as the schema's
 *   owner, can drop — and the privileges step then grants nothing on them;
 * - S13 `db grant` in a project that declares jobs and has no table — no
 *   manifest, no entity file — exiting 1 on the project's tables it cannot
 *   see, before its queue step: the command push's and migrate's failures
 *   point to cannot install or grant the queue there;
 * - S14 `db grant` deciding "no table of the project's" on another state
 *   than `db push`: a drizzle.config.ts whose schema matches no file ends
 *   push, while grant exits 0, grants the queue and none of the project's
 *   tables — a misconfigured project reported as granted;
 * - S15 `db push` in a project without schema files installing the queue,
 *   then refusing roles that disagree: exit 1 after a write the refusal
 *   should have come before, as `db migrate` and `db grant` refuse first;
 * - S11 `db push --dry-run` planning the privileges without reading the
 *   queue schema's catalog: an installed queue the app role holds nothing on
 *   shows no statement, and the real push then grants on it.
 *
 * Skipped, with the reason, where the app role cannot connect; a failure under
 * CI. S4 needs an owner that cannot act for the app role, as on a production
 * database: it is skipped, naming that, where the owner is a superuser or
 * inherits the app role (`ownerActsForUnavailability`); a failure under CI,
 * whose roles from scripts/test-services.sh are neither. Each row works in its own schemas and drops them; no role is created or
 * altered. S4 grants the app role CREATE on the test database for its install,
 * and revokes it; so does S12.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import PgBoss from 'pg-boss';
import { QUEUE_SCHEMA_VERSION, queueInstallSql } from '@spfn/core/job';

import { appUrl, OWNER_URL, ownerActsForUnavailability, requireDatabase, twoRoleUnavailability } from './helpers/test-database.js';

const { dbMigrate } = await import('../migrate.js');
const { dbGrant } = await import('../grant.js');
const { dbPush } = await import('../push.js');

const QUEUE = 'i171b_queue';
const PROJECT = 'i171b_app';
const PROJECT_SQL = `CREATE SCHEMA ${PROJECT};\n--> statement-breakpoint\nCREATE TABLE ${PROJECT}.notes (id serial PRIMARY KEY, body text);\n`;
const MANIFEST = `${JSON.stringify({
    $comment: 'Generated from the entities\' appPrivileges() declarations. Do not edit: regenerate.',
    version: 1,
    default: ['select', 'insert', 'update', 'delete'],
    tables: [{ schema: PROJECT, table: 'notes', privileges: 'default' }],
}, null, 4)}\n`;

describe('the queue step', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    const database = decodeURIComponent(new URL(OWNER_URL).pathname.slice(1));
    let twoRoles: string | undefined = 'beforeAll has not run';
    let ownerActsForApp: string | undefined = 'beforeAll has not run';
    let appRole: string;
    let ownerRole: string;
    let root: string;
    let previousCwd: string;
    let output: string[];

    beforeAll(async () =>
    {
        const reachable = await requireDatabase(owner, 'queue step integration tests');

        twoRoles = reachable ? await twoRoleUnavailability(owner, app) : 'PostgreSQL not available';
        appRole = twoRoles === undefined ? (await app`SELECT current_user AS role`)[0].role : '';
        ownerRole = twoRoles === undefined ? (await owner`SELECT current_user AS role`)[0].role : '';
        ownerActsForApp = twoRoles === undefined ? await ownerActsForUnavailability(owner, appRole) : twoRoles;
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
        root = mkdtempSync(join(__dirname, 'tmp-queue-step-'));
        previousCwd = process.cwd();
        process.chdir(root);
        writeProject();
        output = [];
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;
        for (const method of ['log', 'error'] as const)
        {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' ')));
        }
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() =>
    {
        if (twoRoles !== undefined)
        {
            return;
        }

        process.chdir(previousCwd);
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        delete process.env.DATABASE_APP_ROLE;
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    /** The queue schema is dropped by whichever role owns it: the owner cannot drop the app's. */
    async function dropSchemas(): Promise<void>
    {
        await app.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE`).catch(() => undefined);
        for (const schema of [QUEUE, PROJECT, 'drizzle', 'spfn_queue'])
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
    }

    /** The project's migration and manifest, and its package.json with `spfn` as given; null for none. */
    function writeProject(spfn: Record<string, unknown> | null = { jobs: { schema: QUEUE } }): void
    {
        const folder = join(root, 'src', 'server', 'drizzle');

        mkdirSync(join(folder, '20260101000000_init'), { recursive: true });
        writeFileSync(join(folder, '20260101000000_init', 'migration.sql'), PROJECT_SQL);
        writeFileSync(join(folder, 'privileges.json'), MANIFEST);
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'i171b-app', private: true, ...(spfn && { spfn }) }));
    }

    /** The project's entity, for db push: `i171b_app.notes`, the app's default privileges. */
    function writeEntity(): void
    {
        const entities = join(root, 'src', 'server', 'entities');

        mkdirSync(entities, { recursive: true });
        writeFileSync(join(entities, 'notes.entity.ts'),
            "import { pgSchema, serial, text } from 'drizzle-orm/pg-core';\n"
            + `export const app = pgSchema('${PROJECT}');\n`
            + "export const notes = app.table('notes', { id: serial('id').primaryKey(), body: text('body') });\n");
    }

    async function schemaExists(schema: string): Promise<boolean>
    {
        const [{ exists }] = await owner`SELECT to_regnamespace(${schema}) IS NOT NULL AS exists`;

        return exists;
    }

    /** The installed version, or null without a queue schema. */
    async function installedVersion(): Promise<number | null>
    {
        const [{ exists }] = await owner`SELECT to_regnamespace(${QUEUE}) IS NOT NULL AS exists`;

        return exists ? (await owner.unsafe(`SELECT version FROM ${QUEUE}.version`))[0].version : null;
    }

    /** Every owner of the queue schema and of the tables, types and functions in it. */
    async function queueOwners(): Promise<string[]>
    {
        const rows = await owner`
            SELECT pg_get_userbyid(n.nspowner)::text AS owner FROM pg_namespace n WHERE n.nspname = ${QUEUE}
            UNION SELECT pg_get_userbyid(c.relowner)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = ${QUEUE} AND c.relkind IN ('r', 'p')
            UNION SELECT pg_get_userbyid(t.typowner)::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = ${QUEUE} AND t.typtype = 'e'
            UNION SELECT pg_get_userbyid(p.proowner)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = ${QUEUE}`;

        return rows.map(row => row.owner);
    }

    const plain = () => output.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');

    it('S1 a first install leaves everything owned by the owner, and the app runs pg-boss with only what the step granted', async () =>
    {
        await dbMigrate();

        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION);
        expect(await queueOwners()).toEqual([ownerRole]);

        const errors: unknown[] = [];
        const boss = new PgBoss({ connectionString: appUrl(), schema: QUEUE, migrate: false });
        boss.on('error', error => errors.push(error));

        try
        {
            await boss.start();
            await boss.createQueue('i171b-work');
            const id = await boss.send('i171b-work', { n: 1 });
            const [fetched] = await boss.fetch('i171b-work');

            expect(fetched?.id).toBe(id);
        }
        finally
        {
            await boss.stop({ graceful: false, wait: true });
        }

        expect(errors).toEqual([]);
    });

    /** The queue schema at 25, as the owner: pg-boss's install plan, then its rollback plan from 26. */
    async function installAt25(): Promise<void>
    {
        await owner.unsafe(queueInstallSql(QUEUE));
        // pg-boss types the version a string, but finds its migration with `===` on the number
        await owner.unsafe(PgBoss.getRollbackPlans(QUEUE, QUEUE_SCHEMA_VERSION as unknown as string));
    }

    it('S2 a schema at version 25, built from pg-boss\'s install and rollback plans, is migrated to 26', async () =>
    {
        await installAt25();
        const index = () => owner`SELECT to_regclass(${`${QUEUE}.job_i6`}) IS NOT NULL AS present`.then(([row]) => row.present);

        expect(await installedVersion()).toBe(25);
        expect(await index()).toBe(false);

        await dbMigrate();

        expect(plain()).toContain('Migrate pg-boss schema 25 to 26: done');
        expect(await installedVersion()).toBe(26);
        expect(await index()).toBe(true);
    });

    it('S3 the install lost to another connection is ignored, the version read again, and the queue granted', async () =>
    {
        const racer = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });

        try
        {
            await racer.unsafe(queueInstallSql(QUEUE).replace(/COMMIT;\s*$/, ''));

            const migrating = dbMigrate();

            await waitForAdvisoryLockWaiter();
            await racer.unsafe('COMMIT');
            await migrating;
        }
        finally
        {
            await racer.end();
        }

        expect(plain()).toContain('Another connection ran pg-boss\'s install plan first (its lost race); read again:');
        expect(plain()).toContain(`At pg-boss schema ${QUEUE_SCHEMA_VERSION} — nothing to change`);
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION);
        expect(await app.unsafe(`SELECT version FROM ${QUEUE}.version`)).toEqual([{ version: QUEUE_SCHEMA_VERSION }]);
    });

    /** Until a session waits for an advisory lock: the step's install, behind the racer's. */
    async function waitForAdvisoryLockWaiter(): Promise<void>
    {
        for (let attempt = 0; attempt < 200; attempt++)
        {
            const [{ waiting }] = await owner`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;

            if (waiting > 0)
            {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('the step never waited on pg-boss\'s advisory lock');
    }

    it('S4 a queue the app role installed is left alone with the remedy, exit 0, and the project still granted', async ({ skip }) =>
    {
        skip(ownerActsForApp !== undefined, ownerActsForApp);
        await owner.unsafe(`GRANT CREATE ON DATABASE "${database}" TO "${appRole}"`);

        try
        {
            await app.unsafe(queueInstallSql(QUEUE));
        }
        finally
        {
            await owner.unsafe(`REVOKE CREATE ON DATABASE "${database}" FROM "${appRole}"`);
        }

        await dbMigrate();

        expect(process.exit).not.toHaveBeenCalled();
        expect(plain()).toContain(`In queue schema ${QUEUE} (jobs), another role than ${ownerRole}, the owner this step connects as, owns: `);
        expect(plain()).toContain(`REASSIGN OWNED BY ${appRole} TO ${ownerRole};`);
        expect(await queueOwners()).toEqual([appRole]);
        expect(await app.unsafe(`INSERT INTO ${PROJECT}.notes (body) VALUES ('a') RETURNING id`)).toHaveLength(1);
    });

    it('S12 an empty queue schema the app role owns, where the owner may create, is left alone with the remedy', async ({ skip }) =>
    {
        skip(ownerActsForApp !== undefined, ownerActsForApp);

        await owner.unsafe(`GRANT CREATE ON DATABASE "${database}" TO "${appRole}"`);

        try
        {
            await app.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE, CREATE ON SCHEMA ${QUEUE} TO "${ownerRole}"`);
        }
        finally
        {
            await owner.unsafe(`REVOKE CREATE ON DATABASE "${database}" FROM "${appRole}"`);
        }

        await dbMigrate();

        expect(process.exit).not.toHaveBeenCalled();
        expect(plain()).toContain(`In queue schema ${QUEUE} (jobs), another role than ${ownerRole}, the owner this step connects as, owns: `
            + `schema ${QUEUE} (owner ${appRole})`);
        expect(await owner`SELECT to_regclass(${`${QUEUE}.version`}) IS NULL AS absent`).toEqual([{ absent: true }]);
    });

    it('S16 a queue schema the app role owns, holding the owner\'s pg-boss objects at 25, is left alone with the remedy', async ({ skip }) =>
    {
        skip(ownerActsForApp !== undefined, ownerActsForApp);

        await owner.unsafe(`GRANT CREATE ON DATABASE "${database}" TO "${appRole}"`);

        try
        {
            await app.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE, CREATE ON SCHEMA ${QUEUE} TO "${ownerRole}"`);
        }
        finally
        {
            await owner.unsafe(`REVOKE CREATE ON DATABASE "${database}" FROM "${appRole}"`);
        }
        await installAt25();

        await dbMigrate();

        expect(process.exit).not.toHaveBeenCalled();
        expect(plain()).toContain(`In queue schema ${QUEUE} (jobs), another role than ${ownerRole}, the owner this step connects as, owns: `
            + `schema ${QUEUE} (owner ${appRole}). pg-boss installs and migrates the queue only as the one role that owns the schema `
            + 'and every object in it, so nothing is installed, migrated or granted on the queue');
        expect(plain()).toContain(`REASSIGN OWNED BY ${appRole} TO ${ownerRole};`);
        expect(await installedVersion()).toBe(25);
        expect(await app.unsafe(`INSERT INTO ${PROJECT}.notes (body) VALUES ('a') RETURNING id`)).toHaveLength(1);
    });

    it('S5 db grant --dry-run says it would install and writes nothing', async () =>
    {
        await dbGrant({ dryRun: true });

        expect(plain()).toContain(`Would install pg-boss schema ${QUEUE_SCHEMA_VERSION}\n`
            + '   The queue\'s privilege statements follow the install and are not listed: they are planned over the objects it leaves');
        expect(await installedVersion()).toBe(null);
    });

    it('S5b db grant --dry-run on a schema to migrate lists none of the queue\'s statements, which follow the migration', async () =>
    {
        await installAt25();

        await dbGrant({ dryRun: true });

        expect(plain()).toContain(`Would migrate pg-boss schema 25 to ${QUEUE_SCHEMA_VERSION}\n`
            + '   The queue\'s privilege statements follow the migration and are not listed');
        expect(plain()).not.toContain(`"${QUEUE}".`);
        expect(await installedVersion()).toBe(25);
    });

    it('S11 db push --dry-run lists the privilege statements of an installed queue', async () =>
    {
        writeEntity();
        await owner.unsafe(queueInstallSql(QUEUE));

        await dbPush({ dryRun: true });

        expect(plain()).toContain(`At pg-boss schema ${QUEUE_SCHEMA_VERSION} — nothing to change`);
        expect(plain()).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${QUEUE}"."job" TO "${appRole}";`);
        expect(await schemaExists(PROJECT)).toBe(false);
    });

    it('S7 a queue schema holding an object that is not pg-boss\'s is refused before any migration: the project is untouched', async () =>
    {
        await owner.unsafe(`CREATE SCHEMA ${QUEUE}; CREATE TABLE ${QUEUE}.mine (id int)`);

        await expect(dbMigrate()).rejects.toThrow('exit 1');

        expect(plain()).toContain(`Queue schema ${QUEUE} holds objects that are not pg-boss's`);
        expect(await schemaExists(PROJECT)).toBe(false);
    });

    it('S8 db push refuses a queue schema it manages before anything is planned or applied', async () =>
    {
        writeEntity();
        writeProject({ jobs: { schema: PROJECT } });

        await expect(dbPush({ force: true })).rejects.toThrow('exit 1');

        expect(plain()).toContain(`Planning failed — nothing was applied: The jobs declaration names ${PROJECT} as the queue schema`);
        expect(await schemaExists(PROJECT)).toBe(false);
    });

    it('S9 db push in a project without schema files installs the declared queue as the owner and grants it', async () =>
    {
        await dbPush({ force: true });

        expect(plain()).toContain('No schema files found');
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION);
        expect(await queueOwners()).toEqual([ownerRole]);
        expect(await app.unsafe(`SELECT version FROM ${QUEUE}.version`)).toEqual([{ version: QUEUE_SCHEMA_VERSION }]);
    });

    it('S10 db push creates the project table, installs the declared queue as the owner, and grants both', async () =>
    {
        writeEntity();

        await dbPush({ force: true });

        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION);
        expect(await queueOwners()).toEqual([ownerRole]);
        expect(await app.unsafe(`SELECT version FROM ${QUEUE}.version`)).toEqual([{ version: QUEUE_SCHEMA_VERSION }]);
        expect(await app.unsafe(`INSERT INTO ${PROJECT}.notes (body) VALUES ('a') RETURNING id`)).toHaveLength(1);
    });

    it('S13 db grant in a project with jobs and neither manifest nor entity file installs and grants the queue', async () =>
    {
        rmSync(join(root, 'src'), { recursive: true });

        await dbGrant();

        expect(process.exit).not.toHaveBeenCalled();
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION);
        expect(await app.unsafe(`SELECT version FROM ${QUEUE}.version`)).toEqual([{ version: QUEUE_SCHEMA_VERSION }]);
    });

    it('S14 db push and db grant both exit 1 on a jobs project whose drizzle.config.ts schema matches no file', async () =>
    {
        rmSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'drizzle.config.ts'), "export default { dialect: 'postgresql', schema: './src/server/entitiez/*.ts' };\n");

        await expect(dbPush({ force: true })).rejects.toThrow('exit 1');
        await expect(dbGrant()).rejects.toThrow('exit 1');

        expect(plain()).toContain('The project\'s tables cannot be seen');
        expect(await installedVersion()).toBe(null);
    });

    it('S15 db push in a project without schema files refuses roles that disagree before installing the queue', async () =>
    {
        rmSync(join(root, 'src'), { recursive: true });
        process.env.DATABASE_APP_ROLE = 'not_the_app_role';

        await expect(dbPush({ force: true })).rejects.toThrow('exit 1');

        expect(plain()).toContain('Planning failed — nothing was applied: DATABASE_APP_ROLE names the role not_the_app_role');
        expect(await installedVersion()).toBe(null);
    });

    it('S6 without a declaration nothing of the queue is run or printed', async () =>
    {
        writeProject(null);

        await dbMigrate();

        expect(plain()).not.toMatch(/queue|pg-boss/i);
        expect(await owner`SELECT nspname FROM pg_namespace WHERE nspname IN (${QUEUE}, 'spfn_queue')`).toEqual([]);
        expect(await app.unsafe(`INSERT INTO ${PROJECT}.notes (body) VALUES ('a') RETURNING id`)).toHaveLength(1);
    });
});
