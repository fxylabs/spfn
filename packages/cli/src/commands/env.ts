import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { VALID_ENVS, loadEnvSchema, getTargetFile, type EnvSchemaEntry } from '../utils/env-schema.js';
import {
    alsoDeclaredBy,
    describeEnvList,
    groupBySource,
    loadEnvList,
    type EnvList,
    type EnvSource,
} from '../utils/env-list.js';

/**
 * Base environment file targets (no NODE_ENV)
 */
const BASE_ENV_FILES = {
    nextjs: ['.env', '.env.local'],
    server: ['.env.server'],
} as const;

/**
 * Get all env files for a given NODE_ENV (loading order: low -> high priority)
 */
function getEnvFilesForEnvironment(nodeEnv?: string): string[]
{
    const files: string[] = ['.env'];

    if (nodeEnv)
    {
        files.push(`.env.${nodeEnv}`);
    }

    if (nodeEnv !== 'test')
    {
        files.push('.env.local');
    }

    if (nodeEnv)
    {
        files.push(`.env.${nodeEnv}.local`);
    }

    files.push('.env.server');

    return files;
}

/**
 * Format type with color
 */
function formatType(type: string): string
{
    const typeColors: Record<string, (str: string) => string> = {
        string: chalk.green,
        number: chalk.blue,
        boolean: chalk.yellow,
        url: chalk.cyan,
        enum: chalk.magenta,
        json: chalk.red,
    };

    return (typeColors[type] || chalk.white)(type);
}

/**
 * Format default value
 */
function formatDefault(value: any, type: string): string
{
    if (value === undefined)
    {
        return chalk.dim('(none)');
    }

    if (type === 'string' || type === 'url')
    {
        return chalk.green(`"${value}"`);
    }

    if (type === 'boolean')
    {
        return value ? chalk.green('true') : chalk.red('false');
    }

    return chalk.cyan(String(value));
}

/**
 * List all environment variables from schema
 */
async function listEnvVars(options: { package?: string; group?: boolean }): Promise<void>
{
    const label = describeEnvList(options);

    try
    {
        const list = await loadEnvList(options);
        const allVars = orderedVars(list);

        printNotices(list);

        if (options.group)
        {
            // Group by target file
            const grouped = allVars.reduce((acc, [key, schema]) =>
            {
                const target = getTargetFile(schema);
                if (!acc[target]) acc[target] = [];
                acc[target].push([key, schema]);

                return acc;
            }, {} as Record<string, [string, any][]>);

            console.log(chalk.blue.bold(`\n📋 Environment Variables by File (${label})\n`));

            for (const [file, vars] of Object.entries(grouped))
            {
                console.log(chalk.bold.magenta(`\n${file}`));
                console.log(chalk.dim('─'.repeat(50)));

                for (const [key, schema] of vars)
                {
                    printEnvVar(key, schema, false, list.declaredBy[key]);
                }
            }
        }
        else
        {
            console.log(chalk.blue.bold(`\n📋 Environment Variables (${label})\n`));

            for (const group of groupBySource(list))
            {
                console.log(chalk.bold.magenta(`\n${group.source}`));
                console.log(chalk.dim('─'.repeat(50)));

                for (const entry of group.entries)
                {
                    printEnvVar(entry.key, entry, true, alsoDeclaredBy(list, entry.key));
                }
            }
        }

        console.log(chalk.dim('\n💡 Tip: Use `spfn env init` to generate .env template files\n'));
    }
    catch (error)
    {
        console.error(chalk.red(`\n❌ ${error instanceof Error ? error.message : 'Unknown error'}\n`));
        process.exit(1);
    }
}

/**
 * Every entry of the list as `[key, entry]`, grouped by the source declaring it
 */
function orderedVars(list: EnvList): [string, EnvSchemaEntry][]
{
    return groupBySource(list).flatMap((group) => group.entries.map((entry): [string, EnvSchemaEntry] => [entry.key, entry]));
}

