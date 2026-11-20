/**
 * The project's database, asked through the project's own CLI.
 *
 * The asking is done by a child process rather than in this one, and that is
 * the design rather than an accident. Reading a project's migration state
 * means loading that project's environment, and loading it in *this* process
 * would pull the project's secrets — a connection string with a password in it
 * — into the memory of a command that has no use for them and prints reports
 * for a living. A child loads them, answers one question, and exits.
 *
 * The question is asked in the machine-readable form `spfn db status --json`
 * exists for. Nothing here parses prose: a human summary is written to change
 * when it reads better, and a port that depended on its wording would break
 * quietly the first time someone improved it.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabasePort, DatabaseStatus, MigrationResult } from '../ports.js';
import { runCommand, summarize, type CommandRunner, type RunResult } from './process.js';
import { DB_STATUS_JSON_MARKER, type DbStatusReportV1 } from '../../commands/db/status.js';

/** A migration can take a long time; a wedged one should still end. */
export const DEFAULT_DATABASE_TIMEOUT_MS = 900_000;

export interface SpfnDatabaseOptions
{
    /** How to run this CLI. Defaults to the binary this build ships with. */
    command?: { file: string; args: string[] };
    timeoutMs?: number;
    run?: CommandRunner;
}

export class SpfnDatabasePort implements DatabasePort
{
    private readonly options: SpfnDatabaseOptions;

    constructor(options: SpfnDatabaseOptions = {})
    {
        this.options = options;
    }

    async status(request: { cwd: string }): Promise<DatabaseStatus>
    {
        return toStatus(await this.report(request.cwd, ['db', 'status', '--json']));
    }

    /**
     * Apply what is waiting, then look again.
     *
     * The second look is not belt and braces: `spfn db migrate` reports what it
     * attempted, and this port has to report what is *true afterwards*. A
     * migration that exits 0 having applied three of four is a failure, and
     * only re-reading the status says so.
     */
    async migrate(request: { cwd: string; withBackup: boolean }): Promise<MigrationResult>
    {
        const before = await this.status({ cwd: request.cwd });
        const args = request.withBackup ? ['db', 'migrate', '--with-backup'] : ['db', 'migrate'];
        const run = await this.run(request.cwd, args);

        if (run.exitCode !== 0)
        {
            return {
                ok: false,
                applied: before.applied,
                pending: before.pending,
                failure: summarize(run),
            };
        }

        const after = await this.status({ cwd: request.cwd });

        return {
            ok: after.pending.length === 0,
            applied: after.applied,
            pending: after.pending,
            failure: after.pending.length === 0 ? undefined : 'migrations-still-pending',
        };
    }

    private async report(cwd: string, args: string[]): Promise<DbStatusReportV1 | null>
    {
        return readReport(await this.run(cwd, args));
    }

    private run(cwd: string, args: string[]): Promise<RunResult>
    {
        const command = this.options.command ?? spfnCommand();

        return (this.options.run ?? runCommand)({
            file: command.file,
            args: [...command.args, ...args],
            cwd,
            timeoutMs: this.options.timeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS,
        });
    }
}

/**
 * The report a child printed, found in whatever else it printed.
 *
 * A marker rather than "parse stdout as JSON", because the child's stdout is
 * shared with anything its dependencies decide to say — a driver's warning, a
 * dotenv notice — and none of that is under this CLI's control.
 */
export function readReport(result: RunResult): DbStatusReportV1 | null
{
    const line = result.stdout
        .split('\n')
        .reverse()
        .find(candidate => candidate.includes(DB_STATUS_JSON_MARKER));

    if (line === undefined)
    {
        return null;
    }

    try
    {
        const parsed = JSON.parse(line.slice(line.indexOf(DB_STATUS_JSON_MARKER) + DB_STATUS_JSON_MARKER.length));

        return parsed?.schemaVersion === 1 ? parsed as DbStatusReportV1 : null;
    }
    catch
    {
        return null;
    }
}

/**
 * The port's answer for a report, including the report that never came.
 *
 * A child that printed nothing readable is reported as configured-unknown and
 * unreachable, which is what stops an install rather than letting it run
 * migrations against a database nobody has confirmed exists.
 */
export function toStatus(report: DbStatusReportV1 | null): DatabaseStatus
{
    if (report === null)
    {
        return { configured: false, reachable: false, applied: [], pending: [] };
    }

    return {
        configured: report.configured,
        reachable: report.reachable,
        ...(report.reason === 'bookkeeping-mismatch'
            ? { bookkeepingMismatch: report.detail ?? 'bookkeeping does not match local migrations' }
            : {}),
        // Counts rather than names: the status contract has no field for how
        // many of a target are done, and the names of applied migrations are
        // not something `spfn db status` knows.
        applied: report.targets.map(target => `${target.name} ${target.applied}/${target.total}`),
        pending: [...report.pending],
    };
}

/**
 * How to run this CLI again as a child.
 *
 * The binary this build ships with, not whichever `spfn` is on the PATH: the
 * two can be different versions, and a Kit operation that asked one CLI for a
 * plan should not have another one answer.
 */
export function spfnCommand(): { file: string; args: string[] }
{
    const bin = resolveSpfnBin();

    return bin === null
        ? { file: 'spfn', args: [] }
        : { file: process.execPath, args: [bin] };
}

/** This package's own `bin/spfn.js`, found by walking up from this module. */
export function resolveSpfnBin(from: string = fileURLToPath(import.meta.url)): string | null
{
    let directory = dirname(from);

    for (let depth = 0; depth < 8; depth += 1)
    {
        const candidate = join(directory, 'bin', 'spfn.js');

        if (existsSync(candidate))
        {
            return candidate;
        }

        const parent = dirname(directory);

        if (parent === directory)
        {
            break;
        }

        directory = parent;
    }

    return null;
}
