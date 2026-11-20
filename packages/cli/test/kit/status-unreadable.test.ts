/**
 * A migration status nobody could read is not "nothing pending" (#405).
 *
 * The chain is real from the status read to the operation's answer: `spfn db
 * status --json` runs with the status read throwing PostgreSQL's error the way
 * drizzle wraps it, its printed report is handed to the Kit's database port as
 * a child's stdout, and the operation runs against that port — and, for the
 * `db-status` gate, against the real gate port sharing it. Only the child
 * process is replaced.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationStatus } from '@spfn/core/db';

import type { KitOperationResult } from '../../src/kit/events.js';
import type { DatabasePort } from '../../src/kit/ports.js';
import type { FakeKitWorld as FakeKitWorldType } from './fake-world.js';

vi.mock('@spfn/core/db', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('@spfn/core/db')>();

    return {
        ...original,
        collectMigrationStatus: vi.fn(),
    };
});

const { collectMigrationStatus } = await import('@spfn/core/db');
const { DB_STATUS_JSON_MARKER, dbStatus, unreadableStatusReport } = await import('../../src/commands/db/status.js');
const { checkPendingMigrationsBeforeStart, STATUS_GRANT_REMEDY } = await import('../../src/utils/migration-status.js');
const { SpfnDatabasePort } = await import('../../src/kit/local/database.js');
const { CommandGatePort } = await import('../../src/kit/local/gates.js');
const { runInstall } = await import('../../src/kit/operations/install.js');
const { runUpdate } = await import('../../src/kit/operations/update.js');
const { runRestore } = await import('../../src/kit/operations/restore.js');
const { runResume } = await import('../../src/kit/operations/resume.js');
const { JournalStore } = await import('../../src/kit/journal.js');
const { digestOfJson } = await import('../../src/kit/digest.js');
const { KIT_EXIT } = await import('../../src/kit/errors.js');
const { FakeKitWorld, FAKE_LICENSE_KEY } = await import('./fake-world.js');

/** Nothing listens here; postgres.js connects lazily and the status read is mocked. */
const DATABASE_URL = 'postgres://nobody@127.0.0.1:1/nothing';
const DENIED = 'permission denied for schema drizzle';
const PENDING: MigrationStatus = {
    packages: [{ name: '@spfn/cms', total: 2, applied: 1, pending: 1, pendingTags: ['0002_posts'] }],
    project: null,
};
const APPLIED: MigrationStatus = {
    packages: [{ name: '@spfn/cms', total: 2, applied: 2, pending: 0, pendingTags: [] }],
    project: null,
};
const R0 = { version: '1.0.0', sequence: 1, releaseClass: 'feature' as const };
const R1 = { version: '1.1.0', sequence: 2, releaseClass: 'maintenance' as const, edgesFrom: ['1.0.0'], withMigrations: true };

let root: string;

beforeEach(() =>
{
    root = mkdtempSync(join(tmpdir(), 'spfn-kit-unreadable-'));
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
});

