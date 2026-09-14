import chalk from 'chalk';
import prompts from 'prompts';
import '@spfn/core/config';
import { loadEnv } from '@spfn/core/server';
import { sql } from 'drizzle-orm';

import {
    validateDatabasePrerequisites,
    loadSchemaImports,
    createPushConnection,
    resolvePushSchemaSource,
    resolvePushSchemaFilter,
    resolveSchemaFiles,
    withoutFunctionPackageObjects,
    type ResolvedSchema,
    type SchemaSource,
} from './utils/drizzle.js';
import { classifyStatements } from './utils/sql-classifier.js';
import { displayClassifiedStatements, displayDryRunSummary, displayApplySummary } from './utils/push-display.js';
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
}

export async function resolvePushPlan(
    imports: Record<string, unknown>,
    db: Awaited<ReturnType<typeof createPushConnection>>['db'],
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
    };
}

export async function applyStatements(
    db: Awaited<ReturnType<typeof createPushConnection>>['db'],
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
 * loaded: falling back silently would push a different schema than generate reads.
 */
async function loadSchemaSourceOrExit(explicit?: string): Promise<SchemaSource | undefined>
{
    try
    {
        return await resolvePushSchemaSource(explicit);
    }
    catch (error)
    {
        console.error(chalk.red(`❌ Could not load drizzle.config.ts: ${error instanceof Error ? error.message : String(error)}`));
        console.log(chalk.yellow('💡 Fix the config, or name the schema directly: spfn db push --schema <path>'));
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
 * - --dry-run: shows classified SQL without applying
 * - --schema: schema entry point; otherwise drizzle.config.ts (schema + schemaFilter),
 *   then core's default: the entities folder scan, or its config.ts registry
 *   (DRIZZLE_SCHEMA_PATH) when the folder holds no entity file or exports a table
 *   the folder does not define — as `db generate` reads it. A named source
 *   (--schema, drizzle.config.ts) with no files exits 1.
 *
 * Whichever files are read, objects in a schema a function package owns stay out
 * of the diff: the package's own migrations carry them (step 11).
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
    //    own migrations (step 11) create and alter it.
    const imports = withoutFunctionPackageObjects(resolved.imports ?? await loadSchemaImports(resolved.files));

    // 3.5 Which PostgreSQL schemas to diff (see resolvePushSchemaFilter)
    const schemaFilter = resolvePushSchemaFilter(source?.schemaFilter, imports);

    // 3.7 Preflight: parse function package migrations before touching the DB,
    //     so an incompatible package fails without applying the project schema.
    const functionPlans = loadFunctionPlansOrExit();

    // 4. Create DB connection
    const { db, close } = await createPushConnection();

    try
    {
        // 5. Compute diff via pushSchema (does NOT apply yet)
        const { statements, hints } = await resolvePushPlan(imports, db, schemaFilter);

        for (const hint of hints)
        {
            console.log(chalk.yellow(`⚠️  ${hint.hint}`));
        }

        // 6. Empty diff?
        if (statements.length === 0)
        {
            console.log(chalk.green('✅ No changes detected — database is up to date\n'));
            await applyFunctionMigrations(functionPlans);

            return;
        }

        // 7. Classify
        const result = classifyStatements(statements);

        // 8. Dry-run mode
        if (options.dryRun)
        {
            displayDryRunSummary(result);

            return;
        }

        // 9. Display what we found
        displayClassifiedStatements(result);

        // 10. Apply logic
        if (options.force)
        {
            // --force: apply everything
            console.log(chalk.dim('\n--force: applying all changes...'));
            await applyStatements(db, statements);
            displayApplySummary(statements.length, 0);
        }
        else if (result.destructive.length === 0)
        {
            // No destructive changes — safe to apply all
            await applyStatements(db, statements);
            displayApplySummary(statements.length, 0);
        }
        else
        {
            // Has destructive changes — prompt before applying anything so the
            // selected plan can run atomically in one transaction.
            const destructiveSet = new Set(result.destructive.map(s => s.sql));
            const nonDestructive = statements.filter(s => !destructiveSet.has(s));

            // Prompt for destructive
            console.log(chalk.red(`\n❌ ${result.destructive.length} destructive change(s) require confirmation:`));
            for (const stmt of result.destructive)
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

            if (confirm)
            {
                await applyStatements(db, statements);
                displayApplySummary(statements.length, 0);
            }
            else
            {
                if (nonDestructive.length > 0)
                {
                    await applyStatements(db, nonDestructive);
                }
                displayApplySummary(nonDestructive.length, result.destructive.length);
                console.log(chalk.dim('Tip: Use --force to apply all changes without prompting.\n'));
            }
        }

        // 11. Function package migrations
        await applyFunctionMigrations(functionPlans);
    }
    finally
    {
        await close();
    }
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
    plans.forEach(plan =>
    {
        console.log(chalk.dim(`  - ${plan.packageName}`));
    });

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
