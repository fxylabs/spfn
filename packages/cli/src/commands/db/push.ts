import chalk from 'chalk';
import prompts from 'prompts';
import '@spfn/core/config';
import { loadEnv } from '@spfn/core/server';
import { sql } from 'drizzle-orm';
import { pendingFunctionMigrations } from '@spfn/core/db';

import {
    validateDatabasePrerequisites,
    loadSchemaImports,
    createPushConnection,
    resolvePushSchemaSource,
    resolvePushSchemaFilter,
    resolveSchemaFiles,
    withoutFunctionPackageObjects,
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
    displayUnchangedChecks,
} from './utils/push-display.js';
import { declaredChecks, unchangedChecks, type UnchangedCheck } from './utils/unchanged-checks.js';
import {
    discoverFunctionMigrations,
    loadFunctionMigrationPlans,
    executeFunctionMigrations,
    type FunctionMigrationPlan,
} from '../../utils/function-migrations.js';

export interface PushHint
{
    hint: string;
    statement?: string;
}

export interface PushPlan
{
    statements: string[];
    hints: PushHint[];
    /** Checks whose expression changed: pushSchema leaves them as they are */
    unchangedChecks: UnchangedCheck[];
}

export async function resolvePushPlan(
    imports: Record<string, unknown>,
    db: PushConnection['db'],
    schemaFilter: string[],
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

    return {
        statements: [...hintStatements, ...sqlStatements],
        hints: pushHints,
        unchangedChecks: await unchangedChecks(db, await declaredChecks(imports, schemaFilter)),
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
async function resolveSchemaFilesOrExit(config: Parameters<typeof resolveSchemaFiles>[0]): Promise<ResolvedSchema>
{
    try
    {
        return await resolveSchemaFiles(config);
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
 * - Default: auto-applies safe + warning, prompts for destructive
 * - --force: applies everything without prompting
 * - --dry-run: shows the classified SQL and each function package's pending
 *   migrations, then stops. Each plan query runs in its own `BEGIN READ ONLY`
 *   transaction on one client, rolled back when the query ends, so PostgreSQL
 *   refuses any write and the dry run holds no lock between statements. Before
 *   the plan runs, `transaction_read_only` is read once, in one such
 *   transaction; every plan query then opens its transaction with the same
 *   `BEGIN READ ONLY`. When that read is not `on` it exits 1 instead
 * - --schema: schema entry point; otherwise drizzle.config.ts (schema + schemaFilter),
 *   then core's default: the entities folder scan, or its config.ts registry
 *   (DRIZZLE_SCHEMA_PATH) when the folder holds no entity file or exports a table
 *   the folder does not define — as `db generate` reads it. A named source
 *   (--schema, drizzle.config.ts) with no files exits 1, and so does a
 *   drizzle.config.ts that cannot be loaded, with --schema too: its
 *   schemaFilter is what push may touch.
 *
 * Whichever files are read, objects in a schema a function package owns stay out
 * of the diff: the package's own migrations carry them (step 8).
 *
 * drizzle-kit's push never alters an existing check whose expression changed
 * (an `enumCheck` given another value): push warns about each such check, with
 * the remedy, and changes nothing about it (see unchangedChecks).
 */
export async function dbPush(options: { force?: boolean; dryRun?: boolean; schema?: string } = {}): Promise<void>
{
    // 1. Prerequisites
    validateDatabasePrerequisites();
    loadEnv();

    // 2. Get drizzle config (schema file list + schemaFilter)
    const source = await loadSchemaSourceOrExit(options.schema);
    const { getDrizzleConfig } = await import('@spfn/core/db');
    const config = getDrizzleConfig({
        cwd: process.cwd(),
        schema: source?.schema,
        expandGlobs: true,
        disablePackageDiscovery: true,
    });
    const resolved = await resolveSchemaFilesOrExit(config);
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
    //    own migrations (step 8) create and alter it.
    const imports = withoutFunctionPackageObjects(resolved.imports ?? await loadSchemaImports(resolved.files));

    // 3.5 Which PostgreSQL schemas to diff (see resolvePushSchemaFilter)
    const schemaFilter = resolvePushSchemaFilter(source?.schemaFilter, imports);

    // 3.7 Preflight: parse function package migrations before touching the DB,
    //     so an incompatible package fails without applying the project schema.
    const functionPlans = loadFunctionPlansOrExit();

    // 4. Connect. A dry run runs each plan query in a read-only transaction
    //    of its own, so PostgreSQL refuses any write attempted on it.
    const connection = await openPushConnectionOrExit(options.dryRun);

    try
    {
        // 5. Plan, reading only: the project diff via pushSchema, the checks it
        //    leaves as they are, and each function package's pending migrations
        const plan = await resolvePushPlan(imports, connection.db, schemaFilter);
        const { statements } = plan;
        const pending = await pendingFunctionMigrations(connection.db, functionPlans);
        const result = classifyStatements(statements);

        // 6. Display. Function package lines only when a package is installed,
        //    as `db migrate` prints its header only then.
        displayProjectPlan(plan, statements.length === 0 ? undefined : result, options.dryRun);
        if (functionPlans.length > 0)
        {
            displayPendingFunctionMigrations(pending);
        }

        // 7. The one dry-run gate: every write comes after it
        if (options.dryRun)
        {
            console.log(chalk.cyan('🔍 Dry run: nothing was applied.\n'));

            return;
        }

        // 8. Apply the project statements, then the function package migrations
        await applyProjectStatements(connection.db, statements, result, options.force);
        await applyFunctionMigrations(functionPlans);
    }
    finally
    {
        await connection.close();
    }
}

/**
 * Connect for the plan. Each query of a dry run's plan runs inside
 * `BEGIN READ ONLY`; when the server does not report such a transaction
 * read-only, the command ends before planning rather than preview on a
 * session that could write.
 */
async function openPushConnectionOrExit(dryRun?: boolean): Promise<PushConnection>
{
    const connection = await createPushConnection({ readOnly: dryRun });

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
 * Print pushSchema's hints, the checks it leaves as they are, and the
 * classified project statements, or that the project schema has none.
 */
function displayProjectPlan(plan: PushPlan, result: ClassificationResult | undefined, dryRun?: boolean): void
{
    for (const hint of plan.hints)
    {
        console.log(chalk.yellow(`⚠️  ${hint.hint}`));
    }
    displayUnchangedChecks(plan.unchangedChecks);

    if (!result && plan.unchangedChecks.length > 0)
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

/**
 * Apply the project statements: everything with --force or when nothing is
 * destructive; otherwise destructive ones only after confirmation, in the same
 * transaction as the rest.
 */
async function applyProjectStatements(
    db: PushConnection['db'],
    statements: string[],
    result: ClassificationResult,
    force?: boolean,
): Promise<void>
{
    if (statements.length === 0)
    {
        return;
    }

    if (force)
    {
        console.log(chalk.dim('\n--force: applying all changes...'));
    }

    if (force || result.destructive.length === 0 || await confirmDestructive(result.destructive))
    {
        await applyStatements(db, statements);
        displayApplySummary(statements.length, 0);

        return;
    }

    const destructiveSet = new Set(result.destructive.map(s => s.sql));
    const nonDestructive = statements.filter(s => !destructiveSet.has(s));

    if (nonDestructive.length > 0)
    {
        await applyStatements(db, nonDestructive);
    }
    displayApplySummary(nonDestructive.length, result.destructive.length);
    console.log(chalk.dim('Tip: Use --force to apply all changes without prompting.\n'));
}

/**
 * List the destructive statements and ask before applying any of them.
 */
async function confirmDestructive(destructive: ClassificationResult['destructive']): Promise<boolean>
{
    console.log(chalk.red(`\n❌ ${destructive.length} destructive change(s) require confirmation:`));
    for (const stmt of destructive)
    {
        console.log(chalk.red(`   ${stmt.sql.replace(/\s+/g, ' ').trim()}`));
        console.log(chalk.dim(`   → ${stmt.reason}`));
    }

    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: 'Apply destructive changes?',
        initial: false,
    });

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
 * Run function package migrations (e.g., @spfn/cms)
 */
async function applyFunctionMigrations(plans: FunctionMigrationPlan[]): Promise<void>
{
    if (plans.length === 0)
    {
        return;
    }

    console.log(chalk.blue('\n📦 Applying function package migrations:'));
    plans.forEach(plan => console.log(chalk.dim(`  - ${plan.packageName}`)));

    try
    {
        await executeFunctionMigrations(plans);
        console.log(chalk.green('\n✅ All function migrations applied\n'));
    }
    catch (error)
    {
        console.error(chalk.red('\n❌ Failed to apply function package migrations'));
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        console.error(chalk.yellow('Project schema changes (if any) were already applied — only function package migrations failed.'));
        process.exit(1);
    }
}
