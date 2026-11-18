/**
 * Codegen in the processes the CLI starts — rows R1, R2, R8 and R9 of the #335
 * design
 *
 * Each row runs a real Node process on a fixture app in a temporary directory:
 * a package.json with no `"type"`, `@spfn/core` linked into its `node_modules`
 * (the built package: run `pnpm --filter @spfn/core build` and
 * `pnpm --filter spfn build` first), a tsconfig `@/*` alias, and a fixture
 * package under `node_modules` that counts its own evaluations. tsx sits in the
 * same process as the codegen loader's hooks, and each tsx line hands a hook a
 * different chain, so every row runs once per tsx installed in the workspace
 * (core's and the CLI's); `SPFN_CODEGEN_TSX_DIRS` (`:`-separated tsx package
 * directories) adds others — 4.23 is not installed here.
 *
 * Copies are counted from `@spfn/core`'s own registry, which counts
 * evaluations: a preload writes it out when the process exits.
 *
 * | #  | process                                                     | catches                                                  |
 * |----|-------------------------------------------------------------|----------------------------------------------------------|
 * | R1 | `spfn codegen run` (bin), route map + contract, a project    | a return to jiti or tsx-CommonJS copies: every @spfn/core |
 * |    | env read so the probe varies NODE_ENV                        | entry and the fixture package evaluated exactly once      |
 * | R2 | the `spfn dev` watcher entry under tsx and the dev hook:    | a generation tag that does not reach a transitive module  |
 * |    | edit a route, change the router only, edit an `@/` import    | (stale map); an `@/` file outside `routes/` nobody        |
 * |    | under `routes/` and one outside it, delete a route; a file   | watches; a file that left the import graph still watched  |
 * |    | no longer imported is no longer watched                      |                                                          |
 * | R8 | `spfn codegen run` on a `.cts` route requiring @spfn/core    | a CommonJS copy of @spfn/core passing silently (tsx 4.20, |
 * |    |                                                             | 4.23; 4.22 shares the instance, and the row checks so)    |
 * | R9 | 50 generations in one process, @spfn/core installed in the   | packages re-evaluated per load: MBs per reload, count > 1 |
 * |    | app's node_modules as real files                              |                                                          |
 * | R15| `.spfnrc.ts` writing its `import.meta` beside itself, through | a config that sees a file that does not exist (the        |
 * |    | `fileURLToPath(import.meta.url)`                              | `.spfn-esm` name tsx is kept away by)                     |
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watcherEntrySource } from '../dev';

const cliRoot = join(__dirname, '../../..');
const coreRoot = join(cliRoot, '../core');
const bin = join(cliRoot, 'bin/spfn.js');
const devLoader = join(cliRoot, 'dist/dev-loader/register.js');

interface Tsx
{
    version: string;
    loader: string;
    cli: string;
}

/** Every tsx installed for core and the CLI, plus those `SPFN_CODEGEN_TSX_DIRS` names, one per version. */
function installedTsx(): Tsx[]
{
    const fromPackages = [coreRoot, cliRoot].map(root => dirname(createRequire(join(root, 'package.json')).resolve('tsx/package.json')));
    const extra = (process.env.SPFN_CODEGEN_TSX_DIRS ?? '').split(':').filter(Boolean);
    const byVersion = new Map<string, Tsx>();

    for (const dir of [...fromPackages, ...extra])
    {
        const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

        byVersion.set(version, { version, loader: pathToFileURL(join(dir, 'dist/loader.mjs')).href, cli: join(dir, 'dist/cli.mjs') });
    }

    return [...byVersion.values()];
}

const TSX = installedTsx();

let appDir: string;

function write(path: string, content: string): void
{
    mkdirSync(dirname(join(appDir, path)), { recursive: true });
    writeFileSync(join(appDir, path), content);
}

/** Every `@spfn/core` entry's evaluations and the fixture package's counter, written when the process exits. */
const DUMP = `import { writeFileSync } from 'node:fs';
process.on('exit', () =>
{
    const registry = globalThis[Symbol.for('@spfn/core:module-evaluations')];
    const entries = Object.fromEntries([...(registry?.evaluations ?? [])].map(([entry, evaluations]) =>
        [entry, evaluations.map(evaluation => \`\${evaluation.evaluator}×\${evaluation.count ?? 1}\`)]));
    writeFileSync(process.env.DUMP_FILE, JSON.stringify({ entries, packageEvaluations: globalThis.__fixturePackageEvaluations ?? 0 }));
});
`;

