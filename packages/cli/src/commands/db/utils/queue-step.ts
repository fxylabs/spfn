/**
 * The queue step: the owner installs and migrates the jobs queue schema (#171)
 *
 * pg-boss, started with its defaults, creates and migrates its own schema as
 * the role the app connects as — the one place where the app role would own
 * and change structure. An app that runs jobs declares it in its package.json
 * (`"spfn": { "jobs": true }`, `@spfn/core/db`'s `readJobsDeclaration`), and
 * the owner commands `db push`, `db migrate` and `db grant` run this step
 * before their privileges step, so the queue's tables are the owner's and the
 * app role is granted on them in the same run (`spfn add` does nothing to the
 * queue). Without the declaration nothing of the queue is read, run or
 * printed, and the app installs the queue at its start as before.
 *
 * As the connection the command holds (the owner's, or the one role's in a
 * project without `DATABASE_OWNER_URL`), the step reads the queue schema's
 * state (`readQueueSchemaState`) and:
 *
 * | state | the step |
 * |---|---|
 * | schema, or an object in it, of a role the connection cannot act for | installs, migrates and grants nothing on the queue; prints the ownership remedy; the rest goes on, exit 0 |
 * | absent, or a schema with no object | runs pg-boss's install plan (`queueInstallSql`) |
 * | pg-boss at an older version | runs pg-boss's migration plan from it (`queueMigrationSql`) |
 * | pg-boss at the version core's pg-boss runs on | nothing |
 * | pg-boss at a newer version | nothing, one warning |
 * | older than pg-boss migrates from | `QueueSchemaVersionError`, nothing run |
 * | not pg-boss's, unreadable, or a schema the privileges step manages | `QueueStepRefusal`, nothing run |
 *
 * A plan is pg-boss's own multi-statement string, `BEGIN; …; COMMIT;` under
 * its advisory lock, run whole in one simple-protocol call (node-postgres
 * `query(text)` without parameters). An app starting at the same moment
 * takes the same lock and runs the same plan: the one that waits fails on
 * work already done. That failure (`isQueueSchemaRace`) is rolled back and
 * the state read again; the step judges from what it reads, and fails with
 * the error when the work is still not done. A dry run reads only, and lists
 * no queue privilege statement while a plan is to run (`runQueueStep`).
 */

import chalk from 'chalk';
import { sql } from 'drizzle-orm';
import {
    catalogRows,
    foreignOwnedObjects,
    readJobsDeclaration,
    type AppPrivilegesTarget,
    type ForeignOwnedObject,
    type JobsDeclaration,
} from '@spfn/core/db';
import type { QueueSchemaState } from '@spfn/core/job';

import { describeFailure } from '../../../utils/database-failure.js';
import { createPushConnection, type PushConnection } from './drizzle.js';
import { queueOwnershipRemedy } from './foreign-owners.js';
import { appGrantRoles, grantAppPrivileges, managedQueueSchemaReason, runAppGrantStepOn, type GrantStepOptions } from './app-grants.js';

/** A queue schema the step will not touch for a reason only the project can correct: nothing of the queue is run. */
export class QueueStepRefusal extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'QueueStepRefusal';
    }
}

/** The queue schema as the step judges it: its state, and what in it belongs to a role the connection cannot act for. */
interface QueueSchemaView
{
    readonly state: QueueSchemaState;
    readonly foreign: ForeignOwnedObject[];
}

/** pg-boss's plan to run: its install, or its migration from `from`, to `to`. */
interface QueuePlan
{
    readonly kind: 'install' | 'migration';
    readonly sql: string;
    readonly from?: number;
    readonly to: number;
}

/** What the step does on a queue schema: run a plan, or nothing, which `line` reports. */
interface QueueAction
{
    readonly plan?: QueuePlan;
    /** Whether the privileges step covers the queue afterwards */
    readonly grant: boolean;
    readonly line?: string;
}

/**
 * The project's jobs declaration, ending the command — nothing applied —
 * when its package.json cannot be read or `spfn.jobs` is malformed.
 */
