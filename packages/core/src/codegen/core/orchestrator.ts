/**
 * Codegen Orchestrator
 *
 * Manages multiple code generators and coordinates their execution.
 *
 * Every run — `generateAll`, and each cycle in watch mode — is one generation
 * (`GeneratorOptions.generation`): the generators that read the router share
 * one load of it.
 *
 * Watch mode decides what to regenerate from what each generation read, not
 * from file events alone. Every load stamps the files it read (`./inputs`),
 * attributed to the generator that ran it. File events are hints: a change to
 * a file matching a generator's `watchPatterns` (chokidar, on the patterns'
 * base directories) or in a directory holding an input (`./input-watcher`)
 * marks paths dirty. One serialized loop then takes the whole dirty set and
 * runs, in one generation, every generator a dirty path matches or that read
 * one; then it watches the directories of the new inputs, and then compares
 * every input with its stamp. A stale input is dirty in its turn, and the loop
 * runs again. So a change that lands while a generation runs, or before a
 * watch for it exists, is found by that comparison rather than lost: an edit
 * to `src/server/lib/segment.ts`, imported through `@/` by a route, a file a
 * failed import was looked for at that appears, a file replaced inside the
 * generation that read it.
 *
 * All of this state is the orchestrator's own: two orchestrators in one
 * process share nothing.
 */

import { realpathSync } from 'fs';
import { join, relative, sep } from 'path';
import { watch as chokidarWatch } from 'chokidar';
import mm from 'micromatch';
import type { ChangedFile, Generator, GeneratorOptions, GeneratorTrigger } from './generator';
import { checkStamp, collectInputs, stampOf, type Inputs, type Stamp } from './inputs';
import { InputWatcher } from './input-watcher';
import { pinNodeEnv } from './node-env';
import { logger } from '@spfn/core/logger';
import { newGeneration } from '../loader/register';

const orchestratorLogger = logger.child('@spfn/core:orchestrator');

/**
 * Consecutive cycles started by the check alone — no file event — after which
 * the loop stops starting such cycles until the next event (`guard`).
 */
const CHECK_ONLY_CYCLES = 3;

export interface OrchestratorOptions
{
    /** List of generators to orchestrate */
    generators: Generator[];

    /** Project root directory */
    cwd?: string;

    /** Enable debug logging */
    debug?: boolean;

    /**
     * Rethrow a generator failure instead of only logging it
     *
     * Off by default, which keeps watch mode alive through a half-edited file.
     * A build turns it on: a generator that refuses — a broken contract, a
     * router that will not load — has to reach the exit code, or the refusal
     * scrolls past and the build ships anyway.
     */
    throwOnError?: boolean;
}

/**
 * A dirty path: how it changed, and what found it — a file event, or the check
 * after a generation (`check`), which the loop guard counts.
 */
interface Change extends Omit<ChangedFile, 'path'>
{
    foundBy: 'event' | 'check';
}

const EVENT_ICONS: Record<ChangedFile['event'], string> = { add: '+', change: '~', unlink: '-' };

export class CodegenOrchestrator
{
    private readonly generators: Generator[];
    private readonly cwd: string;
    private readonly debug: boolean;
    private readonly throwOnError: boolean;

    /** What each generator's latest run read, by path relative to the project root. */
    private readonly inputs = new Map<Generator, Inputs>();

    /** Paths changed since the generation that last read them, relative to the project root. */
    private dirty = new Map<string, Change>();

    /** A directory holding an input changed while the loop was idle: compare the inputs. */
    private checkRequested = false;

    /** Stale inputs the loop guard stopped regenerating for, with what they held then. */
    private readonly suppressed = new Map<string, Stamp>();
    private checkOnlyCycles = 0;

    private busy = false;
    private closed = false;
    private root = '';
    private loop?: Promise<void>;
    private wake?: () => void;
    private stopWaiting?: () => void;
    private idleWaiters: Array<() => void> = [];
    private watcher?: ReturnType<typeof chokidarWatch>;
    private inputWatcher?: InputWatcher;

    /**
     * Pins `NODE_ENV` to `production` (`pinNodeEnv`), for a caller that builds
     * its generators by hand rather than through `loadCodegenConfig`: every
     * generator of every run then sees the one value.
     */
    constructor(options: OrchestratorOptions)
    {
        pinNodeEnv();
        this.generators = options.generators;
        this.cwd = options.cwd ?? process.cwd();
        this.debug = options.debug ?? false;
        this.throwOnError = options.throwOnError ?? false;
    }

