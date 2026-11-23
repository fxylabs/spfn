import chalk from 'chalk';
import prompts from 'prompts';
import { env } from '@spfn/core/config';
import { sql } from 'drizzle-orm';
import {
    packageNameToSchema,
    pendingFunctionMigrations,
    type AppPrivilegesTarget,
    type JobsDeclaration,
    type PendingFunctionMigrations,
} from '@spfn/core/db';

import {
    createPushConnection,
    loadProjectEntities,
    missingSchemaFiles,
    resolveProjectSchemaFiles,
    resolvePushSchemaSource,
    resolvePushSchemaFilter,
    type PushConnection,
    type ResolvedSchema,
    type SchemaSource,
} from './utils/drizzle.js';
import { classifyStatements, type ClassificationResult } from './utils/sql-classifier.js';
import {
    displayClassifiedStatements,
    displayDryRunSummary,
    displayApplySummary,
    displayPendingFunctionMigrations,
    displayReplacements,
    displayUncomparedChecks,
    displayUncomparedKinds,
    replacementLine,
} from './utils/push-display.js';
import {
    planProject,
    type HeldName,
    type PlanConnection,
    type PushStop,
    type Replacement,
} from './utils/push-steps.js';
import { declaredEntities, type UncomparedCheck } from './utils/changed-checks.js';
import { uncomparedKinds } from './utils/uncompared-kinds.js';
import {
    discoverFunctionMigrations,
    loadFunctionMigrationPlans,
    executeFunctionMigrations,
    type FunctionMigrationPlan,
} from '../../utils/function-migrations.js';
import { describeFailure, failedStatementOf, sqlStateOf } from '../../utils/database-failure.js';
import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';
import { OWNER_URL_MISSING } from './utils/database.js';
import { ownershipRemedy } from './utils/foreign-owners.js';
import {
    appGrantRoles,
    entityGrantTarget,
    grantAppPrivileges,
    grantRetryNote,
    SCHEMA_APPLIED_PRIVILEGES_UNCHANGED,
    type GrantRoles,
} from './utils/app-grants.js';
import { checkQueueSchema, readJobsDeclarationOrExit, runQueueStep } from './utils/queue-step.js';

export interface PushHint
{
    hint: string;
    statement?: string;
}

export interface PushPlan
{
    statements: string[];
    hints: PushHint[];
    /** Each kind drizzle-kit reported removed and added: planned as drops, then creates (push-steps.ts) */
    replacements: Replacement[];
    /** Set when push cannot plan such a kind: no statement is planned */
    stop?: PushStop;
    /** What push must create before the drops while a removed object holds its name: no statement is planned */
    heldNames?: HeldName[];
    /** What PostgreSQL refused of the drops-then-creates steps: no statement is planned */
    refused?: unknown;
    /** The kinds of declared object push does not compare (uncomparedKinds), each with how many */
    uncompared: string[];
    /** Existing checks push could not compare before applying (compareChecks), left as they are */
    uncomparedChecks: UncomparedCheck[];
}

/**
 * Plan the project statements as drizzle-kit's pushSchema plans them, reading
 * only. Push does not rename: only when drizzle-kit reports a kind with
 * objects both removed and added is the plan two pushSchema steps — the
 * drops, then the creates — run in the connection's `inRolledBackTransaction`
 * (planProject), which must hold one session: on a pool its `BEGIN`, its
 * statements and its `ROLLBACK` could each run on another connection and
 * commit what they write. Then the replacement of each existing check whose
 * declared expression PostgreSQL stores differently (compareChecks): compared
 * in the same `inRolledBackTransaction` on the database as it is, or, for two
 * steps, in their transaction after both (planProject).
 */
export async function resolvePushPlan(
    imports: Record<string, unknown>,
    connection: PlanConnection,
    schemaFilter: string[],
): Promise<PushPlan>
{
    const entities = await declaredEntities(imports, schemaFilter);
    const { steps, checks, ...project } = await planProject(imports, connection, schemaFilter, entities);

    return {
        statements: [...steps.flatMap(step => step.statements), ...checks.replacements],
        hints: steps.flatMap(step => step.hints),
        ...project,
        uncompared: uncomparedKinds(entities),
        uncomparedChecks: checks.uncompared,
    };
}

