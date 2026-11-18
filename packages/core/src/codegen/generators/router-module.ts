/**
 * Loading a router for a generator
 *
 * `@spfn/core:route-map`, `@spfn/core:contract` and `@spfn/core:states` all read
 * the router by importing it. They load it here rather than each on its own,
 * so they cannot drift — and so one generation loads it once.
 *
 * The router is imported in this process's own module graph, through the
 * codegen loader (`../loader`): the `@spfn/*` packages it reaches are the ones
 * this process already holds, evaluated once, and the project's own files are
 * evaluated again on every load. The loader resolves the project's tsconfig
 * `paths` (every target of an entry, in order, as tsc does) and its TypeScript
 * conventions, and treats project TypeScript as ESM whatever its package's
 * `type` — as `spfn dev` and `spfn build` run it.
 *
 * Generators handed the same `generation` (the orchestrator gives every
 * generator of one run the same one) share one load of each router: one
 * evaluation of the project, one record of the environment it read. A load
 * without one is a load of its own.
 *
 * After a load, a second copy of an `@spfn/core` entry in the process is
 * refused when the spfn CLI started it, and warned about otherwise
 * (`module-evaluation.ts`).
 *
 * The environment the router observes is not settled here: it is the
 * generating process's, pinned where generation begins (`../core/node-env`).
 */

import { relative } from 'path';
import type { RouteDef, Router } from '@spfn/core/route';
import { logger } from '@spfn/core/logger';
import { codegenSecondCopy } from '../../module-evaluation';
import { importProjectModule, newGeneration, type ProjectLoad } from '../loader/register';
import { observeEnvironmentReads, type EnvironmentRead } from './environment-probe';

const loadLogger = logger.child('@spfn/core:codegen');

// ============================================================================
// Loading
// ============================================================================

/**
 * An import that never resolved and a module that threw are different repairs.
 *
 * The message used to advise the second for both, which sends a developer whose
 * router imports `@/server/routes` looking for a module-scope side effect that
 * is not there.
 */
function describeFailure(error: unknown, subject: string): string
{
    const message = error instanceof Error ? error.message : String(error);
    const unresolved = /Cannot find (?:module|package) '([^']+)'/.exec(message);

    if (!unresolved)
    {
        return `${message}\n\n`
            + `The ${subject} is read from the loaded router, so a route module must be importable without side `
            + 'effects. Check that nothing at module scope opens a connection or reads a missing environment value.';
    }

    return `${message.split('\n')[0]}\n\n`
        + `"${unresolved[1]}" did not resolve while the router was being imported. Imports resolve through Node and `
        + 'through the "paths" of the nearest tsconfig.json that declares them, searching from the importing file up '
        + 'to the project root. Check that the specifier is mapped in one of those, and that what it points at '
        + 'exists: a workspace package resolves to a dist/ that has to have been built.';
}

export interface RouterModuleLoad
{
    /** Project root: the loader tags the files under it, and the tsconfig search stops here. */
    cwd: string;

    absoluteRouterPath: string;

    /** What is being generated, named in the failure message: `route map`. */
    subject: string;

    /** Wraps the message in the calling generator's own error type. */
    fail: (message: string) => Error;

    /**
     * The orchestrator's run this load belongs to (`GeneratorOptions.generation`).
     * Loads of one router under one generation are one load. Absent: a load of
     * its own.
     */
    generation?: string;

    /**
     * A load the environment probe makes under a varied environment: the files
     * it reaches are added to the router's watched files rather than replacing
     * them.
     */
    variation?: boolean;
}

/** The loaded router module, and the environment keys its project files read while it loaded. */
export interface LoadedRouterModule
{
    module: Record<string, unknown>;
    reads: EnvironmentRead[];
}

interface ObservedLoad
{
    load: ProjectLoad;
    reads: EnvironmentRead[];
}

/** The loads of the current generation, by router path. Only one generation's are kept. */
let sharedGeneration: string | undefined;
const sharedLoads = new Map<string, Promise<ObservedLoad>>();

/** The project files each router's latest load reached. */
const filesByRouter = new Map<string, Set<string>>();

/**
 * The project files the latest load of each router reached, by router path:
 * what the watcher has to watch beside its patterns, so an edit to a file the
 * router imports through `@/` regenerates too.
 */
export function routerFiles(): ReadonlyMap<string, ReadonlySet<string>>
{
    return filesByRouter;
}

async function observedLoad(cwd: string, absoluteRouterPath: string, token: string): Promise<ObservedLoad>
{
    const { value, reads } = await observeEnvironmentReads(cwd, () => importProjectModule(absoluteRouterPath, cwd, token));

    return { load: value, reads };
}

function sharedLoad(load: RouterModuleLoad): Promise<ObservedLoad>
{
    const { cwd, absoluteRouterPath, generation } = load;

    if (generation === undefined)
    {
        return observedLoad(cwd, absoluteRouterPath, newGeneration());
    }

    if (generation !== sharedGeneration)
    {
        sharedGeneration = generation;
        sharedLoads.clear();
    }

    if (!sharedLoads.has(absoluteRouterPath))
    {
        sharedLoads.set(absoluteRouterPath, observedLoad(cwd, absoluteRouterPath, generation));
    }

    return sharedLoads.get(absoluteRouterPath)!;
}

function recordFiles(load: RouterModuleLoad, touched: string[]): void
{
    const files = load.variation ? filesByRouter.get(load.absoluteRouterPath) ?? new Set<string>() : new Set<string>();

    touched.forEach(file => files.add(file));
    filesByRouter.set(load.absoluteRouterPath, files);
}

const warnedCopies = new Set<string>();

/** Refuse or warn about a second copy of an `@spfn/core` entry, found after a router load. */
function checkOneCopy(load: RouterModuleLoad): void
{
    const copy = codegenSecondCopy();

    if (copy?.refuse)
    {
        throw load.fail(copy.message);
    }

    if (copy && !warnedCopies.has(copy.message))
    {
        warnedCopies.add(copy.message);
        loadLogger.warn(`${copy.message} (Warned, not refused: this process was not started by the spfn CLI.)`);
    }
}

/**
 * Import the router module, or throw the caller's error describing why not.
 */
export async function loadRouterModule(load: RouterModuleLoad): Promise<LoadedRouterModule>
{
    const { load: outcome, reads } = await sharedLoad(load);

    recordFiles(load, outcome.touched);

    if (!outcome.ok)
    {
        throw load.fail(
            `Failed to load ${relative(load.cwd, load.absoluteRouterPath)}: ${describeFailure(outcome.error, load.subject)}`,
        );
    }

    checkOneCopy(load);

    return { module: outcome.module, reads };
}

export function isRouter(value: unknown): value is Router<Record<string, RouteDef<any> | Router<any>>>
{
    return value !== null
        && typeof value === 'object'
        && 'routes' in value
        && '_routes' in value;
}

export interface ResolvedRouter
{
    router: Router<any>;

    /**
     * The export it was found under.
     *
     * Both generators try `appRouter`, `default` and `router` in turn, so a file
     * holding more than one router is read from whichever of those it declares.
     * The guard then reads that same one rather than every `defineRouter(` in
     * the file: a router the loader did not find is a router production never
     * mounts.
     */
    exportName: string;
}

/** The first candidate export holding a router, and the name it was found under. */
export function resolveRouterExport(module: Record<string, unknown>, candidates: string[]): ResolvedRouter | undefined
{
    for (const exportName of candidates)
    {
        const candidate = module[exportName];

        if (isRouter(candidate))
        {
            return { router: candidate, exportName };
        }
    }

    return undefined;
}