/**
 * Report keys that two sources declare with different required/sensitive flags
 */
function printNotices(list: EnvList): void
{
    for (const notice of list.notices)
    {
        console.log(chalk.yellow(`⚠️  ${notice}`));
    }
}

/**
 * Print a single environment variable
 *
 * `sources` lists where else the key is declared (or, grouped by file, every
 * source declaring it); nothing is printed for it when empty.
 */
function printEnvVar(key: string, schema: any, showFile = false, sources: string[] = []): void
{
    const typeStr = formatType(schema.type);
    const requiredStr = schema.required || schema.default !== undefined
        ? chalk.red('[required]')
        : chalk.dim('[optional]');
    const sensitiveStr = schema.sensitive ? chalk.yellow(' [sensitive]') : '';
    const fileStr = showFile ? chalk.dim(` → ${getTargetFile(schema)}`) : '';

    console.log(`${chalk.bold.cyan(key)} ${chalk.dim('(')}${typeStr}${chalk.dim(')')} ${requiredStr}${sensitiveStr}${fileStr}`);
    console.log(`  ${chalk.dim(schema.description)}`);

    if (sources.length > 0)
    {
        console.log(`  ${chalk.dim(showFile ? 'Also declared by:' : 'Declared by:')} ${chalk.dim(sources.join(', '))}`);
    }

    if (schema.default !== undefined)
    {
        console.log(`  ${chalk.dim('Default:')} ${formatDefault(schema.default, schema.type)}`);
    }

    if (schema.examples && schema.examples.length > 0)
    {
        const exampleStr = schema.examples
            .map((ex: any) => formatDefault(ex, schema.type))
            .join(', ');
        console.log(`  ${chalk.dim('Examples:')} ${exampleStr}`);
    }

    console.log();
}

/**
 * Show environment variable statistics
 */
async function showEnvStats(options: { package?: string }): Promise<void>
{
    try
    {
        const list = await loadEnvList(options);

        console.log(chalk.blue.bold(`\n📊 Environment Variable Statistics (${describeEnvList(options)})\n`));

        const allVars = orderedVars(list) as [string, any][];
        const required = allVars.filter(([_, schema]) => schema.required || schema.default !== undefined);
        const optional = allVars.filter(([_, schema]) => !schema.required && schema.default === undefined);
        const sensitive = allVars.filter(([_, schema]) => schema.sensitive);
        const nextjsVars = allVars.filter(([_, schema]) =>
            schema.nextjs ?? schema.key?.startsWith('NEXT_PUBLIC_'),
        );
        const serverOnlyVars = allVars.filter(([_, schema]) =>
            !(schema.nextjs ?? schema.key?.startsWith('NEXT_PUBLIC_')),
        );

        const typeCount = allVars.reduce((acc, [_, schema]) =>
        {
            acc[schema.type] = (acc[schema.type] || 0) + 1;

            return acc;
        }, {} as Record<string, number>);

        const fileCount = allVars.reduce((acc, [_, schema]) =>
        {
            const file = getTargetFile(schema);
            acc[file] = (acc[file] || 0) + 1;

            return acc;
        }, {} as Record<string, number>);

        console.log(`${chalk.bold('Total variables:')} ${chalk.cyan(allVars.length)}`);
        console.log(`${chalk.bold('Required:')} ${chalk.red(required.length)}`);
        console.log(`${chalk.bold('Optional:')} ${chalk.dim(optional.length)}`);
        console.log(`${chalk.bold('Sensitive:')} ${chalk.yellow(sensitive.length)}`);

        console.log(chalk.bold('\nBy Target:'));
        console.log(`  ${chalk.blue('Next.js accessible:')} ${chalk.cyan(nextjsVars.length)}`);
        console.log(`  ${chalk.magenta('SPFN server only:')} ${chalk.cyan(serverOnlyVars.length)}`);

        console.log(chalk.bold('\nBy File:'));

        for (const [file, count] of Object.entries(fileCount))
        {
            console.log(`  ${chalk.dim(file)}: ${chalk.cyan(count)}`);
        }

        console.log(chalk.bold('\nBy Type:'));

        for (const [type, count] of Object.entries(typeCount))
        {
            console.log(`  ${formatType(type)}: ${chalk.cyan(count)}`);
        }

        console.log();
    }
    catch (error)
    {
        console.error(chalk.red(`\n❌ ${error instanceof Error ? error.message : 'Unknown error'}\n`));
        process.exit(1);
    }
}

