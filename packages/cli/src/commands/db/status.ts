import chalk from 'chalk';
import type { AppPrivilegeDrift } from '@spfn/core/db';

import { validateDatabasePrerequisites } from './utils/drizzle.js';
import {
    bookkeepingMismatchOf,
    getAppPrivilegesStatus,
    getMigrationStatus,
    migrationTargets,
    permissionDeniedOf,
    STATUS_GRANT_REMEDY,
} from '../../utils/migration-status.js';
import type { AppPrivilegesStatus, MigrationStatus } from '../../utils/migration-status.js';

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
    /**
     * What `spfn db grant` would change for the app role — the role this
     * command connects as — on the managed schemas, against the manifests'
     * declarations, read from the catalog the step reads. Present whenever the
     * status was read.
     */
    privileges?: DbStatusPrivileges;
}

/**
 * `checked: false` with `detail` when the manifests or the catalog could not
 * be read. Otherwise `drift` is what `spfn db grant` would change, per
 * relation (table, view, materialized view or sequence) and grantee — so one
 * relation can appear once per grantee — the app role; a role it is a member
 * of (the read role), whose grants it holds too, with `through`; or `null` for
 * PUBLIC, likewise: `missing` (declared, not held), `excess` (held, not
 * declared; a lost restriction), `grantOption` (declared, and held `WITH GRANT
 * OPTION`, so the app can pass it on) and `columns` (column grants, never
 * declared: `update (amount)`). `schemasWithoutUsage` are the managed schemas
 * the app role cannot use. `publicGrantsByOthers` are grants to PUBLIC from
 * another grantor than the owner, which the app holds and which block `db
 * grant` until their grantor runs `statement`. Status reports drift exactly
 * when `db grant` has a statement that changes what the app role or PUBLIC
 * can do: one on a relation for the app role, PUBLIC or a role the app is a
 * member of, or USAGE on a schema for the app role. USAGE for the read role
 * changes nothing the app can do, so it is no drift. It does not say whether
 * PostgreSQL would refuse a statement (`db grant --dry-run` does). `heldElsewhere` is what the app role holds beyond its
 * declarations as a member of a role `db grant` does not plan for or from
 * another grantor than the owner, which `db grant` reports and does not change.
 * `ownedTables` counts the tables the app role owns or inherits the owner of,
 * which are outside `db grant` — no statement on them for any role or PUBLIC —
 * and compared for nothing: declared, not enforced, and not under row-level
 * security. `publicMayCreateInPublic`: PUBLIC may
 * create in schema `public` (PostgreSQL before 15), which the step reports and
 * never revokes. `readRole` is `checked: false`, with `detail`, when
 * `DATABASE_READ_URL` is set and its role could not be looked up: the rest is
 * the app role's and PUBLIC's part, without what the app holds as a member of
 * another role, which may be the read role's.
 */
export type DbStatusPrivileges =
    | { checked: false; detail: string }
    | {
        checked: true;
        /** Which of the project's declarations was read: `manifest src/server/drizzle/privileges.json`, or `entities` */
        source: string;
        checkedTables: number;
        ownedTables: number;
        drift: {
            schema: string;
            table: string;
            kind: string;
            grantee: string | null;
            through: string | null;
            missing: string[];
            excess: string[];
            grantOption: string[];
            columns: string[];
        }[];
        schemasWithoutUsage: string[];
        publicGrantsByOthers: { schema: string; table: string; privilege: string; grantor: string; statement: string }[];
        heldElsewhere: { schema: string; table: string; privilege: string; through: string }[];
        publicMayCreateInPublic: boolean;
        readRole: { checked: true } | { checked: false; detail: string };
    };

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
export function migrationStatusReport(status: MigrationStatus, privileges?: AppPrivilegesStatus): DbStatusReportV1
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
        ...(privileges === undefined ? {} : { privileges: privilegesReport(privileges) }),
    };
}

