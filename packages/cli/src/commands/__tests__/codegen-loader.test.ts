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
 * |    | under `routes/` and one outside it, delete a route; a file   | watches; a file that left the import graph still watched; |
 * |    | no longer imported is no longer watched; import a missing    | a missing file nobody watches for, so creating it         |
 * |    | file, create it; the same in a directory not there yet       | regenerates nothing                                       |
 * | R8 | `spfn codegen run` on a `.cts` route requiring @spfn/core    | a CommonJS copy of @spfn/core passing silently (tsx 4.20, |
 * |    |                                                             | 4.23; 4.22 shares the instance, and the row checks so)    |
 * | R23| `spfn codegen run` on a route importing a package that       | the refusal itself on every tsx (R8 reaches it only where |
 * |    | imports @spfn/core/route's file again under a query          | tsx makes a CommonJS copy, not on 4.22 in CI)             |
 * | R9 | 50 generations in one process, @spfn/core installed in the   | packages re-evaluated per load: MBs per reload, count > 1 |
 * |    | app's node_modules as real files                              |                                                          |
 * | R15| `.spfnrc.ts` writing its `import.meta` beside itself, through | a config that sees a file that does not exist (the        |
 * |    | `fileURLToPath(import.meta.url)`                              | `.spfn-esm` name tsx is kept away by)                     |
 * | R20| `spfn codegen run` with a `.spfnrc.ts` using `__dirname`      | "No generators configured" and exit 0: CI skips codegen   |
 * | R31| `spfn codegen run` with a misspelt package generator, then   | "No generators configured" / "Make sure it is installed"  |
 * |    | one whose `/codegen` throws on import                        | and exit 0: a configured generator silently skipped       |
 * | R32| R23's second copy under `spfn build --server-only`, `spfn     | a codegen entry point that no longer marks its process:   |
 * |    | contract check` and the watcher entry `spfn dev` writes      | the refusal silently a warning there                      |
 * | R33| the watcher entry with a `.spfnrc.ts` that fails to load,    | a watcher that exits on a broken config while the server  |
 * |    | then fixed                                                   | runs on (regeneration off until a restart), or one that   |
 * |    |                                                              | stays up silent, or never loads the fix                   |
 * | R34| the watcher entry with a generator held by a file gate: one   | an entry that exits mid-generation, or that ignores every |
 * |    | signal, then the gate opened; then two signals               | signal while a generation hangs (orphaned by spfn dev)    |
 * | R34b| the watcher entry reloading a `.spfnrc.ts` whose custom      | a load that never settles taken for a hung watcher: no    |
 * |    | generator's top-level `await` never settles: two signals     | line naming it, or no way out but SIGKILL                 |
 * | R35| `spfn dev` with the watcher's generator held by a file gate: | a parent that exits before its watcher (orphaned, writing |
 * |    | one SIGTERM to it, then the gate opened; then two SIGTERMs   | into the project after spfn dev stopped), or that does    |
 * |    |                                                              | not forward the second signal                             |
 * | R35b| R35's single SIGTERM with no tsx in the app's node_modules   | a watcher started through `pnpm exec tsx` / `npx tsx`,    |
 * |    | (the CLI's own tsx runs it)                                  | which exit at once: the watcher orphaned again            |
 * | R22| the bin, and the tsx child it re-spawns, recording their     | the codegen mark set where the CLI starts, inherited by   |
 * |    | environment at exit                                          | the dev server, `next` and `spfn db` (every descendant)   |
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
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

/**
 * A route importing a package the loader leaves to Node, which imports
 * `@spfn/core/route`'s file again by another URL: a second native copy, on
 * every tsx (R23).
 */
function writeSecondCopy(): void
{
    write('node_modules/copy-pkg/package.json', JSON.stringify({ name: 'copy-pkg', type: 'module', main: 'index.js' }));
    write('node_modules/copy-pkg/index.js', 'import { createRequire } from \'node:module\';\n'
        + 'import { pathToFileURL } from \'node:url\';\n'
        + 'const entry = createRequire(import.meta.url).resolve(\'@spfn/core/route\');\n'
        + 'await import(`${pathToFileURL(entry).href}?second-copy`);\n'
        + 'export const copied = true;\n');
    write('src/server/routes/copy.ts', 'import { route } from \'@spfn/core/route\';\n'
        + 'import { copied } from \'copy-pkg\';\n'
        + 'export const getCopy = route.get(`/copy/${copied}`).handler(async () => ({}));\n');
    writeRouter(['getProbe', 'getCopy']);
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
    return binRun(tsx, ['codegen', 'run']);
}

/** The bin under tsx, as a package script runs it, with `args`. */
function binRun(tsx: Tsx, args: string[]): { status: number | null; output: string }
{
    const env: NodeJS.ProcessEnv = { ...process.env, DUMP_FILE: join(appDir, 'dump.json') };

    delete env.SPFN_APP_URL;
    delete env.SPFN_CODEGEN_PROCESS;
    delete env.NODE_OPTIONS;

    const result = spawnSync(
        process.execPath,
        ['--import', tsx.loader, '--import', pathToFileURL(join(appDir, 'dump.mjs')).href, bin, ...args],
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

afterEach(async () =>
{
    await Promise.all(watchers.splice(0).map(watcher => watcher.kill()));
    rmSync(appDir, { recursive: true, force: true });
});

describe('codegen in CLI processes - the codegen mark', () =>
{
    it('R22 the bin and what it spawns carry no codegen mark in their environment', () =>
    {
        const record = join(appDir, 'mark.log');

        write('record-mark.mjs', 'import { appendFileSync } from \'node:fs\';\n'
            + `process.on('exit', () => appendFileSync(${JSON.stringify(record)}, \`\${process.env.SPFN_CODEGEN_PROCESS ?? 'unset'}\\n\`));\n`);

        const env: NodeJS.ProcessEnv = { ...process.env };

        delete env.SPFN_CODEGEN_PROCESS;
        delete env.NODE_OPTIONS;

        const result = spawnSync(
            process.execPath,
            ['--import', pathToFileURL(join(appDir, 'record-mark.mjs')).href, bin, '--version'],
            { cwd: appDir, env, encoding: 'utf8', timeout: 60_000 },
        );

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        // The bin, and the child it re-spawns under tsx with the same --import.
        expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['unset', 'unset']);
    });
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

    it('R23 a second native evaluation of an @spfn/core entry is refused in spfn codegen run', () =>
    {
        writeSecondCopy();

        const { status, output } = codegenRun(tsx);

        expect(readDump().entries['@spfn/core/route']).toEqual(['esm×2']);
        expect(status, output).not.toBe(0);
        expect(output).toContain('Refusing a second copy of @spfn/core in this process');
        expect(output).not.toContain('Warned, not refused');
    });

    it.each([
        { entry: 'spfn build --server-only', args: ['build', '--server-only'] },
        { entry: 'spfn contract check', args: ['contract', 'check'] },
    ])('R32 $entry marks its process: a second copy of @spfn/core is refused, not warned about', ({ args }) =>
    {
        writeSecondCopy();

        const { status, output } = binRun(tsx, args);

        expect(status, output).not.toBe(0);
        expect(output).toContain('Refusing a second copy of @spfn/core in this process');
        expect(output).not.toContain('Warned, not refused');
    });

    it('R32 the watcher entry spfn dev starts marks its process: a second copy of @spfn/core is refused, not warned about', async () =>
    {
        writeSecondCopy();
        write('.spfn/watcher.mjs', watcherEntrySource());

        const watcher = startWatcher(tsx);

        try
        {
            await watcher.until(() => /Refusing a second copy|Warned, not refused/.test(watcher.output()));

            expect(watcher.output()).toContain('Refusing a second copy of @spfn/core in this process');
            expect(watcher.output()).not.toContain('Warned, not refused');
        }
        finally
        {
            await watcher.stop();
        }
    });

    it('R34 the watcher entry on a signal: finishes the running generation, then exits; on a second, exits at once', async () =>
    {
        // Without the first half, the entry exits mid-generation (the outputs of
        // one cycle from two generations); without the second, a generation that
        // never settles leaves the watcher ignoring every signal, orphaned once
        // spfn dev exits.
        writeGateGenerator();
        write('.spfn/watcher.mjs', watcherEntrySource());

        const stopping = 'Codegen watcher stopping once the running generation or codegen config load finishes';

        for (const second of [true, false])
        {
            rmSync(join(appDir, 'entered'), { force: true });

            const watcher = startWatcher(tsx);

            try
            {
                await watcher.until(() => existsSync(join(appDir, 'entered')));
                watcher.signal('SIGTERM');
                await watcher.until(() => watcher.output().includes(stopping));

                if (second)
                {
                    watcher.signal('SIGTERM');

                    expect(await watcher.exited).toBe(143);
                    expect(existsSync(join(appDir, 'finished'))).toBe(false);
                }
                else
                {
                    write('open', '');

                    expect(await watcher.exited).toBe(0);
                    expect(existsSync(join(appDir, 'finished'))).toBe(true);
                }
            }
            finally
            {
                await watcher.kill();
            }
        }
    });

    it('R34b the watcher entry on a signal during a config load that never settles: says it waits for the load; a second signal exits', async () =>
    {
        // Without it, the first signal's line names only a generation while the
        // watcher sits in a module evaluation nothing can cancel. The load holds
        // a timer, as a stuck connection would: one holding nothing ends the
        // process once close() has released the watches (Node's exit 13).
        writeGateGenerator();
        write('src/gate/x.ts', '');
        write('open', '');
        write('hang-generator.mjs', 'await new Promise(() => setInterval(() => undefined, 1_000));\nexport default function createHang() { return { name: \'hang\', watchPatterns: [], async generate() {} }; }\n');
        write('.spfn/watcher.mjs', watcherEntrySource());

        const watcher = startWatcher(tsx);

        try
        {
            await watcher.until(() => existsSync(join(appDir, 'finished')));
            await watcher.until(() => watcher.output().includes('Watch mode started'));
            write('.spfnrc.ts', 'import { defineConfig } from \'@spfn/core/codegen\';\n\n'
                + 'export default defineConfig({ generators: [{ path: \'./gate-generator.mjs\' }, { path: \'./hang-generator.mjs\' }] });\n');
            await watcher.until(() => watcher.output().includes('Codegen config changed (.spfnrc.ts): reloading'));
            watcher.signal('SIGTERM');
            await watcher.until(() => watcher.output().includes('Codegen watcher stopping once the running generation or codegen config load finishes (signal again to exit now)'));
            await watcher.until(() => watcher.output().includes('Closing watcher'));
            expect(watcher.running()).toBe(true);
            watcher.signal('SIGTERM');

            expect(await watcher.exited, watcher.output()).toBe(143);
            expect(watcher.output()).not.toMatch(/Reloaded codegen config|Codegen config failed to load/);
        }
        finally
        {
            await watcher.kill();
        }
    }, 60_000);

    it('R35 spfn dev on a signal waits for its watcher: forwards the first and the second, and exits after the watcher', async () =>
    {
        // Without it, the parent exits at once and the watcher it started runs on,
        // orphaned, writing into the project: a process manager or a CI runner
        // sends one SIGTERM to the pid it started. The gate stays shut 6 s past
        // the signal: execa's kill() SIGKILLs a child 5 s after a SIGTERM by
        // default, which ends tsx and the parent's wait with the entry still running.
        writeGateGenerator();
        installTsx(tsx);

        const stopping = 'Codegen watcher stopping once the running generation or codegen config load finishes';

        for (const second of [false, true])
        {
            rmSync(join(appDir, 'entered'), { force: true });

            const dev = startDev(tsx, await freePort());

            try
            {
                await dev.until(() => existsSync(join(appDir, 'entered')));

                const watcherPid = Number(readFileSync(join(appDir, 'entered'), 'utf8'));

                dev.signal('SIGTERM');
                await dev.until(() => dev.output().includes(stopping) || !dev.running());

                expect({ dev: dev.running(), watcher: alive(watcherPid) }, dev.output()).toEqual({ dev: true, watcher: true });

                if (second)
                {
                    dev.signal('SIGTERM');
                    await dev.until(() => !dev.running());

                    expect(await dev.exited, dev.output()).toBe(0);
                    expect(alive(watcherPid), dev.output()).toBe(false);
                    expect(existsSync(join(appDir, 'finished'))).toBe(false);
                }
                else
                {
                    await new Promise(settle => setTimeout(settle, 6_000));

                    expect({ dev: dev.running(), watcher: alive(watcherPid) }, dev.output()).toEqual({ dev: true, watcher: true });

                    write('open', '');

                    expect(await dev.exited, dev.output()).toBe(0);
                    expect(alive(watcherPid), dev.output()).toBe(false);
                    expect(existsSync(join(appDir, 'finished'))).toBe(true);
                }
            }
            finally
            {
                await dev.kill();
                rmSync(join(appDir, 'open'), { force: true });
                rmSync(join(appDir, 'finished'), { force: true });
            }
        }
    }, 90_000);

    it('R35b with no tsx installed in the app, spfn dev runs its watcher under the CLI\'s own tsx and still waits for it', async () =>
    {
        // Without it, the watcher of an app with no tsx of its own runs through
        // `pnpm exec tsx`, which exits at once on SIGTERM: spfn dev exits with
        // it, and the watcher runs on, orphaned. The server keeps the app's
        // `.bin/tsx`, as `pnpm exec tsx` runs it.
        writeGateGenerator();
        installTsx(tsx);
        rmSync(join(appDir, 'node_modules/tsx'));

        const dev = startDev(tsx, await freePort());

        try
        {
            await dev.until(() => existsSync(join(appDir, 'entered')));

            const watcherPid = Number(readFileSync(join(appDir, 'entered'), 'utf8'));

            dev.signal('SIGTERM');
            await dev.until(() => dev.output().includes('Codegen watcher stopping once the running generation or codegen config load finishes') || !dev.running());

            expect({ dev: dev.running(), watcher: alive(watcherPid) }, dev.output()).toEqual({ dev: true, watcher: true });

            write('open', '');

            expect(await dev.exited, dev.output()).toBe(0);
            expect(alive(watcherPid), dev.output()).toBe(false);
            expect(existsSync(join(appDir, 'finished'))).toBe(true);
        }
        finally
        {
            await dev.kill();
        }
    }, 60_000);

    it('R36 spfn dev stopped before its server is ready starts no Next.js once the server becomes ready, and exits leaving no process', async () =>
    {
        // Without it, Next.js is started after the stop signalled the children
        // that existed: nothing ever signals it, and it runs on, orphaned, once
        // spfn dev exits with its watcher. The row writes the server's ready
        // file itself after the signal: the server became ready during the stop.
        writeGateGenerator();
        installTsx(tsx);
        write('package.json', JSON.stringify({ name: 'codegen-loader-fixture', private: true, dependencies: { next: '15.0.0' }, scripts: { 'spfn:next': 'node next-stand-in.mjs' } }));
        write('next-stand-in.mjs', 'import { writeFileSync } from \'node:fs\';\n'
            + 'writeFileSync(\'next-started\', \'\');\nsetInterval(() => undefined, 1000);\n');

        const dev = startDev(tsx, await freePort());

        try
        {
            await dev.until(() => existsSync(join(appDir, 'entered')));

            expect(dev.output(), 'the server became ready before the signal').not.toContain('Server ready on port');

            dev.signal('SIGTERM');
            await dev.until(() => dev.output().includes('Codegen watcher stopping once the running generation or codegen config load finishes'));
            write('.spfn/server-ready', '1');
            await dev.until(() => dev.output().includes('Next.js not started') || existsSync(join(appDir, 'next-started')));
            write('open', '');

            expect(await dev.exited, dev.output()).toBe(0);
            expect({ left: await groupLeft(dev.pid), nextStarted: existsSync(join(appDir, 'next-started')) }, dev.output())
                .toEqual({ left: false, nextStarted: false });
        }
        finally
        {
            await dev.kill();
        }
    }, 60_000);

    it('R33 the watcher entry, given a .spfnrc.ts that fails to load, stays up saying regeneration is paused, and loads the fix', async () =>
    {
        const good = readFileSync(join(appDir, '.spfnrc.ts'), 'utf8');

        write('.spfnrc.ts', 'export default __dirname;\n');
        write('.spfn/watcher.mjs', watcherEntrySource());

        const watcher = startWatcher(tsx);

        try
        {
            await watcher.until(() => watcher.output().includes('Regeneration is paused; save a fix to retry.'));
            expect(watcher.output()).toContain('✗ Codegen config failed to load: Failed to load .spfnrc.ts');

            write('.spfnrc.ts', good);
            await watcher.until(() => routeMapPaths().includes('/probe/one'));
            expect(watcher.output()).toContain('Codegen config loads again: 2 generator(s); regenerating');
        }
        finally
        {
            await watcher.stop();
        }
    }, 60_000);

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

    it('R20 spfn codegen run exits non-zero naming the file and line of a .spfnrc.ts that fails to load', () =>
    {
        write('.spfnrc.ts', 'import { join } from \'node:path\';\n'
            + 'import { defineConfig } from \'@spfn/core/codegen\';\n'
            + '\n'
            + 'const routerPath = join(__dirname, \'src/server/router.ts\');\n'
            + 'export default defineConfig({ generators: [{ name: \'@spfn/core:route-map\', routerPath }] });\n');

        const { status, output } = codegenRun(tsx);

        expect(status, output).toBe(1);
        expect(output).toMatch(/Failed to load \.spfnrc\.ts \(at \.spfnrc\.ts:4:\d+\): __dirname is not defined in ES module scope/);
        expect(output).not.toContain('No generators configured');
    });

    it('R31 spfn codegen run exits non-zero naming a package generator that cannot be loaded, with the reason', () =>
    {
        const configWith = (name: string): string => 'import { defineConfig, defineGenerator } from \'@spfn/core/codegen\';\n\n'
            + `export default defineConfig({ generators: [defineGenerator({ name: '${name}', routerPath: './src/server/router.ts' })] });\n`;

        write('.spfnrc.ts', configWith('@spfn/core:route-mapp'));

        const misspelt = codegenRun(tsx);

        expect(misspelt.status, misspelt.output).toBe(1);
        expect(misspelt.output).toContain('Cannot load generator "@spfn/core:route-mapp"');
        expect(misspelt.output).not.toContain('No generators configured');

        write('node_modules/throwing-gen/package.json', JSON.stringify({ name: 'throwing-gen', type: 'module', exports: { './codegen': './codegen.js' } }));
        write('node_modules/throwing-gen/codegen.js', 'throw new Error(\'codegen module boom\');\n');
        write('.spfnrc.ts', configWith('throwing-gen:gen'));

        const throwing = codegenRun(tsx);

        expect(throwing.status, throwing.output).toBe(1);
        expect(throwing.output).toContain('Failed to load generator throwing-gen:gen from node_modules/throwing-gen/codegen.js: codegen module boom');
        expect(throwing.output).not.toContain('installed');
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

            expect(watcher.output()).not.toContain('Regeneration failed');

            // The edit is not counted against "Regenerated" lines: a deletion is two
            // changes, and the generation queued for the second loads whatever is on
            // disk when it runs, so the map can show a later edit before that edit's
            // own generation. What is checked is that the watcher is never told.
            const mentions = (): number => watcher.output().split('src/server/lib/segment.ts').length;
            const mentioned = mentions();

            write('src/server/lib/segment.ts', 'export const segment: string = \'three\';\n');

            // An import of a file that does not exist: the load fails; creating it regenerates.
            const failures = (): number => watcher.output().split('Regeneration failed').length;
            const failed = failures();

            write('src/server/routes/probe.ts', 'import { route } from \'@spfn/core/route\';\n'
                + 'import { later } from \'@/server/lib/later\';\n'
                + 'export const getProbe = route.get(`/probe/${later}`).handler(async () => ({}));\n');
            await watcher.until(() => failures() > failed);
            write('src/server/lib/later.ts', 'export const later: string = \'later\';\n');
            await watcher.until(() => routeMapPaths().includes('/probe/later'));
            // Written before probe.ts: reported, if at all, before this generation ran.
            expect(mentions()).toBe(mentioned);

            // The same, in a directory that does not exist yet.
            const failedAgain = failures();

            write('src/server/routes/probe.ts', 'import { route } from \'@spfn/core/route\';\n'
                + 'import { fresh } from \'@/server/fresh/value\';\n'
                + 'export const getProbe = route.get(`/probe/${fresh}`).handler(async () => ({}));\n');
            await watcher.until(() => failures() > failedAgain);
            write('src/server/fresh/value.ts', 'export const fresh: string = \'fresh\';\n');
            await watcher.until(() => routeMapPaths().includes('/probe/fresh'));
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

/**
 * A generator held until `open` exists in the app: it writes its process's pid
 * to `entered` when it starts, and `finished` when it returns.
 */
function writeGateGenerator(): void
{
    write('gate-generator.mjs', 'import { existsSync, writeFileSync } from \'node:fs\';\n'
        + 'import { join } from \'node:path\';\n'
        + 'export default function createGate()\n{\n'
        + '    return { name: \'gate\', watchPatterns: [\'src/gate/**/*.ts\'], async generate({ cwd })\n    {\n'
        + '        writeFileSync(join(cwd, \'entered\'), String(process.pid));\n'
        + '        while (!existsSync(join(cwd, \'open\'))) await new Promise(settle => setTimeout(settle, 20));\n'
        + '        writeFileSync(join(cwd, \'finished\'), \'\');\n'
        + '    } };\n}\n');
    write('.spfnrc.ts', 'import { defineConfig } from \'@spfn/core/codegen\';\n\n'
        + 'export default defineConfig({ generators: [{ path: \'./gate-generator.mjs\' }] });\n');
}

/**
 * `tsx` installed in the app, as `spfn dev` finds it: the watcher's tsx is
 * resolved from the app, and the server runs through `pnpm exec tsx`.
 */
function installTsx(tsx: Tsx): void
{
    const dir = dirname(dirname(tsx.cli));

    symlinkSync(dir, join(appDir, 'node_modules/tsx'), 'dir');
    mkdirSync(join(appDir, 'node_modules/.bin'), { recursive: true });
    symlinkSync(tsx.cli, join(appDir, 'node_modules/.bin/tsx'));
    write('pnpm-lock.yaml', '');
}

function freePort(): Promise<number>
{
    return new Promise((settle, fail) =>
    {
        const server = createServer().listen(0, '127.0.0.1', () =>
        {
            const { port } = server.address() as AddressInfo;

            server.close(() => settle(port));
        }).on('error', fail);
    });
}

/** SIGKILL every process left in the group `pid` leads, if any is. */
function killGroup(pid: number): void
{
    try
    {
        process.kill(-pid, 'SIGKILL');
    }
    catch
    {
        // ESRCH: the group is empty.
    }
}

/** Whether any process is still in the group `pid` leads 10 s on: the server, signalled and not waited for, may take a moment. */
async function groupLeft(pid: number): Promise<boolean>
{
    const deadline = Date.now() + 10_000;

    while (alive(-pid) && Date.now() < deadline)
    {
        await new Promise(settle => setTimeout(settle, 50));
    }

    return alive(-pid);
}

/** Whether a process with `pid` exists. */
function alive(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);

        return true;
    }
    catch
    {
        return false;
    }
}