afterEach(() =>
{
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

/** drizzle's wrapping of the driver's error: the SQLSTATE is on the cause. */
function permissionError(): Error
{
    return new Error('Failed query: select hash, created_at from drizzle.__drizzle_migrations', {
        cause: Object.assign(new Error(DENIED), { code: '42501' }),
    });
}

function connectionError(): Error
{
    return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
}

/** What `spfn db status --json` prints when the status read answers what `read` does. */
async function printedStatus(read: () => Promise<MigrationStatus>): Promise<string>
{
    const lines: string[] = [];

    vi.mocked(collectMigrationStatus).mockImplementationOnce(read);
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    await dbStatus({ json: true });
    vi.mocked(console.log).mockRestore();

    return lines.join('\n');
}

/** Every way a status goes unread, as the child prints it. */
async function unreadReports(): Promise<{ reason: string; printed: string }[]>
{
    return [
        {
            reason: 'not-configured',
            printed: `${DB_STATUS_JSON_MARKER}${JSON.stringify(unreadableStatusReport('not-configured'))}`,
        },
        { reason: 'unreachable', printed: await printedStatus(async () => Promise.reject(connectionError())) },
        { reason: 'permission denied', printed: await printedStatus(async () => Promise.reject(permissionError())) },
    ];
}

/**
 * The Kit's database port, with each `db status --json` child answering the
 * next report, and the last one again once they run out.
 */
function portAnswering(reports: string[], calls: string[][] = []): InstanceType<typeof SpfnDatabasePort>
{
    return new SpfnDatabasePort({
        command: { file: 'spfn', args: [] },
        run: async (request) =>
        {
            calls.push(request.args);

            return {
                exitCode: 0,
                stdout: request.args.includes('status') ? (reports.length > 1 ? reports.shift()! : reports[0]) : 'migrated',
                stderr: '',
                missing: false,
            };
        },
    });
}

const project = (): string => join(root, 'project');

function install(world: FakeKitWorldType, database: DatabasePort = world.adapters.database): Promise<KitOperationResult>
{
    return runInstall({
        setupUrl: world.setupUrl,
        targetDir: project(),
        readLicenseKey: async () => FAKE_LICENSE_KEY,
        json: true,
        write: () => undefined,
    }, { ...world.adapters, database });
}

function resume(world: FakeKitWorldType, database: DatabasePort): Promise<KitOperationResult>
{
    return runResume({
        projectDir: project(),
        readLicenseKey: async () => FAKE_LICENSE_KEY,
        json: true,
        write: () => undefined,
    }, { ...world.adapters, database });
}

/**
 * Install and update share the migration step's rules. `prepare` brings a world
 * to where the operation starts (an installed R0 for the update); `run` runs it
 * against `database`.
 */
const OPERATIONS = [
    {
        name: 'install',
        prepare: async () => undefined,
        run: (world: FakeKitWorldType, database: DatabasePort) => install(world, database),
    },
    {
        name: 'update',
        prepare: async (world: FakeKitWorldType) =>
        {
            expect((await install(world)).status).toBe('completed');
            world.publish(R1);
        },
        run: (world: FakeKitWorldType, database: DatabasePort) =>
            runUpdate({ projectDir: project(), json: true, write: () => undefined }, { ...world.adapters, database }),
    },
];

describe.each(OPERATIONS)('$name, on a migration status the database refused to give', ({ prepare, run }) =>
{
    it('before migrating, refuses naming the grant rather than waiting for a database', async () =>
    {
        const denied = await printedStatus(async () => Promise.reject(permissionError()));
        const calls: string[][] = [];

        const world = new FakeKitWorld({ releases: [R0] });

        await prepare(world);

        const result = await run(world, portAnswering([denied], calls));

        expect(result.code).toBe('CLI_MIGRATION_STATUS_UNREADABLE');
        expect(result.exitCode).toBe(KIT_EXIT.REFUSED);
        expect(result.summary).toContain('grant the app role USAGE on schema drizzle');
        expect(calls.some((args) => args.includes('migrate'))).toBe(false);
    });

    it('after migrating, refuses with the reason instead of reporting it applied', async () =>
    {
        const pending = await printedStatus(async () => PENDING);
        const denied = await printedStatus(async () => Promise.reject(permissionError()));
        const calls: string[][] = [];

        const world = new FakeKitWorld({ releases: [R0] });

        await prepare(world);

        // The step's own read, the port's read before migrating, the port's read after.
        const result = await run(world, portAnswering([pending, pending, denied], calls));

        expect(calls).toContainEqual(['db', 'migrate', '--with-backup']);
        expect(result.status).toBe('failed');
        expect(result.exitCode).toBe(KIT_EXIT.REFUSED);
        expect(result.code).toBe('CLI_MIGRATION_STATUS_UNREADABLE');
        expect(result.summary).toContain('"Database roles"');
        expect(result.evidence).toMatchObject({ reason: 'permission-denied', detail: DENIED });
    });

    it('does not let a resume take the migration step as done', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });
        const pending = await printedStatus(async () => PENDING);
        const applied = await printedStatus(async () => APPLIED);
        const denied = await printedStatus(async () => Promise.reject(permissionError()));

        // The migration step completes; a later gate stops the operation.
        await prepare(world);
        world.faults.failingGates.add('build');
        expect((await run(world, portAnswering([pending, pending, applied]))).code).toBe('KIT_GATE_FAILED');
        world.faults.failingGates.clear();

        const resumed = await resume(world, portAnswering([denied]));

        expect(resumed.status).toBe('failed');
        expect(resumed.code).toBe('KIT_RESUME_MISMATCH');
        expect(resumed.evidence).toMatchObject({
            checkpoint: 'migration-applied',
            reason: `database-status-unreadable: permission denied (${DENIED})`,
        });
    });
});

