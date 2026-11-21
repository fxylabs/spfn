/**
 * `spfn provision` — deploy-time infrastructure provisioning
 *
 * Loads the app's server.config and runs `provisionInfrastructure()` from
 * `@spfn/core/server`: DB init + the config's provisioning lifecycle hooks
 * (`beforeInfrastructure` / `afterInfrastructure`, e.g. admin seeding + RBAC init).
 *
 * Run this ONCE per deploy — from a build step or deploy hook — instead of paying
 * the seed/RBAC cost on every serverless cold start or pod restart. Always-on
 * targets call it before `spfn start`; serverless targets call it from the
 * build/deploy pipeline.
 *
 * Migrations are NOT run here — run `spfn db migrate` (against the direct,
 * non-pooler connection) before provisioning.
 */

import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import { logger } from '../utils/logger.js';
import { tsxCommand } from '../utils/dev-loader.js';
import { missingTsx } from '../utils/tsx-required.js';
import { redactUrls } from '../utils/redact-urls.js';
import { detectPackageManager } from '../utils/package-manager.js';
import { resolveKeychainEnv } from '../utils/secret-store/index.js';
import { dropOwnerCredentials, enterCommand } from '../utils/database-connection.js';

/**
 * The runner `spfn provision` spawns under tsx.
 *
 * It loads `server.config` with `loadServerConfigFile`, the loader `startServer`
 * uses — same files, same order, same refusals. A file that exists but exports
 * no plain object stops provisioning naming the file; it used to hand
 * `provisionInfrastructure` an `undefined` config and provision on defaults.
 * Only an absent file is "not found", which exits 1 with the paths it tried.
 * It marks its process before (`markAppSourceProcess`), so a second copy of
 * `@spfn/core` the config brings in is refused, not provisioned with. What
 * stops it is printed through `redactUrls`, embedded as source: the runner is
 * another process, in the app.
 *
 * Exported so its content is under test rather than only under review: this is
 * generated text, so nothing type-checks it.
 */
export function renderProvisionRunner(): string
{
    return `
if (!process.env.NODE_ENV)
{
    process.env.NODE_ENV = 'production';
}

// The Vercel Supabase integration injects POSTGRES_URL but not DATABASE_URL,
// which is what SPFN reads. Map it so build-step provisioning connects too.
process.env.DATABASE_URL ??= process.env.POSTGRES_URL;

// Whatever stops the run is printed with the credentials of any URL in it
// blanked: a server.config or a provisioning step can throw with DATABASE_URL
// in its text, and this output reaches deploy logs.
const redactUrls = ${redactUrls.toString()};

async function provision()
{
    // Load environment variables FIRST (before any imports that depend on them)
    await import('@spfn/core/config');

    const { provisionInfrastructure, loadServerConfigFile, SERVER_CONFIG_FILE_PATHS, markAppSourceProcess } = await import('@spfn/core/server');

    // Loads the app's source: a second copy of @spfn/core is refused where it is recorded.
    markAppSourceProcess();

    const loaded = await loadServerConfigFile(process.cwd());

    if (!loaded)
    {
        console.error('server.config not found. Looked for: ' + SERVER_CONFIG_FILE_PATHS.join(', '));
        console.error('Run "spfn init" first, or run this command from the app root.');
        process.exit(1);
    }

    console.info('[SPFN] Provisioning with config: ' + loaded.path);

    await provisionInfrastructure(loaded.config);
}

await provision().catch((error) =>
{
    console.error(redactUrls(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exit(1);
});

// provisionInfrastructure leaves the DB pool open — exit explicitly.
process.exit(0);
`;
}

export const provisionCommand = new Command('provision')
    .description('Run deploy-time provisioning (seed/RBAC lifecycle hooks) — once per deploy, not per cold start')
    .action(async () =>
    {
        // An app command: an inherited owner URL leaves this process first
        enterCommand('spfn provision');

        if (!process.env.NODE_ENV)
        {
            process.env.NODE_ENV = 'production';
        }

        const cwd = process.cwd();

        // Mirror dev.ts: resolve secret:keychain: refs from .env.server so local runs
        // get real values; CI/deploy environments have plain env and resolve nothing.
        const { env: keychainEnv, missing: keychainMissing } = await resolveKeychainEnv(cwd);

        if (Object.keys(keychainEnv).length > 0)
        {
            logger.info(`[SPFN] Injecting ${Object.keys(keychainEnv).length} secret(s) from the keychain`);
        }

        if (keychainMissing.length > 0)
        {
            logger.warn(`[SPFN] Could not resolve keychain secret(s): ${keychainMissing.join(', ')} — run \`spfn secret set <KEY>\``);
        }

        // The runner runs under the app's tsx: without one, say what to install
        const tsxMissing = missingTsx(cwd);

        if (tsxMissing !== undefined)
        {
            logger.error(tsxMissing);
            process.exit(1);
        }

        // Temp runner spawned via tsx, with the hook `spfn dev` runs the server
        // under, so a TS server.config, its path aliases (@/server/...) and its
        // module format resolve the same way they do there.
        const tempDir = join(cwd, '.spfn');
        const runnerEntry = join(tempDir, 'provision.mjs');

        mkdirSync(tempDir, { recursive: true });

        writeFileSync(runnerEntry, renderProvisionRunner());

        const runner = tsxCommand(detectPackageManager(cwd), cwd, runnerEntry);

        // The runner loads server.config and runs its hooks as the app: without
        // the owner's credentials, which the keychain could otherwise hand it.
        const runnerEnv: NodeJS.ProcessEnv = { ...process.env, ...keychainEnv };
        dropOwnerCredentials(runnerEnv);

        const result = await execa(runner.command, runner.args, {
            cwd,
            stdio: 'inherit',
            reject: false,
            env: runnerEnv,
        });

        if (result.exitCode !== 0)
        {
            logger.error(`Provisioning failed (exit code ${result.exitCode})`);
            process.exit(result.exitCode ?? 1);
        }

        logger.info('[SPFN] Provisioning complete');
    });
