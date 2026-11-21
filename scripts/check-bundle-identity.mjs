#!/usr/bin/env node
/**
 * Each source module is emitted once per package (#398).
 *
 * `node ../../scripts/check-bundle-identity.mjs`, the last step of a package's `build`: checks
 * that package's `dist` (`scripts/lib/bundle-identity.mjs` says how). `--all`, from the
 * repository root: every package's `dist` as it stands, whatever its build script ran — CI's
 * verify step, so what would be published is checked. A package without `dist` was not built
 * and is named as skipped.
 *
 * When the package has `scripts/check-bundle.mjs`, it is run afterwards: identity probes that
 * import the built entries and compare what a caller would compare.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBundleProblems } from './lib/bundle-identity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function problemLines({ duplicated, unrecorded })
{
    return [
        ...duplicated.map(([module, outputs]) => `${module} is emitted into ${outputs.join(', ')}`),
        ...(duplicated.length > 0
            ? [`${duplicated.length} module(s) emitted more than once; set \`splitting: true\` in the tsup config, `
                + 'or import the module by package name from a separate build']
            : []),
        ...unrecorded.map(file => `${file}: no build record names this file`),
        ...(unrecorded.length > 0
            ? ['every tsup config passes `recordMetafile(...)` (scripts/lib/bundle-identity.mjs) to `esbuildPlugins`, '
                + 'and nothing else writes code into dist']
            : []),
    ];
}

function runIdentityProbes(packageDirectory)
{
    const probes = join(packageDirectory, 'scripts', 'check-bundle.mjs');
    return !existsSync(probes)
        || spawnSync(process.execPath, [probes], { cwd: packageDirectory, stdio: 'inherit' }).status === 0;
}

/** Checks one built package and prints the outcome; true when it passed. */
function checkPackage(packageDirectory)
{
    const problems = findBundleProblems(packageDirectory);
    const lines = problemLines(problems);
    if (lines.length > 0)
    {
        console.error(`Bundle identity check failed (${packageDirectory}):`);
        lines.forEach(line => console.error(`  - ${line}`));
        return false;
    }
    console.log(`Bundle identity check passed (${relative(ROOT, packageDirectory)}): `
        + `${problems.moduleCount} modules, each in one of ${problems.fileCount} output files.`);
    return runIdentityProbes(packageDirectory);
}

function checkEveryPackage()
{
    const packages = readdirSync(join(ROOT, 'packages'))
        .map(name => join(ROOT, 'packages', name))
        .filter(directory => existsSync(join(directory, 'package.json')));
    packages.filter(directory => !existsSync(join(directory, 'dist')))
        .forEach(directory => console.log(`Bundle identity check skipped (${relative(ROOT, directory)}): not built.`));
    return packages.filter(directory => existsSync(join(directory, 'dist')))
        .map(checkPackage)
        .every(Boolean);
}

const passed = process.argv.includes('--all') ? checkEveryPackage() : checkPackage(process.cwd());
process.exit(passed ? 0 : 1);
