import chalk from 'chalk';

import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';
import { discoverFunctionMigrations } from '../../utils/function-migrations.js';
import { OWNER_URL_MISSING } from './utils/database.js';
import { exitOnGrantFailure, projectGrantTargetOrExit } from './utils/app-grants.js';
import { readJobsDeclarationOrExit, runOwnerStepsOn } from './utils/queue-step.js';

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
 * cannot be seen (app-grants.ts, `projectGrantTarget`) — except in a project
 * that declares jobs and names no schema source (no `schema` in
 * drizzle.config.ts), which has no table of its own, as `db push` finds it:
 * its queue is granted. A named source matching no file exits 1, as push. It prints which one it read:
 * a manifest left behind decides over the entities. When package.json
 * declares jobs, the queue schema is installed or migrated first, and
 * granted with the rest (queue-step.ts).
 *
 * - --dry-run: prints the roles and how each was found, the statements, the
 *   declared tables that do not exist and what it would not revoke, and runs
 *   the statements in one transaction it always rolls back, so a statement
 *   PostgreSQL refuses is reported; says what it would install or migrate
 *   of the queue schema, and runs none of it; changes nothing.
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

    const jobs = readJobsDeclarationOrExit();
    const { target, source } = await projectGrantTargetOrExit(discoverFunctionMigrations(process.cwd()), databaseUrl, { jobs: jobs !== undefined });

    console.log(chalk.dim(`📄 The project's declarations: ${source}`));
    await runOwnerStepsOn(databaseUrl, target, jobs, { dryRun: options.dryRun })
        .catch(error => exitOnGrantFailure(error, databaseUrl, 'Privileges not applied'));

    if (options.dryRun)
    {
        console.log(chalk.cyan('\n🔍 Dry run: nothing was granted or revoked.\n'));
    }
}
