/**
 * Migration status for the CLI
 *
 * `spfn db status` and the `spfn dev` / `spfn start` pre-flight check both read
 * migration state through `@spfn/core/db`, which is the same implementation the
 * server's boot gate and health endpoint use. This module only opens a
 * short-lived connection for the commands that run outside a server.
 */

import chalk from 'chalk';
import { sql } from 'drizzle-orm';

import {
    catalogRows,
    checkAppPrivileges,
    collectMigrationStatus,
    formatPendingMigrations,
    MigrationBookkeepingMismatchError,
    MISMATCH_OVERRIDE_NOTE,
    pendingMigrationTargets,
    pendingMigrationsSummary,
    RUN_MIGRATIONS_HINT,
    discoverFunctionMigrations,
    readJobsDeclaration,
    type AppPrivilegesCheck,
    type JobsDeclaration,
    type MigrationStatus,
    type MigrationTargetStatus,
} from '@spfn/core/db';
import { env } from '@spfn/core/config';
import { ownsQueue, QUEUE_SCHEMA_VERSION, queueStart, readQueueSchemaState, type QueueSchemaStep, type QueueStart } from '@spfn/core/job';
import { loadEnv } from '@spfn/core/server';
import { databaseUrlFor } from './database-connection.js';
import { describeFailure } from './database-failure.js';
import { projectGrantTarget } from '../commands/db/utils/app-grants.js';

export {
    functionMigrationsTable,
    migrationTargets,
    pendingMigrationTargets,
} from '@spfn/core/db';

export type { MigrationStatus, MigrationTargetStatus };

/**
 * Collect applied/pending status for all function packages and the project.
 * Throws when DATABASE_URL is missing or the database is unreachable.
 */
export async function getMigrationStatus(
    cwd: string = process.cwd(),
    databaseUrl?: string,
): Promise<MigrationStatus>
{
    loadEnv();
    const url = databaseUrl ?? databaseUrlFor('db status');

    if (!url)
    {
        throw new Error('DATABASE_URL not found in environment');
    }

    const { drizzle } = await import('drizzle-orm/postgres-js');
    const connection = await statusConnection(url);

    try
    {
        return await collectMigrationStatus(drizzle({ client: connection }), cwd);
    }
    finally
    {
        await connection.end();
    }
}

/** One connection to `url`, given 5 s to connect: every connection `db status` opens. */
async function statusConnection(url: string)
{
    const postgres = await import('postgres');

    return postgres.default(url, { max: 1, connect_timeout: 5 });
}

/** Whether the read role was looked up — or `DATABASE_READ_URL` is unset — or why it could not be. */
export type ReadRoleCheck = { checked: true } | { checked: false; detail: string };

/** What the app role holds against the declarations, or why that could not be read. */
export type AppPrivilegesStatus = ({ checked: true; source: string; readRole: ReadRoleCheck } & AppPrivilegesCheck) | { checked: false; detail: string };

/**
 * Compare what the app role — the role `db status` connects as — holds on the
 * managed tables with what is declared (`checkAppPrivileges`): the project's
 * manifest, else its entities as `db push` loads them, and each function
 * package's manifest (`projectGrantTarget`). The read role is planned as
 * `db grant` plans it: the `current_user` of `DATABASE_READ_URL`, when set, so
 * a statement for it that reaches the app (a member of it) is drift. Never throws: an unreadable
 * manifest, a project whose tables cannot be seen (no manifest, no entity that
 * loads) or a failed read is `checked: false`, with the reason as
 * `describeFailure` prints it.
 *
 * A read role that cannot be looked up does not hide the app role's part:
 * what `db grant` would change for the app role and PUBLIC does not depend on
 * it. What does is what the app holds as a member of another role — drift
 * when that role is the read role, held elsewhere otherwise — so that is left
 * out, and `readRole` says why.
 */
