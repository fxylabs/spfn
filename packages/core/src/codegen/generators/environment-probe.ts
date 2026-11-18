/**
 * Environment probe — does the generated file depend on the environment?
 *
 * The source scan (`assertUnconditionalRegistration`) refuses a conditional
 * spread written inline in the router file. It reads spelling, not behaviour: a
 * condition hoisted one line up, or one inside an imported route module, passes
 * it, and the generated file then describes whatever environment the generator
 * ran in. This reads behaviour instead.
 *
 * The router is loaded, so the generator can see what the load reads. While the
 * first load runs — until its promise settles — `process.env` is a proxy that
 * records every key read through `get` or `has`: direct access, destructuring
 * and `in` alike. A read counts when the stack above it reaches a file of the
 * project (inside the project root, outside `node_modules`) before it reaches a
 * module-loading frame (`node:` internals): `env.ENABLE_ADMIN` through the env
 * registry of `@spfn/core/env` counts, because the registry's frames lead back
 * to the route module that asked, while a package reading its own settings as
 * Node loads it does not. A package does not run again on a second load — the
 * codegen loader (`../loader`) evaluates the project's modules again on every
 * load and a package once, in the pinned production environment — so varying
 * what a package read could change nothing, and a package's own
 * environment-dependent route is not refused: it is in the map as production
 * registers it. A frame is named by the line of the project file's source, not
 * of its transform.
 *
 * There is one environment per process, so loads that observe or vary it run
 * one at a time per process. Every router load (`observeEnvironmentReads`) and
 * every varied load (`withVaried`) holds the environment through one
 * process-wide queue (`holdEnvironment`), kept on a `Symbol.for` global so
 * that two copies of this module would share it; a load started inside the
 * load holding the environment — the router load inside a varied one — runs
 * inside it rather than behind it. Inside is decided by identity, not by
 * ancestry: a timer a finished load left behind still descends from it, and a
 * load it starts queues like any other. The queue captures the real `process.env` when it hands the
 * environment to a load, and that is what the load puts back. So each load of a
 * generation is atomic with respect to the environment: it sees no other
 * load's proxy or varied value, and between loads `process.env` is the real
 * object again — two generations run side by side (two orchestrators, a
 * `Promise.all` over a monorepo's apps) take turns load by load. Other
 * asynchronous work in the process, which does not go through the queue, still
 * sees the proxy and the varied values while a load runs.
 *
 * With no such read, nothing more happens: one load, as before. Otherwise the
 * router is loaded again with every one of those keys varied (a set key
 * deleted, an unset key set to `'true'`, and `NODE_ENV` set to each
 * conventional value it does not hold — `production`, `development`, `test` —
 * one load per value) and the content the generator would write is compared
 * with the content it is about to write — the whole file, so a route's `csrf`,
 * the order of the entries and a header line count as much as a name or a path.
 * When they differ, or a varied load fails, up to `MAX_SINGLE_KEY_LOADS` keys
 * are varied one at a time (`NODE_ENV` once per value) to find which of them
 * changes it. A difference is refused with a `ConditionalRegistrationError` that
 * says what changed, naming the `NODE_ENV` value that produced it: in the
 * generator's own terms where it can, else the first line that differs.
 *
 * Generation runs under `NODE_ENV=production` (`pinNodeEnv`, where it begins),
 * so the baseline is the production file and the variations are `development`
 * and `test`. The probe sets each value itself around its own load, which is
 * why the pin does not hide them.
 *
 * A key read at module scope for use inside a handler is not a defect, and this
 * does not flag it: it compares what is written rather than what is read.
 *
 * Not covered: a condition comparing a key other than `NODE_ENV` against one
 * particular value (`=== 'on'`), a `NODE_ENV` value outside the three, a key
 * first read under a varied environment, a package's own module scope (by
 * design, above), and anything but the environment — a file's existence, the
 * clock. Each variation runs the project's module scope again under the changed
 * environment, which is why a route module must be importable without side
 * effects.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { realpathSync } from 'fs';
import { relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@spfn/core/logger';
import { originalLine } from '../loader/hooks';
import { ConditionalRegistrationError } from './contract-guard';

const probeLogger = logger.child('@spfn/core:codegen');

/** How many keys are varied one at a time, at most, after the joint variations. */
export const MAX_SINGLE_KEY_LOADS = 4;

