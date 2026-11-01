/**
 * Migration Boot Gate
 *
 * A server that boots with pending migrations passes its health check and then
 * fails every request that touches a missing column, as an opaque 500. The gate
 * moves that failure to boot, where it is one line to read and one command to
 * fix.
 *
 * The check runs on the database the server already connected to. When no
 * database was initialized — an app that uses none — there is nothing to check
 * and boot proceeds. When the database is configured but unreachable,
 * `initDatabase()` has already failed before the gate runs, so the gate never
 * turns a database outage into a migration message.
 */

import {
    collectMigrationStatus,
    countPendingMigrations,
    formatPendingMigrations,
    getDatabase,
    hasMigrationTargets,
    pendingMigrationTargets,
    pendingMigrationsSummary,
    RUN_MIGRATIONS_HINT,
    type MigrationStatus,
    type MigrationStatusDb,
} from '@spfn/core/db';
import { env } from '@spfn/core/config';

import { serverLogger } from './logger';
import type { ServerConfig } from './types';

/**
 * How long a status snapshot is reused before the health endpoint re-reads it.
 * Health is polled by readiness probes; migrations change only when someone runs
 * `spfn db migrate`, so a short cache keeps probes cheap without going stale.
 */
const SNAPSHOT_TTL_MS = 30_000;

export type MigrationSnapshot =
    /** Checked successfully — `status` carries per-target applied/pending counts. */
    | { state: 'ok'; checkedAt: string; status: MigrationStatus; pending: number }
    /** Nothing to check: no database in use, or no migrations shipped. */
    | { state: 'skipped'; checkedAt: string; reason: string }
    /** Could not check — distinct from "checked and pending". */
    | { state: 'unavailable'; checkedAt: string; reason: string };

type CachedSnapshot = {
    at: number;
    cwd: string;
    value: MigrationSnapshot;
};

let cache: CachedSnapshot | null = null;

/**
 * Thrown when the gate refuses a boot. Not an HTTP error — it never reaches a
 * request.
 */
export class PendingMigrationsError extends Error
{
    readonly targets: string[];

    constructor(message: string, targets: string[])
    {
        super(message);
        this.name = 'PendingMigrationsError';
        this.targets = targets;
    }
}

/**
 * Forget the cached snapshot — used by tests and after a manual migration run.
 */
export function resetMigrationSnapshot(): void
{
    cache = null;
}

/**
 * The database's own words for why the check failed. drizzle wraps a driver
 * error in one whose message is the failed SQL ("Failed query: …"), which names
 * the statement but not the problem — "permission denied for schema drizzle"
 * lives in its cause.
 */
function failureReason(error: unknown): string
{
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;

    return cause instanceof Error ? cause.message : String(cause);
}

async function inspect(cwd: string, db?: MigrationStatusDb): Promise<MigrationSnapshot>
{
    const checkedAt = new Date().toISOString();

    if (!hasMigrationTargets(cwd))
    {
        return { state: 'skipped', checkedAt, reason: 'no function package or project migrations found' };
    }

    let database = db;

    if (!database)
    {
        try
        {
            database = getDatabase() as unknown as MigrationStatusDb;
        }
        catch
        {
            return { state: 'skipped', checkedAt, reason: 'no database initialized' };
        }
    }

    try
    {
        const status = await collectMigrationStatus(database, cwd);

        return { state: 'ok', checkedAt, status, pending: countPendingMigrations(status) };
    }
    catch (error)
    {
        return { state: 'unavailable', checkedAt, reason: failureReason(error) };
    }
}

/**
 * Current migration snapshot, recomputed at most once per TTL.
 *
 * The boot gate seeds it, so the first health probe after startup costs nothing.
 */
export async function getMigrationSnapshot(options: {
    cwd?: string;
    db?: MigrationStatusDb;
    force?: boolean;
    ttlMs?: number;
} = {}): Promise<MigrationSnapshot>
{
    const cwd = options.cwd ?? process.cwd();
    const ttl = options.ttlMs ?? SNAPSHOT_TTL_MS;
    const now = Date.now();

    if (!options.force && cache && cache.cwd === cwd && now - cache.at < ttl)
    {
        return cache.value;
    }

    const value = await inspect(cwd, options.db);
    cache = { at: now, cwd, value };

    return value;
}

/**
 * Whether a boot may proceed with pending migrations.
 *
 * Server config wins over the environment variable, so a test harness can allow
 * it without exporting anything; containers, which cannot add a CLI flag, set
 * `SPFN_ALLOW_PENDING_MIGRATIONS=true`.
 */
function pendingIsAllowed(config?: ServerConfig): boolean
{
    return config?.migrations?.allowPending ?? env.SPFN_ALLOW_PENDING_MIGRATIONS === true;
}

/**
 * Refuse to serve when a function package (or the project) has migrations the
 * database has not applied.
 *
 * @throws PendingMigrationsError unless the opt-out is set
 */
export async function runMigrationBootGate(config?: ServerConfig, cwd: string = process.cwd()): Promise<MigrationSnapshot>
{
    const snapshot = await getMigrationSnapshot({ cwd, force: true });

    if (snapshot.state === 'skipped')
    {
        serverLogger.debug(`Migration gate skipped: ${snapshot.reason}`);

        return snapshot;
    }

    if (snapshot.state === 'unavailable')
    {
        // "Could not check" is not "checked and pending" — never block a boot on it.
        serverLogger.warn(
            `Could not verify migration status: ${snapshot.reason}. Starting anyway — run \`pnpm spfn db status\` to check.`,
        );

        return snapshot;
    }

    const targets = pendingMigrationTargets(snapshot.status);

    if (targets.length === 0)
    {
        serverLogger.debug('Migration gate passed: database is up to date');

        return snapshot;
    }

    const lines = formatPendingMigrations(targets);
    const summary = pendingMigrationsSummary(targets);

    if (pendingIsAllowed(config))
    {
        serverLogger.warn(`Starting with pending migrations — ${summary}`);
        lines.forEach(line => serverLogger.warn(`  ${line}`));
        serverLogger.warn(`  Requests hitting the missing columns will fail. ${RUN_MIGRATIONS_HINT}`);

        return snapshot;
    }

    serverLogger.error(`Refusing to start: ${summary}`);
    lines.forEach(line => serverLogger.error(`  ${line}`));
    serverLogger.error(`  ${RUN_MIGRATIONS_HINT}`);
    serverLogger.error('  To start anyway: SPFN_ALLOW_PENDING_MIGRATIONS=true (or `spfn dev --allow-pending-migrations`)');

    throw new PendingMigrationsError(
        `${summary}. ${RUN_MIGRATIONS_HINT}, or set SPFN_ALLOW_PENDING_MIGRATIONS=true to start anyway.`,
        targets.map(target => target.name),
    );
}
