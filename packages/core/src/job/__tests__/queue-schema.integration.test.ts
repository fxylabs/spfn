/**
 * The queue schema's facts against a real PostgreSQL, two roles (#171)
 *
 * The owner is TEST_DATABASE_URL; the app role is the one the tenancy
 * helper's `appDatabaseUrl()` connects as. Each row works in its own schemas
 * and drops them; no role is created or altered. What each row keeps from
 * passing unnoticed:
 *
 * - Q1 pg-boss's multi-statement install plan, run through node-postgres's
 *   `query(text)` without parameters — the driver and call of the CLI's
 *   owner connection (`createPushConnection`), on the simple protocol —
 *   stopping after its first statement, or refused, so the queue is half
 *   there;
 * - Q2 a table of pg-boss's construction plan the queue rule does not cover
 *   (a pg-boss release adding one), or a privilege pg-boss needs that the
 *   rule does not grant: the app refused at run time, in production. The app
 *   role runs pg-boss itself — `migrate: false`, its supervisor and
 *   timekeeper on — with only what the step granted, on a schema the owner
 *   installed: what the row proves is that the grants suffice there.
 *   `initBoss` still starts pg-boss with its default (`migrate: true`); it
 *   moves to the owner-installed path in PR 3;
 * - Q3 the queue schema's state read raw: a 42501 escaping where the app has
 *   no USAGE on the schema (though SELECT on `version`), a missing schema
 *   read as one, or an older version not read through the app's grants;
 * - Q4 a function owned by a role the owner cannot act for missing from
 *   `foreignOwnedObjects`, so the remedy has no `ALTER FUNCTION`; or such a
 *   queue blocking the whole grant step instead of being reported apart.
 *   (rv432 N1) A function of a schema that is not the queue's listed, so
 *   `spfn db push` prints a `REASSIGN OWNED` remedy for a project trigger
 *   function it never alters;
 * - Q5 (rv432 B2, rv432b 1) a pg-boss schema whose `version` table does not
 *   hold exactly one integer — no `version` column, whose name PostgreSQL
 *   then reads as the whole row, a text or bigint one, no row or two — read
 *   as a version: NaN, a string, a bigint pg-boss never writes, the first of
 *   two, which a migration would take for an installed one.
 * - Q6 (i171af2, rv432b 3) a schema of the queue's name that is plainly
 *   another's — a project table and no `version` table, or a view named
 *   `version` — read as nothing installed, where pg-boss would be installed
 *   beside those objects and the queue rule would then cover them.
 * - Q7 (i171af3, rv432c B1) a schema of the queue's name holding a project's
 *   own `version (version integer)` table with one row, alone or beside a
 *   project table, read as pg-boss at that version — so pg-boss's migration
 *   SQL would run there — or a pg-boss install with a project table beside it
 *   read as pg-boss's: the queue rule would then grant the app UPDATE and
 *   DELETE on the project's table.
 * - Q8 (i171af3) a pg-boss schema with a partitioned queue — a table
 *   `create_queue` names at run time, which no plan names — read as not
 *   pg-boss's, refusing an app that created such a queue through `getBoss()`.
 * - Q9 (i171af4, rv432d B1) an install another connection commits while the
 *   state is being read — a second replica booting — read half before and
 *   half after: no schema, yet pg-boss's without a readable `version`, so a
 *   caller asks the owner for a grant that exists, or fails the boot. The
 *   install runs, through a database only the row has, after the first
 *   statement the reader sends.
 * - Q10 (i171af4, rv432d N-a) a project's function of a pg-boss function's
 *   name with other arguments, beside a pg-boss install, read as pg-boss's:
 *   the schema taken for pg-boss's alone while it holds a project's object,
 *   which the queue's ownership remedy would then alter as the queue's.
 * - Q11, Q12 (i171af5, rv432e F1, rv432e-codex 1) a queue schema replaced
 *   after the reader's first statement — by a project's schema holding a
 *   `version` table, or by a pg-boss install of another owner at another
 *   version — read as a state that never existed: the first schema's facts
 *   with the second's version, from which a migration would be planned.
 *   Q12 reads as the owner and lets the app role install, as only a
 *   superuser could hand the app role the owner's schema here.
 * - Q13 (i171af5, rv432e P2, P3) the schema dropped, or the app's USAGE
 *   revoked, after the first statement escaping as a raw 42P01 or 42501,
 *   where a caller handles `QueueSchemaChangedError`.
 * - Q14 (i171af5) the same replacement, by renaming the schema, inside the
 *   reader's second statement: after PostgreSQL resolved and locked
 *   `<schema>.version` and before it took the snapshot — held open by a
 *   REINDEX of `version`'s index, which the planner waits on — read as the
 *   new schema's facts with the renamed one's version.
 *
 * Skipped, with the reason, where the app role cannot connect.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import pg from 'pg';
import PgBoss from 'pg-boss';

import { applyAppPrivileges, DEFAULT_APP_PRIVILEGES, foreignOwnedObjects, type CatalogDb, type GrantDb } from '../../db';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';
import { appDatabaseUrl, twoRoleUnavailability } from '../../db/tenant/__tests__/tenancy-db';
import { QUEUE_SCHEMA_VERSION, QueueSchemaChangedError, queueInstallSql, readQueueSchemaState } from '../queue-schema';

const QUEUE = 'i171a_queue';
const OTHER = 'i171a_other';

describe('the queue schema against two roles', () =>
{
    const appUrl = appDatabaseUrl();
    const appRole = decodeURIComponent(new URL(appUrl).username);
    const owner = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    const ownerDb = drizzle({ client: owner }) as unknown as GrantDb;
    const appDb = drizzle({ client: app });
    const ownerRole = decodeURIComponent(new URL(TEST_DATABASE_URL).username);
    const database = decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.slice(1));
    let unavailable: string | undefined = 'beforeAll has not run';

    const dropSchemas = () => owner.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE; DROP SCHEMA IF EXISTS ${OTHER} CASCADE`);
    const grantQueue = (schema: string) =>
        applyAppPrivileges(ownerDb, { schemas: [], tables: [], defaults: DEFAULT_APP_PRIVILEGES, queue: { schema } }, { app: appRole });
    const grantedInstall = `${queueInstallSql(QUEUE)}; GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`;
    /** The app role installs pg-boss in the queue schema, at the version before pg-boss's, readable by the owner. */
    const appInstall = () => app.unsafe(`${queueInstallSql(QUEUE)}; UPDATE ${QUEUE}.version SET version = ${QUEUE_SCHEMA_VERSION - 1};
        GRANT USAGE ON SCHEMA ${QUEUE} TO ${ownerRole}; GRANT SELECT ON ${QUEUE}.version TO ${ownerRole}`);
    /** Runs `row` with the app role allowed to create schemas, then drops the queue schema as the app role. */
    const withAppCreatingSchemas = async (row: () => Promise<void>) =>
    {
        await owner.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${appRole}`);

        try
        {
            await row();
        }
        finally
        {
            await app.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE`);
            await owner.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM ${appRole}`);
        }
    };
    /** `reader`, on which `ddl` runs once the reader's first statement has returned. */
    const afterFirstStatement = (ddl: () => Promise<unknown>, reader: CatalogDb = appDb): CatalogDb =>
    {
        let statements = 0;

        return {
            execute: async query =>
            {
                const result = await reader.execute(query);

                if (++statements === 1)
                {
                    await ddl();
                }

                return result;
            },
        };
    };

    beforeAll(async () =>
    {
        unavailable = await twoRoleUnavailability(owner, app, appRole);
    });

    beforeEach(async ({ skip }) =>
    {
        skip(unavailable !== undefined, unavailable);
        await dropSchemas();
    });

    afterEach(async () =>
    {
        if (unavailable === undefined)
        {
            await dropSchemas();
        }
    });

    afterAll(async () =>
    {
        await Promise.all([owner.end(), app.end()]);
    });

    it('Q1 the install plan runs whole through node-postgres: every object of pg-boss\'s schema exists, at its version', async () =>
    {
        const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
        await client.connect();
        await client.query(queueInstallSql(QUEUE)).finally(() => client.end());

        const objects = await owner`
            SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${QUEUE} AND c.relkind IN ('r', 'p')
            UNION ALL SELECT t.typname || ' (type)' FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${QUEUE} AND t.typtype = 'e'
            UNION ALL SELECT p.proname || '()' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${QUEUE}
            ORDER BY 1`;

        expect(objects.map(row => row.name)).toEqual([
            'create_queue()', 'delete_queue()', 'job', 'job_common', 'job_state (type)', 'queue', 'schedule', 'subscription', 'version',
        ]);
        expect(await owner.unsafe(`SELECT version FROM ${QUEUE}.version`)).toEqual([{ version: QUEUE_SCHEMA_VERSION }]);
    });

    it('Q2 the queue rule covers every table pg-boss creates, and its grants suffice for the app role to run pg-boss on a schema the owner installed', async () =>
    {
        await owner.unsafe(queueInstallSql(QUEUE));

        expect((await grantQueue(QUEUE)).applied).toBe(true);
        expect(await owner`
            SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${QUEUE} AND c.relkind IN ('r', 'p')
                AND NOT has_table_privilege(${appRole}, c.oid, CASE c.relname WHEN 'version' THEN 'SELECT, UPDATE' ELSE 'SELECT, INSERT, UPDATE, DELETE' END)`).toEqual([]);

        const errors: unknown[] = [];
        const boss = new PgBoss({ connectionString: appUrl, schema: QUEUE, migrate: false });
        boss.on('error', error => errors.push(error));

        try
        {
            await boss.start();
            await boss.createQueue('i171a-work');
            const id = await boss.send('i171a-work', { n: 1 });
            const [fetched] = await boss.fetch('i171a-work');
            await boss.complete('i171a-work', fetched.id);
            await boss.createQueue('i171a-cron');
            await boss.schedule('i171a-cron', '0 3 * * *');

            expect(fetched.id).toBe(id);
            expect((await boss.getJobById('i171a-work', id!))?.state).toBe('completed');
            expect((await boss.getSchedules()).map(schedule => schedule.name)).toEqual(['i171a-cron']);
        }
        finally
        {
            await boss.stop({ graceful: false, wait: true });
        }

        expect(errors).toEqual([]);
    });

    it('Q3 the state of a missing schema, of one without USAGE, and of an older version read through the app\'s grants', async () =>
    {
        const facts = { ownsSchema: false, mayCreateOnDatabase: false, notPgBoss: false };

        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual({ ...facts, schema: QUEUE, exists: false, ownsObjects: true, ownedBy: [], owners: [], bootstrapOwned: [], usage: false, version: null });

        await owner.unsafe(`${queueInstallSql(QUEUE)}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual({ ...facts, schema: QUEUE, exists: true, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: false });

        await owner.unsafe(`UPDATE ${QUEUE}.version SET version = ${QUEUE_SCHEMA_VERSION - 1}`);
        await grantQueue(QUEUE);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual({ ...facts, schema: QUEUE, exists: true, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, version: QUEUE_SCHEMA_VERSION - 1 });
    });

    it('Q4 a queue function the app role owns is in foreignOwnedObjects, and only there; the grant step reports the queue apart without blocking', async () =>
    {
        await owner.unsafe(`CREATE SCHEMA ${OTHER}; GRANT USAGE, CREATE ON SCHEMA ${OTHER} TO ${appRole}`);
        await app.unsafe(`CREATE FUNCTION ${OTHER}.twice(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n * 2'`);

        expect((await foreignOwnedObjects(ownerDb, [OTHER], OTHER)).map(({ kind, object, owner: by }) => ({ kind, object, owner: by }))).toEqual([
            { kind: 'FUNCTION', object: `${OTHER}.twice(n integer)`, owner: appRole },
        ]);
        expect(await foreignOwnedObjects(ownerDb, [OTHER])).toEqual([]);

        const run = await grantQueue(OTHER);

        expect(run.plan.blocked).toBe(false);
        expect(run.plan.queue?.foreignOwned).toEqual([{ schema: OTHER, name: 'twice', kind: 'function', arguments: 'n integer', owner: appRole }]);
        expect(run.plan.statements).toEqual([]);
    });

    it('Q5 a pg-boss schema whose version table does not hold exactly one integer is read as not pg-boss\'s, with no version', async () =>
    {
        const notPgBoss = { schema: QUEUE, exists: true, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, mayCreateOnDatabase: false, notPgBoss: true };
        const install = (change: string) => owner.unsafe(`
            DROP SCHEMA IF EXISTS ${QUEUE} CASCADE; ${queueInstallSql(QUEUE)}; ${change};
            GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);

        await install(`ALTER TABLE ${QUEUE}.version DROP COLUMN version`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await install(`ALTER TABLE ${QUEUE}.version ALTER COLUMN version TYPE text`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await install(`ALTER TABLE ${QUEUE}.version ALTER COLUMN version TYPE bigint`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await install(`DELETE FROM ${QUEUE}.version`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await install(`INSERT INTO ${QUEUE}.version VALUES (${QUEUE_SCHEMA_VERSION - 1})`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);
    });

    it('Q6 a schema of the queue\'s name holding objects but no version table is read as not pg-boss\'s, not as nothing installed', async () =>
    {
        const notPgBoss = { schema: QUEUE, exists: true, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, mayCreateOnDatabase: false, notPgBoss: true };

        await owner.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; CREATE TABLE ${QUEUE}.ledger (id integer)`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await owner.unsafe(`DROP TABLE ${QUEUE}.ledger; CREATE VIEW ${QUEUE}.version AS SELECT ${QUEUE_SCHEMA_VERSION} AS version`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);
    });

    it('Q7 a project\'s own version(version integer) table, alone or beside its tables, and a pg-boss install beside a project table, are not pg-boss\'s', async () =>
    {
        const notPgBoss = { schema: QUEUE, exists: true, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, mayCreateOnDatabase: false, notPgBoss: true };

        await owner.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole};
            CREATE TABLE ${QUEUE}.version (version integer); INSERT INTO ${QUEUE}.version VALUES (${QUEUE_SCHEMA_VERSION});
            GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await owner.unsafe(`CREATE TABLE ${QUEUE}.ledger (id integer)`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);

        await owner.unsafe(`DROP SCHEMA ${QUEUE} CASCADE; ${queueInstallSql(QUEUE)}; CREATE TABLE ${QUEUE}.ledger (id integer);
            GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual(notPgBoss);
    });

    it('Q8 a pg-boss schema with a partitioned queue is pg-boss\'s, at its version', async () =>
    {
        await owner.unsafe(`${queueInstallSql(QUEUE)}; SELECT ${QUEUE}.create_queue('i171a-part', '{"policy": "standard", "partition": true}');
            GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);

        expect(await owner`SELECT count(*)::int AS partitions FROM pg_class WHERE relnamespace = ${QUEUE}::regnamespace AND relname ~ '^j[0-9a-f]{56}$'`).toEqual([{ partitions: 1 }]);
        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual({
            schema: QUEUE, exists: true, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, mayCreateOnDatabase: false, notPgBoss: false, version: QUEUE_SCHEMA_VERSION,
        });
    });

    it('Q9 an install another connection commits after the reader\'s first statement reads as before it: no schema, nothing installed', async () =>
    {
        expect(await readQueueSchemaState(afterFirstStatement(() => owner.unsafe(grantedInstall)), QUEUE)).toEqual({
            schema: QUEUE, exists: false, ownsSchema: false, ownsObjects: true, ownedBy: [], owners: [], bootstrapOwned: [], usage: false, mayCreateOnDatabase: false, notPgBoss: false, version: null,
        });
    });

    it('Q10 a pg-boss install beside a project function of a pg-boss function\'s name with other arguments is not pg-boss\'s', async () =>
    {
        await owner.unsafe(`${queueInstallSql(QUEUE)}; CREATE FUNCTION ${QUEUE}.create_queue(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n';
            GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);

        expect(await readQueueSchemaState(appDb, QUEUE)).toEqual({
            schema: QUEUE, exists: true, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, mayCreateOnDatabase: false, notPgBoss: true,
        });
    });

    it('Q11 a pg-boss install replaced by a project\'s schema with a version table after the reader\'s first statement reads as one or the other', async () =>
    {
        const facts = { schema: QUEUE, exists: true, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [ownerRole], bootstrapOwned: [], usage: true, mayCreateOnDatabase: false };
        await owner.unsafe(grantedInstall);

        const state = await readQueueSchemaState(afterFirstStatement(() => owner.unsafe(`DROP SCHEMA ${QUEUE} CASCADE; CREATE SCHEMA ${QUEUE};
            CREATE TABLE ${QUEUE}.version (version integer); INSERT INTO ${QUEUE}.version VALUES (99);
            GRANT USAGE ON SCHEMA ${QUEUE} TO ${appRole}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`)), QUEUE);

        expect([{ ...facts, notPgBoss: false, version: QUEUE_SCHEMA_VERSION }, { ...facts, notPgBoss: true }]).toContainEqual(state);
    });

    it('Q12 a pg-boss install dropped and re-installed by another role at an older version after the reader\'s first statement reads as one or the other', () =>
        withAppCreatingSchemas(async () =>
        {
            const facts = { schema: QUEUE, exists: true, usage: true, mayCreateOnDatabase: true, notPgBoss: false, bootstrapOwned: [] };
            await owner.unsafe(queueInstallSql(QUEUE));

            const state = await readQueueSchemaState(afterFirstStatement(async () =>
            {
                await owner.unsafe(`DROP SCHEMA ${QUEUE} CASCADE`);
                await appInstall();
            }, ownerDb), QUEUE);

            expect([
                { ...facts, ownsSchema: true, ownsObjects: true, ownedBy: [ownerRole], owners: [ownerRole], version: QUEUE_SCHEMA_VERSION },
                { ...facts, ownsSchema: false, ownsObjects: false, ownedBy: [], owners: [appRole], version: QUEUE_SCHEMA_VERSION - 1 },
            ]).toContainEqual(state);
        }));

    it('Q13 a pg-boss install dropped, or its USAGE revoked, after the reader\'s first statement throws QueueSchemaChangedError', async () =>
    {
        await owner.unsafe(grantedInstall);
        await expect(readQueueSchemaState(afterFirstStatement(() => owner.unsafe(`DROP SCHEMA ${QUEUE} CASCADE`)), QUEUE)).rejects.toThrow(QueueSchemaChangedError);

        await owner.unsafe(grantedInstall);
        await expect(readQueueSchemaState(afterFirstStatement(() => owner.unsafe(`REVOKE USAGE ON SCHEMA ${QUEUE} FROM ${appRole}`)), QUEUE)).rejects.toThrow(QueueSchemaChangedError);
    });

    it('Q14 a pg-boss schema renamed, and pg-boss installed under its name by another role, while the reader\'s second statement is being planned throws QueueSchemaChangedError', () =>
        withAppCreatingSchemas(async () =>
        {
            const reader = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
            const locker = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
            await owner.unsafe(queueInstallSql(QUEUE));
            const [{ pid }] = await reader`SELECT pg_backend_pid() AS pid`;
            let read: Promise<unknown> = Promise.resolve();

            await locker.begin(async reindexing =>
            {
                await reindexing.unsafe(`REINDEX INDEX ${QUEUE}.version_pkey`);
                read = readQueueSchemaState(drizzle({ client: reader }), QUEUE).then(() => undefined, (error: unknown) => error);

                while ((await owner`SELECT FROM pg_locks WHERE pid = ${pid} AND NOT granted`).length === 0)
                {
                    await new Promise(resolve => setTimeout(resolve, 20));
                }

                await owner.unsafe(`ALTER SCHEMA ${QUEUE} RENAME TO ${OTHER}`);
                await appInstall();
            }).finally(() => Promise.all([reader.end(), locker.end()]));

            expect(await read).toBeInstanceOf(QueueSchemaChangedError);
        }));
});
