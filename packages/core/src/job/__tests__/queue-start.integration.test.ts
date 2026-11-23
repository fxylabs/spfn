/**
 * The boot rule for the queue schema against a real PostgreSQL, two roles (#171)
 *
 * The owner is TEST_DATABASE_URL; the app role is the one the tenancy
 * helper's `appDatabaseUrl()` connects as, and `initBoss` runs as it. Each
 * row works in its own schema and drops it; the app role's CREATE on the
 * database is granted for a row and revoked after it. A structure statement
 * the app role sends is seen where pg-boss sends every statement
 * (`executeSql` of its pool), and ownership is read back from the catalog.
 * What each row keeps from passing unnoticed:
 *
 * - B1 an owner-installed queue at pg-boss's version, with the app role
 *   allowed to create schemas: the app sending a structure statement (#171
 *   again), or refused; or no warning that package.json (here core's)
 *   does not declare the schema, which the owner step then never migrates;
 * - B2 nothing installed and the app role allowed to create schemas — one
 *   role, `spfn dev` with one URL — refused instead of installed;
 * - B3 an older queue the app role owns — one role, or an app that
 *   installed it itself — refused, or started unmigrated; or warned on every
 *   boot about a declaration it does not need;
 * - B4 an older queue the owner installed: the app migrating it — its
 *   CREATE on the database taken for the right to — or failing on a raw
 *   "must be owner" instead of the versions and the command;
 * - B5 nothing installed and the app role not allowed to create schemas: a
 *   raw 42501 from pg-boss's install instead of the command;
 * - B6 a queue newer than pg-boss's — a rollback, an old pod in a rolling
 *   deploy — refused by pg-boss's own `migrate: false` check, taking the old
 *   pods down; or migrated;
 * - B7 the refusal reached only after the server listens: `startServer`
 *   serving a port with no job queue;
 * - B8 a schema of the queue's name holding a project's table, with the app
 *   role allowed to create schemas: pg-boss installed beside it;
 * - B9 an older queue in a schema the app role owns, its objects the
 *   owner's — a superuser owner step, or a schema created `AUTHORIZATION
 *   app`: the app sending pg-boss's migration, which PostgreSQL refuses
 *   with a raw "must be owner"; or the boot naming `spfn db migrate`, whose
 *   owner step changes nothing in that state, instead of the ownership
 *   transfer (`step` null);
 * - B14 the reverse — an older queue in the owner's schema whose objects the
 *   app role installed: the boot naming `spfn db migrate`, which changes
 *   nothing there either, instead of the ownership transfer;
 * - B15 the B9 queue at pg-boss's version: a warning to declare the schema
 *   for the owner step, which acts on nothing there until ownership moves;
 * - B10 a newer queue the owner moves back to an older version between the
 *   boot's read and pg-boss's first statement: the boot failing on
 *   PostgreSQL's raw "must be owner" instead of the refusal the new state
 *   calls for; or the pg-boss instance that failed left with its pool open;
 * - B11 a current queue the owner moves on to a newer version in that
 *   window: the boot failing on pg-boss's "requires migrations" though the
 *   new state starts; or the instance that failed, or the one that ran the
 *   structure step, left with its pool open or an interval running beside
 *   the running instance;
 * - B13 pg-boss's install committed, and a later statement of pg-boss's
 *   start failing: that failure taken for a changed schema and a second
 *   instance started beside a half-started first — its pool open, its
 *   manager's and supervisor's intervals running, which pg-boss's `stop()`
 *   does not end on an instance whose start failed;
 * - B12 a queue the app role owns, below the oldest version pg-boss 11.1.2
 *   migrates from (25): pg-boss applying its 25→26 statements to it and
 *   stamping it 26.
 *
 * Skipped, with the reason, where the app role cannot connect.
 */

import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import PgBoss from 'pg-boss';