    /**
     * Stop watching: no new generation starts, and the promise resolves once
     * the one running, if any, has finished — every generator of it, so the
     * outputs of one cycle never disagree. `watch()` resolves with it.
     */
    async close(): Promise<void>
    {
        if (this.debug && !this.closed)
        {
            orchestratorLogger.info('Closing watcher');
        }

        this.closed = true;
        this.poke();
        this.stopWaiting?.();
        this.inputWatcher?.close();
        await this.watcher?.close();
        this.watcher = undefined;
        await this.loop;
        this.notifyIdle();
    }

    /**
     * Resolves once watch mode is idle: no generation running, no change
     * waiting for one, and no input directory change still settling. A file
     * event chokidar has not delivered yet (it waits for writes to settle) is
     * not known here. Resolves at once outside watch mode, and after `close()`.
     */
    settled(): Promise<void>
    {
        if (this.isIdle())
        {
            return Promise.resolve();
        }

        return new Promise(resolve => this.idleWaiters.push(resolve));
    }

    /**
     * Check if generator should run for given trigger
     */
    private shouldRun(generator: Generator, trigger: GeneratorTrigger): boolean
    {
        const runOn = generator.runOn ?? ['watch', 'manual', 'build'];

        return runOn.includes(trigger);
    }

    /**
     * Run all generators once
     *
     * @param trigger - How the generators are being triggered
     */
    async generateAll(trigger: GeneratorTrigger = 'manual'): Promise<void>
    {
        const activeGenerators = this.generators.filter(g => this.shouldRun(g, trigger));

        if (activeGenerators.length === 0)
        {
            orchestratorLogger.info('No generators to run for this trigger', { trigger });

            return;
        }

        orchestratorLogger.info(`Running ${activeGenerators.length} generator(s)`, {
            generators: activeGenerators.map(g => g.name).join(', '),
            trigger,
        });

        this.logSkipped(trigger);

        const generation = newGeneration();

        for (const generator of activeGenerators)
        {
            const startTime = Date.now();
            const failure = await this.run(generator, { cwd: this.cwd, debug: this.debug, generation, trigger: { type: trigger } });

            if (failure !== undefined && this.throwOnError)
            {
                throw failure;
            }

            if (failure === undefined)
            {
                orchestratorLogger.info(`[${generator.name}] ✓ Generated successfully (${Date.now() - startTime}ms)`);
            }
        }
    }

    private logSkipped(trigger: GeneratorTrigger): void
    {
        if (!this.debug)
        {
            return;
        }

        this.generators
            .filter(generator => !this.shouldRun(generator, trigger))
            .forEach(generator => orchestratorLogger.info(`[${generator.name}] Skipped (runOn: ${generator.runOn?.join(', ') ?? 'default'})`));
    }

    /**
     * Run one generator with an inputs collector open around it, and keep what
     * it read — whether it succeeded or not — as its inputs. Returns the error
     * it failed with, logged, or undefined.
     */
    private async run(generator: Generator, options: GeneratorOptions): Promise<Error | undefined>
    {
        const { inputs, failure } = await collectInputs(async () => generator.generate(options));
        const root = this.root || realpathSync(this.cwd);

        this.inputs.set(generator, new Map([...inputs].map(([file, stamp]) => [relative(root, file), stamp])));

        if (failure === undefined)
        {
            return undefined;
        }

        const error = failure.error instanceof Error ? failure.error : new Error(String(failure.error));
        const verb = options.trigger?.changedFiles === undefined ? 'Generation' : 'Regeneration';

        orchestratorLogger.error(`[${generator.name}] ✗ ${verb} failed`, error);

        return error;
    }

    /**
     * Start watch mode: once chokidar has scanned the patterns' directories,
     * the initial generation, then the loop. Resolves when `close()` is called.
     */
    async watch(): Promise<void>
    {
        const patterns = this.generators.flatMap(g => g.watchPatterns);

        if (patterns.length === 0)
        {
            await this.generateAll('watch');
            orchestratorLogger.warn('No watch patterns defined, exiting watch mode');

            return;
        }

        this.busy = true;
        this.root = realpathSync(this.cwd);
        this.loop = this.watchLoop(patterns);

        return this.loop;
    }

    private async watchLoop(patterns: string[]): Promise<void>
    {
        const watchDirs = this.watchDirectories(patterns);

        await this.startWatching(watchDirs);

        if (!this.closed)
        {
            await this.generateAll('watch');
        }

        if (!this.closed)
        {
            this.armAndCheck('check');
            this.logWatching(watchDirs, patterns);
        }

        while (await this.nextWork())
        {
            await this.cycle();
        }
    }

    /** One directory per pattern, its part before `**`: "src/**\/*.ts" → "src". */
    private watchDirectories(patterns: string[]): string[]
    {
        return [...new Set(patterns.map(pattern => join(this.cwd, pattern.split('**')[0].replace(/\/$/, '') || '.')))];
    }

