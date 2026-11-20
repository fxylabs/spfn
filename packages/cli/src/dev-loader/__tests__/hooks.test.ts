/**
 * The `spfn dev` resolve hook, through a real `tsx --import` child process on
 * fixture files — the shape `spfn dev` runs the server in. Each fixture records
 * the format it was evaluated in (`typeof require`: a function only in
 * CommonJS) on `globalThis`, so a file of either syntax can report.
 *
 * | #  | fixture                                                               | evaluated as                    |
 * |----|-----------------------------------------------------------------------|---------------------------------|
 * | H1 | type-less package: `.ts`                                              | ESM                             |
 * | H1 | type-less package: `.ts` importing `.ts` statically, by a relative    | ESM, all three (tsx 4.22 gives  |
 * |    | path and through a tsconfig `paths` alias; the first imported again   | them a virtual CommonJS URL);   |
 * |    | dynamically                                                           | one evaluation of it            |
 * | H1 | type-less package: `.ts` imported with the app's own query            | ESM, all four; the query        |
 * |    | (`?v=2`) statically, dynamically, and re-exported, and with a bare    | arrives as written              |
 * |    | `?raw` (tsx 4.22 and 4.23 append the whole query to a virtual path)   | (`import.meta.url` ends `?v=2`, |
 * |    |                                                                       | `?raw`); one evaluation a query |
 * | H1 | type-less package: `.js` with `import`/`export`                       | ESM; default import is the      |
 * |    |                                                                       | function, not the namespace     |
 * | H1 | type-less package: `.js` with only `import.meta` / top-level await    | ESM                             |
 * | H1 | type-less package: `.js` with `require`/`module.exports`              | CommonJS                        |
 * | H1 | type-less package: `.cts` (written with `export`), `.cjs`             | CommonJS, as stated             |
 * | H1 | type-less package: `.mjs`                                             | ESM, as stated                  |
 * | H1 | `"type": "commonjs"` package: `.ts`                                   | ESM                             |
 * | H1 | `"type": "commonjs"` package: `.js` written with `export`             | CommonJS, as stated             |
 * | H1 | a workspace package beside the app: `.ts`                             | ESM                             |
 * | H1 | a dependency under the app's `node_modules`: type-less `.js` with     | untouched: as tsx alone decides |
 * |    | `export`                                                              | it (CommonJS on 4.22, ESM on    |
 * |    |                                                                       | 4.23)                           |
 * | H1 | an app under a directory named `node_modules`: `.ts` with top-level   | ESM                             |
 * |    | await                                                                 |                                 |
 * | H2 | type-less package: `.ts` with TypeScript syntax, through tsx's        | ESM, transformed (tsx's scoped  |
 * |    | `tsImport` (as `spfn env` loads a schema), bare and with `?v=3`       | loader keeps its namespace)     |
 * | H3 | type-less package: `.js` imported as CommonJS (`?v=1`), rewritten     | CommonJS, then ESM: a format    |
 * |    | with `export` and imported again (`?v=2`)                             | is what the file holds when it  |
 * |    |                                                                       | is loaded                       |
 * | H3 | the hook alone: a `.ts` URL resolved before its file is written; a    | no format, then ESM, for both   |
 * |    | `.js` symlink naming a dependency, then retargeted to app source      |                                 |
 *
 * Runs against `dist/dev-loader/register.js`: build first
 * (`pnpm --filter spfn build`). Each tsx minor encodes the URL of a file it
 * takes for CommonJS differently; `SPFN_DEV_HOOK_TSX_CLI` runs the rows on
 * another tsx's `dist/cli.mjs` than the cli's own.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createResolveHook } from '../hooks';

const packageRoot = join(__dirname, '../../..');
const register = join(packageRoot, 'dist/dev-loader/register.js');
const tsxCli = process.env.SPFN_DEV_HOOK_TSX_CLI ?? createRequire(join(packageRoot, 'package.json')).resolve('tsx/cli');
const tsxApi = pathToFileURL(join(dirname(tsxCli), 'esm/api/index.mjs')).href;

/** The statement a fixture records its format with, under its row name. */
function records(row: string): string
{
    return `globalThis.formats[${JSON.stringify(row)}] = typeof require === 'function' ? 'commonjs' : 'module';\n`;
}