import { applyAppPrivileges, DEFAULT_APP_PRIVILEGES, queueOwnershipTransfer, type GrantDb } from '../../db';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';
import { appDatabaseUrl, twoRoleUnavailability } from '../../db/tenant/__tests__/tenancy-db';
import { closeDatabase } from '../../db';
import { logger } from '@spfn/core/logger';
import { initBoss, stopBoss } from '../boss';
import { decideQueueStart } from '../queue-start';
import { defineJobRouter } from '../job-router';
import { job } from '../job-builder';
import { JobQueueSchemaError, QUEUE_SCHEMA_VERSION, QueueSchemaVersionError, queueInstallSql } from '../queue-schema';
import { resetShutdownManager } from '../../server/shutdown-manager';
import { startServer } from '../../server/start-server';

const { serve } = vi.hoisted(() => ({
    serve: vi.fn(() => ({ close: (callback: () => void) => callback(), requestTimeout: 0, keepAliveTimeout: 0, headersTimeout: 0 })),
}));

vi.mock('@hono/node-server', () => ({ serve }));

const QUEUE = 'i171c_queue';

/** pg-boss's pool, through which it sends every statement: required as pg-boss requires it. */
const PgBossDb: { prototype: { executeSql(text: string, values?: unknown[]): Promise<unknown> } } = createRequire(import.meta.url)('pg-boss/src/db.js');

/** A statement that changes structure: pg-boss's install and migration plans are made of these. */
const STRUCTURE = /\b(CREATE|ALTER|DROP)\s+(SCHEMA|TABLE|UNIQUE\s+INDEX|INDEX|TYPE|FUNCTION|OR\s+REPLACE)\b/i;

