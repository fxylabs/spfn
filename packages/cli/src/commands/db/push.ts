import chalk from 'chalk';
import prompts from 'prompts';
import { env } from '@spfn/core/config';
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
import { describeFailure } from '../../utils/database-failure.js';

export interface PushHint
{
    hint: string;
    statement?: string;
}

export interface PushPlan
{
    statements: string[];
    hints: PushHint[];
    /** Existing checks PostgreSQL reads differently from the declared ones, or could not compare: pushSchema leaves them as they are */
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
 * Both halves are planned read-only, once, before any write; destructive project
 * statements are settled next. Then each function package's pending migrations
 * apply (one committed transaction per package, as `db migrate`), then the
 * project statements (one transaction), so a project table may reference a
 * package table on an empty database.
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
 * of the diff: the package's own migrations carry them (step 9).
 *
 * drizzle-kit's push never alters an existing check whose expression changed
 * (an `enumCheck` given another value): push warns about each existing check
 * whose declared expression PostgreSQL reads differently from the stored one,
 * with the remedy, and changes nothing about it (see unchangedChecks for what
 * the comparison does and does not catch).
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
    //    own migrations (step 9) create and alter it.
    const imports = withoutFunctionPackageObjects(resolved.imports ?? await loadSchemaImports(resolved.files));

    // 3.5 Which PostgreSQL schemas to diff (see resolvePushSchemaFilter)
    const schemaFilter = resolvePushSchemaFilter(source?.schemaFilter, imports);

    // 3.7 Preflight: parse function package migrations before touching the DB,
    //     so an incompatible package fails before anything is applied.
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
            console.log(chalk.cyan('🔍 Dry run: nothing was applied.\n'));

            return;
        }

        // 8. Settle the destructive project statements before any write
        const selection = await selectProjectStatements(statements, result, options.force);

        // 9. Apply the function package migrations, then the project statements:
        //    a project table may reference a package table
        const packageMigrationsApplied = await applyFunctionMigrations(functionPlans);
        await applyProjectStatements(connection.db, selection, packageMigrationsApplied > 0);
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
    db: PushConnection['db'],
    { statements, skipped }: ProjectSelection,
    packageMigrationsApplied: boolean,
): Promise<void>
{
    try
    {
        if (statements.length > 0)
        {
            await applyStatements(db, statements);
        }
    }
    catch (error)
    {
        exitOnProjectFailure(error, packageMigrationsApplied);
    }

    if (statements.length > 0 || skipped > 0)
    {
        displayApplySummary(statements.length, skipped);
    }
}

/**
 * Print a failed project statement and exit 1, as `describeFailure` prints it:
 * the error, then the statement's own SQL — the operator's schema, which the
 * plan printed already.
 */
function exitOnProjectFailure(error: unknown, packageMigrationsApplied: boolean): never
{
    console.error(chalk.red(`\n❌ The project statements were rolled back: ${describeFailure(error, env.DATABASE_URL)}`));
    if (packageMigrationsApplied)
    {
        console.error(chalk.yellow('Function package migrations applied above stay applied; fix the schema and run spfn db push again.'));
    }
    process.exit(1);
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
async function applyFunctionMigrations(plans: FunctionMigrationPlan[]): Promise<number>
{
    if (plans.length === 0)
    {
        return 0;
    }

    console.log(chalk.blue('\n📦 Applying function package migrations:'));
    plans.forEach(plan => console.log(chalk.dim(`  - ${plan.packageName}`)));

    try
    {
        const applied = await executeFunctionMigrations(plans);
        console.log(chalk.green('\n✅ All function migrations applied\n'));

        return applied;
    }
    catch (error)
    {
        console.error(chalk.red('\n❌ Failed to apply function package migrations — nothing of the project schema was applied'));
        console.error(chalk.red(describeFailure(error, env.DATABASE_URL)));
        process.exit(1);
    }
}