function writeApp(): void
{
    write('package.json', JSON.stringify({ name: 'codegen-loader-fixture', private: true }));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
    write('.spfnrc.ts', 'import { defineConfig, defineGenerator } from \'@spfn/core/codegen\';\n\n'
        + 'export default defineConfig({ generators: [\n'
        + '    defineGenerator({ name: \'@spfn/core:route-map\', routerPath: \'./src/server/router.ts\', outputPath: \'./src/generated/route-map.ts\' }),\n'
        + '    defineGenerator({ name: \'@spfn/core:contract\', routerPath: \'./src/server/router.ts\' }),\n'
        + '] });\n');
    write('node_modules/fixture-pkg/package.json', JSON.stringify({ name: 'fixture-pkg', type: 'module', main: 'index.js' }));
    write('node_modules/fixture-pkg/index.js', 'globalThis.__fixturePackageEvaluations = (globalThis.__fixturePackageEvaluations ?? 0) + 1;\n'
        + 'import { defineRouter, route } from \'@spfn/core/route\';\n'
        + 'export const pkgRouter = defineRouter({ pkgStatus: route.get(\'/_pkg/status\').handler(async () => ({})) });\n');
    write('src/server/lib/segment.ts', 'export const segment: string = \'one\';\n');
    write('src/server/routes/probe.ts', 'import { route } from \'@spfn/core/route\';\n'
        + 'import { segment } from \'@/server/lib/segment\';\n'
        + 'const verbose = process.env.NODE_ENV !== \'production\';\n'
        + 'export const getProbe = route.get(`/probe/${segment}`).handler(async () => ({ verbose }));\n');
    writeRouter(['getProbe']);
    write('dump.mjs', DUMP);
}

/** The router, importing each named route from `./routes/<name minus "get", lowercased>`. */
function writeRouter(routes: string[], inline = ''): void
{
    const imports = routes.map(name => `import { ${name} } from './routes/${name.slice(3).toLowerCase()}';\n`).join('');

    write('src/server/router.ts', 'import { defineRouter, route } from \'@spfn/core/route\';\n'
        + 'import { pkgRouter } from \'fixture-pkg\';\n' + imports + inline
        + `export const appRouter = defineRouter({ ${[...routes, ...(inline ? ['getInline'] : [])].join(', ')} }).packages([pkgRouter]);\n`);
}

function routeMapPaths(): string[]
{
    const file = join(appDir, 'src/generated/route-map.ts');

    return existsSync(file) ? [...readFileSync(file, 'utf8').matchAll(/path: '([^']+)'/g)].map(match => match[1]) : [];
}

function readDump(): { entries: Record<string, string[]>; packageEvaluations: number }
{
    return JSON.parse(readFileSync(join(appDir, 'dump.json'), 'utf8'));
}

/** Output without colours, and without stack frames: vitest cannot render a child's frames in a message. */
function plain(output: string): string
{
    return output.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(line => !/^\s+at /.test(line)).join('\n');
}

function codegenRun(tsx: Tsx): { status: number | null; output: string }
{
    const env: NodeJS.ProcessEnv = { ...process.env, DUMP_FILE: join(appDir, 'dump.json') };

    delete env.SPFN_APP_URL;
    delete env.SPFN_CODEGEN_PROCESS;
    delete env.NODE_OPTIONS;

    const result = spawnSync(
        process.execPath,
        ['--import', tsx.loader, '--import', pathToFileURL(join(appDir, 'dump.mjs')).href, bin, 'codegen', 'run'],
        { cwd: appDir, env, encoding: 'utf8', timeout: 60_000 },
    );

    return { status: result.status, output: plain(`${result.stdout}${result.stderr}`) };
}

beforeEach(() =>
{
    appDir = mkdtempSync(join(tmpdir(), 'spfn-codegen-cli-'));
    mkdirSync(join(appDir, 'node_modules/@spfn'), { recursive: true });
    symlinkSync(coreRoot, join(appDir, 'node_modules/@spfn/core'), 'dir');
    writeApp();
});

afterEach(() =>
{
    rmSync(appDir, { recursive: true, force: true });
});