describe('the boot rule on the queue schema, two roles', () =>
{
    const appUrl = appDatabaseUrl();
    const appRole = decodeURIComponent(new URL(appUrl).username);
    const ownerRole = decodeURIComponent(new URL(TEST_DATABASE_URL).username);
    const database = decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.slice(1));
    const owner = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl, { max: 1, onnotice: () => undefined });
    const ownerDb = drizzle({ client: owner }) as unknown as GrantDb;
    let unavailable: string | undefined = 'beforeAll has not run';
    let sent: string[];
    let warnings: string[];
    /** Run once, before pg-boss's first statement: the queue schema changed after the boot rule read it. */
    let beforePgBossStatement: (() => Promise<unknown>) | undefined;
    /** The first pg-boss statement matching it fails, as a statement PostgreSQL refuses would. */
    let failPgBossStatement: RegExp | undefined;
    /** Each pg-boss instance started, with the intervals set while its start ran, and every interval cleared. */
    let instances: { boss: PgBoss; intervals: unknown[] }[];
    let cleared: Set<unknown>;

    const dropQueue = async () =>
    {
        await app.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE`).catch(() => undefined);
        await owner.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE`);
    };
    /** The owner installs the queue and grants the app role the queue's part, as PR 1's rows do. */
    const ownerInstall = async (version = QUEUE_SCHEMA_VERSION) =>
    {
        await owner.unsafe(queueInstallSql(QUEUE));
        await setVersion(owner, version);
        expect((await applyAppPrivileges(ownerDb, { schemas: [], tables: [], defaults: DEFAULT_APP_PRIVILEGES, queue: { schema: QUEUE } }, { app: appRole })).applied).toBe(true);
    };
    /** A real older schema: pg-boss's own rollback plan from its version; a newer one is its version table moved on. */
    const setVersion = async (sql: postgres.Sql, version: number) =>
    {
        if (version === QUEUE_SCHEMA_VERSION - 1)
        {
            // pg-boss's rollback store finds the version with ===: a number, whatever its types say
            await sql.unsafe(PgBoss.getRollbackPlans(QUEUE, QUEUE_SCHEMA_VERSION as unknown as string));
        }
        else if (version !== QUEUE_SCHEMA_VERSION)
        {
            await sql.unsafe(`UPDATE ${QUEUE}.version SET version = ${version}`);
        }
    };
    const appMayCreateSchemas = () => owner.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${appRole}`);
    const installedVersion = async (sql = owner) => (await sql.unsafe(`SELECT version FROM ${QUEUE}.version`))[0]?.version;
    /** Every object of the queue schema whose owner is not `role`. */
    const ownedOtherThan = (role: string) => owner`
        SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${QUEUE} AND pg_get_userbyid(c.relowner) <> ${role}
        UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${QUEUE} AND pg_get_userbyid(p.proowner) <> ${role}
        UNION ALL SELECT n.nspname FROM pg_namespace n WHERE n.nspname = ${QUEUE} AND pg_get_userbyid(n.nspowner) <> ${role}`;
    const structureSent = () => sent.filter(text => STRUCTURE.test(text));
    /** Whether `started` was stopped: its pool ended, and none of the intervals its start set still running. */
    const stoppedWhole = (started: { boss: PgBoss; intervals: unknown[] }) => ({
        poolEnded: (started.boss.getDb() as unknown as { pool?: { ended: boolean } }).pool?.ended === true,
        intervalsLeft: started.intervals.filter(handle => !cleared.has(handle)).length,
    });
    const declarationWarnings = () => warnings.filter(line => line.includes('package.json'));
    /** The transfer the boot names where ownership is split, naming every role that owns part: core's, which the owner step prints too. */
    const ownershipRemedy = (owners: string[]) => `Make that the role DATABASE_OWNER_URL connects as (<owner> below), then start again:\n${queueOwnershipTransfer(owners, '<owner>')}`;

    beforeAll(async () =>
    {
        unavailable = await twoRoleUnavailability(owner, app, appRole);
    });

    beforeEach(async ({ skip }) =>
    {
        skip(unavailable !== undefined, unavailable);
        await dropQueue();
        sent = [];
        warnings = [];
        beforePgBossStatement = undefined;
        failPgBossStatement = undefined;
        instances = [];
        cleared = new Set();

        const executeSql = PgBossDb.prototype.executeSql;

        vi.spyOn(PgBossDb.prototype, 'executeSql').mockImplementation(async function (this: unknown, text: string, values?: unknown[])
        {
            const change = beforePgBossStatement;
            const fails = failPgBossStatement?.test(text) === true;

            beforePgBossStatement = undefined;
            failPgBossStatement = fails ? undefined : failPgBossStatement;
            await change?.();
            sent.push(text);

            return fails ? Promise.reject(new Error('i171c: injected failure')) : executeSql.call(this, text, values);
        });
        watchInstances();

        const warn = Object.getPrototypeOf(logger).warn;

        vi.spyOn(Object.getPrototypeOf(logger), 'warn').mockImplementation(function (this: unknown, ...args: unknown[])
        {
            warnings.push(String(args[0]));

            return warn.apply(this, args);
        });
    });

    afterEach(async () =>
    {
        if (unavailable !== undefined)
        {
            return;
        }

        await stopBoss();
        vi.restoreAllMocks();
        await owner.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM ${appRole}`);
        await dropQueue();
    });

    afterAll(async () =>
    {
        await Promise.all([owner.end(), app.end()]);
    });

    /** Record each pg-boss instance's start, the intervals set while it runs, and each interval cleared. */
    function watchInstances(): void
    {
        const { setInterval: set, clearInterval: clear } = globalThis;
        const start = PgBoss.prototype.start;
        let starting: { boss: PgBoss; intervals: unknown[] } | undefined;

        vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof set>) =>
        {
            const handle = set(...args);

            starting?.intervals.push(handle);

            return handle;
        }) as typeof set);
        vi.spyOn(globalThis, 'clearInterval').mockImplementation((handle?: Parameters<typeof clear>[0]) =>
        {
            cleared.add(handle);
            clear(handle);
        });
        vi.spyOn(PgBoss.prototype, 'start').mockImplementation(async function (this: PgBoss)
        {
            starting = { boss: this, intervals: [] };
            instances.push(starting);

            try
            {
                return await start.call(this);
            }
            finally
            {
                starting = undefined;
            }
        });
    }

    it('B1 owner-installed at pg-boss\'s version: pg-boss starts as the app role, which sends no structure statement and owns nothing', async () =>
    {
        await ownerInstall();
        await appMayCreateSchemas();

        const boss = await initBoss({ connectionString: appUrl, schema: QUEUE });

        await boss.createQueue('i171c-b1');
        expect(await boss.send('i171c-b1', { n: 1 })).toEqual(expect.any(String));
        expect(sent.length).toBeGreaterThan(0);
        expect(structureSent()).toEqual([]);
        expect(await ownedOtherThan(ownerRole)).toEqual([]);
        expect(declarationWarnings()).toEqual([expect.stringContaining('package.json declares no jobs')]);
    });

    it('B2 nothing installed, the app role may create schemas: pg-boss installs the queue as it', async () =>
    {
        await appMayCreateSchemas();

        await initBoss({ connectionString: appUrl, schema: QUEUE });

        expect(await installedVersion(app)).toBe(QUEUE_SCHEMA_VERSION);
        expect(await ownedOtherThan(appRole)).toEqual([]);
    });

    it('B3 older, owned by the app role: pg-boss migrates it as its owner', async () =>
    {
        await appMayCreateSchemas();
        await app.unsafe(queueInstallSql(QUEUE));
        await setVersion(app, QUEUE_SCHEMA_VERSION - 1);
        await app.unsafe(`GRANT USAGE ON SCHEMA ${QUEUE} TO ${ownerRole}; GRANT SELECT ON ${QUEUE}.version TO ${ownerRole}`);

        await initBoss({ connectionString: appUrl, schema: QUEUE });

        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION);
        expect(declarationWarnings()).toEqual([]);
    });

    it('B4 older, installed by the owner: refused with both versions and the command, no structure statement sent, though the app may create schemas', async () =>
    {
        await ownerInstall(QUEUE_SCHEMA_VERSION - 1);
        await appMayCreateSchemas();

        const refused = initBoss({ connectionString: appUrl, schema: QUEUE });

        await expect(refused).rejects.toBeInstanceOf(JobQueueSchemaError);
        await expect(refused).rejects.toThrow(`Queue schema ${QUEUE} is at pg-boss schema version ${QUEUE_SCHEMA_VERSION - 1}; `
            + `pg-boss 11.1.2 in this build needs ${QUEUE_SCHEMA_VERSION}, and role ${appRole} does not own the schema and every object in it, `
            + 'so the app does not migrate it. '
            + `Run spfn db migrate (or spfn db push) with DATABASE_OWNER_URL connecting as ${ownerRole}, which owns the schema and every object in it, `
            + `or as a role that inherits ${ownerRole}, then start again; if that command reports the queue as another role's, its transfer lines say what to move.`);
        expect(sent).toEqual([]);
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION - 1);
    });

    it('B5 nothing installed, the app role may not create schemas: refused with the command, nothing sent', async () =>
    {
        const refused = initBoss({ connectionString: appUrl, schema: QUEUE });

        await expect(refused).rejects.toBeInstanceOf(JobQueueSchemaError);
        await expect(refused).rejects.toThrow(`Queue schema ${QUEUE} is not installed, and role ${appRole} may not create schemas in the database, `
            + 'so the app does not install it. Run spfn db migrate (or spfn db push) with DATABASE_OWNER_URL set, then start again.');
        expect(sent).toEqual([]);
        expect(await owner`SELECT FROM pg_namespace WHERE nspname = ${QUEUE}`).toHaveLength(0);
    });

    it('B6 newer than pg-boss\'s: starts with a warning, sends no structure statement, leaves the version', async () =>
    {
        await ownerInstall(QUEUE_SCHEMA_VERSION + 1);

        const boss = await initBoss({ connectionString: appUrl, schema: QUEUE });

        await boss.createQueue('i171c-b6');
        expect(await boss.send('i171c-b6', { n: 1 })).toEqual(expect.any(String));
        expect(warnings.filter(line => line.includes(`newer than the ${QUEUE_SCHEMA_VERSION}`))).toHaveLength(1);
        expect(structureSent()).toEqual([]);
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION + 1);
    });

    it('B7 startServer refuses before the server listens', async () =>
    {
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
        vi.stubEnv('DATABASE_URL', appUrl);

        try
        {
            const started = await startServer({
                host: '127.0.0.1',
                port: 39994,
                infrastructure: { database: true, redis: false },
                database: { provider: { kind: 'test-provider', write: { execute: async () => undefined } as never, close: async () => undefined } },
                jobs: defineJobRouter({ b7: job('i171c-b7').handler(async () => undefined) }),
                jobsConfig: { schema: QUEUE },
            }).then(() => 'listening', (error: unknown) => error);

            expect(serve).not.toHaveBeenCalled();
            expect(started).toBeInstanceOf(JobQueueSchemaError);
        }
        finally
        {
            vi.unstubAllEnvs();
            resetShutdownManager();
            await closeDatabase();
        }
    });

    it('B8 a schema of the queue\'s name holding a project\'s table: refused, nothing installed beside it', async () =>
    {
        await appMayCreateSchemas();
        await app.unsafe(`CREATE SCHEMA ${QUEUE}; CREATE TABLE ${QUEUE}.notes (id integer)`);

        await expect(initBoss({ connectionString: appUrl, schema: QUEUE })).rejects.toThrow(`Queue schema ${QUEUE} holds objects that are not pg-boss's`);
        expect(sent).toEqual([]);
        expect(await owner`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${QUEUE} AND c.relkind = 'r'`)
            .toEqual([{ relname: 'notes' }]);
    });

    it('B9 older, the schema the app role\'s, its objects the owner\'s: refused with the ownership transfer and no step, nothing sent', async () =>
    {
        await appMayCreateSchemas();
        await app.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE, CREATE ON SCHEMA ${QUEUE} TO ${ownerRole}`);
        await owner.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM ${appRole}`);
        await owner.unsafe(queueInstallSql(QUEUE));
        await setVersion(owner, QUEUE_SCHEMA_VERSION - 1);
        await owner.unsafe(`GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);

        const refused = await initBoss({ connectionString: appUrl, schema: QUEUE }).then(() => undefined, (error: unknown) => error as JobQueueSchemaError);

        expect(refused).toBeInstanceOf(JobQueueSchemaError);
        expect(refused?.step).toBeNull();
        expect(refused?.message).toContain(`${appRole}, ${ownerRole} own the schema or objects in it (${appRole} being role ${appRole} or a role it inherits)`);
        expect(refused?.message).toContain(ownershipRemedy([appRole, ownerRole]));
        expect(refused?.message).not.toContain('Run spfn db migrate');
        expect(sent).toEqual([]);
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION - 1);
    });

    it('B14 older, the schema the owner\'s, its objects the app role\'s: refused with the ownership transfer and no step, nothing sent', async () =>
    {
        await owner.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE, CREATE ON SCHEMA ${QUEUE} TO ${appRole}`);
        await appMayCreateSchemas();
        await app.unsafe(queueInstallSql(QUEUE));
        await setVersion(app, QUEUE_SCHEMA_VERSION - 1);
        await owner.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM ${appRole}`);

        const refused = await initBoss({ connectionString: appUrl, schema: QUEUE }).then(() => undefined, (error: unknown) => error as JobQueueSchemaError);

        expect(refused).toBeInstanceOf(JobQueueSchemaError);
        expect(refused?.step).toBeNull();
        expect(refused?.message).toContain(ownershipRemedy([ownerRole, appRole]));
        expect(sent).toEqual([]);
        expect(await installedVersion(app)).toBe(QUEUE_SCHEMA_VERSION - 1);
    });

    it('B15 current, the schema the app role\'s, its objects the owner\'s: starts with no warning to declare it for the owner step', async () =>
    {
        await appMayCreateSchemas();
        await app.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE, CREATE ON SCHEMA ${QUEUE} TO ${ownerRole}`);
        await owner.unsafe(`REVOKE CREATE ON DATABASE ${database} FROM ${appRole}`);
        await owner.unsafe(`${queueInstallSql(QUEUE)}; GRANT SELECT ON ${QUEUE}.version TO ${appRole}`);

        expect((await decideQueueStart(appUrl, QUEUE)).kind).toBe('current');
        expect(declarationWarnings()).toEqual([]);
    });

    it('B10 newer when read, older before pg-boss\'s first statement: refused as the older state is, ownership and version unchanged', async () =>
    {
        await ownerInstall(QUEUE_SCHEMA_VERSION + 1);
        beforePgBossStatement = () => setVersion(owner, QUEUE_SCHEMA_VERSION - 1);

        await expect(initBoss({ connectionString: appUrl, schema: QUEUE })).rejects.toThrow(JobQueueSchemaError);
        expect(await ownedOtherThan(ownerRole)).toEqual([]);
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION - 1);
        expect(instances.map(stoppedWhole)).toEqual([{ poolEnded: true, intervalsLeft: 0 }]);
    });

    it('B11 current when read, newer before pg-boss\'s first statement: starts, the version left', async () =>
    {
        await ownerInstall();
        beforePgBossStatement = () => setVersion(owner, QUEUE_SCHEMA_VERSION + 1);

        const boss = await initBoss({ connectionString: appUrl, schema: QUEUE });

        expect(structureSent()).toEqual([]);
        expect(await installedVersion()).toBe(QUEUE_SCHEMA_VERSION + 1);
        expect(instances.at(-1)?.boss).toBe(boss);
        expect(instances.slice(0, -1).map(stoppedWhole)).toEqual([{ poolEnded: true, intervalsLeft: 0 }, { poolEnded: true, intervalsLeft: 0 }]);
    });

    it('B13 the install committed and a later statement of pg-boss\'s start failing: the installing instance stopped whole, no second start on the failure', async () =>
    {
        await appMayCreateSchemas();
        failPgBossStatement = /__pgboss__send-it/;

        const failed = await initBoss({ connectionString: appUrl, schema: QUEUE }).then(() => undefined, (error: unknown) => error as Error);
        const running = instances.at(-1);

        // the running instance's failed start: pg-boss's stop() does nothing on it, so its pool and intervals are ended here
        await (running?.boss.getDb() as unknown as { close(): Promise<void> } | undefined)?.close();
        running?.intervals.forEach(handle => clearInterval(handle as NodeJS.Timeout));
        expect(failed).toBeInstanceOf(Error);
        expect(failed?.message).toBe('i171c: injected failure');
        expect(await installedVersion(app)).toBe(QUEUE_SCHEMA_VERSION);
        expect(instances).toHaveLength(2);
        expect(stoppedWhole(instances[0])).toEqual({ poolEnded: true, intervalsLeft: 0 });
    });

    it('B12 below the oldest version pg-boss migrates from, owned by the app role: refused with both versions and the step through, nothing sent', async () =>
    {
        await appMayCreateSchemas();
        await app.unsafe(`${queueInstallSql(QUEUE)}; UPDATE ${QUEUE}.version SET version = ${QUEUE_SCHEMA_VERSION - 2}`);

        const refused = initBoss({ connectionString: appUrl, schema: QUEUE });

        await expect(refused).rejects.toBeInstanceOf(QueueSchemaVersionError);
        await expect(refused).rejects.toThrow(`Queue schema ${QUEUE} is at pg-boss schema version ${QUEUE_SCHEMA_VERSION - 2}; pg-boss 11.1.2 needs `
            + `${QUEUE_SCHEMA_VERSION}: it migrates from version ${QUEUE_SCHEMA_VERSION - 1} on. Migrate it to version ${QUEUE_SCHEMA_VERSION - 1} first, `
            + 'with the pg-boss release that runs on that schema version.');
        expect(sent).toEqual([]);
        expect(await installedVersion(app)).toBe(QUEUE_SCHEMA_VERSION - 2);
    });
});