export async function getAppPrivilegesStatus(cwd: string = process.cwd(), databaseUrl?: string, queueSchema?: string): Promise<AppPrivilegesStatus>
{
    const url = databaseUrl ?? databaseUrlFor('db status');

    return readAppPrivileges(cwd, url, queueSchema).then(
        check => ({ checked: true as const, ...check }),
        (error: unknown) => ({ checked: false as const, detail: describeFailure(error, url) }),
    );
}

/**
 * The check, which of the project's declarations it compared with
 * (`projectGrantTarget`), and whether the read role was looked up. The queue
 * schema `queueSchema`, when the app declares one, is the target's queue
 * part, compared by the queue's rule as the step plans it; and, as for
 * `db grant`, a project declaring it that names no schema source has no table
 * of its own, rather than tables that cannot be seen.
 */
async function readAppPrivileges(cwd: string, url: string | undefined, queueSchema: string | undefined): Promise<AppPrivilegesCheck & { source: string; readRole: ReadRoleCheck }>
{
    const { target, source } = await projectGrantTarget(discoverFunctionMigrations(cwd), url ?? '', cwd, { jobs: queueSchema !== undefined });
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const connection = await statusConnection(url ?? '');

    try
    {
        const read = await lookUpReadRole();
        const check = await checkAppPrivileges(drizzle({ client: connection }), queueSchema === undefined ? target : { ...target, queue: { schema: queueSchema } }, read.name);

        return {
            ...check,
            heldElsewhere: read.readRole.checked ? check.heldElsewhere : check.heldElsewhere.filter(held => !held.through.startsWith('member of ')),
            schemaHeldElsewhere: read.readRole.checked ? check.schemaHeldElsewhere : check.schemaHeldElsewhere.filter(held => !held.through.startsWith('member of ')),
            source,
            readRole: read.readRole,
        };
    }
    finally
    {
        await connection.end();
    }
}

/**
 * The app's jobs declaration (`readJobsDeclaration`), none, or why it cannot
 * be read, in the error's words.
 */
