/**
 * The watch loop — rows W1–W3, W5–W20 and G1 of the #353 design
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
 * | W3 | the initial generation held: a pattern file no load reads edited      | an initial generation before chokidar's `ready`      |
 * | W3b| the initial generation held: an input no pattern matches edited,      | no check after the initial generation's arm          |
 * |    | nothing else queued                                                   |                                                      |
 * | W5 | an input unlinked, recreated inside the unlink's own generation, then | bookkeeping saying "watched" while the watcher has   |
 * |    | edited again; its directory removed and recreated inside a generation,| dropped the file, or a directory watcher that went   |
 * |    | then the input edited again                                           | silent: every later edit lost                        |
 * | W6 | `close()` while a generation is held with a change queued             | a generation after `close()` resolved, or `close()`  |
 * |    |                                                                       | resolving with one still running                     |
 * | W7 | two apps in sequence in one process                                   | watch state shared through the process: the second   |
 * |    |                                                                       | app watching the first's files                       |
 * | W8 | a route saved between the environment probe's baseline load and   | a false "depends on the environment" failure on an   |
 * |    | its varied one; then saved and restored around the varied load    | ordinary save (CLI R2 flaking), or, after a restore, |
 * |    |                                                                   | that failure because the file reads as unchanged     |
 * | W9 | `generateAll()` called while a watch cycle is held                | two generations writing the outputs at once, or the  |
 * |    |                                                                   | call resolving before its own run has finished       |
 * | W10| a tsconfig `paths` entry edited to point at another directory     | a map built from a resolution that is no longer the  |
 * |    |                                                                   | one Node would make                                  |
 * | W11| a file created at an earlier `paths` target, then one beside a    | the same, for a resolution whose earlier candidates  |
 * |    | directory an import resolved to the index of                      | were not stamped absent                              |
 * | W12| `watch()` after `close()`                                         | a closed orchestrator opening watchers nothing       |
 * |    |                                                                   | closes                                               |
 * | W13| an input no pattern matches saved once during each of four          | a stop on consecutive check-found cycles: the last   |
 * |    | generations in a row                                              | save marked handled, the map one edit behind         |
 * | W14| a run reads broken content and fails; the file is saved fixed     | a re-run decided again from the file system: it finds|
 * |    | during it, and broken again as its outcome is held back           | the stamp fresh, and the failure is never shown      |
 * | W15| a generator writing a file it reads on every run, and throwing    | a failure held back on every run: a broken app shown |
 * |    |                                                                   | as quietly fine                                      |
 * | W16| `generateAll()` and `settled()` awaited inside a generator while  | a watcher frozen on its own generation, which        |
 * |    | watching; then an edit                                            | `close()` can never end                              |
 * | W17| `settled()` called from a timer a generator's first run scheduled,| a callback outliving its `generate()` taken for that |
 * |    | after that run and the generation have finished                   | call: `settled()`/`generateAll()` rejected forever   |
 * | W18| a failure held back from a torn run, then `close()` in the quiet  | the failure never shown: the re-run that was to      |
 * |    | period                                                            | report it never comes                                |
 * | W19| a failure held back from a torn run, then the loop ends by an     | the same, when the loop ends any way but `close()`:  |
 * |    | exception                                                         | the exception shown, the generator's failure lost    |
 * | W20| `generateAll('manual')` while watching tears the run of a         | a torn run of a generator watch mode does not run    |
 * |    | generator whose `runOn` excludes `'watch'`; then a file it read   | never re-run, or that generator's old inputs found   |
 * |    | and a pattern file are edited                                     | changed by every check: a loop that never idles      |
 * | G1 | a generator writing, on every run, a file it reads, differently     | a silent endless loop (no warning), the warning      |
 * |    |                                                                   | repeated, a stop coming back, or a `close()` that    |
 * |    |                                                                   | never ends it                                        |
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

/**
 * Called before and after each router load (`importProjectModule`) with how
 * many loads started before it: W8 rewrites a file between the environment
 * probe's loads.
 */
const loads = vi.hoisted(() => ({ count: 0, hook: undefined as ((count: number, when: 'before' | 'after') => void) | undefined }));

