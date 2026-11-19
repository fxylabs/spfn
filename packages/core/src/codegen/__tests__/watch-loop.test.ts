/**
 * The watch loop — rows W1–W3, W5–W7 and the loop guard of the #353 design
 *
 * Each row runs an orchestrator in watch mode, in this process, on an app in a
 * temporary directory with `@spfn/core` linked into its `node_modules`.
 * Generations are held open by a gate generator (`gate`), so a row changes
 * files at a known point inside one. Each asserts a positive outcome through
 * `settled()` or `until`, whose deadline is only a failure bound; the one
 * absence (W6) is decided by `await close()`, never by a sleep. A row that
 * needs a chokidar event delivered before the gate opens waits for the debug
 * `Queued` line.
 *
 * | #  | sequence                                                              | what goes unnoticed without it                       |
 * |----|-----------------------------------------------------------------------|------------------------------------------------------|
 * | W1 | while a generation is held: a missing import is created and a file    | the window between a load's read and the watch: no   |
 * |    | the load newly reached is edited; then a file written while its       | check after the generation, or the check done before |
 * |    | directory is first armed (the `fs.watch` seam)                        | arming the watches                                   |
 * | W2 | while a generation is held: an unmatched file, a B file and an A file | the queue reduced to its first path                  |
 * |    | are queued                                                            |                                                      |
 * | W3 | the initial generation held: a pattern file no load reads edited, the | an initial generation before chokidar's `ready`, or  |
 * |    | import the initial load failed on created                             | no check after the first arm                         |
 * | W5 | an input unlinked, recreated inside the unlink's own generation, then | bookkeeping saying "watched" while the watcher has   |
 * |    | edited again; its directory removed and recreated inside a generation,| dropped the file, or a directory watcher that went   |
 * |    | then the input edited again                                           | silent: every later edit lost                        |
 * | W6 | `close()` while a generation is held with a change queued             | a generation after `close()` resolved, or `close()`  |
 * |    |                                                                       | resolving with one still running                     |
 * | W7 | two apps in sequence in one process                                   | watch state shared through the process: the second   |
 * |    |                                                                       | app watching the first's files                       |
 * | G1 | a generator writing, on every run, a file it reads                    | the loop guard: such a generator regenerating        |
 * |    |                                                                       | forever                                              |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@spfn/core/logger';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, type FSWatcher } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createRouteMapGenerator } from '../generators/route-map';
import { CodegenOrchestrator } from '../core/orchestrator';
import type { Generator, GeneratorOptions } from '../core/generator';
import { reportInputs } from '../core/inputs';
import { importProjectModule, newGeneration } from '../loader/register';

const CORE_PACKAGE = resolve(__dirname, '../../..');
const OUTPUT_PATH = 'src/generated/route-map.ts';

/**
 * Called before `fs.watch` watches a path, once: W1 writes a file at the moment
 * the loop arms the watch on its directory.
 */
const beforeWatch = vi.hoisted(() => new Map<string, () => void>());

/** Every path `fs.watch` was asked to watch (W7). */
const watchedPaths = vi.hoisted(() => [] as string[]);

vi.mock('fs', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('fs')>();
    const watch = (path: string, ...rest: unknown[]): FSWatcher =>
    {
        const before = beforeWatch.get(path);

        beforeWatch.delete(path);
        before?.();
        watchedPaths.push(path);

        return (actual.watch as (...args: unknown[]) => FSWatcher)(path, ...rest);
    };

    return { ...actual, watch };
});

/** A spy on a `Logger.prototype` method: its calls' first argument is the message. */
type Spy = { mock: { calls: unknown[][] } };

let appDir: string;
const apps: string[] = [];
const orchestrators: CodegenOrchestrator[] = [];
let info: Spy;
let warn: Spy;

function write(path: string, content: string, root = appDir): void
{
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, 'utf-8');
}

function makeApp(): string
{
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'spfn-watch-loop-')));

    apps.push(root);
    write('package.json', JSON.stringify({ name: 'watch-loop-fixture', private: true }), root);
    mkdirSync(join(root, 'node_modules/@spfn'), { recursive: true });
    symlinkSync(CORE_PACKAGE, join(root, 'node_modules/@spfn/core'), 'dir');
    write('src/server/router.ts', 'import { defineRouter } from \'@spfn/core/route\';\n'
        + 'import { getProbe } from \'./routes/probe\';\n'
        + 'export const appRouter = defineRouter({ getProbe });\n', root);

    return root;
}