/** A process the row started, in a process group of its own. */
interface Watcher
{
    pid: number;
    output: () => string;
    until: (condition: () => boolean) => Promise<void>;

    /** Whether it has not exited yet. */
    running: () => boolean;

    /**
     * Send `signal` to the tsx process alone, as `spfn dev` signals its watcher
     * child; tsx relays it. Not to the group: tsx relays a signal the child also
     * got unless the child reports it within 30 ms, so one signal can arrive twice.
     */
    signal: (signal: NodeJS.Signals) => void;

    /** The exit code, once the watcher has exited. */
    exited: Promise<number | null>;
    stop: () => Promise<void>;

    /** SIGKILL the process group, for a watcher a failed row may have left hung, and what it left behind. */
    kill: () => Promise<void>;
}

/** Every watcher started, killed after each row if still running: a timed-out row never reaches its `finally`. */
const watchers: Watcher[] = [];

/** The watcher, started as `spfn dev` starts it (tsx, the dev hook, `NODE_ENV=production`). */
function startWatcher(tsx: Tsx): Watcher
{
    const loader = pathToFileURL(devLoader);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };

    loader.searchParams.set('root', appDir);
    delete env.SPFN_APP_URL;
    delete env.NODE_OPTIONS;

    return track([tsx.cli, '--import', loader.href, join(appDir, '.spfn/watcher.mjs')], env);
}

/** `spfn dev` as the bin runs it under tsx, its server on `port`: the process a process manager signals. */
function startDev(tsx: Tsx, port: number): Watcher
{
    const env: NodeJS.ProcessEnv = { ...process.env, SPFN_PORT: String(port) };

    delete env.SPFN_APP_URL;
    delete env.SPFN_CODEGEN_PROCESS;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.NODE_ENV;
    delete env.DATABASE_URL;

    return track(['--import', tsx.loader, bin, 'dev', '--no-agent-files'], env);
}

/** Run Node with `args` in the app, in a process group of its own, killed after the row if still running. */
function track(args: string[], env: NodeJS.ProcessEnv): Watcher
{
    const child = spawn(process.execPath, args, {
        cwd: appDir,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));

    const exited = new Promise<number | null>(settle => child.on('exit', code => settle(code)));
    const watcher: Watcher = {
        pid: child.pid!,
        output: () => plain(output),
        running: () => child.exitCode === null && child.signalCode === null,
        signal: signal => process.kill(child.pid!, signal),
        exited,
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
        kill: async () =>
        {
            killGroup(child.pid!);
            await exited;
        },
    };

    watchers.push(watcher);

    return watcher;
}