/**
 * Search for environment variables
 */
async function searchEnvVars(query: string, options: { package?: string }): Promise<void>
{
    try
    {
        const list = await loadEnvList(options);

        const normalizedQuery = query.toLowerCase();
        const results: [string, any][] = [];

        for (const [key, schema] of orderedVars(list) as [string, any][])
        {
            const matchesKey = key.toLowerCase().includes(normalizedQuery);
            const matchesDescription = schema.description.toLowerCase().includes(normalizedQuery);

            if (matchesKey || matchesDescription)
            {
                results.push([key, schema]);
            }
        }

        if (results.length === 0)
        {
            console.log(chalk.yellow(`\n⚠️  No environment variables found matching "${query}"\n`));

            return;
        }

        console.log(chalk.blue.bold(`\n🔍 Found ${results.length} environment variable(s) matching "${query}"\n`));

        for (const [key, schema] of results)
        {
            const typeStr = formatType(schema.type);
            const requiredStr = schema.required || schema.default !== undefined
                ? chalk.red('[required]')
                : chalk.dim('[optional]');

            console.log(`${chalk.bold.cyan(key)} ${chalk.dim('(')}${typeStr}${chalk.dim(')')} ${requiredStr}`);
            console.log(`  ${chalk.dim(schema.description)}`);

            if (schema.default !== undefined)
            {
                console.log(`  ${chalk.dim('Default:')} ${formatDefault(schema.default, schema.type)}`);
            }

            console.log();
        }
    }
    catch (error)
    {
        console.error(chalk.red(`\n❌ ${error instanceof Error ? error.message : 'Unknown error'}\n`));
        process.exit(1);
    }
}

const PACKAGE_OPTION_HELP = 'Read only this package\'s env schema (default: the whole app — spfn.config.js env.schemas + installed @spfn/* packages)';

// Create env command with subcommands
export const envCommand = new Command('env')
    .description('Manage environment variables');

// env:list - List all environment variables
envCommand
    .command('list')
    .description('List all environment variables from schema')
    .option('-p, --package <package>', PACKAGE_OPTION_HELP)
    .option('-g, --group', 'Group variables by target file')
    .action(listEnvVars);

// env:stats - Show statistics
envCommand
    .command('stats')
    .description('Show environment variable statistics')
    .option('-p, --package <package>', PACKAGE_OPTION_HELP)
    .action(showEnvStats);

// env:search - Search environment variables
envCommand
    .command('search')
    .description('Search environment variables')
    .argument('<query>', 'Search query (matches key or description)')
    .option('-p, --package <package>', PACKAGE_OPTION_HELP)
    .action(searchEnvVars);

/**
 * Validate --env option value
 */
function validateEnvOption(envValue: string): string
{
    if (!VALID_ENVS.includes(envValue as any))
    {
        console.error(chalk.red(`\n❌ Invalid environment: "${envValue}"`));
        console.log(chalk.dim(`   Valid values: ${VALID_ENVS.join(', ')}\n`));
        process.exit(1);
    }

    return envValue;
}

/**
 * Generate .env template files
 */