export async function applyStatements(
    db: PushConnection['db'],
    statements: string[],
): Promise<void>
{
    await db.transaction(async (tx: typeof db) =>
    {
        for (const statement of statements)
        {
            await tx.execute(sql.raw(statement));
        }
    });
}

/**
 * Resolve the schema source, ending the command when drizzle.config.ts cannot be
 * loaded, --schema or not: the config declares what push may touch.
 */
async function loadSchemaSourceOrExit(explicit?: string): Promise<SchemaSource | undefined>
{
    try
    {
        return await resolvePushSchemaSource(explicit);
    }
    catch (error)
    {
        console.error(chalk.red(`❌ ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

/**
 * Resolve the files to load, ending the command when the folder and the registry
 * each define objects the other lacks: no choice would keep every table.
 */
async function resolveSchemaFilesOrExit(databaseUrl: string, source: SchemaSource | undefined): Promise<ResolvedSchema>
{
    try
    {
        return await resolveProjectSchemaFiles(databaseUrl, source);
    }
    catch (error)
    {
        console.error(chalk.red(`❌ ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

/**
 * Push schema changes to database with safe-mode protection.
 *
 * Both halves are planned read-only, once, before any write; destructive project
 * statements are settled next. Push plans as drizzle-kit's pushSchema plans,
 * and does not rename: when drizzle-kit reports a kind with objects both
 * removed and added (a table gone and a table new, a column gone and a column
 * new in one table), that kind is planned in two pushSchema steps — the
 * drops, then the creates — in one transaction that always rolls back
 * (push-steps.ts), shown as one plan and applied in that order; a kind push
 * cannot plan so (a primary key replaced by another) ends push at the plan
 * stage, naming it (exitOnStop), and so does an object it must create before
 * the drops whose name an object it drops still holds (exitOnHeldNames). Then each
 * function package's pending migrations apply (one committed transaction per
 * package, as `db migrate`), then the project statements (one transaction),
 * so a project table may reference a package table on an empty database. A
 * database error at any of these stages — planning, a package's migrations,
 * the project statements — ends push the same way: exit 1, the stage named,
 * the error as `describeFailure` prints it, and the ownership remedy when the
 * catalog shows it. So does a connection that cannot be opened, the dry
 * run's read of `transaction_read_only` included (the `connect` stage, with
 * no remedy: there is no session to ask the catalog).
 * Then the app roles are resolved (roles that disagree end push at the
 * `privileges` stage, at `plan` on a dry run or in a project without schema
 * files) and, when package.json declares jobs, the queue schema is installed or
 * migrated as the owner (queue-step.ts); its failure is the `queue` stage. The
 * queue does not depend on the project's tables: in a project without schema
 * files push runs the queue step and grants the queue alone (pushQueueOnly).
 * What the step would refuse on the database as it is — a queue schema push
 * manages, one holding objects that are not pg-boss's, a version pg-boss
 * cannot migrate from — is read right after connecting and ends push at the
 * `plan` stage, before anything is planned or applied.
 * Last, as the owner and in a transaction of its own, the app role is granted
 * exactly what the entities declare (`appPrivileges`), each function
 * package's manifest and the queue (app-grants.ts); its failure is the
 * `privileges` stage: the schema stays applied, and `spfn db grant` runs the
 * queue step and applies the privileges alone.
 *
 * - Default: auto-applies safe + warning, prompts for destructive
 * - --force: applies everything without prompting
 * - --dry-run: shows the classified SQL, each function package's pending
 *   migrations, what it would install or migrate of the queue schema and the
 *   privilege statements (with the roles and how each was found), then
 *   stops. Each plan query runs in its own `BEGIN READ ONLY` transaction on
 *   one client, rolled back when the query ends, so PostgreSQL refuses any
 *   write and the dry run holds no lock between statements. Before
 *   the plan runs, `transaction_read_only` is read once, in one such
 *   transaction; every plan query then opens its transaction with the same
 *   `BEGIN READ ONLY`. When that read is not `on` it exits 1 instead. The
 *   exceptions: comparing an existing check (compareChecks), one transaction
 *   per check, rolled back, that writes only a temporary table of its own
 *   and never touches the live one — a target that refuses it leaves the
 *   check not compared, and the plan goes on; and a plan in two steps — only
 *   for a push drizzle-kit reports a kind removed and added in — which runs
 *   DDL in a transaction that always rolls back, holding the locks it takes
 *   (`ACCESS EXCLUSIVE` on a table it alters or drops) until then, with no
 *   `lock_timeout` of push's own
 * - --schema: schema entry point; otherwise drizzle.config.ts (schema + schemaFilter),
 *   then core's default: the entities folder scan, or its config.ts registry
 *   (DRIZZLE_SCHEMA_PATH) when the folder holds no entity file or exports a table
 *   the folder does not define — as `db generate` reads it. A named source
 *   (--schema, drizzle.config.ts) with no files exits 1, and so does a
 *   drizzle.config.ts that cannot be loaded, with --schema too: its
 *   schemaFilter is what push may touch.
 *
 * Whichever files are read, objects in a schema a function package owns stay out
 * of the diff: the package's own migrations carry them (step 9).
 *
 * drizzle-kit's push never alters an existing check whose expression changed
 * (an `enumCheck` given another value): push compares each existing check with
 * PostgreSQL's own normalisation, on a temporary table in a transaction it
 * rolls back — on a dry run too — and replaces each that differs, naming each
 * it could not compare (compareChecks); a plan in two steps compares them in
 * its own transaction, on the tables as both steps leave them. What else
 * drizzle-kit's push does not compare is named in one line when the schema
 * declares such an object (uncomparedKinds).
 */
export async function dbPush(options: { force?: boolean; dryRun?: boolean; schema?: string } = {}): Promise<void>
{
    // 1. Prerequisites: the owner's connection, for the plan as for the writes
    loadEnvFor('db push');
    const databaseUrl = databaseUrlFor('db push') ?? exitWithoutDatabaseUrl();

    // 2. Get drizzle config (schema file list + schemaFilter)
    const source = await loadSchemaSourceOrExit(options.schema);
    const resolved = await resolveSchemaFilesOrExit(databaseUrl, source);
    const label = source?.label ?? resolved.source;
    const jobs = readJobsDeclarationOrExit();
    const missing = missingSchemaFiles(source, resolved);

    if (missing === 'unmatched')
    {
        console.error(chalk.red(`❌ No schema files found at ${label}: ${String(source?.schema)}`));
        process.exit(1);
    }

    if (missing === 'unconfigured')
    {
        console.log(chalk.yellow(`No schema files found (${label}).`));
        await pushQueueOnly(databaseUrl, jobs, options.dryRun);

        return;
    }

    console.log(chalk.dim(`Schema from ${label}: ${resolved.files.length} file(s)`));
    if (resolved.note) console.log(chalk.yellow(`ℹ️  ${resolved.note}`));
    console.log();

    // 3. Load schema imports, less the objects a function package owns: a
    //    registry re-exports one of its tables for a relation, but the package's
    //    own migrations (step 9) create and alter it.
    const imports = await loadProjectEntities(resolved);

    // 3.5 Which PostgreSQL schemas to diff (see resolvePushSchemaFilter)
    const schemaFilter = resolvePushSchemaFilter(source?.schemaFilter, imports);

    // 3.7 Preflight: parse function package migrations and every privilege
    //     declaration before touching the DB, so an incompatible package or an
    //     unreadable manifest fails before anything is applied.
    const functionPlans = loadFunctionPlansOrExit();
    const grantTarget = loadGrantTargetOrExit(managedSchemas(schemaFilter, functionPlans), imports, functionPlans);

    // 4. Connect. A dry run runs each plan query in a read-only transaction
    //    of its own, so PostgreSQL refuses any write attempted on it.
    const connection = await openPushConnectionOrExit(databaseUrl, options.dryRun);
    const target: PushTarget = {
        db: connection.db,
        inRolledBackTransaction: connection.inRolledBackTransaction,
        databaseUrl,
        schemas: [...grantTarget.schemas],
    };

    try
    {
        // 4.5 What the queue step would refuse on the database as it is ends
        //     push here, nothing planned or applied
        await checkQueueSchema(connection, grantTarget, jobs).catch((error: unknown) => exitOnFailure('plan', error, target));

        // 5. Plan, reading only
        const { plan, pending } = await planOrExit(imports, schemaFilter, functionPlans, target);
        const { statements } = plan;
        const result = classifyStatements(statements);

        // 6. Display in apply order. Function package lines only when a package
        //    is installed, as `db migrate` prints its header only then.
        if (functionPlans.length > 0)
        {
            displayPendingFunctionMigrations(pending);
        }
        if (pending.some(pkg => pkg.entries.length > 0))
        {
            console.log(chalk.dim('Function package migrations are applied first, then the project statements.\n'));
        }
        displayProjectPlan(plan, statements.length === 0 ? undefined : result, options.dryRun);

        // 7. The one dry-run gate: every write comes after it
        if (options.dryRun)
        {
            await ownerStepsOrExit(grantTarget, jobs, connection, target, { dryRun: true, rolesStage: 'plan' });
            console.log(chalk.cyan('\n🔍 Dry run: nothing was applied.\n'));

            return;
        }

        // 8. Settle the destructive project statements before any write
        const selection = await selectProjectStatements(statements, result, options.force);

        // 9. Apply the function package migrations, then the project statements:
        //    a project table may reference a package table
        const packageMigrationsApplied = await applyFunctionMigrations(functionPlans, target);
        await applyProjectStatements(target, selection, packageMigrationsApplied > 0);

        // 10. Install or migrate the declared queue schema, then grant the app
        //     role what is declared, in a transaction of its own
        await ownerStepsOrExit(grantTarget, jobs, connection, target, { dryRun: false, rolesStage: 'privileges' });
    }
    finally
    {
        await connection.close();
    }
}

/**
 * Push in a project without schema files: the declared queue schema alone,
 * which does not depend on the project's tables — the queue step, then the
 * privileges on the queue and nothing else (no project schema, no function
 * package's, not `drizzle`), as the owner, the roles resolved before the
 * queue step; a dry run reads only. Nothing without a declaration.
 */
async function pushQueueOnly(databaseUrl: string, jobs: JobsDeclaration | undefined, dryRun = false): Promise<void>
{
    if (jobs === undefined)
    {
        return;
    }

    const connection = await openPushConnectionOrExit(databaseUrl, dryRun);
    const target: PushTarget = { db: connection.db, inRolledBackTransaction: connection.inRolledBackTransaction, databaseUrl, schemas: [] };

    try
    {
        await ownerStepsOrExit(entityGrantTarget([], {}, []), jobs, connection, target, { dryRun, rolesStage: 'plan' });
    }
    finally
    {
        await connection.close();
    }

    if (dryRun)
    {
        console.log(chalk.cyan('\n🔍 Dry run: nothing was applied.\n'));
    }
}

/**
 * Where push plans and writes, as its failure lines need it: the connection
 * (the owner's), its URL to keep out of the output, and the PostgreSQL
 * schemas push manages.
 */
interface PushTarget extends PlanConnection
{
    databaseUrl: string;
    schemas: string[];
}

/** The schemas push changes: the project's, each function package's, and `drizzle`, where the bookkeeping lives. */
function managedSchemas(schemaFilter: string[], functionPlans: FunctionMigrationPlan[]): string[]
{
    return [...new Set([...schemaFilter, ...functionPlans.map(plan => packageNameToSchema(plan.packageName)), 'drizzle'])];
}

/**
 * What the privileges step grants: the managed schemas, the entities'
 * declarations, and each function package's manifest — read before any
 * connection, so an unreadable manifest ends push with nothing applied.
 */
function loadGrantTargetOrExit(schemas: string[], imports: Record<string, unknown>, functionPlans: FunctionMigrationPlan[]): AppPrivilegesTarget
{
    try
    {
        return entityGrantTarget(schemas, imports, functionPlans);
    }
    catch (error)
    {
        console.error(chalk.red(`\n❌ Invalid app privileges declaration — nothing was applied: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

/**
 * The queue step, then the privileges step, on push's connection. The roles
 * are resolved first, as `db migrate` and `db grant` resolve them, so roles
 * that disagree are refused before the queue step installs anything; that
 * refusal ends push at `rolesStage` — `plan` while nothing is applied.
 */
async function ownerStepsOrExit(
    grantTarget: AppPrivilegesTarget,
    jobs: JobsDeclaration | undefined,
    connection: PushConnection,
    target: PushTarget,
    options: { dryRun: boolean; rolesStage: 'plan' | 'privileges' },
): Promise<void>
{
    const { dryRun, rolesStage } = options;
    const roles = await appGrantRoles()
        .catch((error: unknown) => exitOnFailure(rolesStage, error, target, rolesStage === 'privileges' ? grantRetryNote(error) : undefined));
    const queued = await queueOrExit(grantTarget, jobs, connection, target, dryRun);

    if (roles)
    {
        await grantOrExit(queued, roles, target, dryRun);
    }
}

/**
 * The queue step (queue-step.ts) on push's connection, and the privileges
 * target with the queue part: on a dry run it reads only, and a failure ends
 * push at the `plan` stage; otherwise at the `queue` stage, after the schema
 * changes committed.
 */
async function queueOrExit(
    grantTarget: AppPrivilegesTarget,
    jobs: JobsDeclaration | undefined,
    connection: PushConnection,
    target: PushTarget,
    dryRun: boolean,
): Promise<AppPrivilegesTarget>
{
    try
    {
        return await runQueueStep(connection, grantTarget, jobs, { dryRun });
    }
    catch (error)
    {
        return exitOnFailure(dryRun ? 'plan' : 'queue', error, target, dryRun ? undefined : grantRetryNote(error));
    }
}

/**
 * The privileges step: on a dry run it plans on the read-only connection and
 * a failure ends push at the `plan` stage; otherwise it applies, and a failure
 * is the `privileges` stage, after the schema changes committed.
 */
async function grantOrExit(grantTarget: AppPrivilegesTarget, roles: GrantRoles, target: PushTarget, dryRun: boolean): Promise<void>
{
    try
    {
        await grantAppPrivileges(target.db, grantTarget, roles, { dryRun, schemaPending: dryRun });
    }
    catch (error)
    {
        await exitOnFailure(dryRun ? 'plan' : 'privileges', error, target, dryRun ? undefined : grantRetryNote(error));
    }
}

/**
 * Plan both halves: the project diff via pushSchema — reading only, or in a
 * transaction that rolls back when it is two steps (resolvePushPlan) — the
 * checks it would leave as they are (compared on temporary tables that roll
 * back), and each function package's pending migrations. drizzle-kit reads
 * each table it would drop a column of, or drop, for its data-loss check, so
 * a table the owner may not read fails here, before any write — and ends push
 * as a failed write does; so does a declared check expression PostgreSQL
 * refuses. A kind push cannot split ends it at the same stage (exitOnStop),
 * so does a name held by what it drops (exitOnHeldNames), and so does a
 * statement of the two steps PostgreSQL refuses, with what they were for.
 */
async function planOrExit(
    imports: Record<string, unknown>,
    schemaFilter: string[],
    functionPlans: FunctionMigrationPlan[],
    target: PushTarget,
): Promise<{ plan: PushPlan; pending: PendingFunctionMigrations[] }>
{
    const planned = await planBothHalves(imports, schemaFilter, functionPlans, target);

    if (planned.plan.stop)
    {
        exitOnStop(planned.plan.stop);
    }
    if (planned.plan.heldNames)
    {
        exitOnHeldNames(planned.plan.heldNames, planned.plan.replacements);
    }
    if (planned.plan.refused)
    {
        await exitOnFailure('plan', planned.plan.refused, target, twoStepNote(planned.plan.replacements));
    }

    return planned;
}

/** The project plan and each function package's pending migrations, ending push at the `plan` stage when either cannot be read. */
async function planBothHalves(
    imports: Record<string, unknown>,
    schemaFilter: string[],
    functionPlans: FunctionMigrationPlan[],
    target: PushTarget,
): Promise<{ plan: PushPlan; pending: PendingFunctionMigrations[] }>
{
    try
    {
        return {
            plan: await resolvePushPlan(imports, target, schemaFilter),
            pending: await pendingFunctionMigrations(target.db, functionPlans),
        };
    }
    catch (error)
    {
        return exitOnFailure('plan', error, target);
    }
}

/**
 * End push at the plan stage, nothing applied, when drizzle-kit reports a
 * kind removed and added that push cannot plan as drops, then creates: the
 * kind, why, what push reads of it, and the two ways that work.
 */
function exitOnStop(stop: PushStop): never
{
    console.error(chalk.red(`\n❌ Planning stopped — nothing was applied: drizzle-kit finds a ${stop.kind} removed and another added, `
        + `and db push does not rename; ${stop.reason}`));
    stop.replacements.forEach(replacement => console.error(chalk.red(`   ${replacementLine(replacement)}`)));
    console.log(chalk.yellow('💡 Push twice — first without the removed one, then with the added one — '
        + 'or use spfn db generate (in a terminal, where it asks whether this is a rename) and spfn db migrate.'));
    process.exit(1);
}

/**
 * End push at the plan stage, nothing applied, when what it must create
 * before the drops has a name an object it drops still holds: the two orders
 * contradict, so each such object and its name's holder are named, with the
 * route that orders them as the change needs.
 */
function exitOnHeldNames(heldNames: HeldName[], replacements: Replacement[]): never
{
    console.error(chalk.red('\n❌ Planning stopped — nothing was applied: db push does not rename; it drops, then creates, for'));
    replacements.forEach(replacement => console.error(chalk.red(`   ${replacementLine(replacement)}`)));
    console.error(chalk.red('and must create before the drops what still has the name of an object it drops:'));
    heldNames.forEach(({ created, holder, names }) => console.error(chalk.red(`   ${created}: the name is held by ${holder}, which this push drops`
        + (names ? `; it names ${names} by identifier, so push creates it before the drops` : ''))));
    console.log(chalk.yellow('💡 Use spfn db generate (in a terminal, where it asks whether this is a rename) and spfn db migrate: '
        + 'a migration drops and creates in the order the change needs. Or push twice: first without the object named above, then with it.'));
    process.exit(1);
}

/** What a plan failure adds when push planned the drops, then the creates. */
function twoStepNote(replacements: Replacement[]): string | undefined
{
    if (replacements.length === 0)
    {
        return undefined;
    }

    return ['db push does not rename: it planned the drops, then the creates, for', ...replacements.map(replacement => `   ${replacementLine(replacement)}`),
        'and PostgreSQL refused a statement of those two steps (nothing of them stays). When the change needs another order, '
        + 'push it twice — what is added first, what is removed next, or the other way round — or use spfn db generate and spfn db migrate.']
        .join('\n');
}

/** Each stage of push a database error can end, and what its failure leaves behind. */
const FAILED_STAGES = {
    connect: 'Could not connect to the database — nothing was planned or applied',
    plan: 'Planning failed — nothing was applied',
    packages: 'Failed to apply function package migrations — nothing of the project schema was applied',
    project: 'The project statements were rolled back',
    queue: 'The queue schema was not installed or migrated, and no privilege was changed — any schema change above stays applied',
    privileges: SCHEMA_APPLIED_PRIVILEGES_UNCHANGED,
} as const;

/**
 * End push on a failure at `stage` — the one way every stage ends: exit 1, the
 * stage's line with the error as `describeFailure` prints it (core's fields,
 * never a bound parameter or the URL), the ownership remedy when the catalog
 * shows another role owns what push manages, then `note`.
 */
async function exitOnFailure(stage: keyof typeof FAILED_STAGES, error: unknown, target: PushTarget, note?: string): Promise<never>
{
    printStageFailure(stage, error, target.databaseUrl);
    await printOwnershipRemedy(error, target);
    if (note)
    {
        console.error(chalk.yellow(note));
    }
    process.exit(1);
}

/** The line a failure at `stage` prints: the stage, then the error as `describeFailure` prints it. */
function printStageFailure(stage: keyof typeof FAILED_STAGES, error: unknown, databaseUrl: string): void
{
    console.error(chalk.red(`\n❌ ${FAILED_STAGES[stage]}: ${describeFailure(error, databaseUrl)}`));
}

/**
 * Connect for the plan, ending push at the `connect` stage when the connection
 * or the dry run's first read fails. Each query of a dry run's plan runs inside
 * `BEGIN READ ONLY`; when the server does not report such a transaction
 * read-only, the command ends before planning rather than preview on a
 * session that could write.
 */
async function openPushConnectionOrExit(databaseUrl: string, dryRun?: boolean): Promise<PushConnection>
{
    const connection = await createPushConnection(databaseUrl, { readOnly: dryRun }).catch((error: unknown) =>
    {
        printStageFailure('connect', error, databaseUrl);

        return process.exit(1);
    });

    if (!dryRun || connection.transactionReadOnly === 'on')
    {
        return connection;
    }

    await connection.close();
    console.error(chalk.red(`❌ --dry-run plans in read-only transactions, but after BEGIN READ ONLY the server `
        + `reported transaction_read_only=${connection.transactionReadOnly} — nothing was planned or applied`));
    console.log(chalk.yellow('💡 Something between the CLI and PostgreSQL (a pooler or proxy) changed the transaction; connect to PostgreSQL directly for a dry run'));
    process.exit(1);
}

/**
 * Print the kinds planned as drops, then creates, pushSchema's hints, what
 * push does not compare, and the classified project statements, or that the
 * project schema has none.
 */
function displayProjectPlan(plan: PushPlan, result: ClassificationResult | undefined, dryRun?: boolean): void
{
    displayReplacements(plan.replacements);
    for (const hint of plan.hints)
    {
        console.log(chalk.yellow(`⚠️  ${hint.hint}`));
    }
    displayUncomparedChecks(plan.uncomparedChecks);
    displayUncomparedKinds(plan.uncompared);

    if (!result && plan.uncomparedChecks.length > 0)
    {
        console.log(chalk.yellow('No statements to apply; the checks above stay as they are\n'));
    }
    else if (!result)
    {
        console.log(chalk.green('✅ No changes detected — project schema is up to date\n'));
    }
    else if (dryRun)
    {
        displayDryRunSummary(result);
    }
    else
    {
        displayClassifiedStatements(result);
        console.log('');
    }
}

interface ProjectSelection
{
    statements: string[];
    skipped: number;
}

/**
 * The project statements to apply: all of them with --force or when nothing is
 * destructive; otherwise destructive ones only after confirmation. Answering No
 * keeps the rest, which still apply after the function package migrations; an
 * aborted or impossible confirmation ends the command before any write.
 */
async function selectProjectStatements(
    statements: string[],
    result: ClassificationResult,
    force?: boolean,
): Promise<ProjectSelection>
{
    if (force && statements.length > 0)
    {
        console.log(chalk.dim('\n--force: applying all changes...'));
    }

    if (force || result.destructive.length === 0 || await confirmDestructive(result.destructive))
    {
        return { statements, skipped: 0 };
    }

    const destructiveSet = new Set(result.destructive.map(s => s.sql));
    console.log(chalk.dim('Tip: Use --force to apply all changes without prompting.\n'));

    return {
        statements: statements.filter(s => !destructiveSet.has(s)),
        skipped: result.destructive.length,
    };
}

/**
 * Apply the selected project statements in one transaction. On failure it
 * rolls back and exits 1; function package migrations this run committed stay.
 */
async function applyProjectStatements(
    target: PushTarget,
    { statements, skipped }: ProjectSelection,
    packageMigrationsApplied: boolean,
): Promise<void>
{
    try
    {
        if (statements.length > 0)
        {
            await applyStatements(target.db, statements);
        }
    }
    catch (error)
    {
        await exitOnFailure('project', error, target, packageMigrationsApplied
            ? 'Function package migrations applied above stay applied; fix the schema and run spfn db push again.'
            : undefined);
    }

    if (statements.length > 0 || skipped > 0)
    {
        displayApplySummary(statements.length, skipped);
    }
}

/**
 * List the destructive statements and ask before applying any of them. Only an
 * explicit answer comes back: a confirmation that is aborted (Ctrl-C, EOF) or
 * cannot be asked (stdin is not a terminal) exits 1 with nothing applied.
 */
async function confirmDestructive(destructive: ClassificationResult['destructive']): Promise<boolean>
{
    console.log(chalk.red(`\n❌ ${destructive.length} destructive change(s) require confirmation:`));
    for (const stmt of destructive)
    {
        console.log(chalk.red(`   ${stmt.sql.replace(/\s+/g, ' ').trim()}`));
        console.log(chalk.dim(`   → ${stmt.reason}`));
    }

    if (!process.stdin.isTTY)
    {
        console.error(chalk.red('\n❌ Destructive changes need a confirmation and stdin is not a terminal — nothing was applied'));
        console.log(chalk.yellow('💡 Pass --force to apply them, or run spfn db push in a terminal to choose.'));
        process.exit(1);
    }

    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: 'Apply these destructive changes? No skips them; the other project statements and the function package migrations are still applied.',
        initial: false,
    });

    if (typeof confirm !== 'boolean')
    {
        console.error(chalk.red('\n❌ The confirmation was aborted — nothing was applied'));
        process.exit(1);
    }

    return confirm;
}

/**
 * Discover function packages and parse their migration folders.
 * Exits before any DB work when a package ships unreadable migrations.
 */
function loadFunctionPlansOrExit(): FunctionMigrationPlan[]
{
    const functions = discoverFunctionMigrations(process.cwd());

    try
    {
        return loadFunctionMigrationPlans(functions);
    }
    catch (error)
    {
        console.error(chalk.red('\n❌ Invalid function package migrations — nothing was applied'));
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        process.exit(1);
    }
}

/**
 * Run function package migrations (e.g., @spfn/cms); returns how many applied.
 */
async function applyFunctionMigrations(plans: FunctionMigrationPlan[], target: PushTarget): Promise<number>
{
    if (plans.length === 0)
    {
        return 0;
    }

    console.log(chalk.blue('\n📦 Applying function package migrations:'));
    plans.forEach(plan => console.log(chalk.dim(`  - ${plan.packageName}`)));

    try
    {
        const applied = await executeFunctionMigrations(plans, target.databaseUrl);
        console.log(chalk.green('\n✅ All function migrations applied\n'));

        return applied;
    }
    catch (error)
    {
        return exitOnFailure('packages', error, target);
    }
}

function exitWithoutDatabaseUrl(): never
{
    console.error(chalk.red(OWNER_URL_MISSING));
    console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL (and DATABASE_OWNER_URL for the table owner) to your .env file'));
    process.exit(1);
}

/**
 * Say what to do when PostgreSQL refused push a privilege (SQLSTATE 42501)
 * because objects push manages belong to another role — a database pushed
 * through DATABASE_URL before push connected as the owner. Only with an owner
 * URL of its own can another role own them, and only the catalog can say they
 * do: it is asked on the owner's connection once the failed transaction is
 * over. Any other 42501, or a catalog that cannot be read, adds nothing.
 */
async function printOwnershipRemedy(error: unknown, target: PushTarget): Promise<void>
{
    if (sqlStateOf(error) !== '42501' || !env.DATABASE_OWNER_URL || env.DATABASE_OWNER_URL === env.DATABASE_URL)
    {
        return;
    }

    const remedy = await ownershipRemedy(target.db, target.schemas, failedStatementOf(error));

    if (remedy)
    {
        console.error(chalk.yellow(remedy));
    }
}
