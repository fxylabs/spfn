/**
 * `node --test scripts/lib/` — the bundle identity check (#398) on packages built by tsup.
 *
 * Each row builds a fixture package in a temporary directory with the tsup the packages use,
 * `recordMetafile` among its esbuild plugins, and reads it as `check-bundle-identity.mjs` does.
 *
 * | #  | build                                                                 | expected                          |
 * |----|-----------------------------------------------------------------------|-----------------------------------|
 * | B1 | two entries share a module, no splitting, minified, no source map     | the module, in both files         |
 * | B2 | B1 with splitting                                                     | passes; the module in one chunk   |
 * | B3 | a plugin loads the shared source again under a `?copy` suffix         | one module, in both files         |
 * | B4 | the shared source reached through two symlinked directories           | one module, in both files         |
 * | B5 | a dependency from `node_modules` in both entries, no splitting        | the dependency's module, in both  |
 * | B6 | B2, then a file of `__`-named code written into `dist`                | that file, unrecorded             |
 * | B7 | B2, then a second config built without `recordMetafile`               | its output, unrecorded            |
 * | B8 | a barrel re-exported by one entry (0 bytes), whose own code another has | passes                          |
 * | B9 | B2, then a second config writing `dist/a.js` again, unsplit           | the file, named by both records; the module in it and the chunk |
 * | B10| a record of an earlier build whose output is gone, then B2            | that record's file, stale         |
 * | B11| B2                                                                    | no stale or overlapping record    |
 *
 * B1, B3 and B6 are the round-2 review's probes (a)–(c): a duplicate without markers or a
 * source map, one source under two spellings, a markerless file of `__` variables. B9 and
 * B10 are round 3's: the Opus reviewer's two configs writing one path, Codex's stale record.
 *
 * The C rows run `check-bundle-identity.mjs --all` on a workspace of fixture packages, a copy
 * of the script beside them (it checks the `packages/` next to its own directory):
 *
 * | #  | workspace                                         | arguments                          | expected                  |
 * |----|---------------------------------------------------|------------------------------------|---------------------------|
 * | C1 | `built` (B2's build) and `unbuilt` (no dist)      | none                               | passes; `unbuilt` skipped |
 * | C2 | C1                                                | `--built packages/built packages/unbuilt` | fails on `unbuilt`  |
 * | C3 | C1                                                | `--built packages/built examples/app` | passes                 |
 * | C4 | C1, `built`'s build record removed                | `--built packages/built`           | fails: no build record    |
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findBundleProblems, recordMetafile } from './bundle-identity.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const { build } = await import(pathToFileURL(createRequire(join(repositoryRoot, 'packages/core/package.json')).resolve('tsup')));

/** An ESM package directory holding `files` (path → text); removed when the row ends. */
function fixture(t, files)
{
    const directory = mkdtempSync(join(tmpdir(), 'bundle-identity-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [path, text] of Object.entries({ 'package.json': '{ "name": "fixture", "type": "module" }\n', ...files }))
    {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), text);
    }

    return directory;
}

/**
 * tsup in `directory`, as a package's `build` runs it; esbuild records paths from there. Its
 * service keeps the directory it started in, so the working directory is passed to it too.
 */
async function tsup(directory, { esbuildOptions, ...options })
{
    const previous = process.cwd();
    process.chdir(directory);
    try
    {
        await build({
            format: ['esm'],
            outDir: 'dist',
            config: false,
            silent: true,
            dts: false,
            esbuildOptions: (esbuild, context) =>
            {
                esbuild.absWorkingDir = directory;
                esbuildOptions?.(esbuild, context);
            },
            ...options,
        });
    }
    finally
    {
        process.chdir(previous);
    }
}

const SHARED = {
    'src/shared.ts': 'export class Shared {}\n',
    'src/a.ts': 'import { Shared } from \'./shared\';\nexport const a = new Shared();\n',
    'src/b.ts': 'import { Shared } from \'./shared\';\nexport const b = new Shared();\n',
};

const ENTRIES = { a: 'src/a.ts', b: 'src/b.ts' };

/** Loads `./shared?copy` as a second module of `src/shared.ts`, as core's old entry plugin did. */
const suffixPlugin = {
    name: 'suffix',
    setup(esbuild)
    {
        esbuild.onResolve({ filter: /\?copy$/ }, args => ({ path: join(args.resolveDir, 'shared.ts'), suffix: '?copy' }));
    },
};

