import chalk from 'chalk';
import prompts from 'prompts';
import { env } from '@spfn/core/config';
import { sql } from 'drizzle-orm';
import { packageNameToSchema, pendingFunctionMigrations, type AppPrivilegesTarget, type PendingFunctionMigrations } from '@spfn/core/db';

import {
    createPushConnection,
    loadProjectEntities,
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
    displayUncomparedChecks,
    displayUncomparedKinds,
} from './utils/push-display.js';
import { compareChecks, declaredEntities, type UncomparedCheck } from './utils/changed-checks.js';
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
import { entityGrantTarget, grantRetryNote, runAppGrantStep, SCHEMA_APPLIED_PRIVILEGES_UNCHANGED } from './utils/app-grants.js';

export interface PushHint
{
    hint: string;
    statement?: string;
}

export interface PushPlan
{
    statements: string[];
    hints: PushHint[];
    /** The kinds of declared object push does not compare (uncomparedKinds), each with how many */
    uncompared: string[];
    /** Existing checks push could not compare before applying (compareChecks), left as they are */
    uncomparedChecks: UncomparedCheck[];
}

/**
 * The project's plan: pushSchema's hints and statements, then the replacement
 * of each existing check whose declared expression PostgreSQL stores
 * differently (compareChecks), compared in `inRolledBackTransaction`: a
 * transaction on the one session `db` runs on, never a pool's (see
 * PushConnection.inRolledBackTransaction).
 */
export async function resolvePushPlan(
    imports: Record<string, unknown>,
    db: PushConnection['db'],
    schemaFilter: string[],
    inRolledBackTransaction: PushConnection['inRolledBackTransaction'],
): Promise<PushPlan>
{
    const { pushSchema } = await import('drizzle-kit/api-postgres');
    const { sqlStatements, hints } = await pushSchema(
        imports,
        db,
        {
            schemas: schemaFilter,
            tables: [],
            entities: undefined,
            extensions: [],
        },
    );
    const pushHints = hints as PushHint[];
    const hintStatements = pushHints.flatMap(hint => hint.statement ? [hint.statement] : []);
    const entities = await declaredEntities(imports, schemaFilter);
    const checks = await compareChecks(db, inRolledBackTransaction, entities);

    return {
        statements: [...hintStatements, ...sqlStatements, ...checks.replacements],
        hints: pushHints,
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
 * statements are settled next. Then each function package's pending migrations
 * apply (one committed transaction per package, as `db migrate`), then the
 * project statements (one transaction), so a project table may reference a
 * package table on an empty database. A database error at any of these stages
 * — planning, a package's migrations, the project statements — ends push the
 * same way: exit 1, the stage named, the error as `describeFailure` prints it,
 * and the ownership remedy when the catalog shows it. So does a connection
 * that cannot be opened, the dry run's read of `transaction_read_only` included
 * (the `connect` stage, with no remedy: there is no session to ask the catalog).
 * Last, as the owner and in a transaction of its own, the app role is granted
 * exactly what the entities declare (`appPrivileges`) and each function
 * package's manifest (app-grants.ts); its failure is the `privileges` stage:
 * the schema stays applied, and `spfn db grant` applies the privileges alone.
 *
 * - Default: auto-applies safe + warning, prompts for destructive
 * - --force: applies everything without prompting
 * - --dry-run: shows the classified SQL, each function package's pending
 *   migrations and the privilege statements (with the roles and how each was
 *   found), then stops. Each plan query runs in its own `BEGIN READ ONLY`
 *   transaction on one client, rolled back when the query ends, so PostgreSQL
 *   refuses any write and the dry run holds no lock between statements. Before
 *   the plan runs, `transaction_read_only` is read once, in one such
 *   transaction; every plan query then opens its transaction with the same
 *   `BEGIN READ ONLY`. When that read is not `on` it exits 1 instead. The
 *   one exception is comparing an existing check (compareChecks): one
 *   transaction per check, rolled back, that writes only a temporary table
 *   of its own and never touches the live one; a target that refuses it
 *   leaves the check not compared, and the plan goes on
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
 * it could not compare (compareChecks). What else drizzle-kit's push does not
 * compare is named in one line when the schema declares such an object
 * (uncomparedKinds).
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

    if (resolved.files.length === 0)
    {
        if (source)
        {
            console.error(chalk.red(`❌ No schema files found at ${label}: ${String(source.schema)}`));
            process.exit(1);
        }

        console.log(chalk.yellow(`No schema files found (${label}).`));

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
            await grantOrExit(grantTarget, target, true);
            console.log(chalk.cyan('\n🔍 Dry run: nothing was applied.\n'));

            return;
        }

        // 8. Settle the destructive project statements before any write
        const selection = await selectProjectStatements(statements, result, options.force);

        // 9. Apply the function package migrations, then the project statements:
        //    a project table may reference a package table
        const packageMigrationsApplied = await applyFunctionMigrations(functionPlans, target);
        await applyProjectStatements(target, selection, packageMigrationsApplied > 0);

        // 10. Grant the app role what is declared, in a transaction of its own
        await grantOrExit(grantTarget, target, false);
    }
    finally
    {
        await connection.close();
    }
}

/**
 * Where push writes, as its failure lines need it: the connection (the owner's)
 * and its rolled-back transactions, its URL to keep out of the output, and the
 * PostgreSQL schemas push manages.
 */
interface PushTarget
{
    db: PushConnection['db'];
    inRolledBackTransaction: PushConnection['inRolledBackTransaction'];
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
 * The privileges step: on a dry run it plans on the read-only connection and
 * a failure ends push at the `plan` stage; otherwise it applies, and a failure
 * is the `privileges` stage, after the schema changes committed.
 */
async function grantOrExit(grantTarget: AppPrivilegesTarget, target: PushTarget, dryRun: boolean): Promise<void>
{
    try
    {
        await runAppGrantStep(target.db, grantTarget, { dryRun, schemaPending: dryRun });
    }
    catch (error)
    {
        await exitOnFailure(dryRun ? 'plan' : 'privileges', error, target, dryRun ? undefined : grantRetryNote(error));
    }
}

/**
 * Plan both halves: the project diff via pushSchema and the checks it would
 * leave as they are (compared on temporary tables that roll back), and each
 * function package's pending migrations. drizzle-kit reads each table it would
 * drop a column of, or drop, for its data-loss check, so a table the owner may
 * not read fails here, before any write — and ends push as a failed write
 * does; so does a declared check expression PostgreSQL refuses.
 */
async function planOrExit(
    imports: Record<string, unknown>,
    schemaFilter: string[],
    functionPlans: FunctionMigrationPlan[],
    target: PushTarget,
): Promise<{ plan: PushPlan; pending: PendingFunctionMigrations[] }>
{
    try
    {
        return {
            plan: await resolvePushPlan(imports, target.db, schemaFilter, target.inRolledBackTransaction),
            pending: await pendingFunctionMigrations(target.db, functionPlans),
        };
    }
    catch (error)
    {
        return exitOnFailure('plan', error, target);
    }
}

/** Each stage of push a database error can end, and what its failure leaves behind. */
const FAILED_STAGES = {
    connect: 'Could not connect to the database — nothing was planned or applied',
    plan: 'Planning failed — nothing was applied',
    packages: 'Failed to apply function package migrations — nothing of the project schema was applied',
    project: 'The project statements were rolled back',
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
 * Print pushSchema's hints, what push does not compare, and the classified
 * project statements, or that the project schema has none.
 */
function displayProjectPlan(plan: PushPlan, result: ClassificationResult | undefined, dryRun?: boolean): void
{
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