async function initEnvFiles(options: { package?: string; force?: boolean; env?: string }): Promise<void>
{
    const targetEnv = options.env ? validateEnvOption(options.env) : undefined;
    const cwd = process.cwd();

    try
    {
        const list = await loadEnvList(options);
        const allVars = orderedVars(list) as [string, any][];

        printNotices(list);

        // Group by target file
        const grouped = allVars.reduce((acc, [key, schema]) =>
        {
            const target = getTargetFile(schema);
            const exampleFile = target + '.example';

            if (!acc[exampleFile]) acc[exampleFile] = [];
            acc[exampleFile].push([key, schema]);

            return acc;
        }, {} as Record<string, [string, any][]>);

        // If --env specified, also generate environment-specific template
        if (targetEnv)
        {
            console.log(chalk.blue.bold(`\n🚀 Generating .env template files for ${chalk.cyan(targetEnv)} environment\n`));

            const envSpecificFiles: Record<string, [string, any][]> = {};

            // .env.{NODE_ENV}.example — non-sensitive vars
            const committedVars = allVars.filter(([_, schema]) => !schema.sensitive);
            if (committedVars.length > 0)
            {
                envSpecificFiles[`.env.${targetEnv}.example`] = committedVars;
            }

            // .env.{NODE_ENV}.local.example — sensitive vars
            const sensitiveVars = allVars.filter(([_, schema]) => schema.sensitive);
            if (sensitiveVars.length > 0)
            {
                envSpecificFiles[`.env.${targetEnv}.local.example`] = sensitiveVars;
            }

            // Generate base files + environment-specific files
            const allGrouped = { ...grouped, ...envSpecificFiles };

            for (const [file, vars] of Object.entries(allGrouped))
            {
                writeEnvTemplate(cwd, file, vars, options.force ?? false, list);
            }
        }
        else
        {
            console.log(chalk.blue.bold(`\n🚀 Generating .env template files\n`));

            for (const [file, vars] of Object.entries(grouped))
            {
                writeEnvTemplate(cwd, file, vars, options.force ?? false, list);
            }
        }

        console.log(chalk.dim('\n💡 Copy .example files to create your actual .env files:'));
        console.log(chalk.dim('   cp .env.example .env'));
        console.log(chalk.dim('   cp .env.local.example .env.local'));
        console.log(chalk.dim('   cp .env.server.example .env.server'));

        if (targetEnv)
        {
            console.log(chalk.dim(`   cp .env.${targetEnv}.example .env.${targetEnv}`));
            console.log(chalk.dim(`   cp .env.${targetEnv}.local.example .env.${targetEnv}.local`));
        }

        console.log('');
    }
    catch (error)
    {
        console.error(chalk.red(`\n❌ ${error instanceof Error ? error.message : 'Unknown error'}\n`));
        process.exit(1);
    }
}

/**
 * Write a single .env template file
 */
function writeEnvTemplate(cwd: string, file: string, vars: [string, any][], force: boolean, list: EnvList): void
{
    const filePath = resolve(cwd, file);

    if (existsSync(filePath) && !force)
    {
        console.log(chalk.yellow(`  ⏭️  ${file} already exists (use --force to overwrite)`));

        return;
    }

    writeFileSync(filePath, generateEnvFileContent(vars, list), 'utf-8');
    console.log(chalk.green(`  ✅ ${file} (${vars.length} variables)`));
}

/**
 * Generate .env file content from schema
 *
 * With more than one source, a comment line opens each source's section.
 */
