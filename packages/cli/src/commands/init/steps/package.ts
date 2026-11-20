import ora, { type Ora } from 'ora';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';
import { findUnresolvedPackages, getInstallArgs, pnpmNonMemberReason, runInstall, type PackageManager } from '../../../utils/package-manager.js';
import { getSpfnTag } from '../../../utils/version.js';
import type { PackageJson } from './validate.js';
import type { ScaffoldMode } from '../mode.js';
import { NODE_ENGINE_RANGE, admitsOnlyPatchedNode } from './node-engine.js';

const { writeFileSync } = fse;

/**
 * Update package.json with SPFN dependencies and scripts
 * Then install all dependencies
 */
export async function setupPackageJson(
    cwd: string,
    packageJsonPath: string,
    packageJson: PackageJson,
    packageManager: PackageManager,
    mode: ScaffoldMode,
): Promise<void>
{
    const spinner = ora('Updating package.json...').start();

    // Initialize dependencies
    packageJson.dependencies = packageJson.dependencies || {};
    packageJson.devDependencies = packageJson.devDependencies || {};
    packageJson.scripts = packageJson.scripts || {};

    // Add SPFN dependencies (fixes Issue #3: explicit installation for pnpm)
    // - @spfn/core: Use same tag as CLI (alpha, beta, or latest)
    // - @sinclair/typebox: contract files import Type
    // - drizzle-orm: entity/repository files import from drizzle-orm, drizzle-orm/pg-core
    // - postgres/pg: app must declare the same drivers @spfn/core uses, otherwise pnpm
    //   resolves drizzle-orm to a separate instance (drizzle-orm branches on its postgres/pg
    //   peer) → BaseRepository generics collapse to `unknown` and RPC responses lose types
    // - spfn: CLI needed for both build and runtime (spfn build, spfn start)
    // - concurrently: Process manager for running Next.js + SPFN API concurrently
    const spfnTag = getSpfnTag();
    const dependencies: Record<string, string> = {
        '@spfn/core': spfnTag,
        '@sinclair/typebox': '^0.34.0',
        'drizzle-orm': '1.0.0-rc.4',
        'postgres': '^3.4.0',
        'pg': '^8.16.3',
        'spfn': spfnTag,
        'concurrently': '^9.2.5',
    };

    // Both modes declare the Node releases that carry the CVE-2026-111497 fix
    // (see node-engine.ts). A range the app already declares is kept only when
    // every version it admits is one of those.
    packageJson.engines = packageJson.engines || {};
    const existingNodeRange = packageJson.engines.node;
    if (!existingNodeRange || !admitsOnlyPatchedNode(existingNodeRange))
    {
        packageJson.engines.node = NODE_ENGINE_RANGE;
        if (existingNodeRange)
        {
            logger.warn(`Updated engines.node from "${existingNodeRange}" to "${NODE_ENGINE_RANGE}": SPFN requires a Node release with the CVE-2026-111497 fix`);
        }
    }

    // The full profile is the Prototype-to-Production baseline. Auth's
    // notification peer is installed explicitly so a fresh pnpm scaffold has a
    // single, compatible SPFN dependency graph. The ops surface needs no package
    // of its own: `@spfn/core/ops` carries the router and `@spfn/auth` the tokens.
    if (mode === 'full')
    {
        dependencies['@spfn/auth'] = spfnTag;
        dependencies['@spfn/i18n'] = spfnTag;
        dependencies['@spfn/notification'] = spfnTag;
    }

    // Add SPFN dev dependencies (fixes Issue #2)
    // - tsx: TypeScript executor for development (spfn dev). 4.22 is the first
    //   that registers with module.registerHooks on Node 26; an older one prints
    //   DEP0205 (module.register() deprecated) at every spfn dev start there.
    const devDependencies: Record<string, string> = {
        '@types/node': '^20.11.0',
        'tsx': '^4.22.4',
        'drizzle-kit': '1.0.0-rc.4',
    };

    Object.assign(packageJson.dependencies, dependencies);
    Object.assign(packageJson.devDependencies, devDependencies);

    // Add SPFN-specific scripts
    // Preserve existing build script if it exists, otherwise use default Next.js build
    if (!packageJson.scripts['build'])
    {
        packageJson.scripts['build'] = 'next build --turbopack';
    }
    // Preserve existing start script if it exists
    if (!packageJson.scripts['start'])
    {
        packageJson.scripts['start'] = 'next start';
    }
    packageJson.scripts['spfn:dev'] = 'spfn dev';
    packageJson.scripts['spfn:server'] = 'spfn dev --server-only';
    // No port here: `spfn dev` passes the resolved one, so spfn.config.js stays
    // the only place the number is written.
    packageJson.scripts['spfn:next'] = 'next dev --turbo';
    packageJson.scripts['spfn:start'] = 'spfn start';
    packageJson.scripts['spfn:build'] = 'spfn build';
    packageJson.scripts['codegen'] = 'spfn codegen run';

    // Write updated package.json
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

    spinner.succeed('package.json updated');

    await installDependencies(spinner, cwd, packageManager);
}

/**
 * Install all dependencies at once, then confirm the app's packages are there.
 */
async function installDependencies(spinner: Ora, cwd: string, packageManager: PackageManager): Promise<void>
{
    spinner.start('Installing dependencies...');
    const failure = await runInstall(packageManager, getInstallArgs(packageManager), { cwd });

    if (failure)
    {
        spinner.fail('Failed to install dependencies');
        logger.error(failure);
        process.exit(1);
    }

    confirmInstalled(spinner, cwd, packageManager);
}

/**
 * Report "Dependencies installed" only when every package the app declares
 * (`findUnresolvedPackages`) resolves from `appDir`; otherwise fail the command
 * naming the missing ones, and why when that can be known.
 *
 * An exit code proves nothing here: pnpm run in a directory that is not a member
 * of the workspace above it installs that workspace and exits 0, leaving the app
 * without a single one of its packages.
 */
export function confirmInstalled(spinner: Ora, appDir: string, packageManager: PackageManager): void
{
    const missing = findUnresolvedPackages(appDir);

    if (missing.length > 0)
    {
        const reason = packageManager === 'pnpm' ? pnpmNonMemberReason(appDir) : null;

        spinner.fail(`${packageManager} install finished, but these do not resolve from ${appDir}: ${missing.join(', ')}`);
        if (reason)
        {
            logger.error(reason);
        }
        process.exit(1);
    }

    spinner.succeed('Dependencies installed');
}