/** The statement a fixture counts its evaluations with: one file imported twice is one module. */
function counts(row: string): string
{
    const key = JSON.stringify(`${row}: evaluations`);

    return `globalThis.formats[${key}] = (globalThis.formats[${key}] ?? 0) + 1;\n`;
}

/** A fixture imported under the app's own query: it records its format and evaluations by that query. */
const QUERIED_SOURCE = `const row = '.ts imported with an app query ' + new URL(import.meta.url).search;
globalThis.formats[row] = typeof require === 'function' ? 'commonjs' : 'module';
globalThis.formats[row + ': evaluations'] = (globalThis.formats[row + ': evaluations'] ?? 0) + 1;
export const queried = 1;
`;

/**
 * The workspace fixtures, by path under it: the source, and the row `main.ts`
 * imports it under — none for a package.json, a tsconfig, or a file only
 * another fixture imports.
 */
const WORKSPACE_FIXTURES = [
    { path: 'app/package.json', source: '{ "name": "app" }' },
    { path: 'app/ts-file.ts', row: '.ts', source: `const typed: number = 1;\nvoid typed;\n${records('.ts')}` },
    { path: 'app/tsconfig.json', source: '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }' },
    {
        path: 'app/static-importer.ts',
        row: '.ts importing .ts statically',
        source: `import { value } from './statically-imported';\nimport { aliased } from '@/alias-imported';\n`
            + `void value;\nvoid aliased;\n${records('.ts importing .ts statically')}`,
    },
    {
        path: 'app/statically-imported.ts',
        row: '.ts imported statically',
        source: `${records('.ts imported statically')}${counts('.ts imported statically')}export const value = 1;\n`,
    },
    { path: 'app/alias-imported.ts', source: `${records('.ts imported through a paths alias')}export const aliased = 1;\n` },
    { path: 'app/queried.ts', source: QUERIED_SOURCE },
    {
        path: 'app/query-static-importer.ts',
        row: '.ts importing .ts with an app query statically',
        source: `import { queried } from './queried.ts?v=2';\nimport { queried as raw } from './queried.ts?raw';\nvoid queried;\nvoid raw;\n`
            + records('.ts importing .ts with an app query statically'),
    },
    {
        path: 'app/query-dynamic-importer.ts',
        row: '.ts importing .ts with an app query dynamically',
        source: `await import('./queried.ts?v=2');\n${records('.ts importing .ts with an app query dynamically')}`,
    },
    {
        path: 'app/query-re-exporter.ts',
        row: '.ts re-exporting .ts with an app query',
        source: `export { queried } from './queried.ts?v=2';\n${records('.ts re-exporting .ts with an app query')}`,
    },
    { path: 'app/esm-syntax.js', row: 'ESM-syntax .js', source: `${records('ESM-syntax .js')}export default function greet() {}\n` },
    { path: 'app/import-meta.js', row: '.js with only import.meta', source: `void import.meta.url;\n${records('.js with only import.meta')}` },
    { path: 'app/top-level-await.js', row: '.js with only top-level await', source: `await Promise.resolve();\n${records('.js with only top-level await')}` },
    { path: 'app/cjs-syntax.js', row: 'CJS-syntax .js', source: `${records('CJS-syntax .js')}module.exports = { value: require('node:path').sep };\n` },
    { path: 'app/stated.cts', row: '.cts', source: `${records('.cts')}export const value: number = 1;\n` },
    { path: 'app/plain.cjs', row: '.cjs', source: `${records('.cjs')}module.exports = {};\n` },
    { path: 'app/plain.mjs', row: '.mjs', source: `${records('.mjs')}export const value = 1;\n` },
    { path: 'app/commonjs-package/package.json', source: '{ "type": "commonjs" }' },
    { path: 'app/commonjs-package/ts-file.ts', row: 'type commonjs: .ts', source: records('type commonjs: .ts') },
    { path: 'app/commonjs-package/esm-syntax.js', row: 'type commonjs: .js', source: `${records('type commonjs: .js')}export const value = 1;\n` },
    { path: 'lib/index.ts', row: 'workspace package beside the app: .ts', source: records('workspace package beside the app: .ts') },
    { path: 'app/node_modules/dep/package.json', source: '{ "name": "dep", "main": "index.js" }' },
    { path: 'app/node_modules/dep/index.js', row: 'dependency: type-less ESM-syntax .js', source: `${records('dependency: type-less ESM-syntax .js')}export const value = 1;\n` },
];