/** The privileges field: the check's own shape, its lists copied as plain arrays. */
function privilegesReport(privileges: AppPrivilegesStatus): DbStatusPrivileges
{
    if (!privileges.checked)
    {
        return privileges;
    }

    return {
        checked: true,
        source: privileges.source,
        checkedTables: privileges.checkedTables,
        ownedTables: privileges.ownedTables,
        drift: privileges.drift.map(entry => ({
            ...entry,
            missing: [...entry.missing],
            excess: [...entry.excess],
            grantOption: [...entry.grantOption],
            columns: [...entry.columns],
        })),
        schemasWithoutUsage: [...privileges.schemasWithoutUsage],
        publicGrantsByOthers: privileges.publicGrantsByOthers.map(entry => ({ ...entry })),
        heldElsewhere: privileges.heldElsewhere.map(entry => ({ ...entry })),
        publicMayCreateInPublic: privileges.publicMayCreateInPublic,
        readRole: { ...privileges.readRole },
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

    const privileges = await getAppPrivilegesStatus(process.cwd());

    if (json)
    {
        printReport(migrationStatusReport(status, privileges));

        return;
    }

    const targets = migrationTargets(status);

    if (targets.length === 0)
    {
        console.log(chalk.dim('No migrations found (no @spfn packages with migrations, no src/server/drizzle).'));

        return;
    }

    printMigrationTargets(targets);
    printPrivileges(privileges);
}

function printMigrationTargets(targets: ReturnType<typeof migrationTargets>): void
{
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

/**
 * The app role's privileges against the declarations: what `db grant` would
 * change, the grants to PUBLIC that block it, what it holds another way, the
 * tables it owns, a read role it could not look up, PUBLIC CREATE on public.
 * "Holds what is declared" only when there is none of the first three and the
 * read role was looked up.
 */
function printPrivileges(privileges: AppPrivilegesStatus): void
{
    if (!privileges.checked)
    {
        console.log(chalk.yellow(`⚠️  Could not check the app role's privileges: ${privileges.detail}\n`));

        return;
    }

    console.log(chalk.dim(`📄 The project's declarations: ${privileges.source}`));

    if (privileges.ownedTables > 0)
    {
        console.log(chalk.dim(`🔐 The app role owns ${privileges.ownedTables} managed table(s), or inherits their owner: their declarations are not enforced, nothing is compared on them, and row-level security does not apply to it.`));
    }

    printGrantWork(privileges);
    privileges.publicGrantsByOthers.forEach(grant => console.log(chalk.yellow(`⚠️  PUBLIC holds ${privilegeText(grant.privilege)} on ${grant.schema}.${grant.table}, `
        + `granted by ${grant.grantor}, so the app role holds it too — spfn db grant is blocked until ${grant.grantor} runs: ${grant.statement};`)));
    privileges.heldElsewhere.forEach(held => console.log(chalk.yellow(`⚠️  The app role holds ${privilegeText(held.privilege)} on ${held.schema}.${held.table} `
        + `beyond its declaration, ${held.through} — spfn db grant does not change it: the step changes no other role`)));

    printReadRoleOrClean(privileges);

    if (privileges.publicMayCreateInPublic)
    {
        console.log(chalk.yellow('⚠️  PUBLIC may CREATE in schema public (PostgreSQL before 15): any role, the app\'s too, can create — and so own — tables there. '
            + 'As the database owner: REVOKE CREATE ON SCHEMA public FROM PUBLIC;'));
    }

    console.log();
}

/**
 * Why the read role's part is not checked; else "holds what is declared" when
 * nothing differs, nothing blocks `db grant` and nothing is held another way.
 */
function printReadRoleOrClean(privileges: Extract<AppPrivilegesStatus, { checked: true }>): void
{
    if (!privileges.readRole.checked)
    {
        console.log(chalk.yellow(`⚠️  Not checked: ${privileges.readRole.detail} — what the app role holds as a member of another role is not reported`));

        return;
    }

    if (privileges.drift.length + privileges.schemasWithoutUsage.length + privileges.publicGrantsByOthers.length + privileges.heldElsewhere.length === 0
        && privileges.checkedTables > 0)
    {
        console.log(chalk.green(`🔐 The app role holds what is declared on ${privileges.checkedTables} table(s)${privileges.ownedTables > 0 ? ' it does not own' : ''}`));
    }
}

/** What `db grant` would change: each schema the app cannot use, each relation and grantee whose privileges differ. */
function printGrantWork(privileges: Extract<AppPrivilegesStatus, { checked: true }>): void
{
    if (privileges.drift.length + privileges.schemasWithoutUsage.length === 0)
    {
        return;
    }

    console.log(chalk.yellow('⚠️  The app role\'s privileges differ from the declarations — as the owner, run: pnpm spfn db grant '
        + '(--dry-run first shows whether PostgreSQL refuses a statement)'));
    privileges.schemasWithoutUsage.forEach(schema => console.log(chalk.yellow(`      schema ${schema}: no USAGE`)));
    privileges.drift.forEach(entry => console.log(chalk.yellow(`      ${entry.schema}.${entry.table}${granteeText(entry)}: ${driftText(entry)}`)));
}

/** Whose grants an entry is about, when not the app role's own: ` (PUBLIC)`, or ` (member of app_read)`. */
function granteeText(entry: AppPrivilegeDrift): string
{
    return entry.grantee === null ? ' (PUBLIC)' : entry.through === null ? '' : ` (${entry.through})`;
}

function driftText(entry: AppPrivilegeDrift): string
{
    const list = (privileges: readonly string[]) => privileges.map(privilegeText).join(', ');

    return [
        entry.missing.length > 0 && `missing ${list(entry.missing)}`,
        entry.excess.length > 0 && `beyond the declaration ${list(entry.excess)}`,
        entry.grantOption.length > 0 && `WITH GRANT OPTION on ${list(entry.grantOption)}`,
        entry.columns.length > 0 && `column grants ${list(entry.columns)}`,
    ].filter(Boolean).join('; ');
}

/** `UPDATE`, or `UPDATE (amount)` for a column's: the privilege upper case, the column as it is named. */
function privilegeText(privilege: string): string
{
    return privilege.replace(/^\w+/, word => word.toUpperCase());
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