/** Frames collected per read: deep enough to climb out of a library to the route module that called it. */
const STACK_DEPTH = 50;

/** One key a project file read while the router loaded, and the first place it did. */
export interface EnvironmentRead
{
    readonly key: string;

    /** `src/server/routes/admin.ts:3`, relative to the project root. */
    readonly where: string;
}

/** A frame of the stack above a read: its file and line, as V8 reports them. */
export interface StackFrame
{
    readonly file: string | undefined;
    readonly line: number | undefined;
}

/** The environment each of two loads ran under, as the refusal names it: `production`, `development`. */
export interface LoadEnvironments
{
    baseline: string;
    varied: string;
}

/**
 * What the probe needs from the generator, for a generator whose one load of
 * the router produces a `T` that it writes as a file.
 */
export interface EnvironmentProbe<T>
{
    /** Project root. */
    cwd: string;

    /** The reads the first load made, from `observeEnvironmentReads`. */
    reads: EnvironmentRead[];

    /** What the first load produced. */
    baseline: T;

    /** Load the router again and collect it. A rejection means it cannot load in this environment. */
    collect: () => Promise<T>;

    /** The file content the generator writes for a collection. */
    render: (collection: T) => string;

    /**
     * What differs between two collections, one line each, in terms a person can
     * act on: `~ ping: csrf 'required' → none`. Empty when the difference is not
     * one it knows how to name; the refusal then shows the first line that differs.
     * `environments` names the environment each load ran under, for a difference
     * best shown as what each one wrote.
     */
    describe: (baseline: T, varied: T, environments: LoadEnvironments) => string[];

    /** What is being generated, named in the refusal: `route map`. */
    subject: string;
}

// ============================================================================
// Holding the environment
// ============================================================================

/** One load's hold on the environment: the real `process.env` the queue captured for it. */
interface Hold
{
    readonly real: NodeJS.ProcessEnv;
}

/** The process's environment, held by one load at a time. */
interface EnvironmentQueue
{
    /** Settles once every load queued so far has settled. */
    tail: Promise<void>;

    /** The hold of the load this code descends from, if any — which may have ended. */
    holder: AsyncLocalStorage<Hold>;

    /** The hold of the load holding the environment now. */
    current?: Hold;
}

const QUEUE_KEY = Symbol.for('@spfn/core/codegen:environment-queue');

function environmentQueue(): EnvironmentQueue
{
    const global = globalThis as { [QUEUE_KEY]?: EnvironmentQueue };

    global[QUEUE_KEY] ??= { tail: Promise.resolve(), holder: new AsyncLocalStorage() };

    return global[QUEUE_KEY];
}

/**
 * Run `load` holding the process's environment, handing it the real
 * `process.env`: once every load queued before it has settled, or at once
 * inside the load that holds it now.
 */
function holdEnvironment<T>(load: (real: NodeJS.ProcessEnv) => Promise<T>): Promise<T>
{
    const queue = environmentQueue();
    const held = queue.holder.getStore();

    if (held !== undefined && held === queue.current)
    {
        return load(held.real);
    }

    const run = queue.tail.then(() =>
    {
        const hold: Hold = { real: process.env };

        queue.current = hold;

        return queue.holder.run(hold, () => load(hold.real)).finally(() =>
        {
            queue.current = undefined;
        });
    });

    queue.tail = run.then(() => undefined, () => undefined);

    return run;
}

// ============================================================================
// Observing reads
// ============================================================================

/**
 * Run `load`, holding the environment, with `process.env` behind a proxy that
 * records which keys project files read. `process.env` is the real object again
 * when its promise settles.
 */
export function observeEnvironmentReads<T>(
    cwd: string,
    load: () => Promise<T>,
): Promise<{ value: T; reads: EnvironmentRead[] }>
{
    return holdEnvironment(async (real) =>
    {
        const reads = new Map<string, EnvironmentRead>();

        process.env = new Proxy(real, recordingHandler(projectRoots(cwd), reads));

        try
        {
            return { value: await load(), reads: [...reads.values()] };
        }
        finally
        {
            process.env = real;
        }
    });
}

type Trap = (...args: any[]) => unknown;