let tmp: string;

function write(root: string, path: string, source: string): void
{
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
}

/**
 * Run `main.ts` in `root` under tsx with the hook registered for `root`,
 * importing each specifier: the formats the fixtures recorded, and what the
 * default import of `./esm-syntax.js` is when it is among them.
 */
function runProject(root: string, specifiers: string[]): Record<string, string | number>
{
    const imports = specifiers.map(specifier => `const ns${specifiers.indexOf(specifier)} = await import(${JSON.stringify(specifier)});`);

    write(root, 'main.ts', `globalThis.formats = {};
${imports.join('\n')}
const esm = ${specifiers.includes('./esm-syntax.js') ? `ns${specifiers.indexOf('./esm-syntax.js')}` : 'undefined'};
console.log(JSON.stringify({ ...globalThis.formats, 'default import of ESM-syntax .js': typeof esm?.default }));`);

    const loader = pathToFileURL(register);

    loader.searchParams.set('root', root);

    const child = spawnSync(process.execPath, [tsxCli, '--import', loader.href, 'main.ts'], { cwd: root, encoding: 'utf8' });

    // The child's stack frames left out: vitest would resolve them as its own.
    const stderr = child.stderr.replace(/^\s+at .*$\n?/gm, '');

    expect(child.status, stderr).toBe(0);
    expect(stderr).toBe('');

    return JSON.parse(child.stdout.trim().split('\n').pop()!);
}

/** The format tsx alone, without the hook, evaluates the dependency fixture of the app at `root` in. */
function dependencyFormatWithoutHook(root: string): string
{
    write(root, 'control.mjs', `globalThis.formats = {};\nawait import('dep');\nconsole.log(JSON.stringify(globalThis.formats));\n`);

    const child = spawnSync(process.execPath, [tsxCli, 'control.mjs'], { cwd: root, encoding: 'utf8' });

    expect(child.status, child.stderr).toBe(0);

    return JSON.parse(child.stdout.trim().split('\n').pop()!)['dependency: type-less ESM-syntax .js'];
}