vi.mock('../loader/register', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../loader/register')>();
    const importProjectModule: typeof actual.importProjectModule = async (...args) =>
    {
        const count = loads.count;

        loads.hook?.(count, 'before');
        loads.count += 1;

        const load = await actual.importProjectModule(...args);

        loads.hook?.(count, 'after');

        return load;
    };

    return { ...actual, importProjectModule };
});

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
type Spy = { mock: { calls: unknown[][] }; mockImplementation(implementation: (message: unknown) => void): unknown };

let appDir: string;
const apps: string[] = [];
const orchestrators: CodegenOrchestrator[] = [];
let info: Spy;
let warn: Spy;
let error: Spy;

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
        running: 0,
        maxRunning: 0,
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
                state.running += 1;
                state.maxRunning = Math.max(state.maxRunning, state.running);
                state.triggers.push(options.trigger);
                entered();
                await wait;
                state.running -= 1;
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
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(async () =>
{
    await Promise.all(orchestrators.splice(0).map(orchestrator => orchestrator.close()));
    vi.restoreAllMocks();
    beforeWatch.clear();
    loads.hook = undefined;
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

    it('W3 a pattern file no load reads, edited during the initial generation, is regenerated', async () =>
    {
        // Without the initial generation starting after chokidar's `ready`, the edit
        // to `src/r/r.ts` lands before chokidar's scan and is never reported.
        const reads: string[] = [];
        const reader: Generator = {
            name: 'reader',
            watchPatterns: ['src/r/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                reads.push(readFileSync(join(options.cwd, 'src/r/r.ts'), 'utf-8'));
            },
        };
        const held = gate('gate', ['src/g/**/*.ts']);

        write('src/r/r.ts', 'r0');
        write('src/g/g.ts', 'g0');
        held.hold();

        const orchestrator = watching([reader, held.generator]);

        await held.entered;
        write('src/r/r.ts', 'r1');
        await until(() => logged(info, /^Queued ~ src\/r\/r\.ts$/));
        held.release();
        await orchestrator.settled();

        expect(reads).toEqual(['r0', 'r1']);
    });

    it('W3b an input outside every pattern, edited during the initial generation with nothing queued, is regenerated', async () =>
    {
        // Without the check after the initial generation's arm, nothing reports the
        // edit: no pattern matches `src/server/lib/seg.ts`, and its directory is
        // first watched after the write.
        const held = gate('gate', ['src/g/**/*.ts']);

        write('src/server/lib/seg.ts', 'export const seg: string = \'one\';\n');
        writeProbe('/probe/${seg}', 'import { seg } from \'../lib/seg\';\n');
        held.hold();

        const orchestrator = watching([routeMap(), held.generator]);

        await held.entered;
        write('src/server/lib/seg.ts', 'export const seg: string = \'two\';\n');
        held.release();
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/two']);
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
        const watcher = (orchestrator as unknown as { watcher: { close: () => Promise<void> } }).watcher;
        const closeWatcher = watcher.close.bind(watcher);

        // Released as close() closes chokidar, the last of its work before it
        // waits for the loop: a close() that does not wait resolves without it.
        watcher.close = async () =>
        {
            await closeWatcher();
            held.release();
        };
        await orchestrator.close();

        // The generation reported its end before close() resolved: a close() that
        // resolves on its own work alone does so within a few microtasks of the
        // release, before the loop gets there.
        expect(info.mock.calls.filter(([message]) => String(message).startsWith('[gate] ✓ Regenerated'))).toHaveLength(1);
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

    it('W8 a route rewritten between the environment probe\'s loads is regenerated, with no failure reported', async () =>
    {
        // The probe loads the router again with the key varied and compares the
        // maps. A save between the baseline load and the varied one makes them
        // differ, and that was reported as "depends on the environment" (CLI R2,
        // iteration 2): a failure from inputs that changed while it ran is not one.
        // The second half saves and restores the route around the varied load: the
        // file holds what the baseline read by the check, yet the maps compared
        // came from two contents.
        const probe = (path: string): void => writeProbe(path, 'const mode = process.env.SPFN_WATCH_LOOP_MODE;\nvoid mode;\n');

        probe('/probe/one');

        const orchestrator = watching([routeMap()]);

        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/one']);

        const first = loads.count;

        loads.hook = (count, when) => count === first + 1 && when === 'before' && probe('/probe/final');
        probe('/probe/two');
        await until(() => loads.count > first + 1);
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/final']);

        const second = loads.count;

        loads.hook = (count, when) => count === second + 1 && probe(when === 'before' ? '/probe/between' : '/probe/three');
        probe('/probe/three');
        await until(() => loads.count > second + 1);
        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/three']);
        expect(error.mock.calls.map(([message]) => String(message))).toEqual([]);
        expect(info.mock.calls.filter(([message]) => /^\[@spfn\/core:route-map\] Read files that changed while it ran/.test(String(message)))).toHaveLength(2);
    });

    it('W9 generateAll() while a watch cycle runs is a run of the loop: never concurrent with it, and awaited to its end', async () =>
    {
        // Without it, the manual run starts while the cycle is held, and the two
        // generations write the same outputs at once.
        const held = gate('gate', ['src/**/*.ts']);

        write('src/x.ts', 'x0');

        const orchestrator = watching([held.generator]);

        await orchestrator.settled();
        held.hold();
        write('src/x.ts', 'x1');
        await held.entered;

        let finishedAtResolve = -1;
        const manual = orchestrator.generateAll('manual').then(() => (finishedAtResolve = held.finished));

        await new Promise(resolve => setImmediate(resolve));
        held.release();
        await manual;

        expect(held.maxRunning).toBe(1);
        expect(held.triggers.map(trigger => trigger?.type)).toEqual(['watch', 'watch', 'manual']);
        expect(finishedAtResolve).toBe(3);
    });

    it('W10 a tsconfig "paths" entry pointed elsewhere regenerates with the new target', async () =>
    {
        // Without the tsconfig stamped, the alias keeps resolving where it did
        // when the watcher started, and the map describes a file Node no longer loads.
        const config = (target: string): void => write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@lib/*': [target] } } }));

        config('src/one/*');
        write('src/one/seg.ts', 'export const seg: string = \'one\';\n');
        write('src/two/seg.ts', 'export const seg: string = \'two\';\n');
        writeProbe('/probe/${seg}', 'import { seg } from \'@lib/seg\';\n');

        const orchestrator = watching([routeMap()]);

        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/one']);

        config('src/two/*');
        await until(() => mapPaths().includes('/probe/two'));
    });

    it('W11 a file created at a candidate tried before the one an import resolved to regenerates with it', async () =>
    {
        // Without the earlier candidates stamped absent, only a failed resolution's
        // are, and an import keeps the file it found first: an alias's later
        // target, a directory's index beside a new file of the same name.
        write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@lib/*': ['src/first/*', 'src/second/*'] } } }));
        write('src/second/seg.ts', 'export const seg: string = \'second\';\n');
        write('src/server/lib/name/index.ts', 'export const name: string = \'index\';\n');
        writeProbe('/probe/${seg}/${name}', 'import { seg } from \'@lib/seg\';\nimport { name } from \'../lib/name\';\n');

        const orchestrator = watching([routeMap()]);

        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/second/index']);

        write('src/first/seg.ts', 'export const seg: string = \'first\';\n');
        await until(() => mapPaths().includes('/probe/first/index'));

        write('src/server/lib/name.ts', 'export const name: string = \'file\';\n');
        await until(() => mapPaths().includes('/probe/first/file'));
    });

    it('W12 watch() after close() rejects, and opens no watcher', async () =>
    {
        // Without it, the closed orchestrator starts chokidar and the input watcher
        // again, and nothing will close them: the process never exits.
        write('src/x.ts', 'x0');

        const orchestrator = new CodegenOrchestrator({ generators: [gate('gate', ['src/**/*.ts']).generator], cwd: appDir });

        await orchestrator.close();

        await expect(orchestrator.watch()).rejects.toThrow('This CodegenOrchestrator was closed: an orchestrator is single-use');
        expect((orchestrator as unknown as { watcher?: unknown }).watcher).toBeUndefined();
        expect(inputChangePending(orchestrator)).toBe(false);
        expect((orchestrator as unknown as { inputWatcher?: unknown }).inputWatcher).toBeUndefined();
    });

    it('W13 an input saved during each of four generations in a row is regenerated to its last content', async () =>
    {
        // seg.ts matches no pattern: each save lands inside a generation and is
        // found only by the check after it, four cycles in a row. A stop keyed on
        // that count marks the last save handled, though no generation read it.
        writeProbe('/probe/${seg}', 'import { seg } from \'../lib/seg\';\n');
        write('src/server/lib/seg.ts', 'export const seg: string = \'v0\';\n');

        const user = gate('route-map, held', ['src/server/routes/**/*.ts'], routeMap());
        const orchestrator = watching([user.generator]);

        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/v0']);

        write('src/server/lib/seg.ts', 'export const seg: string = \'v1\';\n');

        for (const version of [2, 3, 4, 5])
        {
            user.hold();
            await user.entered;
            write('src/server/lib/seg.ts', `export const seg: string = 'v${version}';\n`);
            user.release();
        }

        await orchestrator.settled();

        expect(mapPaths()).toEqual(['/probe/v5']);
    });

    it('W14 a failure held back because a save tore its run is reported when the file is restored before the re-run', async () =>
    {
        // The run reads the broken file and fails; the fixed save lands while it
        // runs, so its failure is held back. The broken content is restored as
        // that is logged, inside the quiet period: a re-run decided by a later
        // check finds the stamp fresh, runs nothing, and settles with the
        // failure for what is on disk never shown.
        const failures: unknown[] = [];
        let duringRun: (() => void) | undefined;
        const failing: Generator = {
            name: 'failing',
            watchPatterns: ['src/self/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                const load = await importProjectModule(join(options.cwd, 'src/seg.ts'), options.cwd, newGeneration());

                reportInputs(load.inputs);
                duringRun?.();

                if (!load.ok)
                {
                    failures.push(load.error);
                    throw load.error;
                }
            },
        };
        const broken = 'export const seg: string = ;\n';

        write('src/self/index.ts', 'export {};\n');
        write('src/seg.ts', 'export const seg: string = \'v0\';\n');

        const orchestrator = watching([failing]);

        await orchestrator.settled();
        duringRun = () =>
        {
            duringRun = undefined;
            write('src/seg.ts', 'export const seg: string = \'fixed\';\n');
        };
        info.mockImplementation((message: unknown) =>
        {
            if (/^\[failing\] Read files that changed while it ran/.test(String(message)))
            {
                write('src/seg.ts', broken);
            }
        });
        write('src/seg.ts', broken);
        await until(() => logged(info, /^\[failing\] Read files that changed while it ran/));
        await orchestrator.settled();

        expect(error.mock.calls.map(([message]) => String(message))).toEqual(['[failing] ✗ Regeneration failed']);
        expect(failures).toHaveLength(2);
        expect(error.mock.calls[0][1]).toBe(failures[1]);
    });

    it('W15 a generator that rewrites a file it reads and throws on every run has its error reported', async () =>
    {
        // Every run of it is torn by its own write. Held back every time, its
        // failure would never be shown: only the warning about repeated changes.
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
                await new Promise(resolve => setImmediate(resolve));
                throw new Error('the generator failed');
            },
        };

        write('src/self/index.ts', 'export {};\n');
        write('src/counter.ts', 'export const runs = 0;\n');

        const orchestrator = watching([selfWriter]);

        await until(() => error.mock.calls.length > 0);
        await orchestrator.close();

        expect(runs).toBeGreaterThanOrEqual(2);
        expect(error.mock.calls[0].map(String)).toEqual([
            '[self-writer] ✗ Generation failed (its inputs changed while it ran; running it again once they settle)',
            'Error: the generator failed',
        ]);
    });

    it('W16 generateAll() and settled() awaited inside a generator while watching reject, and the loop runs on', async () =>
    {
        // Without it, each waits for the generation that is waiting for it: the
        // loop never runs again, and close() never resolves.
        let orchestrator!: CodegenOrchestrator;
        const reads: string[] = [];
        const outcomes: string[] = [];
        const reentrant: Generator = {
            name: 'reentrant',
            watchPatterns: ['src/n/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                reads.push(readFileSync(join(options.cwd, 'src/n/a.ts'), 'utf-8'));

                if (reads.at(-1) !== 'a1')
                {
                    return;
                }

                for (const call of [() => orchestrator.generateAll('manual'), () => orchestrator.settled()])
                {
                    outcomes.push(await call().then(() => 'resolved', (failure: Error) => failure.message));
                }
            },
        };

        write('src/n/a.ts', 'a0');
        orchestrator = watching([reentrant]);
        await orchestrator.settled();
        write('src/n/a.ts', 'a1');
        await until(() => outcomes.length === 2);
        write('src/n/a.ts', 'a2');
        await until(() => reads.includes('a2'));
        await orchestrator.close();

        expect(outcomes).toEqual([
            expect.stringMatching(/^generateAll\('manual'\) was called while the calling generator's own generate\(\), run by this CodegenOrchestrator's watch loop, was still running: awaited there it can never finish/),
            expect.stringMatching(/^settled\(\) was called while the calling generator's own generate\(\)/),
        ]);
    });

    it('W17 settled() from a callback a finished generate() left behind resolves', async () =>
    {
        // The callback descends from the generator's call, which has returned:
        // it waits for the loop as any caller does, and is not refused.
        let orchestrator!: CodegenOrchestrator;
        let resolveDelayed!: (value: string) => void;
        const delayed = new Promise<string>(resolve => (resolveDelayed = resolve));
        let scheduled = false;
        const generator: Generator = {
            name: 'delayed-caller',
            watchPatterns: ['src/n/**/*.ts'],
            async generate(): Promise<void>
            {
                if (scheduled)
                {
                    return;
                }

                scheduled = true;
                setTimeout(() =>
                {
                    orchestrator.settled().then(
                        () => resolveDelayed('resolved'),
                        (failure: Error) => resolveDelayed(failure.message),
                    );
                }, 50);
            },
        };

        write('src/n/a.ts', 'a0');
        orchestrator = watching([generator]);
        await orchestrator.settled();

        expect(await delayed).toBe('resolved');
    });

    it('W18 a failure held back from a torn run is reported when close() comes before its re-run', async () =>
    {
        // close() is called as the failure is held back: a re-run started before
        // it (chokidar's event for the same save, arriving late) would report
        // the failure itself, and the row would not reach the close path.
        let closing: Promise<void> | undefined;
        let fail = false;
        let tear = false;
        const generator: Generator = {
            name: 'failing',
            watchPatterns: ['src/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                const load = await importProjectModule(join(options.cwd, 'src/a.ts'), options.cwd, newGeneration());

                reportInputs(load.inputs);

                if (tear)
                {
                    tear = false;
                    write('src/a.ts', 'export const a = 2;\n');
                }

                if (fail)
                {
                    throw new Error('broken');
                }
            },
        };

        write('src/a.ts', 'export const a = 0;\n');

        const orchestrator = watching([generator]);

        await orchestrator.settled();
        info.mockImplementation((message: unknown) =>
        {
            if (/^\[failing\] Read files that changed/.test(String(message)))
            {
                closing ??= orchestrator.close();
            }
        });
        fail = true;
        tear = true;
        write('src/a.ts', 'export const a = 1;\n');
        await until(() => closing !== undefined);
        await closing;

        expect(error.mock.calls.map(call => call.map(String))).toEqual([[
            '[failing] ✗ Regeneration failed (its inputs changed while it ran; no further run follows: the watch loop is ending)',
            'Error: broken',
        ]]);
    });

    it('W19 a failure held back from a torn run is reported when the loop ends by an exception, which still rejects watch()', async () =>
    {
        let fail = false;
        let tear = false;
        const generator: Generator = {
            name: 'failing',
            watchPatterns: ['src/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                const load = await importProjectModule(join(options.cwd, 'src/a.ts'), options.cwd, newGeneration());

                reportInputs(load.inputs);

                if (tear)
                {
                    tear = false;
                    write('src/a.ts', 'export const a = 2;\n');
                }

                if (fail)
                {
                    throw new Error('broken');
                }
            },
        };

        write('src/a.ts', 'export const a = 0;\n');

        const orchestrator = new CodegenOrchestrator({ generators: [generator], cwd: appDir, debug: true });
        const loop = orchestrator as unknown as { nextWork: () => Promise<boolean> };

        orchestrators.push(orchestrator);

        const watched = orchestrator.watch().then(() => undefined, (reason: unknown) => reason);

        await orchestrator.settled();
        info.mockImplementation((message: unknown) =>
        {
            if (/^\[failing\] Read files that changed/.test(String(message)))
            {
                vi.spyOn(loop, 'nextWork').mockRejectedValueOnce(new Error('loop failed'));
            }
        });
        fail = true;
        tear = true;
        write('src/a.ts', 'export const a = 1;\n');

        expect(String(await watched)).toBe('Error: loop failed');
        await orchestrator.close();
        expect(error.mock.calls.map(call => call.map(String))).toEqual([[
            '[failing] ✗ Regeneration failed (its inputs changed while it ran; no further run follows: the watch loop is ending)',
            'Error: broken',
        ]]);
    });

    it('W20 a torn run of a generator whose runOn excludes watch, started by generateAll(), is run again; its inputs then go unwatched', async () =>
    {
        // Watch mode never runs it on its own: only the mark its torn run left
        // brings it into the next generation. After that, no run stamps its
        // inputs again, so an edit to one must not leave them compared.
        let runs = 0;
        const manualOnly: Generator = {
            name: 'manual-only',
            watchPatterns: [],
            runOn: ['manual'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                const load = await importProjectModule(join(options.cwd, 'src/a.ts'), options.cwd, newGeneration());

                runs += 1;
                reportInputs(load.inputs);

                if (runs === 1)
                {
                    write('src/a.ts', 'export const a = 1;\n');
                }

                throw new Error('broken');
            },
        };
        const anchor: Generator = {
            name: 'anchor',
            watchPatterns: ['src/anchor/**/*.ts'],
            async generate(): Promise<void>
            {
                // Its pattern starts a cycle, and so a check.
            },
        };

        write('src/anchor/index.ts', 'export {};\n');
        write('src/a.ts', 'export const a = 0;\n');

        const orchestrator = watching([anchor, manualOnly]);

        await orchestrator.settled();
        await orchestrator.generateAll('manual');
        await until(() => runs === 2);
        await orchestrator.settled();

        expect(error.mock.calls.map(call => call.map(String))).toEqual([['[manual-only] ✗ Generation failed', 'Error: broken']]);

        write('src/a.ts', 'export const a = 2;\n');
        write('src/anchor/index.ts', 'export const anchor = 1;\n');
        await until(() => logged(info, /^\[anchor\] ✓ Regenerated/));

        const idle = await Promise.race([orchestrator.settled().then(() => true), new Promise(settle => setTimeout(() => settle(false), 5_000))]);

        expect({ idle, runs }).toEqual({ idle: true, runs: 2 });
    });

    it('G1 a generator that rewrites a file it reads on every run: one warning, and it regenerates on until close()', async () =>
    {
        // Each check after its run finds the file it just wrote: the loop runs it
        // again once the change has settled (the input watcher's 150 ms), for as
        // long as it watches, and says so once.
        let runs = 0;
        const starts: number[] = [];
        const ends: number[] = [];
        const selfWriter: Generator = {
            name: 'self-writer',
            watchPatterns: ['src/self/**/*.ts'],
            async generate(options: GeneratorOptions): Promise<void>
            {
                starts.push(Date.now());

                const load = await importProjectModule(join(options.cwd, 'src/counter.ts'), options.cwd, newGeneration());

                runs += 1;
                reportInputs(load.inputs);
                write('src/counter.ts', `export const runs = ${runs};\n`);

                // A macrotask, as a real generator's I/O is: a loop that regenerates
                // with no quiet period then still lets the row's timers fire, and
                // fails the row instead of starving the worker.
                await new Promise(resolve => setImmediate(resolve));
                ends.push(Date.now());
            },
        };

        write('src/self/index.ts', 'export {};\n');
        write('src/counter.ts', 'export const runs = 0;\n');

        const orchestrator = watching([selfWriter]);

        await until(() => logged(warn, /src\/counter\.ts \(read by self-writer\)/));

        const atWarning = runs;

        await until(() => runs >= atWarning + 3);
        await orchestrator.close();

        expect(atWarning).toBe(4);
        expect(ends.slice(0, -1).map((end, run) => starts[run + 1] - end).filter(quiet => quiet < 140)).toEqual([]);
        expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
            'Inputs changed during each of the last 3 generations: src/counter.ts (read by self-writer). Either a '
            + 'generator writes a file it reads, differently on every run, or files are being saved during every '
            + 'generation; regenerating again each time the changes settle.',
        ]);
    });
});
