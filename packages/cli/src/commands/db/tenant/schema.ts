/**
 * The app schema the tenant commands plan from, read the way `db push` reads it:
 * drizzle.config.ts, else core's default (the entities folder scan, or its
 * config.ts registry). Function packages are not discovered — their tables
 * are theirs to move.
 */

import chalk from 'chalk';
import { loadSchemaImports, resolvePushSchemaSource, resolveSchemaFiles } from '../utils/drizzle.js';

/** Every export of the app's schema files, merged. */
export async function loadAppSchema(): Promise<Record<string, unknown>>
{
    const source = await resolvePushSchemaSource();
    const { getDrizzleConfig } = await import('@spfn/core/db');
    const config = getDrizzleConfig({
        cwd: process.cwd(),
        schema: source?.schema,
        expandGlobs: true,
        disablePackageDiscovery: true,
    });
    const resolved = await resolveSchemaFiles(config);

    return resolved.imports ?? await loadSchemaImports(resolved.files);
}

/** Print `message` as the command's failure and end it with exit code 1. */
export function fail(message: string): never
{
    console.error(chalk.red(`❌ ${message}`));
    process.exit(1);
}