test('B1: a module two unsplit entries inline is found without markers or a source map', async (t) =>
{
    const directory = fixture(t, SHARED);
    await tsup(directory, { entry: ENTRIES, splitting: false, minify: true, sourcemap: false, esbuildPlugins: [recordMetafile('main')] });

    assert.doesNotMatch(readFileSync(join(directory, 'dist/a.js'), 'utf-8'), /src\/shared/);
    assert.deepEqual(findBundleProblems(directory).duplicated, [['src/shared.ts', ['dist/a.js', 'dist/b.js']]]);
});

test('B2: with splitting the shared module is in one chunk and the build passes', async (t) =>
{
    const directory = fixture(t, SHARED);
    await tsup(directory, { entry: ENTRIES, splitting: true, esbuildPlugins: [recordMetafile('main')] });

    const problems = findBundleProblems(directory);
    assert.deepEqual([problems.duplicated, problems.unrecorded], [[], []]);
    assert.equal(problems.fileCount, 3);
});

test('B3: one source loaded under two spellings is one module', async (t) =>
{
    const directory = fixture(t, { ...SHARED, 'src/b.ts': 'import { Shared } from \'./shared?copy\';\nexport const b = new Shared();\n' });
    await tsup(directory, { entry: ENTRIES, splitting: true, esbuildPlugins: [suffixPlugin, recordMetafile('main')] });

    assert.match(readFileSync(join(directory, 'dist/main.metafile.json'), 'utf-8'), /"src\/shared\.ts\?copy"/);
    assert.deepEqual(findBundleProblems(directory).duplicated.map(([module]) => module), ['src/shared.ts']);
});

test('B4: one source reached through two symlinked directories is one module', async (t) =>
{
    const directory = fixture(t, {
        'lib/shared.ts': 'export class Shared {}\n',
        'src/a.ts': 'import { Shared } from \'./one/shared\';\nexport const a = new Shared();\n',
        'src/b.ts': 'import { Shared } from \'./two/shared\';\nexport const b = new Shared();\n',
    });
    symlinkSync('../lib', join(directory, 'src/one'));
    symlinkSync('../lib', join(directory, 'src/two'));
    await tsup(directory, {
        entry: ENTRIES,
        splitting: true,
        esbuildOptions: (options) =>
        {
            options.preserveSymlinks = true;
        },
        esbuildPlugins: [recordMetafile('main')],
    });

    assert.deepEqual(findBundleProblems(directory).duplicated, [['lib/shared.ts', ['dist/a.js', 'dist/b.js']]]);
});

test('B5: a bundled dependency\'s module counts like the package\'s own', async (t) =>
{
    const directory = fixture(t, {
        'node_modules/dep/package.json': '{ "name": "dep", "main": "index.js" }\n',
        'node_modules/dep/index.js': 'export class Registry {}\n',
        'src/a.ts': 'import { Registry } from \'dep\';\nexport const a = new Registry();\n',
        'src/b.ts': 'import { Registry } from \'dep\';\nexport const b = new Registry();\n',
    });
    await tsup(directory, { entry: ENTRIES, splitting: false, noExternal: ['dep'], esbuildPlugins: [recordMetafile('main')] });

    assert.deepEqual(findBundleProblems(directory).duplicated, [['node_modules/dep/index.js', ['dist/a.js', 'dist/b.js']]]);
});

test('B6: a file in dist that no build recorded fails, whatever its code is named', async (t) =>
{
    const directory = fixture(t, SHARED);
    await tsup(directory, { entry: ENTRIES, splitting: true, esbuildPlugins: [recordMetafile('main')] });
    writeFileSync(join(directory, 'dist/extra.js'), 'var __shared = class {};\nexport { __shared };\n');

    assert.deepEqual(findBundleProblems(directory).unrecorded, ['dist/extra.js']);
});

test('B7: a second config built without recordMetafile leaves its output unrecorded', async (t) =>
{
    const directory = fixture(t, { ...SHARED, 'src/client.ts': 'export const client = 1;\n' });
    await tsup(directory, { entry: ENTRIES, splitting: true, clean: true, esbuildPlugins: [recordMetafile('main')] });
    await tsup(directory, { entry: { client: 'src/client.ts' }, splitting: false });

    assert.deepEqual(findBundleProblems(directory).unrecorded, ['dist/client.js']);
});

test('B8: a module listed with 0 bytes in one file and with code in another is in one file', async (t) =>
{
    const directory = fixture(t, {
        'src/shared.ts': 'export class Shared {}\n',
        'src/barrel.ts': 'export { Shared } from \'./shared\';\nexport const own = { name: \'barrel\' };\n',
        'src/a.ts': 'import { Shared } from \'./barrel\';\nexport const a = new Shared();\n',
        'src/b.ts': 'import { own } from \'./barrel\';\nexport const b = own;\n',
    });
    await tsup(directory, { entry: ENTRIES, splitting: false, esbuildPlugins: [recordMetafile('main')] });

    const { outputs } = JSON.parse(readFileSync(join(directory, 'dist/main.metafile.json'), 'utf-8'));
    assert.deepEqual(
        [outputs['dist/a.js'].inputs['src/barrel.ts'].bytesInOutput, outputs['dist/b.js'].inputs['src/barrel.ts'].bytesInOutput > 0],
        [0, true],
    );
    assert.deepEqual(findBundleProblems(directory).duplicated, []);
});