/** `get` and `has` traps that record the first project read of each key into `reads`. */
function recordingHandler(roots: string[], reads: Map<string, EnvironmentRead>): ProxyHandler<NodeJS.ProcessEnv>
{
    const note = (key: string | symbol, trap: Trap): void =>
    {
        if (typeof key !== 'string' || reads.has(key))
        {
            return;
        }

        const reader = readerOf(roots, framesBelow(trap));

        if (reader)
        {
            reads.set(key, { key, where: describeFrame(roots, reader) });
        }
    };
    const handler: ProxyHandler<NodeJS.ProcessEnv> = {
        get(target, key)
        {
            note(key, handler.get as Trap);

            return Reflect.get(target, key);
        },
        has(target, key)
        {
            note(key, handler.has as Trap);

            return Reflect.has(target, key);
        },
    };

    return handler;
}

/** The project root, both as given and resolved through symlinks (`/var` → `/private/var` on macOS). */
function projectRoots(cwd: string): string[]
{
    const given = resolve(cwd);
    let real = given;

    try
    {
        real = realpathSync(given);
    }
    catch
    {
        // A root that cannot be resolved is compared as given.
    }

    return real === given ? [given] : [given, real];
}

/** The frames below `trap` — the code that touched `process.env` first, then its callers. */
function framesBelow(trap: Trap): StackFrame[]
{
    const limit = Error.stackTraceLimit;
    const prepare = Error.prepareStackTrace;
    const holder: { stack?: unknown } = {};

    Error.stackTraceLimit = STACK_DEPTH;
    Error.prepareStackTrace = (_error, sites) => sites;

    try
    {
        Error.captureStackTrace(holder, trap);

        return (holder.stack as NodeJS.CallSite[]).map(site => ({
            file: site.getFileName() ?? undefined,
            line: sourceLine(site),
        }));
    }
    finally
    {
        Error.stackTraceLimit = limit;
        Error.prepareStackTrace = prepare;
    }
}

/** The frame's line in the file as written: the loader transforms project TypeScript. */
function sourceLine(site: NodeJS.CallSite): number | undefined
{
    const file = site.getFileName();
    const line = site.getLineNumber();

    return file && line ? originalLine(file, line, site.getColumnNumber() ?? 1) : line ?? undefined;
}

/**
 * The project frame a read is attributed to, or undefined when a module-loading
 * frame comes first or no project frame is reached. Frames of anything else —
 * a package, `@spfn/core` itself — are passed over.
 *
 * @internal exported for its unit test
 */
export function readerOf(roots: string[], frames: StackFrame[]): StackFrame | undefined
{
    for (const frame of frames)
    {
        const kind = frameKind(roots, frame.file);

        if (kind === 'project')
        {
            return frame;
        }

        if (kind === 'loader')
        {
            return undefined;
        }
    }

    return undefined;
}

function frameKind(roots: string[], file: string | undefined): 'project' | 'loader' | 'other'
{
    if (!file || file.startsWith('node:'))
    {
        return 'loader';
    }

    const path = file.startsWith('file:') ? fileURLToPath(file) : file;

    if (path.includes(`${sep}node_modules${sep}`))
    {
        return 'other';
    }

    return roots.some(root => path.startsWith(root + sep)) ? 'project' : 'other';
}

function describeFrame(roots: string[], frame: StackFrame): string
{
    const path = frame.file!.startsWith('file:') ? fileURLToPath(frame.file!) : frame.file!;
    const root = roots.find(candidate => path.startsWith(candidate + sep)) ?? roots[0];

    return `${relative(root, path)}${frame.line ? `:${frame.line}` : ''}`;
}

// ============================================================================
// Varying the environment
// ============================================================================

/**
 * The values tooling sets `NODE_ENV` to on its own: `next build` and `spfn start`
 * production, `next dev` and `spfn dev` development, vitest and jest test.
 *
 * It is the one key with a conventional closed set, so it is varied over each
 * of them rather than to one alternative: a route registered only under `test`
 * is as much a difference as one registered only under `development`.
 */
const NODE_ENV_VALUES = ['production', 'development', 'test'];

/** One key and the value it is varied to; `undefined` deletes it. */
interface Change
{
    key: string;
    value: string | undefined;
}

/** Keys varied together for one load of the router. */
type Variation = Change[];

