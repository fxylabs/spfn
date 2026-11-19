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
 * every input with its stamp. A stale input is a late file event: once writes
 * have settled (`SETTLE_MS`, the quiet period every input event waits), it is
 * dirty in its turn, and the loop runs again. So a change that lands while a
 * generation runs, or before a watch for it exists, is found by that comparison rather than lost: an edit
 * to `src/server/lib/segment.ts`, imported through `@/` by a route, a file a
 * failed import was looked for at that appears, a file replaced inside the
 * generation that read it. How each generator's run ended is logged only
 * after that comparison: a run whose inputs changed under it is run again
 * once they settle, and its outcome is held back at most once in a row
 * (`settleOutcome`).
 *
 * All of this state is the orchestrator's own: two orchestrators in one
 * process share nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'fs';
import { join, relative, sep } from 'path';
import { watch as chokidarWatch } from 'chokidar';
import mm from 'micromatch';
import type { ChangedFile, Generator, GeneratorOptions, GeneratorTrigger } from './generator';
import { checkStamp, collectInputs, type Inputs } from './inputs';
import { InputWatcher } from './input-watcher';
import { pinNodeEnv } from './node-env';
import { logger } from '@spfn/core/logger';
import { newGeneration } from '../loader/register';

const orchestratorLogger = logger.child('@spfn/core:orchestrator');

/**
 * Consecutive cycles started by the check after a generation alone — a change
 * no event reported to the idle loop — after which the loop warns once
 * (`warnCheckOnly`). It keeps regenerating.
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
     * scrolls past and the build ships anyway. Watch mode's own generations,
     * the initial one included, only log under it too. What rejects under it:
     * `generateAll()`, also one called while watching (its own promise), and
     * `watch()` when no generator has `watchPatterns`, which then runs one
     * `generateAll('watch')` instead of watching and rejects with that run's
     * first failure.
     */
    throwOnError?: boolean;
}

/**
 * A dirty path: how it changed, and what found it — a file event, or the check
 * after a generation (`check`), whose consecutive cycles are counted for one
 * warning.
 */
interface Change extends Omit<ChangedFile, 'path'>
{
    foundBy: 'event' | 'check';
}

/** A generator to run in a generation, and what it is told triggered it. */
interface Run
{
    generator: Generator;
    trigger: NonNullable<GeneratorOptions['trigger']>;
}

/** How a run ended: the error it failed with, if any, and how long it took. */
interface Outcome extends Run
{
    failure?: Error;
    ms: number;
}

/** A `generateAll()` call made while watching, waiting for the loop to run it. */
interface RunRequest
{
    trigger: GeneratorTrigger;
    resolve: () => void;
    reject: (error: unknown) => void;
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

    /**
     * The check after a generation found a stale input, and the input watcher
     * is waiting out its quiet period before the loop compares again: what that
     * comparison finds was found by the check, not by an event.
     */
    private lateCheck = false;

    /**
     * Generators whose latest run read a file the check after it found changed,
     * with the trigger that run had: each runs again once the change has
     * settled, whether or not a later check still finds a difference.
     */
    private readonly rerun = new Map<Generator, Run['trigger']>();

    /**
     * Generators whose latest run failed and whose failure was not reported,
     * with that run: the next failure is reported, and so is this one if the
     * loop stops first (`reportWithheld`).
     */
    private readonly withheld = new Map<Generator, Outcome>();

    /** Consecutive cycles the check alone started; the warning about them is given once until an event's cycle. */
    private checkOnlyCycles = 0;
    private warnedCheckOnly = false;

    private busy = false;
    private closed = false;
    private root = '';
    private loop?: Promise<void>;
    private wake?: () => void;
    private stopWaiting?: () => void;
    private idleWaiters: Array<() => void> = [];

    /** `generateAll()` calls made while watching, for the loop to run in turn. */
    private requests: RunRequest[] = [];
    private watcher?: ReturnType<typeof chokidarWatch>;
    private warnedUnwatchable = false;
    private inputWatcher?: InputWatcher;