/** `src/server/routes/probe.ts` serving `path`, after `imports`. */
function writeProbe(path: string, imports = '', root = appDir): void
{
    write('src/server/routes/probe.ts', `import { route } from '@spfn/core/route';\n${imports}`
        + `export const getProbe = route.get(\`${path}\`).handler(async () => ({}));\n`, root);
}

function routeMap(): Generator
{
    return createRouteMapGenerator({ name: '@spfn/core:route-map', routerPath: './src/server/router.ts', outputPath: `./${OUTPUT_PATH}` });
}

function mapPaths(root = appDir): string[]
{
    const map = join(root, OUTPUT_PATH);

    return existsSync(map) ? [...readFileSync(map, 'utf-8').matchAll(/path: '([^']+)'/g)].map(match => match[1]) : [];
}

/**
 * A generator that, once held, does not return until released: the generation
 * it is part of stays open. With `inner`, it runs that generator first (a
 * failure of it is ignored) and so reads what it reads.
 */
function gate(name: string, watchPatterns: string[], inner?: Generator)
{
    let held: Promise<void> | undefined;
    let open = (): void => undefined;
    let entered = (): void => undefined;
    const state = {
        calls: 0,
        finished: 0,
        triggers: [] as GeneratorOptions['trigger'][],
        entered: Promise.resolve(),
        hold(): void
        {
            held = new Promise(resolve => (open = resolve));
            state.entered = new Promise(resolve => (entered = resolve));
        },
        release(): void
        {
            held = undefined;
            open();
        },
        generator: {
            name,
            watchPatterns,
            async generate(options: GeneratorOptions): Promise<void>
            {
                await inner?.generate(options).catch(() => undefined);

                const wait = held;

                state.calls += 1;
                state.triggers.push(options.trigger);
                entered();
                await wait;
                state.finished += 1;
            },
        } satisfies Generator,
    };

    return state;
}

function watching(generators: Generator[], root = appDir): CodegenOrchestrator
{
    const orchestrator = new CodegenOrchestrator({ generators, cwd: root, debug: true });

    orchestrators.push(orchestrator);
    void orchestrator.watch();

    return orchestrator;
}

/** Whether a directory event of an input is still settling (`InputWatcher.pending`). */
function inputChangePending(orchestrator: CodegenOrchestrator): boolean
{
    return (orchestrator as unknown as { inputWatcher?: { pending: boolean } }).inputWatcher?.pending ?? false;
}

function logged(spy: Spy, pattern: RegExp): boolean
{
    return spy.mock.calls.some(([message]) => pattern.test(String(message)));
}