export function readJobsDeclarationOf(cwd: string = process.cwd()): JobsDeclaration | undefined | { error: string }
{
    try
    {
        return readJobsDeclaration(cwd);
    }
    catch (error)
    {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * The queue schema as `db status` reports it, read as the app role: its
 * version against the one this build's pg-boss runs on
 * (`QUEUE_SCHEMA_VERSION`), its owner, what the app role may do there, and
 * how the server would start on it — the boot rule itself (`queueStart`), so
 * `refused` here is exactly a boot refusal, with its text.
 */
export type QueueStatus =
    | { checked: false; schema?: string; detail: string }
    | {
        checked: true;
        schema: string;
        required: number;
        /** The installed version; null when nothing is installed; absent when the app role may not read it or the schema is not pg-boss's */
        installed?: number | null;
        /** The schema's owner; null when there is no schema */
        owner: string | null;
        /**
         * Every role that owns the schema or an object in it, quoted as
         * identifiers, the schema's owner first (`QueueSchemaState.owners`);
         * empty when there is no schema. More than one, outside the app
         * role's own, is a queue no owner command resolves.
         */
        owners: readonly string[];
        /** The role `db status` connects as: the app role */
        appRole: string;
        database: string;
        /** Whether the app role is, or inherits, the owner of the schema and of every object in it (`ownsQueue`) */
        appOwnsQueue: boolean;
        appMayCreateOnDatabase: boolean;
        notPgBoss: boolean;
        start: QueueStart['kind'];
        /** The boot refusal's text, where `start` is `refused` */
        refusal?: string;
        /** The owner's step that resolves the refusal (`JobQueueSchemaError.step`); null where no command does */
        refusalStep?: QueueSchemaStep | null;
    };

/**
 * The declared queue schema's status (`QueueStatus`); undefined when the app
 * declares no jobs. Never throws: a declaration that cannot be read, or a
 * failed read, is `checked: false` with the reason.
 */
export async function getQueueStatus(
    declaration: ReturnType<typeof readJobsDeclarationOf>,
    databaseUrl?: string,
): Promise<QueueStatus | undefined>
{
    if (declaration === undefined)
    {
        return undefined;
    }

    if ('error' in declaration)
    {
        return { checked: false, detail: `the jobs declaration cannot be read: ${declaration.error}` };
    }

    const url = databaseUrl ?? databaseUrlFor('db status');

    return readQueueStatus(declaration.schema, url ?? '').catch((error: unknown) =>
        ({ checked: false as const, schema: declaration.schema, detail: describeFailure(error, url) }));
}

/** `QueueStatus` of `schema`, on a status connection to `url`. */
async function readQueueStatus(schema: string, url: string): Promise<QueueStatus>
{
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const connection = await statusConnection(url);

    try
    {
        const db = drizzle({ client: connection });
        const state = await readQueueSchemaState(db, schema);
        const [row] = catalogRows(await db.execute(sql`SELECT current_user::text AS role, current_database()::text AS database,
            (SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text FROM pg_catalog.pg_namespace n WHERE n.nspname = ${schema}) AS owner`));
        const start = queueStart(state, String(row.role), true);

        return {
            checked: true,
            schema,
            required: QUEUE_SCHEMA_VERSION,
            ...(state.version === undefined ? {} : { installed: state.version }),
            owner: row.owner === null ? null : String(row.owner),
            owners: state.owners,
            appRole: String(row.role),
            database: String(row.database),
            appOwnsQueue: ownsQueue(state),
            appMayCreateOnDatabase: state.mayCreateOnDatabase,
            notPgBoss: state.notPgBoss,
            start: start.kind,
            ...(start.kind === 'refused' ? { refusal: start.error.message, refusalStep: start.error.step } : {}),
        };
    }
    finally
    {
        await connection.end();
    }
}

/** The `current_user` of `DATABASE_READ_URL`, none when it is unset, or why it could not be asked. */
async function lookUpReadRole(): Promise<{ name?: string; readRole: ReadRoleCheck }>
{
    const url = env.DATABASE_READ_URL;

    if (!url)
    {
        return { readRole: { checked: true } };
    }

    return currentUserOn(url).then(
        name => ({ name, readRole: { checked: true as const } }),
        (error: unknown) => ({ readRole: { checked: false as const, detail: `the read role could not be looked up through DATABASE_READ_URL: ${describeFailure(error, url)}` } }),
    );
}

/** `SELECT current_user` on a status connection to `url`. */
async function currentUserOn(url: string): Promise<string>
{
    const connection = await statusConnection(url);

    try
    {
        const [row] = await connection`SELECT current_user::text AS role`;

        return String(row.role);
    }
    finally
    {
        await connection.end();
    }
}

/**
 * The text of the project's bookkeeping mismatch when `error` is one, else
 * undefined. A mismatch is not "could not check": the database answered, and
 * `spfn db migrate` refuses it, so every caller must stop and say so.
 */
export function bookkeepingMismatchOf(error: unknown): string | undefined
{
    return error instanceof MigrationBookkeepingMismatchError ? error.message : undefined;
}

/** PostgreSQL's SQLSTATE for "insufficient privilege". */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * What to do about a permission error reading the bookkeeping, in one line:
 * the grant step gives the app role USAGE on schema drizzle and SELECT on its
 * tables, and `spfn db grant` runs it alone.
 */
export const STATUS_GRANT_REMEDY = 'With DATABASE_OWNER_URL set, run spfn db grant: it grants the app role USAGE on schema drizzle and SELECT '
    + 'on its tables (the @spfn/core db README, "Database roles").';

/**
 * PostgreSQL's message when `error` is a permission error, else undefined.
 *
 * Not "could not check": the database answered and refused the app role, so
 * waiting or retrying changes nothing until someone grants the read. drizzle
 * wraps the driver's error, so the SQLSTATE is looked for along the causes.
 */
export function permissionDeniedOf(error: unknown): string | undefined
{
    for (let cause = error; cause instanceof Error; cause = cause.cause)
    {
        if ((cause as { code?: unknown }).code === INSUFFICIENT_PRIVILEGE)
        {
            return cause.message;
        }
    }

    return undefined;
}

/** The innermost message: drizzle's own one is the failed query's text. */
function readFailureOf(error: unknown): string
{
    let cause = error;

    while (cause instanceof Error && cause.cause instanceof Error)
    {
        cause = cause.cause;
    }

    return cause instanceof Error ? cause.message : String(cause);
}

export type StartupMigrationCheck = {
    /** The caller must stop: migrations are pending and nothing allows it. */
    block: boolean;
    /** Pass this on to the server process so it makes the same decision. */
    allowPending: boolean;
};

/**
 * Pre-flight check for `spfn dev` and `spfn start`.
 *
 * The server refuses the same boot by itself — this runs first only so the
 * refusal is immediate and readable instead of arriving as a child process that
 * died while the CLI waited for a readiness signal.
 *
 * Silent when there is no database to ask: a project without DATABASE_URL is
 * not migration drift. A status that could not be read is not drift either and
 * never blocks, but it is said in one line — the boot goes on unchecked, and a
 * permission error will not go away by itself. A project bookkeeping mismatch
 * blocks whatever the opt-out says, as the server's gate does: migrate refuses
 * that database.
 *
 * The environment variable is read through `@spfn/core/config`, the same
 * accessor the server's gate uses, so `1` and `yes` mean here what they mean
 * there — the CLI must never refuse a boot the server would have allowed.
 */
export async function checkPendingMigrationsBeforeStart(
    cwd: string,
    databaseUrl: string | undefined,
    flagAllowsPending: boolean,
): Promise<StartupMigrationCheck>
{
    loadEnv();

    const allowPending = flagAllowsPending || env.SPFN_ALLOW_PENDING_MIGRATIONS === true;

    const url = databaseUrl ?? databaseUrlFor('pre-start check');

    if (!url)
    {
        return { block: false, allowPending };
    }

    let status: MigrationStatus;

    try
    {
        status = await getMigrationStatus(cwd, url);
    }
    catch (error)
    {
        const mismatch = bookkeepingMismatchOf(error);

        // "Could not check" is not "checked and pending" — never block on it.
        if (mismatch === undefined)
        {
            warnUncheckedStart(error);

            return { block: false, allowPending };
        }

        refuseMismatchedBookkeeping(mismatch);

        return { block: true, allowPending };
    }

    const targets = pendingMigrationTargets(status);

    if (targets.length === 0)
    {
        return { block: false, allowPending };
    }

    const lines = formatPendingMigrations(targets);

    console.log('');

    if (allowPending)
    {
        console.warn(chalk.yellow(`⚠️  Starting with pending migrations — ${pendingMigrationsSummary(targets)}`));
        lines.forEach(line => console.warn(chalk.yellow(`   ${line}`)));
        console.warn(chalk.yellow(`   Requests hitting the missing columns will fail. ${RUN_MIGRATIONS_HINT}\n`));

        return { block: false, allowPending };
    }

    console.error(chalk.red(`❌ Refusing to start: ${pendingMigrationsSummary(targets)}`));
    lines.forEach(line => console.error(chalk.red(`   ${line}`)));
    console.error(chalk.yellow(`\n   ${RUN_MIGRATIONS_HINT}`));
    console.error(chalk.dim('   To start anyway: --allow-pending-migrations, or SPFN_ALLOW_PENDING_MIGRATIONS=true\n'));

    return { block: true, allowPending };
}

function warnUncheckedStart(error: unknown): void
{
    const remedy = permissionDeniedOf(error) === undefined
        ? 'run `pnpm spfn db status` to check'
        : STATUS_GRANT_REMEDY;

    console.warn(chalk.yellow(`⚠️  Could not check migrations: ${readFailureOf(error)} — starting anyway; ${remedy}`));
}

function refuseMismatchedBookkeeping(mismatch: string): void
{
    console.error(chalk.red(`\n❌ Refusing to start: ${mismatch}`));
    console.error(chalk.dim(`   ${MISMATCH_OVERRIDE_NOTE}\n`));
}
