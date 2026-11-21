import chalk from 'chalk';

import { validateDatabasePrerequisites } from './utils/drizzle.js';
import {
    bookkeepingMismatchOf,
    getMigrationStatus,
    migrationTargets,
    permissionDeniedOf,
    STATUS_GRANT_REMEDY,
} from '../../utils/migration-status.js';
import type { MigrationStatus } from '../../utils/migration-status.js';

/**
 * The machine-readable form of `spfn db status`.
 *
 * It exists because "are there migrations waiting" is a question another
 * program has to answer without reading prose — `spfn kit install` decides
 * whether to run migrations from it. So the three states a caller must tell
 * apart get fields of their own rather than being inferred from an exit code:
 * a project with no database configured, a database that could not be reached,
 * and a database that answered.
 */
export interface DbStatusReportV1
{
    schemaVersion: 1;
    /** Whether a connection string is configured for this project at all. */
    configured: boolean;
    /**
     * Whether the status was read. False when the database did not answer, on
     * a bookkeeping mismatch and on a permission error — so a reader that does
     * not know that reason stops rather than taking the empty pending list as
     * "nothing to do". An unread status is never "nothing pending".
     */
    reachable: boolean;
    /** Why it could not be read, in a word. Absent when it was read. */
    reason?: DbStatusUnreadableReason;
    /**
     * With `bookkeeping-mismatch`: what does not match, and the remedy. With
     * `permission-denied`: PostgreSQL's message, which names what was refused.
     */
    detail?: string;
    targets: {
        name: string;
        total: number;
        applied: number;
        pending: number;
        pendingTags: string[];
    }[];
    /** `<target>/<tag>` for every migration still waiting. */
    pending: string[];
    pendingCount: number;
}

/**
 * `bookkeeping-mismatch`: the database answered, and the project's bookkeeping
 * does not match `src/server/drizzle` the way `spfn db migrate` matches it, so
 * migrate refuses — waiting for the database will not change it.
 *
 * `permission-denied`: the database answered and refused the connecting role
 * the read (SQLSTATE 42501, typically no grant on schema `drizzle`). Not
 * "unreachable": waiting changes nothing until someone grants it.
 */
export type DbStatusUnreadableReason = 'not-configured' | 'unreachable' | 'bookkeeping-mismatch' | 'permission-denied';

/**
 * Read a migration status into the report.
 *
 * `pending` is flattened to one identifier per waiting migration because a
 * caller counting work to do should not have to walk two levels to do it; the
 * per-target detail stays in `targets` for anything that wants it.
 */
export function migrationStatusReport(status: MigrationStatus): DbStatusReportV1
{
    const targets = migrationTargets(status).map(target => ({
        name: target.name,
        total: target.total,
        applied: target.applied,
        pending: target.pending,
        pendingTags: [...target.pendingTags],
    }));
    const pending = targets.flatMap(target => target.pendingTags.map(tag => `${target.name}/${tag}`));

    return {
        schemaVersion: 1,
        configured: true,
        reachable: true,
        targets,
        pending,
        pendingCount: targets.reduce((sum, target) => sum + target.pending, 0),
    };
}

/** The report for a database that could not be read, and why. */
export function unreadableStatusReport(reason: DbStatusUnreadableReason, detail?: string): DbStatusReportV1
{
    return {
        schemaVersion: 1,
        configured: reason !== 'not-configured',
        reachable: false,
        reason,
        ...(detail === undefined ? {} : { detail }),
        targets: [],
        pending: [],
        pendingCount: 0,
    };
}

/**
 * Show applied/pending migration status for function packages and the project.
 *
 * Entry point for "why are the package tables missing?" — reports what
 * `spfn db migrate` would apply, without touching the database.
 *
 * `--json` prints one object and nothing else, and exits 0 whenever it has an
 * answer — including "no database is configured", which is an answer. The
 * human path is unchanged: it still explains itself and still exits 1 when it
 * cannot read the status, because a person reading a broken status wants the
 * shell to notice.
 */
export async function dbStatus(options: { json?: boolean } = {}): Promise<void>
{
    const json = options.json === true;

    try
    {
        validateDatabasePrerequisites('db status');
    }
    catch (error)
    {
        if (json)
        {
            printReport(unreadableStatusReport('not-configured'));

            return;
        }

        // Error already logged in validateDatabasePrerequisites
        process.exit(1);
    }

    let status;

    try
    {
        status = await getMigrationStatus(process.cwd());
    }
    catch (error)
    {
        if (json)
        {
            printReport(unreadableReportFor(error));

            return;
        }

        printReadFailure(error);
        process.exit(1);
    }

    if (json)
    {
        printReport(migrationStatusReport(status));

        return;
    }

    const targets = migrationTargets(status);

    if (targets.length === 0)
    {
        console.log(chalk.dim('No migrations found (no @spfn packages with migrations, no src/server/drizzle).'));

        return;
    }

    console.log(chalk.blue('📦 Migration status:\n'));

    for (const target of targets)
    {
        const state = target.pending === 0
            ? chalk.green(`${target.applied}/${target.total} applied`)
            : chalk.yellow(`${target.applied}/${target.total} applied, ${target.pending} pending`);

        console.log(`  ${target.name.padEnd(32)} ${state}`);

        for (const tag of target.pendingTags)
        {
            console.log(chalk.dim(`      - ${tag}`));
        }
    }

    const pendingTotal = targets.reduce((sum, t) => sum + t.pending, 0);

    if (pendingTotal === 0)
    {
        console.log(chalk.green('\n✅ Database is up to date\n'));
    }
    else
    {
        console.log(chalk.yellow(`\n⚠️  ${pendingTotal} pending migration(s) — run: pnpm spfn db migrate\n`));
    }
}

/** The report for a status read that threw: why, in the report's own words. */
function unreadableReportFor(error: unknown): DbStatusReportV1
{
    const mismatch = bookkeepingMismatchOf(error);

    if (mismatch !== undefined)
    {
        return unreadableStatusReport('bookkeeping-mismatch', mismatch);
    }

    const denied = permissionDeniedOf(error);

    return denied === undefined
        ? unreadableStatusReport('unreachable')
        : unreadableStatusReport('permission-denied', denied);
}

function printReadFailure(error: unknown): void
{
    const mismatch = bookkeepingMismatchOf(error) !== undefined;

    console.error(chalk.red(mismatch
        ? '❌ The project\'s migration bookkeeping does not match src/server/drizzle'
        : '❌ Failed to read migration status'));
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));

    const denied = permissionDeniedOf(error);

    if (denied !== undefined)
    {
        console.error(chalk.red(denied));
        console.error(chalk.yellow(STATUS_GRANT_REMEDY));
    }
}

/**
 * The report, on one line, marked so a caller can find it.
 *
 * Anything else on the way here — a driver's warning, a dotenv notice — is
 * still on stdout, and a reader that took the whole stream as JSON would break
 * on it. The marker makes the report findable in a stream it does not control.
 */
export const DB_STATUS_JSON_MARKER = '#spfn-db-status#';

function printReport(report: DbStatusReportV1): void
{
    console.log(`${DB_STATUS_JSON_MARKER}${JSON.stringify(report)}`);
}