describe.each(TSX)('codegen in CLI processes, tsx $version', (tsx) =>
{
    it('R1 spfn codegen run evaluates every @spfn/core entry once, and the mounted package once', () =>
    {
        const { status, output } = codegenRun(tsx);

        expect(status, output).toBe(0);
        expect(routeMapPaths()).toEqual(['/probe/one', '/_pkg/status']);

        const { entries, packageEvaluations } = readDump();

        expect(Object.keys(entries)).toContain('@spfn/core/codegen');
        expect(Object.keys(entries)).toContain('@spfn/core/route');
        expect(Object.entries(entries).filter(([, evaluations]) => evaluations.join() !== 'esm×1')).toEqual([]);
        expect(packageEvaluations).toBe(1);
    });

    it('R8 a .cts route requiring @spfn/core is refused with the copy message naming the file', () =>
    {
        write('src/server/routes/legacy.cts', 'const { route } = require(\'@spfn/core/route\');\n'
            + 'module.exports = { getLegacy: route.get(\'/legacy\').handler(async () => ({})) };\n');
        writeRouter(['getProbe']);
        write('src/server/router.ts', readFileSync(join(appDir, 'src/server/router.ts'), 'utf8')
            .replace('import { pkgRouter }', 'import { getLegacy } from \'./routes/legacy.cjs\';\nimport { pkgRouter }')
            .replace('defineRouter({ getProbe })', 'defineRouter({ getProbe, getLegacy })'));

        const { status, output } = codegenRun(tsx);
        const copies = Object.values(readDump().entries).filter(evaluations => evaluations.length > 1);

        // tsx 4.20 and 4.23 compile what a `.cts` requires as CommonJS, a copy;
        // 4.22 hands the require to Node, which shares the ES module instance.
        if (copies.length === 0)
        {
            expect(status, output).toBe(0);

            return;
        }

        expect(status).not.toBe(0);
        expect(output).toContain('Refusing a second copy of @spfn/core in this process');
        expect(output).toContain('required by');
        expect(output).toContain('src/server/routes/legacy.cts');
        expect(output).not.toContain('Warned, not refused');
    });

    it('R15 .spfnrc.ts sees its own file in import.meta.url, filename and dirname', () =>
    {
        write('.spfnrc.ts', 'import { writeFileSync } from \'node:fs\';\n'
            + 'import { dirname, join } from \'node:path\';\n'
            + 'import { fileURLToPath } from \'node:url\';\n'
            + 'const meta = { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname };\n'
            + 'writeFileSync(join(dirname(fileURLToPath(import.meta.url)), \'meta.json\'), JSON.stringify(meta));\n'
            + readFileSync(join(appDir, '.spfnrc.ts'), 'utf8'));

        const { status, output } = codegenRun(tsx);
        const config = realpathSync(join(appDir, '.spfnrc.ts'));
        const meta = JSON.parse(readFileSync(join(appDir, 'meta.json'), 'utf8'));

        expect(status, output).toBe(0);
        expect({ ...meta, url: meta.url.replace(/\?.*$/, '') })
            .toEqual({ url: pathToFileURL(config).href, filename: config, dirname: dirname(config) });
    });

    it('R9 fifty generations retain a bounded heap each and evaluate the packages once, @spfn/core installed in the app', () =>
    {
        installCoreInApp();
        write('driver.mjs', `import { CodegenOrchestrator, generators } from '@spfn/core/codegen';
const generator = generators['route-map']({ name: '@spfn/core:route-map', routerPath: './src/server/router.ts' });
const orchestrator = new CodegenOrchestrator({ generators: [generator], cwd: process.cwd(), throwOnError: true });
const heap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage().heapUsed; };
for (let run = 0; run < 10; run++) await orchestrator.generateAll('manual');
const settled = heap();
for (let run = 0; run < 40; run++) await orchestrator.generateAll('manual');
const registry = globalThis[Symbol.for('@spfn/core:module-evaluations')];
const repeated = [...registry.evaluations].filter(([, evaluations]) => evaluations.length > 1 || (evaluations[0].count ?? 1) > 1).map(([entry]) => entry);
console.log(JSON.stringify({ perGeneration: (heap() - settled) / 40, packageEvaluations: globalThis.__fixturePackageEvaluations, repeated }));
`);
        const env: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: 'error', SPFN_LOG_LEVEL: 'error' };

        delete env.NODE_OPTIONS;

        const result = spawnSync(process.execPath, ['--expose-gc', '--import', tsx.loader, 'driver.mjs'], { cwd: appDir, env, encoding: 'utf8', timeout: 120_000 });
        const last = result.stdout.trim().split('\n').at(-1) ?? '';

        expect(result.status, plain(`${result.stdout}${result.stderr}`).slice(-2000)).toBe(0);

        const { perGeneration, packageEvaluations, repeated } = JSON.parse(last);

        expect(packageEvaluations).toBe(1);
        expect(repeated).toEqual([]);
        // Measured about 55 KB per generation for this fixture (three loads each: a
        // baseline and one per varied NODE_ENV value); re-evaluating the packages it
        // imports — @spfn/core among them — measured 2.3 MB.
        expect(perGeneration).toBeLessThan(400_000);
    });

    it('R2 the watcher regenerates for a route, the router, an @/ import inside and outside routes/, and a deletion', async () =>
    {
        write('src/server/routes/shared/name.ts', 'export const name: string = \'extra\';\n');
        write('src/server/routes/extra.ts', 'import { route } from \'@spfn/core/route\';\n'
            + 'import { name } from \'@/server/routes/shared/name\';\n'
            + 'export const getExtra = route.get(`/${name}`).handler(async () => ({}));\n');
        writeRouter(['getProbe', 'getExtra']);
        write('.spfn/watcher.mjs', watcherEntrySource());

        const watcher = startWatcher(tsx);

        try
        {
            await watcher.until(() => routeMapPaths().includes('/extra') && watcher.output().includes('Watch mode started'));

            // A route module.
            write('src/server/routes/extra.ts', readFileSync(join(appDir, 'src/server/routes/extra.ts'), 'utf8').replace('`/${name}`', '`/v2/${name}`'));
            await watcher.until(() => routeMapPaths().includes('/v2/extra'));

            // The router alone.
            writeRouter(['getProbe', 'getExtra'], 'const getInline = route.get(\'/inline\').handler(async () => ({}));\n');
            await watcher.until(() => routeMapPaths().includes('/inline'));

            // An `@/` import under routes/, reached only through another route module.
            write('src/server/routes/shared/name.ts', 'export const name: string = \'renamed\';\n');
            await watcher.until(() => routeMapPaths().includes('/v2/renamed'));

            // An `@/` import outside routes/: no pattern names it.
            write('src/server/lib/segment.ts', 'export const segment: string = \'two\';\n');
            await watcher.until(() => routeMapPaths().includes('/probe/two'));

            // A deleted route.
            writeRouter(['getProbe']);
            unlinkSync(join(appDir, 'src/server/routes/extra.ts'));
            await watcher.until(() => !routeMapPaths().some(path => path.includes('renamed')));

            // A file no load reaches any more is no longer watched.
            write('src/server/routes/probe.ts', 'import { route } from \'@spfn/core/route\';\n'
                + 'export const getProbe = route.get(\'/probe/plain\').handler(async () => ({}));\n');
            await watcher.until(() => routeMapPaths().includes('/probe/plain'));

            const regenerations = watcher.output().split('Regenerated').length;

            write('src/server/lib/segment.ts', 'export const segment: string = \'three\';\n');
            await new Promise(settle => setTimeout(settle, 1500));

            expect(watcher.output().split('Regenerated').length).toBe(regenerations);
            expect(watcher.output()).not.toContain('Regeneration failed');
        }
        finally
        {
            await watcher.stop();
        }
    }, 90_000);
});