test('B9: an output file two configs write is named by both records, and the duplicate is found', async (t) =>
{
    const directory = fixture(t, SHARED);
    await tsup(directory, { entry: ENTRIES, splitting: true, clean: true, esbuildPlugins: [recordMetafile('main')] });
    await tsup(directory, { entry: { a: 'src/a.ts' }, splitting: false, esbuildPlugins: [recordMetafile('client')] });

    const problems = findBundleProblems(directory);
    assert.match(readFileSync(join(directory, 'dist/a.js'), 'utf-8'), /var Shared = class/);
    assert.deepEqual(problems.overlapping, [['dist/a.js', ['client', 'main']]]);
    assert.deepEqual(problems.duplicated.map(([module, outputs]) => [module, outputs.length]), [['src/shared.ts', 2]]);
});

test('B10: a record of an earlier build naming a file no longer in dist is stale', async (t) =>
{
    const directory = fixture(t, SHARED);
    await tsup(directory, { entry: { legacy: 'src/a.ts' }, esbuildPlugins: [recordMetafile('legacy')] });
    rmSync(join(directory, 'dist/legacy.js'));
    await tsup(directory, { entry: ENTRIES, splitting: true, esbuildPlugins: [recordMetafile('main')] });

    assert.deepEqual(findBundleProblems(directory).stale, [['dist/legacy.js', 'legacy']]);
});

test('B11: one build has no stale or overlapping record', async (t) =>
{
    const directory = fixture(t, SHARED);
    await tsup(directory, { entry: ENTRIES, splitting: true, sourcemap: true, esbuildPlugins: [recordMetafile('main')] });

    const { overlapping, stale, recordCount } = findBundleProblems(directory);
    assert.deepEqual({ overlapping, stale, recordCount }, { overlapping: [], stale: [], recordCount: 1 });
});

/** A workspace of `built` (B2's build) and `unbuilt` beside a copy of the check, and a run of it. */
async function workspace(t)
{
    const root = fixture(t, { 'packages/unbuilt/package.json': '{ "name": "unbuilt" }\n', ...prefixed('packages/built/', SHARED) });
    cpSync(join(repositoryRoot, 'scripts/check-bundle-identity.mjs'), join(root, 'scripts/check-bundle-identity.mjs'));
    cpSync(join(repositoryRoot, 'scripts/lib/bundle-identity.mjs'), join(root, 'scripts/lib/bundle-identity.mjs'));
    writeFileSync(join(root, 'packages/built/package.json'), '{ "name": "built", "type": "module" }\n');
    await tsup(join(root, 'packages/built'), { entry: ENTRIES, splitting: true, esbuildPlugins: [recordMetafile('main')] });

    const check = (...args) =>
    {
        const { status, stdout, stderr } = spawnSync(process.execPath, ['scripts/check-bundle-identity.mjs', '--all', ...args], { cwd: root, encoding: 'utf-8' });
        return { status, output: stdout + stderr };
    };

    return { root, check };
}

function prefixed(prefix, files)
{
    return Object.fromEntries(Object.entries(files).map(([path, text]) => [prefix + path, text]));
}

test('C1: without a list, a package without dist is skipped', async (t) =>
{
    const { status, output } = (await workspace(t)).check();

    assert.equal(status, 0, output);
    assert.match(output, /skipped \(packages\/unbuilt\): not built/);
});

test('C2: a listed package without dist fails', async (t) =>
{
    const { status, output } = (await workspace(t)).check('--built', 'packages/built', 'packages/unbuilt');

    assert.equal(status, 1, output);
    assert.match(output, /failed \(packages\/unbuilt\): the run built it, and it has no dist/);
});

test('C3: a listed directory outside packages/ is not checked', async (t) =>
{
    const { status, output } = (await workspace(t)).check('--built', 'packages/built', 'examples/app');

    assert.equal(status, 0, output);
});

test('C4: a listed package whose dist has no build record fails', async (t) =>
{
    const { root, check } = await workspace(t);
    renameSync(join(root, 'packages/built/dist/main.metafile.json'), join(root, 'packages/built/main.metafile.json'));
    const { status, output } = check('--built', 'packages/built');

    assert.equal(status, 1, output);
    assert.match(output, /dist holds no build record/);
});