function currentValue(key: string): string | undefined
{
    return Object.hasOwn(process.env, key) ? process.env[key] : undefined;
}

/** The values a key is varied to: every other conventional NODE_ENV, or the key's absence flipped. */
function variedValues(key: string): (string | undefined)[]
{
    const current = currentValue(key);

    if (key === 'NODE_ENV')
    {
        return NODE_ENV_VALUES.filter(value => value !== current);
    }

    return [current === undefined ? 'true' : undefined];
}

/**
 * Every key varied at once: one variation per alternative `NODE_ENV`, each
 * with every other key flipped, or a single variation when `NODE_ENV` was not
 * read.
 */
function jointVariations(keys: string[]): Variation[]
{
    const alternatives = keys.map(variedValues);
    const count = Math.max(...alternatives.map(values => values.length));

    return Array.from({ length: count }, (_, index) => keys.map((key, at) =>
        ({ key, value: alternatives[at][Math.min(index, alternatives[at].length - 1)] })));
}

/** Each key varied alone, once per value it is varied to. */
function singleVariations(keys: string[]): Variation[]
{
    return keys.flatMap(key => variedValues(key).map(value => [{ key, value }]));
}

function setVariable(key: string, value: string | undefined): void
{
    if (value === undefined)
    {
        delete process.env[key];
    }
    else
    {
        process.env[key] = value;
    }
}

/**
 * Run `fn`, holding the environment, with `variation` applied, and put every
 * key back once its promise settles.
 */
function withVaried<T>(variation: Variation, fn: () => Promise<T>): Promise<T>
{
    return holdEnvironment(async () =>
    {
        const original = variation.map(({ key }) => ({ key, value: currentValue(key) }));

        try
        {
            variation.forEach(({ key, value }) => setVariable(key, value));

            return await fn();
        }
        finally
        {
            original.forEach(({ key, value }) => setVariable(key, value));
        }
    });
}

type Attempt<T> = (Difference<T> & { ok: true }) | { variation: Variation; ok: false };

/** One variation at a time: each holds the environment (`withVaried`). */
async function attemptEach<T>(variations: Variation[], probe: EnvironmentProbe<T>): Promise<Attempt<T>[]>
{
    const attempts: Attempt<T>[] = [];

    for (const variation of variations)
    {
        attempts.push(await attempt(variation, probe));
    }

    return attempts;
}

async function attempt<T>(variation: Variation, probe: EnvironmentProbe<T>): Promise<Attempt<T>>
{
    try
    {
        const collection = await withVaried(variation, probe.collect);

        return { variation, ok: true, collection, content: probe.render(collection) };
    }
    catch
    {
        return { variation, ok: false };
    }
}

// ============================================================================
// The check
// ============================================================================

/**
 * Refuse a router whose generated file changes with an environment key its
 * project files read while it loaded.
 */
export async function assertContentIndependentOfEnvironment<T>(probe: EnvironmentProbe<T>): Promise<void>
{
    if (probe.reads.length === 0)
    {
        return;
    }

    const written = probe.render(probe.baseline);
    const keys = probe.reads.map(read => read.key);
    const joint = await attemptEach(jointVariations(keys), probe);

    if (joint.every(result => result.ok && result.content === written))
    {
        return;
    }

    const singles = await attemptEach(singleVariations(keys.slice(0, MAX_SINGLE_KEY_LOADS)), probe);
    const differs = (result: Attempt<T>): result is Difference<T> & { ok: true } => result.ok && result.content !== written;
    const gating = singles.filter(differs);
    const untried = keys.slice(MAX_SINGLE_KEY_LOADS);

    if (gating.length > 0)
    {
        throw refusal(probe, gating, untried);
    }

    const jointDifference = joint.find(differs);

    if (jointDifference)
    {
        throw refusal(probe, [jointDifference], untried);
    }

    logNotVaried(
        probe.subject,
        singles.filter(result => !result.ok).map(result => describeVaried(result.variation[0])),
        untried,
    );
}