describe('restore, on a migration status nobody read', () =>
{
    /** An installed R0 copied the way `git clone` would carry it. */
    async function cleanClone(world: FakeKitWorldType): Promise<string>
    {
        expect((await install(world)).status).toBe('completed');

        const clone = join(root, 'clone');

        cpSync(project(), clone, {
            recursive: true,
            filter: source => !source.includes('node_modules') && !source.includes(join('.spfn', 'operations')),
        });

        return clone;
    }

    function restore(world: FakeKitWorldType, clone: string, database: DatabasePort): Promise<KitOperationResult>
    {
        const gates = new CommandGatePort({
            database,
            run: async () => ({ exitCode: 0, stdout: '', stderr: '', missing: false }),
        });

        return runRestore({ projectDir: clone, json: true, write: () => undefined }, { ...world.adapters, database, gates });
    }

    it('fails the db-status gate on each reason the status went unread', async () =>
    {
        for (const { reason, printed } of await unreadReports())
        {
            rmSync(project(), { recursive: true, force: true });
            rmSync(join(root, 'clone'), { recursive: true, force: true });

            const world = new FakeKitWorld({ releases: [{ ...R0, gates: ['db-status'] }] });
            const result = await restore(world, await cleanClone(world), portAnswering([printed]));

            expect(result.code, reason).toBe('KIT_GATE_FAILED');
            expect(String(result.evidence?.detail), reason)
                .toContain(`the migration status could not be read: ${reason}`);
        }
    });

    it('records the pending count as unknown, not as 0', async () =>
    {
        const world = new FakeKitWorld({ releases: [{ ...R0, gates: ['typecheck' as const] }] });
        const clone = await cleanClone(world);
        const unreachable = await printedStatus(async () => Promise.reject(connectionError()));

        const result = await restore(world, clone, portAnswering([unreachable]));
        const journal = new JournalStore(clone, { now: () => world.now() }).readHistory(result.operationId!);
        const gatesCheckpoint = journal?.checkpoints.find(checkpoint => checkpoint.id === 'local-gates-passed');

        expect(result.code).toBe('KIT_RESTORE_COMPLETE');
        expect(gatesCheckpoint?.evidenceDigest).toBe(digestOfJson({ gates: { typecheck: 'pass' }, pendingMigrations: null }));
    });
});

describe('the spfn dev / spfn start pre-start check', () =>
{
    it('names the grant when the database refused the read, and starts', async () =>
    {
        vi.mocked(collectMigrationStatus).mockRejectedValueOnce(permissionError());
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const check = await checkPendingMigrationsBeforeStart(root, DATABASE_URL, false);

        expect(check.block).toBe(false);
        expect(warned).toHaveBeenCalledTimes(1);
        expect(String(warned.mock.calls[0][0])).toContain(`Could not check migrations: ${DENIED}`);
        expect(String(warned.mock.calls[0][0])).toContain(STATUS_GRANT_REMEDY);
    });

    it('says nothing, and asks nothing, when no DATABASE_URL is configured', async () =>
    {
        vi.stubEnv('DATABASE_URL', undefined);
        vi.mocked(collectMigrationStatus).mockClear();
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const check = await checkPendingMigrationsBeforeStart(root, undefined, false);

        expect(check.block).toBe(false);
        expect(warned).not.toHaveBeenCalled();
        expect(collectMigrationStatus).not.toHaveBeenCalled();
    });
});

describe('spfn db status, read by a person', () =>
{
    it('names the grant on a permission error, then exits 1', async () =>
    {
        vi.mocked(collectMigrationStatus).mockRejectedValueOnce(permissionError());
        const printed: string[] = [];
        vi.spyOn(console, 'error').mockImplementation((line: string) => void printed.push(line));
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(process, 'exit').mockImplementation((code) =>
        {
            throw new Error(`exit ${code}`);
        });

        await expect(dbStatus()).rejects.toThrow('exit 1');
        expect(printed.join('\n')).toContain(DENIED);
        expect(printed.join('\n')).toContain(STATUS_GRANT_REMEDY);
    });
});
