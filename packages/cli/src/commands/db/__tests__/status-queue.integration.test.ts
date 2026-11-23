/**
 * `spfn db status` on the declared queue schema, against a real PostgreSQL,
 * two roles (#171)
 *
 * The owner is TEST_DATABASE_URL; the app role, which status connects as, is
 * TEST_APP_DATABASE_URL, or the other role scripts/test-services.sh creates.
 * The owner installs the queue with core's `queueInstallSql` and grants it
 * with the step's plan (`applyAppPrivileges`), as the owner step will. What
 * the row keeps from passing unnoticed:
 *
 * - S1 a missing grant on a queue table and a queue schema older than
 *   pg-boss's — the server's boot refusal until the owner step runs —
 *   reported as nothing: the privileges compared on the managed schemas
 *   only, no queue section; or the human form exiting 1 on it, which the next
 *   spfn db migrate resolves, as it does pending migrations (exit 0); or the
 *   refusal not naming the role that owns the queue, which that command
 *   has to connect as;
 * - S2 a queue schema at a version pg-boss cannot migrate from, or holding a
 *   project's table, which no command resolves: the human form exiting 0 on
 *   it, so a pipeline running status before a deploy goes on to a server
 *   that refuses to start;
 * - S3 an older queue in a schema the app role owns, its pg-boss objects
 *   the owner's: reported as work for spfn db migrate (exit 0), whose owner
 *   step changes nothing in that state, instead of the ownership transfer
 *   the boot names (no step, exit 1), or that transfer, or the report's
 *   owners, leaving out the owner's part;
 * - S4 a project that declares jobs and has no table of its own — no
 *   manifest, no entity file, as `db grant` grants it: its privileges
 *   reported unchecked, so a queue table missing a grant goes unseen.
 *
 * Skipped, with the reason, where the app role cannot connect.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { applyAppPrivileges, DEFAULT_APP_PRIVILEGES, type GrantDb } from '@spfn/core/db';
import { QUEUE_SCHEMA_VERSION, queueInstallSql } from '@spfn/core/job';

import { appUrl, OWNER_URL, requireDatabase, twoRoleUnavailability } from './helpers/test-database.js';

const { dbStatus, DB_STATUS_JSON_MARKER } = await import('../status.js');

const QUEUE = 'i171c_status_queue';

describe('db status on the queue schema', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    let twoRoles: string | undefined = 'beforeAll has not run';
    let appRole: string;
    let ownerRole: string;
    let database: string;
    let root: string;
    let previousCwd: string;
    let output: string[];

    beforeAll(async () =>
    {
        const reachable = await requireDatabase(owner, 'db status queue integration tests');

        twoRoles = reachable ? await twoRoleUnavailability(owner, app) : 'PostgreSQL not available';
        appRole = twoRoles === undefined ? (await app`SELECT current_user AS role`)[0].role : '';
        [{ role: ownerRole, database }] = twoRoles === undefined ? await owner`SELECT current_user AS role, current_database() AS database` : [{ role: '', database: '' }];
    });

    afterAll(async () =>
    {
        if (twoRoles === undefined)
        {
            await dropQueue();
        }
        await Promise.all([owner.end(), app.end()]);
    });

    beforeEach(async ({ skip }) =>
    {
        skip(twoRoles !== undefined, twoRoles);

        await dropQueue();
        root = mkdtempSync(join(__dirname, 'tmp-status-queue-'));
        writeProject(root);
        previousCwd = process.cwd();
        process.chdir(root);
        output = [];
        process.env.DATABASE_URL = appUrl();
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' ')));
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
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    /** The queue schema is dropped by whichever role owns it: the owner cannot drop the app's. */
    async function dropQueue(): Promise<void>
    {
        await app.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE`).catch(() => undefined);
        await owner.unsafe(`DROP SCHEMA IF EXISTS ${QUEUE} CASCADE`);
    }

    /** The owner grants the app role the queue's part, by the step's plan. */
    async function grantQueue(): Promise<void>
    {
        expect((await applyAppPrivileges(drizzle({ client: owner }) as unknown as GrantDb,
            { schemas: [], tables: [], defaults: DEFAULT_APP_PRIVILEGES, queue: { schema: QUEUE } }, { app: appRole })).applied).toBe(true);
    }

    /** The JSON report of `db status --json`. */
    async function jsonReport(): Promise<Record<string, any>>
    {
        output.length = 0;
        await dbStatus({ json: true });

        return JSON.parse(output.find(line => line.startsWith(DB_STATUS_JSON_MARKER))!.slice(DB_STATUS_JSON_MARKER.length));
    }

    it('S1 reports a missing grant on a queue table and a version older than pg-boss\'s, the owner step to run, and exits 0', async () =>
    {
        await owner.unsafe(`${queueInstallSql(QUEUE)}; UPDATE ${QUEUE}.version SET version = ${QUEUE_SCHEMA_VERSION - 1}`);
        expect((await applyAppPrivileges(drizzle({ client: owner }) as unknown as GrantDb,
            { schemas: [], tables: [], defaults: DEFAULT_APP_PRIVILEGES, queue: { schema: QUEUE } }, { app: appRole })).applied).toBe(true);
        await owner.unsafe(`REVOKE INSERT ON ${QUEUE}.job_common FROM ${appRole}`);

        await dbStatus({ json: true });

        const report = JSON.parse(output.find(line => line.startsWith(DB_STATUS_JSON_MARKER))!.slice(DB_STATUS_JSON_MARKER.length));

        expect(report.privileges.drift).toEqual([expect.objectContaining({ schema: QUEUE, table: 'job_common', grantee: appRole, missing: ['insert'], excess: [] })]);
        expect(report.queue).toEqual(expect.objectContaining({
            checked: true,
            schema: QUEUE,
            installed: QUEUE_SCHEMA_VERSION - 1,
            required: QUEUE_SCHEMA_VERSION,
            owners: [ownerRole],
            appOwnsQueue: false,
            start: 'refused',
            refusalStep: 'owner',
        }));
        expect(report.queue.refusal).toContain(`DATABASE_OWNER_URL connecting as ${ownerRole}`);
        await expect(dbStatus()).resolves.toBeUndefined();
    });

    it('S2 a version pg-boss cannot migrate from, and a schema not pg-boss\'s: no step resolves them, and the human form exits 1', async () =>
    {
        await owner.unsafe(`${queueInstallSql(QUEUE)}; UPDATE ${QUEUE}.version SET version = ${QUEUE_SCHEMA_VERSION - 2}`);
        expect((await applyAppPrivileges(drizzle({ client: owner }) as unknown as GrantDb,
            { schemas: [], tables: [], defaults: DEFAULT_APP_PRIVILEGES, queue: { schema: QUEUE } }, { app: appRole })).applied).toBe(true);

        await dbStatus({ json: true });

        const report = JSON.parse(output.find(line => line.startsWith(DB_STATUS_JSON_MARKER))!.slice(DB_STATUS_JSON_MARKER.length));

        expect(report.queue).toEqual(expect.objectContaining({ installed: QUEUE_SCHEMA_VERSION - 2, start: 'refused', refusalStep: null }));
        await expect(dbStatus()).rejects.toThrow('exit 1');

        await owner.unsafe(`DROP SCHEMA ${QUEUE} CASCADE; CREATE SCHEMA ${QUEUE}; CREATE TABLE ${QUEUE}.notes (id integer)`);
        await expect(dbStatus()).rejects.toThrow('exit 1');
    });

    it('S3 an older queue whose schema the app role owns and whose objects the owner owns: the ownership transfer, no step, and exit 1', async () =>
    {
        await owner.unsafe(`GRANT CREATE ON DATABASE "${database}" TO "${appRole}"`);

        try
        {
            await app.unsafe(`CREATE SCHEMA ${QUEUE}; GRANT USAGE, CREATE ON SCHEMA ${QUEUE} TO "${ownerRole}"`);
        }
        finally
        {
            await owner.unsafe(`REVOKE CREATE ON DATABASE "${database}" FROM "${appRole}"`);
        }
        await owner.unsafe(`${queueInstallSql(QUEUE)}; UPDATE ${QUEUE}.version SET version = ${QUEUE_SCHEMA_VERSION - 1}; GRANT SELECT ON ${QUEUE}.version TO "${appRole}"`);

        const report = await jsonReport();

        expect(report.queue).toEqual(expect.objectContaining({
            installed: QUEUE_SCHEMA_VERSION - 1, owner: appRole, owners: [appRole, ownerRole], start: 'refused', refusalStep: null,
        }));
        expect(report.queue.refusal).toContain(`REASSIGN OWNED BY ${appRole}, ${ownerRole} TO <owner>;`);
        await expect(dbStatus()).rejects.toThrow('exit 1');
    });

    it('S4 a project declaring jobs with no table of its own: the queue\'s privileges compared as db grant grants them', async () =>
    {
        rmSync(join(root, 'src'), { recursive: true });
        await owner.unsafe(queueInstallSql(QUEUE));
        await grantQueue();

        expect((await jsonReport()).privileges).toEqual(expect.objectContaining({ checked: true, drift: [] }));
        expect((await jsonReport()).queue).toEqual(expect.objectContaining({ checked: true, start: 'current' }));

        await owner.unsafe(`REVOKE INSERT ON ${QUEUE}.job_common FROM "${appRole}"`);

        expect((await jsonReport()).privileges.drift).toEqual([expect.objectContaining({ schema: QUEUE, table: 'job_common', grantee: appRole, missing: ['insert'] })]);
    });
});

/** A project declaring the queue schema, with an empty privileges manifest, as `spfn db generate` writes one. */
function writeProject(root: string): void
{
    const drizzleDir = join(root, 'src', 'server', 'drizzle');

    mkdirSync(drizzleDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'i171c-status', private: true, spfn: { jobs: { schema: QUEUE } } }));
    writeFileSync(join(drizzleDir, 'privileges.json'), `${JSON.stringify({
        $comment: 'Generated from the entities\' appPrivileges() declarations. Do not edit: regenerate.',
        version: 1,
        default: ['select', 'insert', 'update', 'delete'],
        tables: [],
    }, null, 4)}\n`);
}
