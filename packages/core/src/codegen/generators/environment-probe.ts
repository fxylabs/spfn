/**
 * Environment probe — does the router's route set depend on the environment?
 *
 * The source scan (`assertUnconditionalRegistration`) refuses a conditional
 * spread written inline in the router file. It reads spelling, not behaviour: a
 * condition hoisted one line up, or one inside an imported route module, passes
 * it, and the generated map then describes whatever environment the generator
 * ran in. This reads behaviour instead.
 *
 * The router is loaded, so the generator can see what the load reads. While the
 * first load runs, `process.env` is a proxy that records every key read through
 * `get` or `has` — direct access, destructuring and `in` alike. A read counts
 * when the stack above it reaches a file of the project (inside the project
 * root, outside `node_modules`) before it reaches a module-loading frame (jiti,
 * `node:` internals): `env.ENABLE_ADMIN` through the env registry of
 * `@spfn/core/env` counts, because the registry's frames lead back to the route
 * module that asked, while jiti, babel and pg reading their own settings as they
 * load do not. A package does not run again on a second load either way — jiti
 * re-evaluates the project's modules on every load and leaves `node_modules`
 * cached — so varying what a package read could change nothing.
 *
 * With no such read, nothing more happens: one load, as before. Otherwise the
 * router is loaded again with every one of those keys varied (`NODE_ENV`
 * between `development` and `production`, a set key deleted, an unset key set
 * to `'true'`) and the route sets are compared — name, method and path. When
 * they differ, or the varied load fails, up to `MAX_SINGLE_KEY_LOADS` keys are
 * varied one at a time to find which of them changes the route set. A
 * difference is refused with a `ConditionalRegistrationError`.
 *
 * A key read at module scope for use inside a handler is not a defect, and this
 * does not flag it: it compares route sets rather than reads.
 *
 * Not covered: a condition comparing a key against one particular value
 * (`=== 'on'`), a key first read under a varied environment, a package's own
 * module scope, and anything but the environment — a file's existence, the
 * clock. Each variation runs the project's module scope again under the
 * changed environment, which is why a route module must be importable without
 * side effects.
 */

import { realpathSync } from 'fs';
import { relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@spfn/core/logger';
import { ConditionalRegistrationError } from './contract-guard';

const probeLogger = logger.child('@spfn/core:codegen');

/** How many keys are varied one at a time, at most, after the joint variation. */
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

/** Route name → `METHOD path`: what the generated map holds per name. */
export type RouteSet = ReadonlyMap<string, string>;

/** What the probe needs from the generator. */
export interface EnvironmentProbe
{
    /** Project root. */
    cwd: string;

    /** The reads the first load made, from `observeEnvironmentReads`. */
    reads: EnvironmentRead[];

    /** The route set of the first load. */
    baseline: RouteSet;

    /** Load the router again and return its route set. A throw means it cannot load in this environment. */
    routeSet: () => RouteSet;

    /** What is being generated, named in the refusal: `route map`. */
    subject: string;
}

// ============================================================================
// Observing reads
// ============================================================================

/**
 * Run `load` with `process.env` behind a proxy that records which keys project
 * files read. `process.env` is the real object again when this returns or throws.
 */
export function observeEnvironmentReads<T>(cwd: string, load: () => T): { value: T; reads: EnvironmentRead[] }
{
    const reads = new Map<string, EnvironmentRead>();
    const real = process.env;

    process.env = new Proxy(real, recordingHandler(projectRoots(cwd), reads));

    try
    {
        return { value: load(), reads: [...reads.values()] };
    }
    finally
    {
        process.env = real;
    }
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
            line: site.getLineNumber() ?? undefined,
        }));
    }
    finally
    {
        Error.stackTraceLimit = limit;
        Error.prepareStackTrace = prepare;
    }
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

    if (path.includes(`${sep}node_modules${sep}jiti${sep}`))
    {
        return 'loader';
    }

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

/** The value a key is varied to: the other common NODE_ENV, or the key's absence flipped. */
function variedValue(key: string, current: string | undefined): string | undefined
{
    if (key === 'NODE_ENV')
    {
        return current === 'development' ? 'production' : 'development';
    }

    return current === undefined ? 'true' : undefined;
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
 * Run `fn` with `keys` varied, and put every one of them back afterwards.
 *
 * Synchronous on purpose: the router loads synchronously, so no other code runs
 * while the environment is changed.
 */
function withVaried<T>(keys: string[], fn: () => T): T
{
    const original = new Map(keys.map(key => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]));

    try
    {
        for (const [key, value] of original)
        {
            setVariable(key, variedValue(key, value));
        }

        return fn();
    }
    finally
    {
        for (const [key, value] of original)
        {
            setVariable(key, value);
        }
    }
}

