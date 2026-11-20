/**
 * A migration status the database would not give is not "nothing pending" (#405).
 *
 * The chain is real from the status read to the install's answer: `spfn db
 * status --json` runs with the status read throwing PostgreSQL's permission
 * error the way drizzle wraps it, its printed report is handed to the Kit's
 * database port as a child's stdout, and the install runs against that port.
 * Only the child process is replaced.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MigrationStatus } from '@spfn/core/db';

vi.mock('@spfn/core/db', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('@spfn/core/db')>();

    return {
        ...original,
        collectMigrationStatus: vi.fn(),
    };
});

const { collectMigrationStatus } = await import('@spfn/core/db');
const { dbStatus } = await import('../../src/commands/db/status.js');
const { SpfnDatabasePort } = await import('../../src/kit/local/database.js');
const { runInstall } = await import('../../src/kit/operations/install.js');
const { verifyNothingPending } = await import('../../src/kit/operations/shared.js');
const { KIT_EXIT } = await import('../../src/kit/errors.js');
const { FakeKitWorld, FAKE_LICENSE_KEY } = await import('./fake-world.js');

/** Nothing listens here; postgres.js connects lazily and the status read is mocked. */
const DATABASE_URL = 'postgres://nobody@127.0.0.1:1/nothing';
const DENIED = 'permission denied for schema drizzle';
const PENDING: MigrationStatus = {
    packages: [{ name: '@spfn/cms', total: 2, applied: 1, pending: 1, pendingTags: ['0002_posts'] }],
    project: null,
};

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

/** The Kit's database port, with each `db status --json` child answering the next report. */
function portAnswering(reports: string[], calls: string[][]): InstanceType<typeof SpfnDatabasePort>
{
    return new SpfnDatabasePort({
        command: { file: 'spfn', args: [] },
        run: async (request) =>
        {
            calls.push(request.args);

            return {
                exitCode: 0,
                stdout: request.args.includes('status') ? reports.shift() ?? '' : 'migrated',
                stderr: '',
                missing: false,
            };
        },
    });
}

async function installWith(reports: string[], calls: string[][])
{
    const world = new FakeKitWorld();

    return runInstall({
        setupUrl: world.setupUrl,
        targetDir: join(root, 'project'),
        readLicenseKey: async () => FAKE_LICENSE_KEY,
        json: true,
        write: () => undefined,
    }, { ...world.adapters, database: portAnswering(reports, calls) });
}

describe('a migration status the database refused to give', () =>
{
    it('after migrating, refuses the install with the reason instead of reporting it applied', async () =>
    {
        const pending = await printedStatus(async () => PENDING);
        const denied = await printedStatus(async () => Promise.reject(permissionError()));
        const calls: string[][] = [];

        // The step's own read, the port's read before migrating, the port's read after.
        const result = await installWith([pending, pending, denied], calls);

        expect(calls).toContainEqual(['db', 'migrate', '--with-backup']);
        expect(result.status).toBe('failed');
        expect(result.exitCode).toBe(KIT_EXIT.REFUSED);
        expect(result.code).toBe('CLI_MIGRATION_STATUS_UNREADABLE');
        expect(result.summary).toContain('"Database roles"');
        expect(result.evidence).toMatchObject({ reason: 'permission-denied', detail: DENIED });
    });

    it('does not let the step\'s verify pass on it', async () =>
    {
        const denied = await printedStatus(async () => Promise.reject(permissionError()));
        const status = await portAnswering([denied], []).status({ cwd: root });

        expect(verifyNothingPending(status)).toEqual({
            ok: false,
            reason: `database-status-unreadable: permission denied (${DENIED})`,
        });
    });

    it('before migrating, refuses naming the grant rather than waiting for a database', async () =>
    {
        const denied = await printedStatus(async () => Promise.reject(permissionError()));
        const calls: string[][] = [];

        const result = await installWith([denied], calls);

        expect(result.code).toBe('CLI_MIGRATION_STATUS_UNREADABLE');
        expect(result.code).not.toBe('KIT_WAITING_DATABASE');
        expect(result.summary).toContain('grant the app role USAGE on schema drizzle');
        expect(calls.some((args) => args.includes('migrate'))).toBe(false);
    });
});
