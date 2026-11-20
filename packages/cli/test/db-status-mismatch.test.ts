/**
 * A project bookkeeping mismatch (#370) is its own answer, not "unreachable".
 *
 * `spfn db migrate` refuses such a database, so a caller that waits for it, or
 * starts a server on it, waits or runs forever on a wrong diagnosis. Both
 * readers of the status — `spfn db status` and the `spfn dev`/`spfn start`
 * pre-start check — go through one test of the error, pinned here with the
 * real error class and a status read that throws it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MigrationBookkeepingMismatchError } from '@spfn/core/db';

vi.mock('@spfn/core/db', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('@spfn/core/db')>();

    return {
        ...original,
        collectMigrationStatus: vi.fn(),
    };
});

const { collectMigrationStatus } = await import('@spfn/core/db');
const { DB_STATUS_JSON_MARKER, dbStatus } = await import('../src/commands/db/status.js');
const { checkPendingMigrationsBeforeStart } = await import('../src/utils/migration-status.js');

/** Nothing listens here; postgres.js connects lazily and the status read is mocked. */
const DATABASE_URL = 'postgres://nobody@127.0.0.1:1/nothing';
const DETAIL = 'id 1 matches a folder named 20231114221320_* or a migration.sql with hash gone…';

describe('a project bookkeeping mismatch', () =>
{
    let logged: string[];

    beforeEach(() =>
    {
        vi.stubEnv('DATABASE_URL', DATABASE_URL);
        vi.stubEnv('SPFN_ALLOW_PENDING_MIGRATIONS', 'true');
        vi.mocked(collectMigrationStatus).mockRejectedValue(new MigrationBookkeepingMismatchError(DETAIL));
        logged = [];
        vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
        vi.spyOn(console, 'error').mockImplementation((line: string) => logged.push(line));
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('is reported by `db status --json` as reason "bookkeeping-mismatch" with its text', async () =>
    {
        await dbStatus({ json: true });

        const line = logged.find(candidate => candidate.startsWith(DB_STATUS_JSON_MARKER))!;

        expect(JSON.parse(line.slice(DB_STATUS_JSON_MARKER.length))).toEqual({
            schemaVersion: 1,
            configured: true,
            reachable: false,
            reason: 'bookkeeping-mismatch',
            detail: expect.stringContaining(DETAIL),
            targets: [],
            pending: [],
            pendingCount: 0,
        });
    });

    it('blocks the pre-start check, whatever the opt-out says, and prints why', async () =>
    {
        const check = await checkPendingMigrationsBeforeStart(process.cwd(), DATABASE_URL, true);

        expect(check).toEqual({ block: true, allowPending: true });
        expect(logged.join('\n')).toContain(DETAIL);
        expect(logged.join('\n')).toContain('does not apply');
    });

    it('does not block the pre-start check when the status could not be read at all', async () =>
    {
        vi.mocked(collectMigrationStatus).mockRejectedValue(new Error('connection refused'));

        const check = await checkPendingMigrationsBeforeStart(process.cwd(), DATABASE_URL, false);

        expect(check).toEqual({ block: false, allowPending: true });
    });
});