export function readJobsDeclarationOrExit(): JobsDeclaration | undefined
{
    try
    {
        return readJobsDeclaration(process.cwd());
    }
    catch (error)
    {
        console.error(chalk.red(`❌ Invalid jobs declaration — nothing was applied: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

/**
 * Refuse, reading only, what the queue step would refuse on the database as
 * it is — a queue schema the privileges step manages (`target.schemas`), one
 * holding objects that are not pg-boss's, a version it cannot read or one
 * pg-boss cannot migrate from — so a command checks it before it applies
 * anything. Nothing without a declaration. What a command's own changes put
 * in the queue schema afterwards (a migration's raw SQL), the step itself
 * still refuses, after them.
 *
 * @throws QueueStepRefusal, QueueSchemaVersionError; a database error
 */
export async function checkQueueSchema(connection: PushConnection, target: AppPrivilegesTarget, jobs: JobsDeclaration | undefined): Promise<void>
{
    if (jobs !== undefined)
    {
        refuseManagedQueueSchema(target, jobs);
        await judgeQueueSchema(connection, jobs.schema);
    }
}

/**
 * `checkQueueSchema` on a connection of its own to `databaseUrl`, the
 * owner's, ending the command — nothing applied — on a refusal or a failed
 * read; opens nothing without a declaration.
 */
export async function checkQueueSchemaOrExit(databaseUrl: string, target: AppPrivilegesTarget, jobs: JobsDeclaration | undefined): Promise<void>
{
    if (jobs === undefined)
    {
        return;
    }

    await checkQueueSchemaOn(databaseUrl, target, jobs).catch((error: unknown) =>
    {
        console.error(chalk.red(`❌ The queue schema cannot be installed or migrated — nothing was applied: ${describeFailure(error, databaseUrl)}`));
        process.exit(1);
    });
}

async function checkQueueSchemaOn(databaseUrl: string, target: AppPrivilegesTarget, jobs: JobsDeclaration): Promise<void>
{
    const connection = await createPushConnection(databaseUrl);

    try
    {
        await checkQueueSchema(connection, target, jobs);
    }
    finally
    {
        await connection.close();
    }
}

/** @throws QueueStepRefusal when the declared queue schema is one of the managed `target.schemas` */
function refuseManagedQueueSchema(target: AppPrivilegesTarget, jobs: JobsDeclaration): void
{
    if (target.schemas.includes(jobs.schema))
    {
        throw new QueueStepRefusal(managedQueueSchemaReason(jobs.schema, 'run the command again'));
    }
}

/**
 * Install or migrate the declared queue schema on `connection`, or, with
 * `dryRun`, say what would run; then `target` with the queue part for the
 * privileges step — `target` unchanged without a declaration, for a queue
 * the connection cannot act for, or on a dry run with a plan to run. The
 * privileges step plans the queue's statements over the objects in the
 * catalog, which the plan creates or changes: before it runs they cannot be
 * read (push's dry run is read-only, and pg-boss's plan commits itself), so
 * the dry run says its statements follow and lists none, rather than list
 * those of the objects as they are, or a list of pg-boss's tables of its own.
 *
 * @throws QueueStepRefusal, QueueSchemaVersionError, QueueSchemaChangedError; a database error
 */
export async function runQueueStep(
    connection: PushConnection,
    target: AppPrivilegesTarget,
    jobs: JobsDeclaration | undefined,
    options: { dryRun?: boolean } = {},
): Promise<AppPrivilegesTarget>
{
    if (jobs === undefined)
    {
        return target;
    }

    refuseManagedQueueSchema(target, jobs);
    console.log(chalk.blue(`\n📦 Queue schema ${jobs.schema} (jobs, package.json)`));

    const judged = await judgeQueueSchema(connection, jobs.schema);

    if (judged.plan !== undefined && options.dryRun)
    {
        console.log(chalk.cyan(`   Would ${planChange(judged.plan)}`));
        console.log(chalk.dim(`   The queue's privilege statements follow the ${judged.plan.kind} and are not listed: they are planned over the objects it leaves`));

        return target;
    }

    const action = judged.plan === undefined ? judged : await runQueuePlan(connection, jobs.schema, judged.plan);

    if (action.line !== undefined)
    {
        console.log(action.line);
    }

    return action.grant ? { ...target, queue: { schema: jobs.schema } } : target;
}

/**
 * `runQueueStep`, then the privileges step, on one connection of their own
 * to `databaseUrl`, the owner's — `db migrate`, `db grant`. The roles are
 * resolved first, so roles that disagree are refused before the queue step
 * installs anything. Without a declaration, the privileges step alone, as
 * before.
 *
 * @throws as `appGrantRoles`, `runQueueStep` and `grantAppPrivileges`
 */
export async function runOwnerStepsOn(
    databaseUrl: string,
    target: AppPrivilegesTarget,
    jobs: JobsDeclaration | undefined,
    options: GrantStepOptions = {},
): Promise<void>
{
    if (jobs === undefined)
    {
        return runAppGrantStepOn(databaseUrl, target, options);
    }

    const roles = await appGrantRoles();
    const connection = await createPushConnection(databaseUrl);

    try
    {
        const queued = await runQueueStep(connection, target, jobs, options);

        if (roles)
        {
            await grantAppPrivileges(connection.db, queued, roles, options);
        }
    }
    finally
    {
        await connection.close();
    }
}

/**
 * Run `plan`, whole, and what the step then does. A failure is rolled back —
 * the failed statement leaves the session in its aborted transaction — and,
 * for pg-boss's lost race, the schema judged again, which decides: found
 * done, as found (owned elsewhere, when the app installed it); still to do,
 * or on any other failure, the plan's error stands — a `ROLLBACK` that fails
 * too (a connection lost mid-plan) included: it is the plan's error that says
 * what went wrong.
 */
async function runQueuePlan(connection: PushConnection, schema: string, plan: QueuePlan): Promise<QueueAction>
{
    const { isQueueSchemaRace } = await import('@spfn/core/job');
    const failure = await connection.query(plan.sql).then(() => undefined, (error: unknown) => ({ error }));

    if (failure === undefined)
    {
        return { grant: true, line: chalk.green(`   ✅ ${capitalised(planChange(plan))}: done`) };
    }

    const rolledBack = await connection.query('ROLLBACK').then(() => true, () => false);
    const again = rolledBack && isQueueSchemaRace(failure.error, plan.kind) ? await judgeQueueSchema(connection, schema) : { plan, grant: false };

    if (again.plan !== undefined)
    {
        throw failure.error;
    }

    return { ...again, line: `${chalk.dim(`   Another connection ran pg-boss's ${plan.kind} plan first (its lost race); read again:`)}\n${again.line}` };
}

/** `install pg-boss schema 26`, `migrate pg-boss schema 25 to 26`. */
function planChange(plan: QueuePlan): string
{
    return plan.kind === 'install' ? `install pg-boss schema ${plan.to}` : `migrate pg-boss schema ${plan.from} to ${plan.to}`;
}

/** What the step does on the queue schema `schema` as `connection` reads it now. */
async function judgeQueueSchema(connection: PushConnection, schema: string): Promise<QueueAction>
{
    const view = await readQueueSchemaView(connection, schema);

    if (view.state.notPgBoss)
    {
        throw new QueueStepRefusal(`Queue schema ${schema} holds objects that are not pg-boss's, so nothing of pg-boss is installed, migrated or `
            + 'granted there. Give the queue a schema of its own in the project\'s package.json ("spfn": { "jobs": { "schema": "<name>" } }), '
            + 'or move those objects out of it, then run the command again.');
    }

    if (view.foreign.length > 0)
    {
        return { grant: false, line: chalk.yellow(queueOwnershipRemedy(schema, view.foreign)) };
    }

    return versionAction(view.state);
}

/** The action for a pg-boss schema the connection owns, from its version. */
async function versionAction(state: QueueSchemaState): Promise<QueueAction>
{
    const { QUEUE_SCHEMA_VERSION, queueInstallSql, queueMigrationSql } = await import('@spfn/core/job');
    const { schema, version } = state;

    if (version === undefined)
    {
        throw new QueueStepRefusal(`Queue schema ${schema} is pg-boss's, but its version cannot be read as the connected role: `
            + `it needs USAGE on the schema and SELECT on ${schema}.version, which its owner holds unless they were revoked.`);
    }

    if (version === null)
    {
        return { plan: { kind: 'install', sql: queueInstallSql(schema), to: QUEUE_SCHEMA_VERSION }, grant: true };
    }

    if (version < QUEUE_SCHEMA_VERSION)
    {
        return { plan: { kind: 'migration', sql: queueMigrationSql(schema, version), from: version, to: QUEUE_SCHEMA_VERSION }, grant: true };
    }

    return version === QUEUE_SCHEMA_VERSION
        ? { grant: true, line: chalk.dim(`   At pg-boss schema ${version} — nothing to change`) }
        : { grant: true, line: chalk.yellow(`   ⚠️  At pg-boss schema ${version}, newer than the ${QUEUE_SCHEMA_VERSION} this @spfn/core's pg-boss `
            + 'runs on — left as it is: a newer release installed it') };
}

/**
 * The queue schema's state and its objects of a role the connection cannot
 * act for: `foreignOwnedObjects` lists the schema only where the connection
 * may not create in it, so a schema owned elsewhere that it may create in is
 * added (`schemaOwnedElsewhere`) — the privileges step leaves either alone.
 */
async function readQueueSchemaView(connection: PushConnection, schema: string): Promise<QueueSchemaView>
{
    const { readQueueSchemaState } = await import('@spfn/core/job');
    const state = await readQueueSchemaState(connection.db, schema);
    const objects = await foreignOwnedObjects(connection.db, [schema], schema);
    const schemaListed = objects.some(entry => entry.kind === 'SCHEMA');

    return {
        state,
        foreign: state.exists && !state.ownsSchema && !schemaListed ? [...await schemaOwnedElsewhere(connection, schema), ...objects] : objects,
    };
}

/** The schema `schema` as `foreignOwnedObjects` lists one, its owner the bootstrap superuser when its oid is 10 (`BOOTSTRAP_SUPERUSERID`). */
async function schemaOwnedElsewhere(connection: PushConnection, schema: string): Promise<ForeignOwnedObject[]>
{
    const rows = catalogRows(await connection.db.execute(sql`
        SELECT quote_ident(current_user) AS "connectedRole", quote_ident(pg_catalog.pg_get_userbyid(n.nspowner)) AS owner,
            n.nspowner = 10 AS bootstrap, 'SCHEMA' AS kind, quote_ident(n.nspname) AS object, NULL AS schema, n.nspname::text AS name,
            NULL AS arguments
        FROM pg_catalog.pg_namespace n
        WHERE n.nspname = ${schema} AND NOT pg_catalog.pg_has_role(n.nspowner, 'USAGE')`));

    return rows as unknown as ForeignOwnedObject[];
}

function capitalised(text: string): string
{
    return text.charAt(0).toUpperCase() + text.slice(1);
}
