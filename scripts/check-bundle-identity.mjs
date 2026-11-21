#!/usr/bin/env node
/**
 * Each source module is emitted once per package (#398).
 *
 * `node ../../scripts/check-bundle-identity.mjs`, the last step of a package's `build`: checks
 * that package's `dist` (`scripts/lib/bundle-identity.mjs` says how). `--all`, from the
 * repository root: every package's `dist` as it stands, whatever its build script ran, so
 * what would be published is checked. A package without `dist` was not built and is named as
 * skipped — unless the run says it built it: `--built <directory>...` (CI's verify step
 * passes `node scripts/ci-scope.mjs built`, the directories turbo's `build` ran in with the
 * scope's filters) makes a listed package under `packages/` without `dist` or without a
 * build record a failure. Listed directories elsewhere (examples, the website) are not
 * library packages and are not checked.
 *
 * When the package has `scripts/check-bundle.mjs`, it is run afterwards: identity probes that
 * import the built entries and compare what a caller would compare.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBundleProblems } from './lib/bundle-identity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function problemLines({ recordCount, duplicated, overlapping, stale, unrecorded })
{
    return [
        ...(recordCount === 0 ? ['dist holds no build record (`*.metafile.json`); was it built by this repository\'s build?'] : []),
        ...overlapping.map(([output, labels]) => `${output} is named by the build records ${labels.join(', ')}; `
            + 'each output file has one record (two configs writing one path, or a record left from an earlier build)'),
        ...stale.map(([output, label]) => `${output} is named by the build record ${label} and does not exist; `
            + 'the record is stale (clean dist and build again)'),
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

/** The package directories under `packages/` among `--built`'s, or undefined without the flag. */
function builtPackages(argv)
{
    const index = argv.indexOf('--built');
    return index === -1
        ? undefined
        : argv.slice(index + 1)
            .map(directory => resolve(ROOT, directory))
            .filter(directory => dirname(directory) === join(ROOT, 'packages'));
}

/** A package without `dist`: skipped, or a failure when the run built it. */
function reportUnbuilt(directory, built)
{
    if (built?.includes(directory))
    {
        console.error(`Bundle identity check failed (${relative(ROOT, directory)}): the run built it, and it has no dist.`);
        return false;
    }
    console.log(`Bundle identity check skipped (${relative(ROOT, directory)}): not built.`);
    return true;
}

function checkEveryPackage(built)
{
    const packages = [...new Set([
        ...readdirSync(join(ROOT, 'packages'))
            .map(name => join(ROOT, 'packages', name))
            .filter(directory => existsSync(join(directory, 'package.json'))),
        ...(built ?? []),
    ])];
    return packages
        .map(directory => (existsSync(join(directory, 'dist')) ? checkPackage(directory) : reportUnbuilt(directory, built)))
        .every(Boolean);
}

const passed = process.argv.includes('--all') ? checkEveryPackage(builtPackages(process.argv)) : checkPackage(process.cwd());
process.exit(passed ? 0 : 1);
