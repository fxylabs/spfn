/**
 * Each source module is emitted once per package (#398): what the bundler itself records.
 *
 * Every tsup config of a package passes `recordMetafile(label)` to `esbuildPlugins`. It writes
 * esbuild's metafile, which lists for each output file every input module that contributed
 * bytes to it — the package's own sources, the dependencies it bundles (auth, monitor and
 * notification bundle `@sinclair/typebox`, whose modules hold registries) and plugin-made
 * modules alike — to `dist/<label>.metafile.json`. `files` in `package.json` keeps it out
 * of the published package.
 *
 * `findBundleProblems` then reads those records: a module in two output files is in the
 * package twice, and so is every class, singleton and registry it defines; an output file no
 * record names holds code nothing accounts for. Each output file must have exactly one record:
 * a file two records name (two configs writing one path, or a record left from an earlier
 * build) is whichever was written last, so either record may describe it wrongly, and a
 * record naming a file that is not there is stale; both fail. `splitting: true` moves a
 * shared module into one chunk; a second tsup config, which cannot share chunks, must import
 * its siblings by package name (or through the package's private `imports`) instead.
 *
 * The records describe the files tsup writes only while nothing rewrites them after esbuild.
 * tsup's `treeshake` does: its rollup pass, one output file at a time, deleted all of
 * `src/server/index.ts` from core's `dist/server/index.js` while the record still lists it,
 * and dropped 47 side-effect imports of chunks that esbuild writes to keep evaluation order.
 * No package builds with it. Were one to, the check would still not miss a duplicate: rollup
 * sees one file, every other import external, so it removes code and never adds any.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const METAFILE = /\.metafile\.json$/;
const OUTPUT_FILE = /\.[cm]?js$/;

/** esbuild plugin: writes the build's metafile to `<outdir>/<label>.metafile.json`. */
export function recordMetafile(label)
{
    return {
        name: 'spfn-record-metafile',
        setup(build)
        {
            build.initialOptions.metafile = true;
            build.onEnd((result) =>
            {
                if (result.metafile !== undefined)
                {
                    mkdirSync(build.initialOptions.outdir, { recursive: true });
                    writeFileSync(join(build.initialOptions.outdir, `${label}.metafile.json`), JSON.stringify(result.metafile));
                }
            });
        },
    };
}

/**
 * One name per module, whatever spelling esbuild recorded it under. A plugin that loads a
 * source with a suffix (`src/a.ts?entry`) makes a second module of the same file: the suffix
 * is dropped. A path is taken to its real file, so a symlink is not a second module. A
 * plugin's module in a namespace of its own (`<namespace>:<path>`, core's per-entry module)
 * holds the plugin's code, not the file's, and keeps its namespace.
 */
export function moduleName(packageDirectory, input)
{
    const [, namespace, path] = /^(?:([\w-]+):)?([^?#]*)/.exec(input);
    if (namespace !== undefined)
    {
        return `${namespace}:${path}`;
    }
    const file = resolve(packageDirectory, path);

    return relative(packageDirectory, existsSync(file) ? realpathSync(file) : file);
}

function listFiles(directory, pattern)
{
    return readdirSync(directory, { withFileTypes: true, recursive: true })
        .filter(entry => entry.isFile() && pattern.test(entry.name))
        .map(entry => join(entry.parentPath, entry.name))
        .sort();
}

/**
 * Every output file each build record names, with the modules that contributed bytes to it:
 * `{ label, output, modules }`, `label` being the record's name (`<label>.metafile.json`).
 * esbuild writes paths relative to its working directory, the package directory tsup runs
 * in, and they are read relative to it. A module listed with 0 bytes in a file (a re-export
 * the bundler resolved through, or code it tree-shook away) is not in it.
 */
export function readBuildRecords(packageDirectory)
{
    return listFiles(join(packageDirectory, 'dist'), METAFILE).flatMap(metafile =>
        Object.entries(JSON.parse(readFileSync(metafile, 'utf-8')).outputs).map(([output, { inputs }]) => ({
            label: relative(join(packageDirectory, 'dist'), metafile).replace(METAFILE, ''),
            output: relative(packageDirectory, resolve(packageDirectory, output)),
            modules: Object.entries(inputs)
                .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
                .map(([input]) => moduleName(packageDirectory, input)),
        })));
}

/** `[key, values]` for each key paired with more than one distinct value. */
function keysWithSeveralValues(pairs)
{
    const grouped = new Map();
    for (const [key, value] of pairs)
    {
        grouped.set(key, [...new Set([...(grouped.get(key) ?? []), value])]);
    }

    return [...grouped].filter(([, values]) => values.length > 1);
}

/**
 * Module → the output files holding its code, for every module in more than one. Records are
 * not merged: when two name one file (itself reported), each one's modules count for it.
 */
function duplicatedModules(records)
{
    return keysWithSeveralValues(records.flatMap(({ output, modules }) => modules.map(module => [module, output])));
}

/** What breaks "one copy of each module" in a built package, and what was counted. */
export function findBundleProblems(packageDirectory)
{
    const records = readBuildRecords(packageDirectory);
    const recorded = new Set(records.map(({ output }) => output));
    const files = listFiles(join(packageDirectory, 'dist'), OUTPUT_FILE)
        .map(file => relative(packageDirectory, file));

    return {
        recordCount: new Set(records.map(({ label }) => label)).size,
        duplicated: duplicatedModules(records),
        overlapping: keysWithSeveralValues(records.map(({ output, label }) => [output, label])),
        stale: records.filter(({ output }) => !existsSync(join(packageDirectory, output)))
            .map(({ output, label }) => [output, label]),
        unrecorded: files.filter(file => !recorded.has(file)),
        moduleCount: new Set(records.flatMap(({ modules }) => modules)).size,
        fileCount: files.length,
    };
}