describe('spfn dev resolve hook', () =>
{
    beforeAll(() =>
    {
        expect(existsSync(register), 'dist/dev-loader/register.js — build spfn first').toBe(true);
        tmp = mkdtempSync(join(tmpdir(), 'spfn-dev-hook-'));
    });

    afterAll(() =>
    {
        rmSync(tmp, { recursive: true, force: true });
    });

    it('H1 states the format of application source, keeps the app\'s own query, and leaves stated formats and dependencies alone', () =>
    {
        const workspace = join(tmp, 'workspace');

        WORKSPACE_FIXTURES.forEach(fixture => write(workspace, fixture.path, fixture.source));

        const specifiers = WORKSPACE_FIXTURES
            .filter(fixture => fixture.row !== undefined)
            .map(fixture => fixture.path.startsWith('app/node_modules/dep/') ? 'dep'
                : fixture.path.startsWith('app/') ? `./${fixture.path.slice('app/'.length)}` : `../${fixture.path}`);

        expect(runProject(join(workspace, 'app'), specifiers)).toEqual({
            '.ts': 'module',
            '.ts importing .ts statically': 'module',
            '.ts imported statically': 'module',
            '.ts imported statically: evaluations': 1,
            '.ts imported through a paths alias': 'module',
            '.ts importing .ts with an app query statically': 'module',
            '.ts importing .ts with an app query dynamically': 'module',
            '.ts re-exporting .ts with an app query': 'module',
            '.ts imported with an app query ?v=2': 'module',
            '.ts imported with an app query ?v=2: evaluations': 1,
            '.ts imported with an app query ?raw': 'module',
            '.ts imported with an app query ?raw: evaluations': 1,
            'ESM-syntax .js': 'module',
            'default import of ESM-syntax .js': 'function',
            '.js with only import.meta': 'module',
            '.js with only top-level await': 'module',
            'CJS-syntax .js': 'commonjs',
            '.cts': 'commonjs',
            '.cjs': 'commonjs',
            '.mjs': 'module',
            'type commonjs: .ts': 'module',
            'type commonjs: .js': 'commonjs',
            'workspace package beside the app: .ts': 'module',
            'dependency: type-less ESM-syntax .js': dependencyFormatWithoutHook(join(workspace, 'app')),
        });
    });

    it('H1 treats an app under a directory named node_modules as application source', () =>
    {
        const root = join(tmp, 'node_modules/app');

        write(root, 'package.json', '{ "name": "app" }');
        write(root, 'probe.ts', `await Promise.resolve();\n${records('.ts with top-level await')}`);

        expect(runProject(root, ['./probe.ts'])).toEqual({
            '.ts with top-level await': 'module',
            'default import of ESM-syntax .js': 'undefined',
        });
    });

    it('H2 lets tsx\'s tsImport transform a .ts file it loads as ESM', () =>
    {
        const root = join(tmp, 'ts-import');

        write(root, 'package.json', '{ "name": "app" }');
        write(root, 'typed.ts', `const typed = 1 as number;\nvoid typed;\n${records('tsImport: .ts with TypeScript syntax')}`);
        write(root, 'typed-query.ts', `const typed = 1 as number;\nvoid typed;\n${records('tsImport: .ts with TypeScript syntax ?v=3')}`);
        write(root, 'tsimporter.ts', `const { tsImport } = await import(${JSON.stringify(tsxApi)});\n`
            + 'await tsImport(new URL(\'./typed.ts\', import.meta.url).href, import.meta.url);\n'
            + 'await tsImport(new URL(\'./typed-query.ts?v=3\', import.meta.url).href, import.meta.url);\n');

        expect(runProject(root, ['./tsimporter.ts'])).toEqual({
            'tsImport: .ts with TypeScript syntax': 'module',
            'tsImport: .ts with TypeScript syntax ?v=3': 'module',
            'default import of ESM-syntax .js': 'undefined',
        });
    });

    it('H3 classifies a .js file by what it holds when it is loaded, not when its path was first resolved', () =>
    {
        const root = join(tmp, 'rewritten');

        write(root, 'package.json', '{ "name": "app" }');
        write(root, 'rewritten.js', `${records('.js rewritten as ESM ?v=1')}module.exports = {};\n`);
        write(root, 'rewriter.ts', 'import { writeFileSync } from \'node:fs\';\n'
            + 'await import(\'./rewritten.js?v=1\');\n'
            + `writeFileSync(new URL('./rewritten.js', import.meta.url), ${JSON.stringify(`${records('.js rewritten as ESM ?v=2')}export const value = 1;\n`)});\n`
            + 'await import(\'./rewritten.js?v=2\');\n');

        expect(runProject(root, ['./rewriter.ts'])).toEqual({
            '.js rewritten as ESM ?v=1': 'commonjs',
            '.js rewritten as ESM ?v=2': 'module',
            'default import of ESM-syntax .js': 'undefined',
        });
    });

    it('H3 asks again for a URL first resolved before its file existed, or while its symlink named a dependency', () =>
    {
        const root = join(tmp, 'unit');
        const hook = createResolveHook((write(root, 'package.json', '{ "name": "app" }'), root));
        const formatOf = (path: string) => hook('', undefined, () => ({ url: pathToFileURL(join(root, path)).href })).format;

        write(root, 'node_modules/dep/index.js', 'export const value = 1;\n');
        write(root, 'esm-syntax.js', 'export const value = 1;\n');
        symlinkSync(join(root, 'node_modules/dep/index.js'), join(root, 'link.js'));

        expect([formatOf('generated.ts'), formatOf('link.js')]).toEqual([undefined, undefined]);

        write(root, 'generated.ts', 'export const value = 1;\n');
        rmSync(join(root, 'link.js'));
        symlinkSync(join(root, 'esm-syntax.js'), join(root, 'link.js'));

        expect([formatOf('generated.ts'), formatOf('link.js')]).toEqual(['module', 'module']);
    });
});