    /**
     * The `generate()` call of a generator the watch loop runs, seen by what
     * that call starts — including a timer or promise that outlives it, so the
     * call says whether it is still running.
     */
    private readonly loopCall = new AsyncLocalStorage<{ running: boolean }>();

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
     * outputs of one cycle never disagree. `watch()` resolves with it. A
     * generation cannot be cancelled: one that never settles keeps this
     * pending, and only exiting the process stops it. A loop that ended by an
     * exception rejected `watch()` with it; `close()` still resolves. An
     * orchestrator is single-use: `watch()` after `close()` rejects.
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
        await this.loop?.catch(() => undefined);
        this.requests.splice(0).forEach(request => request.reject(new Error(
            `generateAll('${request.trigger}') was not run: the codegen watcher was closed before its turn`,
        )));
        this.notifyIdle();
    }

    /**
     * Resolves once watch mode is idle: no generation running, no change
     * waiting for one, and no input directory change still settling. A file
     * event chokidar has not delivered yet (it waits for writes to settle) is
     * not known here. Resolves at once outside watch mode, and after `close()`.
     * It may not be called while the calling generator's own `generate()`,
     * run by the watch loop, is still running: awaited there, it could never
     * resolve, so it rejects (`reentered`), awaited or not. A callback
     * scheduled to run after `generate()` returned waits as any caller does.
     */
    settled(): Promise<void>
    {
        if (this.loopCall.getStore()?.running)
        {
            return Promise.reject(this.reentered('settled()'));
        }

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
     * Run all generators once, in one generation
     *
     * While watching, the run is the loop's to make, so that two generations
     * never write outputs at once: it is queued, runs between two cycles, and
     * the promise settles when that run has finished — rejecting with its
     * failure under `throwOnError`, as outside watch mode. Its log lines follow
     * watch mode's (`watchGeneration`). Called once `close()` has been, it
     * waits for the loop's last generation and then runs as outside watch mode;
     * one still queued when `close()` is called is rejected. It may not be
     * called while the calling generator's own `generate()`, run by the watch
     * loop, is still running: awaited there, its run could never finish, so it
     * rejects (`reentered`), awaited or not. A callback scheduled to run after
     * `generate()` returned is queued as any call is.
     *
     * @param trigger - How the generators are being triggered
     */
    async generateAll(trigger: GeneratorTrigger = 'manual'): Promise<void>
    {
        if (this.loopCall.getStore()?.running)
        {
            throw this.reentered(`generateAll('${trigger}')`);
        }

        if (this.loop !== undefined && !this.closed)
        {
            return new Promise((resolve, reject) =>
            {
                this.requests.push({ trigger, resolve, reject });
                this.poke();
            });
        }

        await this.loop;

        const outcomes = await this.generate(this.startRuns(trigger), this.throwOnError);
        const failed = outcomes.find(outcome => outcome.failure !== undefined);

        outcomes.forEach(outcome => this.report(outcome));

        if (failed !== undefined && this.throwOnError)
        {
            throw failed.failure;
        }
    }

    /** The error for `call` made from inside a generation the watch loop runs. */
    private reentered(call: string): Error
    {
        return new Error(
            `${call} was called while the calling generator's own generate(), run by this CodegenOrchestrator's watch loop, `
            + 'was still running: awaited there it can never finish, since it waits for that generation. '
            + 'Call it after generate() has returned; the loop runs a generator again when a file it read changes.',
        );
    }

    /** A run of every generator `trigger` starts, logged; none, and said so, when it starts none. */
    private startRuns(trigger: GeneratorTrigger): Run[]
    {
        const active = this.generators.filter(g => this.shouldRun(g, trigger));

        if (active.length === 0)
        {
            orchestratorLogger.info('No generators to run for this trigger', { trigger });

            return [];
        }

        orchestratorLogger.info(`Running ${active.length} generator(s)`, {
            generators: active.map(g => g.name).join(', '),
            trigger,
        });
        this.logSkipped(trigger);

        return active.map(generator => ({ generator, trigger: { type: trigger } }));
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
     * Run each of `runs` in one generation, in order — up to the first failure
     * when `stopAtFailure` — and return how each ended, unreported. `inLoop`:
     * the watch loop runs them (`loopCall`).
     */
    private async generate(runs: Run[], stopAtFailure: boolean, inLoop = false): Promise<Outcome[]>
    {
        const generation = newGeneration();
        const outcomes: Outcome[] = [];

        for (const { generator, trigger } of runs)
        {
            const startTime = Date.now();
            const failure = await this.run(generator, { cwd: this.cwd, debug: this.debug, generation, trigger }, inLoop);

            outcomes.push({ generator, trigger, failure, ms: Date.now() - startTime });

            if (failure !== undefined && stopAtFailure)
            {
                break;
            }
        }

        return outcomes;
    }

    /**
     * Run one generator with an inputs collector open around it, and keep what
     * it read — whether it succeeded or not — as its inputs. Returns the error
     * it failed with, or undefined.
     */
    private async run(generator: Generator, options: GeneratorOptions, inLoop: boolean): Promise<Error | undefined>
    {
        const { inputs, failure } = await collectInputs(async () => (inLoop ? this.runInLoop(generator, options) : generator.generate(options)));
        const root = this.root || realpathSync(this.cwd);

        this.inputs.set(generator, new Map([...inputs].map(([file, stamp]) => [relative(root, file), stamp])));

        if (failure === undefined)
        {
            return undefined;
        }

        return failure.error instanceof Error ? failure.error : new Error(String(failure.error));
    }

    /** `generator.generate()` as the watch loop's call (`loopCall`): running until it settles. */
    private async runInLoop(generator: Generator, options: GeneratorOptions): Promise<void>
    {
        const call = { running: true };

        try
        {
            await this.loopCall.run(call, () => generator.generate(options));
        }
        finally
        {
            call.running = false;
        }
    }

    /**
     * Log how a run ended: `✓`, or `✗` with the error it failed with and
     * `note`, if any — why a torn run's failure is reported anyway.
     */
    private report({ generator, trigger, failure, ms }: Outcome, note = ''): void
    {
        const initial = trigger.changedFiles === undefined;

        if (failure !== undefined)
        {
            orchestratorLogger.error(`[${generator.name}] ✗ ${initial ? 'Generation' : 'Regeneration'} failed${note}`, failure);

            return;
        }

        orchestratorLogger.info(initial ? `[${generator.name}] ✓ Generated successfully (${ms}ms)` : `[${generator.name}] ✓ Regenerated (${ms}ms)`);
    }

    /**
     * A watch generation: run it, arm and check, and only then report how each
     * run ended (`settleOutcome`). After `close()` there is no check, and each
     * run is reported as it ended.
     */
    private async watchGeneration(runs: Run[]): Promise<Outcome[]>
    {
        const outcomes = await this.generate(runs, false, true);
        const stale = this.closed ? new Map<string, ChangedFile['event']>() : this.armAndCheck();

        outcomes.forEach(outcome => this.settleOutcome(outcome, [...stale.keys()].some(path => this.inputs.get(outcome.generator)?.has(path))));
        this.deferCheck(stale);

        return outcomes;
    }

    /**
     * Report how a watch run ended. A `torn` run read a file the check found
     * changed: it ran on inputs that changed under it, so its result says
     * nothing sure about the app as it is now (a save between two of the
     * environment probe's loads reads as "depends on the environment"). It is
     * marked to run again once the change has settled, whatever a later check
     * finds, and its outcome is held back for one line saying so — but a
     * failure is held back at most once in a row: a failure after a withheld
     * one is reported, torn or not. A transient failure from a save is
     * therefore never shown, and a real one is shown by the second run at the
     * latest, or as the watcher closes if it closes first (`reportWithheld`).
     */
    private settleOutcome(outcome: Outcome, torn: boolean): void
    {
        const { generator, failure } = outcome;
        const failedAfterWithheld = this.withheld.delete(generator) && failure !== undefined;

        this.markRerun(outcome, torn);

        if (!torn || failedAfterWithheld)
        {
            this.report(outcome, torn ? ' (its inputs changed while it ran; running it again once they settle)' : '');

            return;
        }

        if (failure !== undefined)
        {
            this.withheld.set(generator, outcome);
        }

        orchestratorLogger.info(`[${generator.name}] Read files that changed while it ran; running it again once they settle`);
    }

    /**
     * Mark a torn run to run again by name (`regenerate` takes it whatever its
     * `runOn`), else unmark it. A generator watch mode does not run (a
     * `generateAll()` while watching ran it) keeps its inputs only until then:
     * no later run would stamp them again, so every check after an edit to
     * one would find it changed, and the loop would cycle on it forever.
     */
    private markRerun({ generator, trigger }: Outcome, torn: boolean): void
    {
        if (torn)
        {
            this.rerun.set(generator, trigger);

            return;
        }

        this.rerun.delete(generator);

        if (!this.shouldRun(generator, 'watch'))
        {
            this.inputs.delete(generator);
        }
    }

    /**
     * The check after a generation found `stale`: a late file event. Like any
     * event on an input, it waits for writes to settle — the input watcher's
     * quiet period, restarted by every write meanwhile — and the loop then
     * compares again and regenerates for what it finds then, and every
     * generator marked to run again (`settleOutcome`). Without that wait
     * a file written all through a generation, by a user or by a generator,
     * would start the next one at once, every time.
     */
    private deferCheck(stale: Map<string, ChangedFile['event']>): void
    {
        if (stale.size === 0)
        {
            this.checkOnlyCycles = 0;

            return;
        }

        stale.forEach((event, path) => orchestratorLogger.info(`Changed during generation: ${EVENT_ICONS[event]} ${path}`));
        this.warnCheckOnly(stale);
        this.lateCheck = true;
        this.inputWatcher?.schedule();
    }

    /**
     * Start watch mode: once chokidar has scanned the patterns' directories,
     * the initial generation, then the loop. Resolves when `close()` is called.
     * Rejects when `close()` was called before: a closed orchestrator watches
     * nothing again.
     */
    async watch(): Promise<void>
    {
        if (this.closed)
        {
            throw new Error('This CodegenOrchestrator was closed: an orchestrator is single-use, so create a new one to watch again');
        }

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

    /**
     * The watch loop's lifecycle. A failure held back is reported once
     * however the loop ends: by `close()`, or by an exception, which still
     * rejects `watch()`.
     */
    private async watchLoop(patterns: string[]): Promise<void>
    {
        const watchDirs = this.watchDirectories(patterns);

        await this.startWatching(watchDirs);

        try
        {
            await this.runLoop(watchDirs, patterns);
        }
        finally
        {
            this.reportWithheld();
        }
    }

    /** The initial generation, then a cycle per piece of work until the loop is closed. */
    private async runLoop(watchDirs: string[], patterns: string[]): Promise<void>
    {
        if (!this.closed)
        {
            await this.watchGeneration(this.startRuns('watch'));
        }

        if (!this.closed)
        {
            this.logWatching(watchDirs, patterns);
        }

        while (await this.nextWork())
        {
            await this.cycle();
        }
    }

    /**
     * The loop ended: a failure still held back would otherwise never be
     * shown, since the re-run that was to report it does not come. A success
     * held back needs no line: its `Read files that changed` line said all
     * there is, and nothing went wrong.
     */
    private reportWithheld(): void
    {
        this.withheld.forEach(outcome => this.report(outcome, ' (its inputs changed while it ran; no further run follows: the watch loop is ending)'));
        this.withheld.clear();
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
            .on('unlink', path => this.changed(path, 'unlink'))
            .on('error', error => this.unwatchable(watchDirs, error));

        // The initial generation starts after chokidar's first scan: it reports no
        // change to a file it has not scanned (`ignoreInitial`), so an edit made
        // before `ready` is one the initial generation reads instead.
        return new Promise(resolve =>
        {
            this.watcher!.on('ready', () => resolve());
            this.stopWaiting = resolve;
        });
    }

    /**
     * chokidar reported an error (EACCES, ENOSPC at the inotify limit): say so
     * once, naming the pattern directories — never thrown into the loop. The
     * inputs' own directories are watched apart from it (`./input-watcher`).
     */
    private unwatchable(watchDirs: string[], error: unknown): void
    {
        if (this.warnedUnwatchable)
        {
            return;
        }

        const code = (error as NodeJS.ErrnoException | null)?.code ?? String(error);

        this.warnedUnwatchable = true;
        orchestratorLogger.warn(
            `Cannot watch ${watchDirs.map(dir => relative(this.cwd, dir) || '.').join(', ')} for the generators' watchPatterns `
            + `(${code}): a file created or changed there may not regenerate until spfn dev restarts.`,
        );
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

    /**
     * Wait until there is something to do; false once closed. A re-run is due
     * once no quiet period is pending: the input watcher's call at its end is
     * dropped while the loop is busy, so this is where a re-run marked then is
     * picked up.
     */
    private async nextWork(): Promise<boolean>
    {
        const rerunDue = this.rerun.size > 0 && !(this.inputWatcher?.pending ?? false);

        if (!this.closed && this.dirty.size === 0 && !this.checkRequested && this.requests.length === 0 && !rerunDue)
        {
            this.busy = false;
            this.notifyIdle();
            await new Promise<void>(resolve => (this.wake = resolve));
        }

        return !this.closed;
    }

    /**
     * Run the next `generateAll()` call made while watching; else, with nothing
     * dirty, arm and check first; then take the whole dirty set, and every
     * generator marked to run again, into one watch generation.
     */
    private async cycle(): Promise<void>
    {
        const request = this.closed ? undefined : this.requests.shift();

        if (request !== undefined)
        {
            await this.runRequested(request);

            return;
        }

        if (this.dirty.size === 0)
        {
            const foundBy = this.lateCheck ? 'check' : 'event';

            this.armAndCheck().forEach((event, path) => this.markDirty(path, event, foundBy));
        }

        if (this.dirty.size === 0 && this.rerun.size === 0)
        {
            return;
        }

        const changes = this.dirty;

        this.dirty = new Map();
        await this.regenerate(changes);
    }

    /** A `generateAll()` made while watching: its run, as a watch generation, settling its promise. */
    private async runRequested({ trigger, resolve, reject }: RunRequest): Promise<void>
    {
        const failed = (await this.watchGeneration(this.startRuns(trigger))).find(outcome => outcome.failure !== undefined);

        if (failed !== undefined && this.throwOnError)
        {
            reject(failed.failure);

            return;
        }

        resolve();
    }

    /**
     * Run, in one generation, every generator a change matches or whose inputs
     * hold a changed path, and every one marked to run again.
     */
    private async regenerate(changes: Map<string, Change>): Promise<void>
    {
        const checkOnly = [...changes.values()].every(change => change.foundBy === 'check');

        this.checkOnlyCycles = checkOnly ? this.checkOnlyCycles + 1 : 0;
        this.warnedCheckOnly &&= checkOnly;
        [...changes]
            .filter(([, change]) => change.foundBy === 'event')
            .forEach(([path, { event }]) => orchestratorLogger.info(`File ${EVENT_ICONS[event]} ${path}`));

        const runs = this.generators
            .filter(generator => this.rerun.has(generator) || this.shouldRun(generator, 'watch'))
            .map(generator => this.runOf(generator, changes))
            .filter(run => run !== undefined);

        this.rerun.clear();

        if (runs.length === 0 && this.debug)
        {
            orchestratorLogger.info('No generators matched this file');
        }

        await this.watchGeneration(runs);
    }

    /**
     * The run `changes` call for of `generator`, if any. One marked to run
     * again is told what its torn run was told, and what changed since; a torn
     * run that had no changed files (the initial generation, a `generateAll()`)
     * runs again with the same trigger, in full.
     */
    private runOf(generator: Generator, changes: Map<string, Change>): Run | undefined
    {
        const torn = this.rerun.get(generator);

        if (torn !== undefined && torn.changedFiles === undefined)
        {
            return { generator, trigger: torn };
        }

        const changedFiles = [...new Map([...torn?.changedFiles ?? [], ...this.triggersOf(generator, changes)].map(file => [file.path, file])).values()];

        if (changedFiles.length === 0)
        {
            return undefined;
        }

        return { generator, trigger: { type: 'watch', changedFiles, ...(changedFiles.length === 1 ? { changedFile: changedFiles[0] } : {}) } };
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
     * stamp. Returns every stale input, with how it changed; the caller decides
     * when it is dirty.
     */
    private armAndCheck(): Map<string, ChangedFile['event']>
    {
        this.checkRequested = false;
        this.lateCheck = false;

        // Arm before the check: this order is what makes the loop correct. A
        // change that lands before the check is found by it; one that lands
        // after the watch is armed is reported by the watch. Checked first and
        // armed after, a change between the two would be neither.
        this.inputWatcher?.sync([...this.inputPaths()].map(path => join(this.root, path)));

        return this.staleInputs();
    }

    private markDirty(path: string, event: ChangedFile['event'], foundBy: Change['foundBy']): void
    {
        if (!this.dirty.has(path))
        {
            this.dirty.set(path, { event, foundBy });
        }
    }

    private inputPaths(): Set<string>
    {
        return new Set([...this.inputs.values()].flatMap(inputs => [...inputs.keys()]));
    }

    /** Every input that differs from its stamp, with how it changed. */
    private staleInputs(): Map<string, ChangedFile['event']>
    {
        const stale = new Map<string, ChangedFile['event']>();

        for (const inputs of this.inputs.values())
        {
            for (const [path, stamp] of inputs)
            {
                const checked = checkStamp(join(this.root, path), stamp);

                if (!checked.fresh)
                {
                    stale.set(path, eventOf(stamp.exists, checked.exists));
                }
            }
        }

        return stale;
    }

    /**
     * Inputs changed during each of the last cycles, which the check alone
     * started: say which files and which generators read them, once until a
     * cycle an event started. A generator writing a file it reads, differently
     * on every run, would do this; so would a file saved during every one of
     * them. The loop regenerates either way.
     */
    private warnCheckOnly(stale: Map<string, ChangedFile['event']>): void
    {
        if (this.checkOnlyCycles < CHECK_ONLY_CYCLES || this.warnedCheckOnly)
        {
            return;
        }

        const named = [...stale.keys()].map(path => `${path} (read by ${this.readersOf(path).join(', ')})`);

        this.warnedCheckOnly = true;
        orchestratorLogger.warn(
            `Inputs changed during each of the last ${CHECK_ONLY_CYCLES} generations: ${named.join(', ')}. `
            + 'Either a generator writes a file it reads, differently on every run, or files are being saved during '
            + 'every generation; regenerating again each time the changes settle.',
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
