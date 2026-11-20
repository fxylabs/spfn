#!/usr/bin/env node
/**
 * Each source module is emitted once per package (#398).
 *
 * Run from a package directory after its tsup build(s). esbuild opens every module it
 * bundles with a `// src/…` marker line; when two output files carry the same marker,
 * that module is in the package twice, and so is every class, singleton and registry it
 * defines — `instanceof` and shared configuration then break between entry points.
 * `splitting: true` moves such a module into one shared chunk. A second tsup config,
 * which cannot share chunks, must import its siblings by package name (or through the
 * package's private `imports`) instead.
 *
 * Reading text covers browser entries, which Node cannot import. The check refuses to pass
 * on output that lost its markers: none at all in a package of more than one file, or a
 * module a file's source map names without its marker.
 *
 * When the package has `scripts/check-bundle.mjs`, it is run afterwards: identity
 * probes that import the built entries and compare what a caller would compare.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The query is dropped: a plugin that loads a source with a suffix (`src/…/index.ts?entry`) makes
// a second module of the same source, which would otherwise pass as a different one.
const MARKER = /^\/\/ (src\/[^\s?#]+)\S*$/gm;

function listOutputFiles(directory)
{
    return readdirSync(directory, { withFileTypes: true, recursive: true })
        .filter(entry => entry.isFile() && /\.[cm]?js$/.test(entry.name))
        .map(entry => join(entry.parentPath, entry.name))
        .sort();
}

function markersOf(file)
{
    return new Set(Array.from(readFileSync(file, 'utf-8').matchAll(MARKER), match => match[1]));
}

/** Source module → the output files that contain it. */
function collectModules(files)
{
    const modules = new Map();
    for (const file of files)
    {
        for (const marker of markersOf(file))
        {
            modules.set(marker, [...(modules.get(marker) ?? []), relative(process.cwd(), file)]);
        }
    }
    return modules;
}

function fail(lines)
{
    console.error(`Bundle identity check failed (${process.cwd()}):`);
    for (const line of lines)
    {
        console.error(`  - ${line}`);
    }
    process.exit(1);
}

function runIdentityProbes()
{
    const probes = join('scripts', 'check-bundle.mjs');
    if (existsSync(probes))
    {
        const { status } = spawnSync(process.execPath, [probes], { stdio: 'inherit' });
        if (status !== 0)
        {
            process.exit(status ?? 1);
        }
    }
}

/**
 * Files whose source map names a source module that has no marker in the file. esbuild
 * writes a marker for every module it emits; a rollup pass over its output (tsup's
 * `treeshake`) drops the marker with the first statement it removes after it, and the
 * check would not see that module. A file without a source map is taken as it is.
 */
function filesWithStrippedMarkers(files)
{
    return files.filter(file =>
    {
        if (!existsSync(`${file}.map`))
        {
            return false;
        }
        const markers = markersOf(file);
        return JSON.parse(readFileSync(`${file}.map`, 'utf-8')).sources
            .map(source => relative(process.cwd(), resolve(dirname(file), source)))
            .some(source => source.startsWith('src/') && !markers.has(source));
    });
}

const files = listOutputFiles('dist');
const modules = collectModules(files);

if (modules.size === 0 && files.length > 1)
{
    fail([`no module markers found in ${files.length} output files; the check cannot tell duplicates apart`]);
}

const unmarked = filesWithStrippedMarkers(files);
if (unmarked.length > 0)
{
    fail([
        ...unmarked.map(file => `${relative(process.cwd(), file)} has code of a source module without its \`// src/…\` marker`),
        'module markers were stripped (tsup\'s `treeshake` runs rollup, which drops them); the check cannot see those modules',
    ]);
}

const duplicated = [...modules].filter(([, outputs]) => outputs.length > 1);
if (duplicated.length > 0)
{
    fail([
        ...duplicated.map(([module, outputs]) => `${module} is emitted into ${outputs.join(', ')}`),
        `${duplicated.length} source module(s) emitted more than once; set \`splitting: true\` in the tsup config, `
        + 'or import the module by package name from a separate build',
    ]);
}

console.log(`Bundle identity check passed: ${modules.size} source modules, each in one of ${files.length} output files.`);
runIdentityProbes();