    /** chokidar on the patterns' directories, and the input watcher; resolves on chokidar's `ready`, or on `close()`. */
    private startWatching(watchDirs: string[]): Promise<void>
    {
        this.inputWatcher = new InputWatcher(this.root, () => this.requestCheck());
        this.watcher = chokidarWatch(watchDirs, {
            // Ignore dotfiles by path segments relative to cwd — matching the absolute
            // path would ignore everything when the checkout itself lives under a dot
            // directory (e.g. .claude/worktrees/<name>), leaving zero watched files
            ignored: (watchedPath: string) => relative(this.cwd, watchedPath)
                .split(sep)
                .some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..'),
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 100,
                pollInterval: 50,
            },
        });

        this.watcher
            .on('add', path => this.changed(path, 'add'))
            .on('change', path => this.changed(path, 'change'))
            .on('unlink', path => this.changed(path, 'unlink'));

        // The initial generation starts after chokidar's first scan: it reports no
        // change to a file it has not scanned (`ignoreInitial`), so an edit made
        // before `ready` is one the initial generation reads instead.
        return new Promise(resolve =>
        {
            this.watcher!.on('ready', () => resolve());
            this.stopWaiting = resolve;
        });
    }

    /** A file event from chokidar: the path is dirty. */
    private changed(absolutePath: string, event: ChangedFile['event']): void
    {
        if (this.closed)
        {
            return;
        }

        const path = relative(this.cwd, absolutePath);

        if (this.busy && this.debug)
        {
            orchestratorLogger.info(`Queued ${EVENT_ICONS[event]} ${path}`);
        }

        this.dirty.set(path, { event, foundBy: 'event' });
        this.suppressed.clear();
        this.poke();
    }

    /**
     * A directory holding an input changed. While the loop is busy nothing is
     * needed: every cycle ends with the check, which compares every input. Idle,
     * the loop is woken to check.
     */
    private requestCheck(): void
    {
        if (this.closed || this.busy)
        {
            return;
        }

        this.checkRequested = true;
        this.poke();
    }

    /** Wake the loop if it is waiting; it is busy from here. */
    private poke(): void
    {
        const wake = this.wake;

        this.wake = undefined;

        if (wake !== undefined)
        {
            this.busy = true;
            wake();
        }
    }

    /** Wait until there is something to do; false once closed. */
    private async nextWork(): Promise<boolean>
    {
        if (!this.closed && this.dirty.size === 0 && !this.checkRequested)
        {
            this.busy = false;
            this.checkOnlyCycles = 0;
            this.notifyIdle();
            await new Promise<void>(resolve => (this.wake = resolve));
        }

        return !this.closed;
    }

    /** Take the whole dirty set into one generation, then arm and check; or only arm and check, when that was asked. */
    private async cycle(): Promise<void>
    {
        // A turn for I/O first: file events, and a signal's `close()`, are handled
        // between cycles even when a generation settles without waiting on any.
        await new Promise(resolve => setImmediate(resolve));

        if (this.dirty.size === 0)
        {
            this.armAndCheck('event');

            return;
        }

        const changes = this.dirty;

        this.dirty = new Map();
        await this.regenerate(changes);

        if (!this.closed)
        {
            this.armAndCheck('check');
        }
    }

    /** Run every generator a change matches or whose inputs hold a changed path, in one generation. */
    private async regenerate(changes: Map<string, Change>): Promise<void>
    {
        const checkOnly = [...changes.values()].every(change => change.foundBy === 'check');

        this.checkOnlyCycles = checkOnly ? this.checkOnlyCycles + 1 : 0;
        [...changes]
            .filter(([, change]) => change.foundBy === 'event')
            .forEach(([path, { event }]) => orchestratorLogger.info(`File ${EVENT_ICONS[event]} ${path}`));

        const runs = this.generators
            .filter(generator => this.shouldRun(generator, 'watch'))
            .map(generator => ({ generator, triggers: this.triggersOf(generator, changes) }))
            .filter(({ triggers }) => triggers.length > 0);

        if (runs.length === 0 && this.debug)
        {
            orchestratorLogger.info('No generators matched this file');
        }

        const generation = newGeneration();

        for (const { generator, triggers } of runs)
        {
            const startTime = Date.now();
            const trigger = { type: 'watch' as const, changedFiles: triggers, ...(triggers.length === 1 ? { changedFile: triggers[0] } : {}) };
            const failure = await this.run(generator, { cwd: this.cwd, debug: this.debug, generation, trigger });

            if (failure === undefined)
            {
                orchestratorLogger.info(`[${generator.name}] ✓ Regenerated (${Date.now() - startTime}ms)`);
            }
        }
    }

    /** The changes that trigger `generator`: a path its patterns match, or one its latest run read. */
    private triggersOf(generator: Generator, changes: Map<string, Change>): ChangedFile[]
    {
        const inputs = this.inputs.get(generator);

        return [...changes]
            .filter(([path]) => inputs?.has(path) || generator.watchPatterns.some(pattern => mm.isMatch(path, pattern)))
            .map(([path, { event }]) => ({ path, event }));
    }

    /**
     * Watch the directories of every input, then compare every input with its
     * stamp; a stale one is dirty. `foundBy` says what started the comparison:
     * the end of a generation (`check`), or a directory event (`event`).
     */
    private armAndCheck(foundBy: Change['foundBy']): void
    {
        this.checkRequested = false;

        // Arm before the check: this order is what makes the loop correct. A
        // change that lands before the check is found by it; one that lands
        // after the watch is armed is reported by the watch. Checked first and
        // armed after, a change between the two would be neither.
        this.inputWatcher?.sync([...this.inputPaths()].map(path => join(this.root, path)));

        const stale = this.staleInputs();

        if (foundBy === 'check' && stale.size > 0 && this.checkOnlyCycles >= CHECK_ONLY_CYCLES)
        {
            this.guard(stale);

            return;
        }

        stale.forEach((event, path) => this.markStale(path, event, foundBy));
    }

    private markStale(path: string, event: ChangedFile['event'], foundBy: Change['foundBy']): void
    {
        if (foundBy === 'check')
        {
            orchestratorLogger.info(`Changed during generation: ${EVENT_ICONS[event]} ${path}`);
        }

        if (!this.dirty.has(path))
        {
            this.dirty.set(path, { event, foundBy });
        }
    }

    private inputPaths(): Set<string>
    {
        return new Set([...this.inputs.values()].flatMap(inputs => [...inputs.keys()]));
    }

    /**
     * Every input that differs from its stamp, with how it changed. An input
     * the guard suppressed is left out while it still holds what it held then.
     */
    private staleInputs(): Map<string, ChangedFile['event']>
    {
        const stale = new Map<string, ChangedFile['event']>();

        for (const inputs of this.inputs.values())
        {
            for (const [path, stamp] of inputs)
            {
                const checked = checkStamp(join(this.root, path), stamp);

                if (!checked.fresh && !this.isSuppressed(path))
                {
                    stale.set(path, eventOf(stamp.exists, checked.exists));
                }
            }
        }

        return stale;
    }

    private isSuppressed(path: string): boolean
    {
        const held = this.suppressed.get(path);

        if (held === undefined)
        {
            return false;
        }

        if (checkStamp(join(this.root, path), held).fresh)
        {
            return true;
        }

        this.suppressed.delete(path);

        return false;
    }

    /**
     * The loop guard: inputs changed after each of the last cycles, which the
     * check alone started. A generator that writes a file it reads, differently
     * on every run, does that; nothing else keeps every generation stale. Say
     * which files and generators, and start no cycle for those files until a
     * file event, or until they change again.
     */
    private guard(stale: Map<string, ChangedFile['event']>): void
    {
        const named = [...stale.keys()].map(path => `${path} (read by ${this.readersOf(path).join(', ')})`);

        stale.forEach((_event, path) => this.suppressed.set(path, stampOf(join(this.root, path))));
        orchestratorLogger.warn(
            `Inputs changed during each of the last ${CHECK_ONLY_CYCLES} generations, with no file event between: `
            + `${named.join(', ')}. A generator may be writing a file it reads; not regenerating for them again until `
            + 'the next file change.',
        );
    }

    private readersOf(path: string): string[]
    {
        return this.generators.filter(generator => this.inputs.get(generator)?.has(path)).map(generator => generator.name);
    }

    private isIdle(): boolean
    {
        return this.closed || (!this.busy && !(this.inputWatcher?.pending ?? false));
    }

    private notifyIdle(): void
    {
        if (this.isIdle())
        {
            this.idleWaiters.splice(0).forEach(resolve => resolve());
        }
    }

    private logWatching(watchDirs: string[], patterns: string[]): void
    {
        orchestratorLogger.info('Watch mode started', {
            watching: watchDirs.length === 1 ? watchDirs[0] : `${watchDirs.length} directories`,
            generators: this.generators.filter(g => this.shouldRun(g, 'watch')).map(g => g.name).join(', '),
        });

        if (this.debug)
        {
            orchestratorLogger.info('Watch mode details', { patterns, watchDirs, cwd: this.cwd });
        }
    }
}

/** How a stale input changed: it appeared, it went, or its content did. */
function eventOf(existed: boolean, exists: boolean): ChangedFile['event']
{
    if (exists === existed)
    {
        return 'change';
    }

    return exists ? 'add' : 'unlink';
}