type Attempt = { ok: true; routes: RouteSet } | { ok: false };

function attempt(keys: string[], routeSet: () => RouteSet): Attempt
{
    try
    {
        return { ok: true, routes: withVaried(keys, routeSet) };
    }
    catch
    {
        return { ok: false };
    }
}

function sameRouteSet(left: RouteSet, right: RouteSet): boolean
{
    return left.size === right.size && [...left].every(([name, route]) => right.get(name) === route);
}

// ============================================================================
// The check
// ============================================================================

/**
 * Refuse a router whose route set changes with an environment key its project
 * files read while it loaded.
 */
export function assertRouteSetIndependentOfEnvironment(probe: EnvironmentProbe): void
{
    if (probe.reads.length === 0)
    {
        return;
    }

    const keys = probe.reads.map(read => read.key);
    const joint = attempt(keys, probe.routeSet);

    if (joint.ok && sameRouteSet(joint.routes, probe.baseline))
    {
        return;
    }

    const tried = keys.slice(0, MAX_SINGLE_KEY_LOADS);
    const singles = tried.map(key => ({ key, result: attempt([key], probe.routeSet) }));
    const gating = singles.flatMap(({ key, result }) =>
        result.ok && !sameRouteSet(result.routes, probe.baseline) ? [{ key, routes: result.routes }] : []);
    const untried = keys.slice(MAX_SINGLE_KEY_LOADS);

    if (gating.length > 0)
    {
        throw refusal(probe, gating.map(({ key, routes }) => ({ keys: [key], routes })), untried);
    }

    if (joint.ok)
    {
        throw refusal(probe, [{ keys, routes: joint.routes }], untried);
    }

    const failed = singles.flatMap(({ key, result }) => result.ok ? [] : [key]);

    logNotVaried(probe.subject, failed, untried);
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

interface Difference
{
    keys: string[];
    routes: RouteSet;
}

function refusal(probe: EnvironmentProbe, differences: Difference[], untried: string[]): ConditionalRegistrationError
{
    const where = new Map(probe.reads.map(read => [read.key, read.where]));
    const sections = differences.map(difference => describeDifference(difference, where, probe.baseline));

    return new ConditionalRegistrationError(
        `The ${probe.subject} depends on the environment. The router registers a different route set when these `
        + 'keys change, so a map generated under one environment leaves out or misroutes a route another one serves, '
        + 'and the client that names it gets a 404:\n\n'
        + `${sections.join('\n\n')}\n${jointNote(differences, untried)}\n`
        + 'Register the routes unconditionally and gate their behaviour inside the handler instead.',
    );
}

/** Said when only varying every key together changed the route set. */
function jointNote(differences: Difference[], untried: string[]): string
{
    if (differences.length !== 1 || differences[0].keys.length === 1)
    {
        return '';
    }

    const tried = Math.min(differences[0].keys.length, MAX_SINGLE_KEY_LOADS);
    const rest = untried.length > 0 ? ` ${untried.join(', ')} ${untried.length === 1 ? 'was' : 'were'} not varied alone.` : '';

    return `\nThese keys change it together; none of the ${tried} varied alone does.${rest}\n`;
}

/** One key's (or one set of keys') change, and the routes it adds, drops and moves. */
function describeDifference(difference: Difference, where: Map<string, string>, baseline: RouteSet): string
{
    const header = difference.keys
        .map(key => `  ${key} (read at ${where.get(key)}), ${describeChange(key)}`)
        .join('\n');

    return `${header}\n${routeChanges(baseline, difference.routes).map(line => `    ${line}`).join('\n')}`;
}

/**
 * How the key was varied. Only NODE_ENV's values are named: any other key may
 * hold a secret, so it is described as set or unset.
 */
function describeChange(key: string): string
{
    const current = process.env[key];

    if (key === 'NODE_ENV')
    {
        return `${current ?? 'unset'} → ${variedValue(key, current)}`;
    }

    return current === undefined ? 'unset → set' : 'set → unset';
}

/** `+ admin (GET /admin)`, `- legacy (GET /old)`, `~ env: GET /production → GET /development`. */
function routeChanges(baseline: RouteSet, varied: RouteSet): string[]
{
    const added = [...varied].filter(([name]) => !baseline.has(name)).map(([name, route]) => `+ ${name} (${route})`);
    const dropped = [...baseline].filter(([name]) => !varied.has(name)).map(([name, route]) => `- ${name} (${route})`);
    const moved = [...baseline]
        .filter(([name, route]) => varied.has(name) && varied.get(name) !== route)
        .map(([name, route]) => `~ ${name}: ${route} → ${varied.get(name)}`);

    return [...added, ...dropped, ...moved];
}