function generateEnvFileContent(vars: [string, any][], list: EnvList): string
{
    const lines: string[] = [
        '# Auto-generated by spfn env init',
        '# Copy this file and fill in the values',
        '',
    ];
    let section: string | undefined;

    for (const [key, schema] of vars)
    {
        const source = list.declaredBy[key]?.[0];

        if (list.sources.length > 1 && source !== section)
        {
            section = source;
            lines.push(`# ── ${source} ──`, '');
        }

        // Comment with description
        lines.push(`# ${schema.description}`);

        if (schema.required)
        {
            lines.push(`# [required]`);
        }

        if (schema.sensitive)
        {
            lines.push(`# [sensitive] - Do not commit this value!`);
        }

        // Example or default value
        let value = '';

        if (schema.default !== undefined)
        {
            value = String(schema.default);
        }
        else if (schema.examples && schema.examples.length > 0)
        {
            value = String(schema.examples[0]);
        }

        lines.push(`${key}=${value}`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Check .env files against schema
 */
async function checkEnvFiles(options: { package?: string; env?: string }): Promise<void>
{
    const targetEnv = options.env ? validateEnvOption(options.env) : undefined;
    const cwd = process.cwd();

    try
    {
        const list = await loadEnvList(options);
        const allVars = orderedVars(list) as [string, any][];

        printNotices(list);

        const envLabel = targetEnv ? ` (${targetEnv})` : '';
        console.log(chalk.blue.bold(`\n🔍 Checking .env files against schema${envLabel}\n`));

        // Determine which files to check
        const filesToCheck = targetEnv
            ? getEnvFilesForEnvironment(targetEnv)
            : [...BASE_ENV_FILES.nextjs, ...BASE_ENV_FILES.server];

        const loadedEnv: Record<string, { value: string; file: string }> = {};
        const issues: SourcedLine[] = [];
        const warnings: SourcedLine[] = [];

        // Load env files
        for (const file of filesToCheck)
        {
            const filePath = resolve(cwd, file);

            if (!existsSync(filePath))
            {
                continue;
            }

            const content = readFileSync(filePath, 'utf-8');
            const parsed = parse(content);

            for (const [key, value] of Object.entries(parsed))
            {
                loadedEnv[key] = { value: value || '', file };
            }

            console.log(chalk.dim(`  📄 ${file} loaded`));
        }

        console.log('');

        // Check each schema variable
        for (const [key, schema] of allVars)
        {
            const expectedFile = getTargetFile(schema);
            const found = loadedEnv[key];

            if (!found)
            {
                if (schema.required && schema.default === undefined)
                {
                    issues.push(sourced(list, key, `${chalk.red('✗')} ${chalk.cyan(key)} is required but not found in any .env file`));
                }

                continue;
            }

            // Check if in correct file
            const isNextjsFile = BASE_ENV_FILES.nextjs.includes(found.file as any);
            const isServerFile = BASE_ENV_FILES.server.includes(found.file as any);
            const shouldBeNextjs = schema.nextjs ?? key.startsWith('NEXT_PUBLIC_');

            if (!shouldBeNextjs && isNextjsFile && !isServerFile)
            {
                // Server-only var in nextjs file = security issue
                if (schema.sensitive)
                {
                    issues.push(sourced(
                        list,
                        key,
                        `${chalk.red('✗')} ${chalk.cyan(key)} is sensitive and should be in ${chalk.magenta(expectedFile)}, ` +
                        `but found in ${chalk.yellow(found.file)} (security risk!)`,
                    ));
                }
                else
                {
                    warnings.push(sourced(
                        list,
                        key,
                        `${chalk.yellow('⚠')} ${chalk.cyan(key)} should be in ${chalk.magenta(expectedFile)}, ` +
                        `but found in ${chalk.dim(found.file)}`,
                    ));
                }
            }
        }

        // Check for unknown variables
        for (const [key, { file }] of Object.entries(loadedEnv))
        {
            if (!list.schema[key])
            {
                warnings.push({ source: UNDECLARED, text: `${chalk.yellow('⚠')} ${chalk.cyan(key)} in ${chalk.dim(file)} is not in schema` });
            }
        }

        // Print results
        if (issues.length > 0)
        {
            console.log(chalk.red.bold('Issues:'));
            printBySource(issues);
            console.log('');
        }

        if (warnings.length > 0)
        {
            console.log(chalk.yellow.bold('Warnings:'));
            printBySource(warnings);
            console.log('');
        }

        if (issues.length === 0 && warnings.length === 0)
        {
            console.log(chalk.green('✅ All environment variables are correctly configured!\n'));
        }
        else
        {
            console.log(chalk.dim(`Found ${issues.length} issue(s) and ${warnings.length} warning(s)\n`));

            if (issues.length > 0)
            {
                process.exit(1);
            }
        }
    }
    catch (error)
    {
        console.error(chalk.red(`\n❌ ${error instanceof Error ? error.message : 'Unknown error'}\n`));
        process.exit(1);
    }
}

/** A report line and the source whose key it is about. */
interface SourcedLine
{
    source: string;
    text: string;
}

/** Heading for report lines about keys no schema declares. */
const UNDECLARED = '(not declared by any schema)';

function sourced(list: EnvList, key: string, text: string): SourcedLine
{
    return { source: list.declaredBy[key]?.[0] ?? UNDECLARED, text };
}

/**
 * Print report lines under one heading per source, in first-seen order
 */
function printBySource(lines: SourcedLine[]): void
{
    const sources = [...new Set(lines.map((line) => line.source))];

    for (const source of sources)
    {
        console.log(`  ${chalk.bold.magenta(source)}`);

        for (const line of lines.filter((candidate) => candidate.source === source))
        {
            console.log(`    ${line.text}`);
        }
    }
}

// env:init - Generate template files
envCommand
    .command('init')
    .description('Generate .env template files from schema')
    .option('-p, --package <package>', PACKAGE_OPTION_HELP)
    .option('-e, --env <environment>', 'Generate environment-specific templates (e.g. production, staging)')
    .option('-f, --force', 'Overwrite existing files')
    .action(initEnvFiles);

// env:check - Check .env files
envCommand
    .command('check')
    .description('Check .env files against schema')
    .option('-p, --package <package>', PACKAGE_OPTION_HELP)
    .option('-e, --env <environment>', 'Check files for a specific environment (e.g. production)')
    .action(checkEnvFiles);

/**
 * Validate environment variables against schema (runtime validation)
 *
 * Unlike `check` which validates .env files, this validates the actual
 * process.env values against the schema. Useful for CI/CD pipelines
 * to verify all required env vars are set before deployment.
 *
 * When --env is specified, loads .env files for that environment first,
 * then validates the resulting process.env against the schema.
 */
async function validateEnvVars(options: { packages?: string[]; strict?: boolean; env?: string }): Promise<void>
{
    const targetEnv = options.env ? validateEnvOption(options.env) : undefined;

    // If --env specified, load env files for that environment before validating
    if (targetEnv)
    {
        const { loadEnv } = await import('@spfn/core/env/loader');
        const result = loadEnv({ nodeEnv: targetEnv });

        console.log(chalk.blue.bold(`\n🔍 Validating environment variables for ${chalk.cyan(targetEnv)}\n`));

        if (result.loadedFiles.length > 0)
        {
            console.log(chalk.dim(`  Loaded: ${result.loadedFiles.join(', ')}`));
        }

        console.log('');
    }
    else
    {
        console.log(chalk.blue.bold(`\n🔍 Validating environment variables\n`));
    }

    const sources = options.packages
        ? await loadPackagesToValidate(options.packages, options.strict ?? false)
        : await loadWholeListToValidate();
    const { errors, warnings } = await validateSources(sources);

    console.log('');

    if (errors.length > 0)
    {
        console.log(chalk.red.bold(`❌ Validation Errors (${errors.length}):\n`));
        printFindingsBySource(errors, chalk.red('✗'));
    }

    if (warnings.length > 0)
    {
        console.log(chalk.yellow.bold(`⚠️  Warnings (${warnings.length}):\n`));
        printFindingsBySource(warnings, chalk.yellow('⚠'));
    }

    // Summary
    if (errors.length === 0 && warnings.length === 0)
    {
        console.log(chalk.green.bold('✅ All environment variables are valid!\n'));
    }
    else if (errors.length === 0)
    {
        console.log(chalk.green('✅ No errors found.'));
        console.log(chalk.yellow(`⚠️  ${warnings.length} warning(s) found.\n`));
    }
    else
    {
        console.log(chalk.red(`\n❌ Validation failed with ${errors.length} error(s)\n`));
        process.exit(1);
    }
}

/** A validation error or warning and the source whose schema raised it. */
interface Finding
{
    key: string;
    message: string;
    source: string;
}

/**
 * The packages named with `-p`. A package without an `envSchema` is skipped;
 * one that fails to load is reported, and ends the run under `--strict`.
 */
async function loadPackagesToValidate(packages: string[], strict: boolean): Promise<EnvSource[]>
{
    const sources: EnvSource[] = [];

    for (const packageName of packages)
    {
        console.log(chalk.dim(`  📦 ${packageName}`));

        const schema = await loadEnvSchema(packageName).catch((error: unknown) =>
        {
            const message = error instanceof Error ? error.message : String(error);

            if (message.includes('does not export envSchema'))
            {
                console.log(chalk.dim(`    ⏭️  No envSchema exported, skipping`));
            }
            else
            {
                console.error(chalk.red(`    ❌ Failed to load: ${message}`));
                exitIf(strict);
            }

            return undefined;
        });

        if (schema)
        {
            sources.push({ name: packageName, schema });
        }
    }

    return sources;
}

/**
 * The whole-app list. Failing to build it — a schema module that is missing,
 * or two schemas at odds — ends the run: validating part of the app would
 * report a pass it has not earned.
 */
async function loadWholeListToValidate(): Promise<EnvSource[]>
{
    const list = await loadEnvList({}).catch((error: unknown) =>
    {
        console.error(chalk.red(`  ❌ ${error instanceof Error ? error.message : String(error)}`));

        return process.exit(1);
    });

    for (const source of list.sources)
    {
        console.log(chalk.dim(`  📦 ${source.name}`));
    }

    printNotices(list);

    return list.sources;
}

function exitIf(condition: boolean): void
{
    if (condition)
    {
        process.exit(1);
    }
}

/**
 * Validate each source with its own registry — the way each package enforces
 * its schema at runtime. A key two sources declare identically fails once.
 */
async function validateSources(sources: EnvSource[]): Promise<{ errors: Finding[]; warnings: Finding[] }>
{
    const { createEnvRegistry } = await import('@spfn/core/env');
    const errors: Finding[] = [];
    const warnings: Finding[] = [];

    for (const source of sources)
    {
        const result = createEnvRegistry(source.schema).validateAll();

        errors.push(...result.errors.map((error) => ({ ...error, source: source.name })));
        warnings.push(...result.warnings.map((warning) => ({ ...warning, source: source.name })));
    }

    return { errors: uniqueFindings(errors), warnings: uniqueFindings(warnings) };
}

function uniqueFindings(findings: Finding[]): Finding[]
{
    const seen = new Set<string>();

    return findings.filter((finding) =>
    {
        const id = `${finding.key}\n${finding.message}`;
        const isNew = !seen.has(id);

        seen.add(id);

        return isNew;
    });
}

function printFindingsBySource(findings: Finding[], mark: string): void
{
    printBySource(findings.map((finding) => ({
        source: finding.source,
        text: `${mark} ${chalk.cyan(finding.key)}\n      ${chalk.dim(finding.message)}`,
    })));
    console.log('');
}

// env:validate - Validate runtime environment variables
envCommand
    .command('validate')
    .description('Validate environment variables against schema (for CI/CD)')
    .option('-p, --packages <packages...>', 'Validate only these packages (default: the whole app — spfn.config.js env.schemas + installed @spfn/* packages)')
    .option('-e, --env <environment>', 'Load env files for specific environment before validating')
    .option('-s, --strict', 'Exit on any error (including load failures)')
    .action(validateEnvVars);