async function until(condition: () => boolean): Promise<void>
{
    const deadline = Date.now() + 10_000;

    while (!condition())
    {
        if (Date.now() > deadline)
        {
            throw new Error('the watcher did not get there');
        }

        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

beforeEach(() =>
{
    appDir = makeApp();
    info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(async () =>
{
    await Promise.all(orchestrators.splice(0).map(orchestrator => orchestrator.close()));
    vi.restoreAllMocks();
    beforeWatch.clear();
    watchedPaths.length = 0;
    apps.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('codegen watch loop', () =>
{
    it('W1 a file created or newly reached during a generation, and one written as its directory is armed, are regenerated', async () =>
    {
        // Without the check after each generation, the files written while it was
        // held are never reported: the load's directory is watched only after it.
        // Without arming before the check, the file written as `extra/` is armed
        // falls between the two.
        const held = gate('gate', ['src/server/routes/**/*.ts']);

        writeProbe('/probe/plain');
        write('src/server/lib/seg.ts', 'import { later } from \'./later\';\nexport const seg: string = `one-${later}`;\n');
        write('src/server/extra/name.ts', 'export const name: string = \'first\';\n');

        const orchestrator = watching([routeMap(), held.generator]);

        await orchestrator.settled();
        held.hold();
        writeProbe('/probe/${seg}', 'import { seg } from \'../lib/seg\';\n');
        await held.entered;
        write('src/server/lib/seg.ts', 'import { later } from \'./later\';\nexport const seg: string = `two-${later}`;\n');
        write('src/server/lib/later.ts', 'export const later: string = \'later\';\n');
        held.release();
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/two-later']);

        // Held until the directory event of the probe edit has settled, inside the
        // generation: then nothing but the check after the arm can find the write.
        held.hold();
        beforeWatch.set(join(appDir, 'src/server/extra'), () => write('src/server/extra/name.ts', 'export const name: string = \'armed\';\n'));
        writeProbe('/probe/${name}', 'import { name } from \'../extra/name\';\n');
        await held.entered;
        await until(() => !inputChangePending(orchestrator));
        held.release();
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/armed']);
    });

    it('W2 every change queued during a generation is applied, across two generators', async () =>
    {
        // Without taking the whole dirty set, the first queued path decides the next
        // run: `notes.md` matches nothing, and A's and B's changes are lost.
        const reads: Record<string, string> = {};
        const read = (generator: string, path: string): Generator => ({
            name: generator,
            watchPatterns: [`${dirname(path)}/**/*.ts`],
            async generate(options: GeneratorOptions): Promise<void>
            {
                reads[generator] = readFileSync(join(options.cwd, path), 'utf-8');
            },
        });
        const held = gate('gate', ['src/g/**/*.ts']);

        write('src/g/g.ts', 'g0');
        write('src/a/a.ts', 'a0');
        write('src/b/b.ts', 'b0');

        const orchestrator = watching([held.generator, read('A', 'src/a/a.ts'), read('B', 'src/b/b.ts')]);

        await orchestrator.settled();
        held.hold();
        write('src/g/g.ts', 'g1');
        await held.entered;
        write('src/a/notes.md', 'notes');
        write('src/b/b.ts', 'b1');
        write('src/a/a.ts', 'a2');
        await until(() => ['+ src/a/notes.md', '~ src/b/b.ts', '~ src/a/a.ts'].every(line => logged(info, new RegExp(`^Queued ${line.replace(/[.+~]/g, '\\$&')}$`))));
        held.release();
        await orchestrator.settled();

        expect(reads).toEqual({ A: 'a2', B: 'b1' });
        expect(held.triggers.at(-1)?.changedFiles).toEqual([{ path: 'src/g/g.ts', event: 'change' }]);
        expect(logged(info, /^No generators matched this file$/)).toBe(false);
    });

    it('W3 edits made during the initial generation are regenerated', async () =>
    {
        // Without the initial generation starting after chokidar's `ready`, the edit
        // to `src/r/r.ts`, which no load reads, is never reported; without the check
        // after the first arm, neither is the creation of the import the initial
        // load failed on.
        const reads: string[] = [];
        const reader: Generator = {
            name: 'reader',
            watchPatterns: ['src/r/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                reads.push(readFileSync(join(options.cwd, 'src/r/r.ts'), 'utf-8'));
            },
        };
        const held = gate('gate', ['src/server/routes/**/*.ts']);

        write('src/r/r.ts', 'r0');
        writeProbe('/probe/${later}', 'import { later } from \'../lib/later\';\n');
        held.hold();

        const orchestrator = watching([routeMap(), reader, held.generator]);

        await held.entered;
        write('src/r/r.ts', 'r1');
        write('src/server/lib/later.ts', 'export const later: string = \'later\';\n');
        await until(() => logged(info, /^Queued ~ src\/r\/r\.ts$/));
        held.release();
        await orchestrator.settled();

        expect(reads).toEqual(['r0', 'r1']);
        expect(mapPaths()).toEqual(['/probe/later']);
    });

    it('W5 an input unlinked and recreated inside the unlink\'s generation is still watched: a later edit regenerates', async () =>
    {
        // Without it, the recreated file is in the bookkeeping while no watcher
        // reports it, and every later edit is lost until a restart.
        const map = routeMap();
        const held = gate('route-map, held', map.watchPatterns, map);

        writeProbe('/probe/${seg}', 'import { seg } from \'../lib/seg\';\n');
        write('src/server/lib/seg.ts', 'export const seg: string = \'one\';\n');

        const orchestrator = watching([held.generator]);

        await orchestrator.settled();
        held.hold();
        unlinkSync(join(appDir, 'src/server/lib/seg.ts'));
        await held.entered;
        write('src/server/lib/seg.ts', 'export const seg: string = \'two\';\n');
        held.release();
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/two']);

        write('src/server/lib/seg.ts', 'export const seg: string = \'three\';\n');
        await until(() => mapPaths().includes('/probe/three'));

        // The same for its directory: removed and created again inside a generation.
        held.hold();
        writeProbe('/probe/again/${seg}', 'import { seg } from \'../lib/seg\';\n');
        await held.entered;
        rmSync(join(appDir, 'src/server/lib'), { recursive: true });
        write('src/server/lib/seg.ts', 'export const seg: string = \'four\';\n');
        await until(() => inputChangePending(orchestrator));
        held.release();
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/again/four']);

        write('src/server/lib/seg.ts', 'export const seg: string = \'five\';\n');
        await until(() => mapPaths().includes('/probe/again/five'));
    });

    it('W6 close() while a generation is held with a change queued: it finishes that generation and starts none', async () =>
    {
        // Without it, the queued change runs the generator again after close(), or
        // close() resolves while the generation still runs.
        const held = gate('gate', ['src/**/*.ts']);

        write('src/x.ts', 'x0');

        const orchestrator = watching([held.generator]);

        await orchestrator.settled();
        held.hold();
        write('src/x.ts', 'x1');
        await held.entered;
        write('src/y.ts', 'y1');
        await until(() => logged(info, /^Queued \+ src\/y\.ts$/));

        const calls = held.calls;
        const closing = orchestrator.close();

        // Released once close() has done the rest of its work, so a close() that
        // does not wait for the generation resolves first.
        setTimeout(() => held.release(), 200);
        await closing;

        expect(held.finished).toBe(calls);
        expect(held.calls).toBe(calls);
    });

    it('W7 a second app in the same process watches none of the first app\'s files', async () =>
    {
        // Without it, what one orchestrator's loads read is watched by the next one
        // in the process: another app's files, and a router a config dropped.
        const first = appDir;

        writeProbe('/probe/${later}', 'import { later } from \'../lib/later\';\n', first);

        const firstOrchestrator = watching([routeMap()], first);

        await firstOrchestrator.settled();
        await firstOrchestrator.close();

        expect(watchedPaths).toContain(join(first, 'src/server'));

        watchedPaths.length = 0;

        const second = makeApp();

        writeProbe('/probe/${seg}', 'import { seg } from \'../lib/seg\';\n', second);
        write('src/server/lib/seg.ts', 'export const seg: string = \'second\';\n', second);

        const secondOrchestrator = watching([routeMap()], second);

        await secondOrchestrator.settled();

        expect(mapPaths(second)).toEqual(['/probe/second']);
        expect(watchedPaths).toContain(join(second, 'src/server/lib'));
        expect(watchedPaths.filter(path => path.startsWith(first))).toEqual([]);
    });

    it('G1 a generator that rewrites a file it reads on every run is stopped after three check-only cycles, with a warning', async () =>
    {
        // Without the guard, such a generator regenerates forever: every check
        // after its run finds the file it just wrote.
        let runs = 0;
        const selfWriter: Generator = {
            name: 'self-writer',
            watchPatterns: ['src/self/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                const load = await importProjectModule(join(options.cwd, 'src/counter.ts'), options.cwd, newGeneration());

                runs += 1;
                reportInputs(load.inputs);
                write('src/counter.ts', `export const runs = ${runs};\n`);
            },
        };

        write('src/self/index.ts', 'export {};\n');
        write('src/counter.ts', 'export const runs = 0;\n');

        const orchestrator = watching([selfWriter]);

        await until(() => logged(warn, /src\/counter\.ts \(read by self-writer\)/));
        await orchestrator.settled();

        expect(runs).toBe(4);
        expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
            'Inputs changed during each of the last 3 generations, with no file event between: src/counter.ts (read by '
            + 'self-writer). A generator may be writing a file it reads; not regenerating for them again until the next '
            + 'file change.',
        ]);
    });
});