/**
 * `@spfn/core` as an app installs it: real files under the app's
 * `node_modules`, so a load that tagged packages would reach it. The link the
 * other rows use resolves to the workspace, outside the app root, which the
 * loader never tags either way. Its own dependencies resolve through a link to
 * the workspace package's.
 */
function installCoreInApp(): void
{
    const installed = join(appDir, 'node_modules/@spfn/core');

    unlinkSync(installed);
    mkdirSync(installed);
    cpSync(join(coreRoot, 'package.json'), join(installed, 'package.json'));
    cpSync(join(coreRoot, 'dist'), join(installed, 'dist'), { recursive: true, filter: source => !source.endsWith('.map') });
    symlinkSync(join(coreRoot, 'node_modules'), join(installed, 'node_modules'), 'dir');
}

/** The watcher, started as `spfn dev` starts it (tsx, the dev hook, `NODE_ENV=production`), in a process group of its own. */
function startWatcher(tsx: Tsx): { output: () => string; until: (condition: () => boolean) => Promise<void>; stop: () => Promise<void> }
{
    const loader = pathToFileURL(devLoader);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };

    loader.searchParams.set('root', appDir);
    delete env.SPFN_APP_URL;
    delete env.NODE_OPTIONS;

    const child = spawn(process.execPath, [tsx.cli, '--import', loader.href, join(appDir, '.spfn/watcher.mjs')], {
        cwd: appDir,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));

    const exited = new Promise<void>(settle => child.on('exit', () => settle()));

    return {
        output: () => plain(output),
        until: async (condition) =>
        {
            const deadline = Date.now() + 20_000;

            while (!condition())
            {
                if (Date.now() > deadline || child.exitCode !== null)
                {
                    throw new Error(`watcher did not get there:\n${plain(output).slice(-3000)}`);
                }

                await new Promise(settle => setTimeout(settle, 50));
            }
        },
        stop: async () =>
        {
            if (child.exitCode === null && child.signalCode === null)
            {
                process.kill(-child.pid!, 'SIGTERM');
                await exited;
            }
        },
    };
}
