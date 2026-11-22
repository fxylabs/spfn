import chalk from 'chalk';

import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';
import { discoverFunctionMigrations } from '../../utils/function-migrations.js';
import { OWNER_URL_MISSING } from './utils/database.js';
import { exitOnGrantFailure, projectGrantTargetOrExit, runAppGrantStepOn } from './utils/app-grants.js';

/**
 * Grant the app role exactly what is declared, and nothing else —
 * the step `db push`, `db migrate` and `spfn add` end with, alone: for a
 * database set up by an older CLI, a migrate job that ran without a way to
 * name the app role, or a step that failed after its schema changes.
 *
 * Connects as the owner (DATABASE_OWNER_URL). Reads each function package's
 * manifest, and the project's `src/server/drizzle/privileges.json` — or, when
 * the project has none (one that only pushes), its entities as `db push`
 * loads them. When neither can be read it exits 1: the project's tables
 * cannot be seen (app-grants.ts, `projectGrantTarget`). It prints which one
 * it read: a manifest left behind decides over the entities.
 *
 * - --dry-run: prints the roles and how each was found, the statements, the
 *   declared tables that do not exist and what it would not revoke, and runs
 *   the statements in one transaction it always rolls back, so a statement
 *   PostgreSQL refuses is reported; changes nothing.
 */
export async function dbGrant(options: { dryRun?: boolean } = {}): Promise<void>
{
    loadEnvFor('db grant');
    const databaseUrl = databaseUrlFor('db grant');

    if (!databaseUrl)
    {
        console.error(chalk.red(OWNER_URL_MISSING));
        process.exit(1);
    }

    const { target, source } = await projectGrantTargetOrExit(discoverFunctionMigrations(process.cwd()), databaseUrl);

    console.log(chalk.dim(`📄 The project's declarations: ${source}`));
    await runAppGrantStepOn(databaseUrl, target, { dryRun: options.dryRun })
        .catch(error => exitOnGrantFailure(error, databaseUrl, 'Privileges not applied'));

    if (options.dryRun)
    {
        console.log(chalk.cyan('\n🔍 Dry run: nothing was granted or revoked.\n'));
    }
}