function logNotVaried(subject: string, failed: string[], untried: string[]): void
{
    if (failed.length > 0)
    {
        probeLogger.info(
            `Could not vary ${failed.join(', ')} while checking the ${subject} against the environment: the router `
            + 'did not load with them changed. A route they gate, if any, was not checked.',
        );
    }

    if (untried.length > 0)
    {
        probeLogger.info(
            `${untried.join(', ')} ${untried.length === 1 ? 'was' : 'were'} not varied one at a time while checking `
            + `the ${subject} against the environment (at most ${MAX_SINGLE_KEY_LOADS} are).`,
        );
    }
}

// ============================================================================
// The refusal
// ============================================================================

interface Difference<T>
{
    variation: Variation;
    collection: T;
    content: string;
}

function refusal<T>(probe: EnvironmentProbe<T>, differences: Difference<T>[], untried: string[]): ConditionalRegistrationError
{
    const where = new Map(probe.reads.map(read => [read.key, read.where]));
    const sections = differences.map(difference => describeDifference(probe, difference, where));

    return new ConditionalRegistrationError(
        `The ${probe.subject} depends on the environment. The file generated from this router changes when these `
        + 'keys change, so a file generated under one environment describes something another one does not serve — '
        + 'a route the client names that 404s, a CSRF token it never sends:\n\n'
        + `${sections.join('\n\n')}\n${jointNote(differences, untried)}\n`
        + 'Register the routes unconditionally and gate their behaviour inside the handler instead.',
    );
}

/** Said when only varying every key together changed the file. */
function jointNote<T>(differences: Difference<T>[], untried: string[]): string
{
    if (differences.length !== 1 || differences[0].variation.length === 1)
    {
        return '';
    }

    const tried = Math.min(differences[0].variation.length, MAX_SINGLE_KEY_LOADS);
    const rest = untried.length > 0 ? ` ${untried.join(', ')} ${untried.length === 1 ? 'was' : 'were'} not varied alone.` : '';

    return `\nThese keys change it together; none of the ${tried} varied alone does.${rest}\n`;
}

/** One variation, and what it changes in the file. */
function describeDifference<T>(probe: EnvironmentProbe<T>, difference: Difference<T>, where: Map<string, string>): string
{
    const header = difference.variation
        .map(change => `  ${change.key} (read at ${where.get(change.key)}), ${describeChange(change)}`)
        .join('\n');
    const environments = { baseline: environmentOf([]), varied: environmentOf(difference.variation) };
    const named = probe.describe(probe.baseline, difference.collection, environments);
    const changes = named.length > 0 ? named : firstDifferingLine(probe.render(probe.baseline), difference.content);

    return `${header}\n${changes.map(line => `    ${line}`).join('\n')}`;
}

/**
 * How the key was varied. Only NODE_ENV's values are named: any other key may
 * hold a secret, so it is described as set or unset.
 */
function describeChange(change: Change): string
{
    const current = currentValue(change.key);

    if (change.key === 'NODE_ENV')
    {
        return `${current ?? 'unset'} → ${change.value}`;
    }

    return current === undefined ? 'unset → set' : 'set → unset';
}

/**
 * The environment a load ran under: its `NODE_ENV`, and any other key it
 * varied, by name only, as `describeChange` does.
 */
function environmentOf(variation: Variation): string
{
    const nodeEnv = variation.find(change => change.key === 'NODE_ENV');
    const value = nodeEnv ? nodeEnv.value : currentValue('NODE_ENV');
    const others = variation.filter(change => change.key !== 'NODE_ENV').map(change => change.key);
    const name = value ?? 'NODE_ENV unset';

    return others.length > 0 ? `${name} with ${others.join(', ')} varied` : name;
}

/** A key as a log line names it: with the value only for NODE_ENV, as `describeChange` does. */
function describeVaried(change: Change): string
{
    return change.key === 'NODE_ENV' ? `NODE_ENV (as "${change.value}")` : change.key;
}

/**
 * The first line the two contents disagree on, for a difference the generator
 * has no name for. A missing line is shown as `(end of file)`.
 */
export function firstDifferingLine(written: string, varied: string): string[]
{
    const left = written.split('\n');
    const right = varied.split('\n');
    const index = left.findIndex((line, at) => line !== right[at]);
    const at = index === -1 ? left.length : index;
    const show = (line: string | undefined) => line === undefined ? '(end of file)' : JSON.stringify(line);

    return [`line ${at + 1}: ${show(left[at])} → ${show(right[at])}`];
}
