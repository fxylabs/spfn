import ora from 'ora';
import { execa } from 'execa';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';
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
    packageManager: string,
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
    // - drizzle-typebox: contract files import createInsertSchema, createSelectSchema
    // - postgres/pg: app must declare the same drivers @spfn/core uses, otherwise pnpm
    //   resolves drizzle-orm to a separate instance (drizzle-orm branches on its postgres/pg
    //   peer) → BaseRepository generics collapse to `unknown` and RPC responses lose types
    // - spfn: CLI needed for both build and runtime (spfn build, spfn start)
    // - concurrently: Process manager for running Next.js + SPFN API concurrently
    const spfnTag = getSpfnTag();
    packageJson.dependencies['@spfn/core'] = spfnTag;
    packageJson.dependencies['@sinclair/typebox'] = '^0.34.0';
    packageJson.dependencies['drizzle-orm'] = '1.0.0-rc.4';
    packageJson.dependencies['drizzle-typebox'] = '^0.3.3';
    packageJson.dependencies['postgres'] = '^3.4.0';
    packageJson.dependencies['pg'] = '^8.16.3';
    packageJson.dependencies['spfn'] = spfnTag;
    packageJson.dependencies['concurrently'] = '^9.2.5';

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
        packageJson.dependencies['@spfn/auth'] = spfnTag;
        packageJson.dependencies['@spfn/i18n'] = spfnTag;
        packageJson.dependencies['@spfn/notification'] = spfnTag;
    }

    // Add SPFN dev dependencies (fixes Issue #2)
    // - tsx: TypeScript executor for development (spfn dev)
    // - tsup: TypeScript bundler for server build with @/ alias support
    packageJson.devDependencies['@types/node'] = '^20.11.0';
    packageJson.devDependencies['tsx'] = '^4.20.6';
    packageJson.devDependencies['tsup'] = '^8.5.0';
    packageJson.devDependencies['drizzle-kit'] = '1.0.0-rc.4';
    packageJson.devDependencies['dotenv'] = '^17.2.3';

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

    // Install all dependencies at once
    spinner.start('Installing dependencies...');

    try
    {
        const installArgs = packageManager === 'npm'
            ? ['install', '--legacy-peer-deps']
            : ['install'];

        await execa(packageManager, installArgs, { cwd });

        spinner.succeed('Dependencies installed');
    }
    catch (error)
    {
        spinner.fail('Failed to install dependencies');
        logger.error(String(error));
        process.exit(1);
    }
}
