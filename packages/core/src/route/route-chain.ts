/**
 * Route chain resolution
 *
 * The one computation of which named middleware runs on each route, in which
 * order. `registerRoutes` registers exactly what it returns, and anything that
 * has to know whether a route is authenticated — a test classifying routes,
 * a tool listing them — reads the same answer instead of re-deriving it.
 *
 * A route inherits the server-level list and the `.use()` of every router it
 * sits in, outer to inner, and adds its own `.use()`. From what it inherits,
 * a middleware is removed when the route names it in `.skip([...])` (or skips
 * `'*'`), or when a middleware below it declares it in `skips`: one in the
 * route's own `.use()`, or one in the `.use()` of a router nested deeper than
 * the level the middleware came from. A sibling in the same `.use()` never
 * removes another.
 *
 * A skipper's `skips` count only while the skipper itself is still in the
 * chain. Levels are resolved from the innermost outwards in one pass, so a
 * route that skips `machineAuth` gets back the `auth` that `machineAuth` would
 * have stood in for.
 */

import type { MiddlewareHandler } from 'hono';
import { logger } from '@spfn/core/logger';
import type { NamedMiddleware } from './define-middleware';
import type { RouteDef } from './route-builder';
import type { Router } from './router';
import type { HttpMethod } from './types';

/** Where a middleware in a chain was declared. */
export type MiddlewareSource = 'server' | 'router' | 'route';

/** One middleware a route runs, in chain order. */
export interface ChainMiddleware
{
    /** The middleware's name; empty for a plain handler. */
    name: string;
    source: MiddlewareSource;
    /** 0 for the server list, 1 for the top router, one more per nested router; a route sits one below its router. */
    depth: number;
    handler: MiddlewareHandler;
}

/** An inherited middleware a route does not run, and what removed it. */
export interface RemovedMiddleware
{
    name: string;
    /** The middleware whose `skips` removed it, or `.skip` / `.skip('*')` for the route's own opt-out. */
    by: string;
    /** Where the remover was declared. */
    level: 'router' | 'route';
}

type Remover = Omit<RemovedMiddleware, 'name'>;

/** A route with the middleware chain it is registered with. */
export interface ResolvedRoute
{
    name: string;
    method: HttpMethod;
    path: string;
    middlewares: ChainMiddleware[];
    removed: RemovedMiddleware[];
    route: RouteDef<any>;
}

/** A server-level middleware: anything named with a handler. Its `skips`, if any, have nothing outside them to remove. */
type ServerMiddleware = { name: string; handler: MiddlewareHandler };

interface InheritedMiddleware extends ChainMiddleware
{
    skips: readonly string[];
}

/** A middleware in some router's `.use()` that declares `skips`, with the router that holds it. */
interface RouterSkipper
{
    router: string;
    middleware: NamedMiddleware<string>;
}

interface Walk
{
    inherited: InheritedMiddleware[];
    depth: number;
    /** The keys leading to the router, empty for the top one. */
    path: string[];
    skippers: RouterSkipper[];
    resolved: ResolvedRoute[];
}

/**
 * Resolve the middleware chain of every route of a router tree.
 *
 * Routes come back in registration order: a router's own routes (nested
 * routers in place) before its package routers.
 *
 * Throws when a router-level middleware declaring `skips` sits above a
 * `.packages()` mount — on the mounting router or on any router enclosing it.
 * A package route has no authenticator of its own; it relies on what it
 * inherits, and the skip would remove that from every one of them.
 *
 * @param router - The top router
 * @param serverMiddlewares - The server-level named middlewares, outermost
 */
export function resolveRouteMiddlewares(
    router: Router<any>,
    serverMiddlewares?: ReadonlyArray<ServerMiddleware>,
): ResolvedRoute[]
{
    const walk: Walk = {
        inherited: (serverMiddlewares ?? []).map(mw => inheritedFrom(mw, 'server', 0)),
        depth: 1,
        path: [],
        skippers: [],
        resolved: [],
    };

    walkRouter(router, walk);

    return walk.resolved;
}

function inheritedFrom(mw: ServerMiddleware | NamedMiddleware<string>, source: MiddlewareSource, depth: number): InheritedMiddleware
{
    return {
        name: mw.name,
        source,
        depth,
        handler: mw.handler,
        skips: ('skips' in mw && mw.skips) || [],
    };
}

function walkRouter(router: Router<any>, walk: Walk): void
{
    const own = router._globalMiddlewares ?? [];
    const inner: Walk = {
        ...walk,
        inherited: [...walk.inherited, ...own.map(mw => inheritedFrom(mw, 'router', walk.depth))],
        depth: walk.depth + 1,
        skippers: [...walk.skippers, ...own.filter(mw => mw.skips?.length).map(mw => ({ router: routerLabel(walk.path), middleware: mw }))],
    };

    for (const [name, entry] of Object.entries(router.routes))
    {
        walkEntry(name, entry, inner);
    }

    const packageRouters = router._packageRouters ?? [];
    if (packageRouters.length > 0)
    {
        assertNoSkipperAbovePackages(inner.skippers, routerLabel(walk.path));
    }

    packageRouters.forEach((pkgRouter, index) =>
    {
        walkRouter(pkgRouter, { ...inner, path: [...walk.path, `packages[${index}]`] });
    });
}

/** A router named by the keys leading to it from the top one. */
function routerLabel(path: readonly string[]): string
{
    return path.length > 0 ? path.join('.') : '(top-level)';
}

function walkEntry(name: string, entry: unknown, walk: Walk): void
{
    if (isRouter(entry))
    {
        walkRouter(entry, { ...walk, path: [...walk.path, name] });
    }
    else if (isRouteDef(entry))
    {
        const resolved = resolveRoute(name, entry, walk);
        if (resolved)
        {
            walk.resolved.push(resolved);
        }
    }
    else
    {
        logger.warn(`Unknown route type for "${name}" - skipping`, {
            type: typeof entry,
        });
    }
}

/**
 * Package routes have no authenticator of their own: `getAuth(c)` in a
 * package's signed-in route reads what the inherited `auth` left. A skipper
 * above the mount would remove that `auth` from each of them, enclosing
 * routers included, since a package router inherits their `.use()` too.
 */
function assertNoSkipperAbovePackages(skippers: readonly RouterSkipper[], mount: string): void
{
    const skipper = skippers[0];
    if (!skipper)
    {
        return;
    }

    const { name, skips } = skipper.middleware;
    const where = skipper.router === mount
        ? `Router "${mount}" .use()s "${name}"`
        : `Router "${mount}" sits under "${skipper.router}", which .use()s "${name}"`;

    throw new Error(
        `${where}, a middleware declaring skips: [${skips!.map(skip => `'${skip}'`).join(', ')}], `
        + `and "${mount}" mounts package routers with .packages(). Package routes have no authenticator of their own, `
        + `so "${name}" would remove the ${skips!.join(', ')} they inherit from every one of them. `
        + `Put "${name}" on a nested router that mounts no packages, or on the routes themselves.`,
    );
}

function resolveRoute(name: string, route: RouteDef<any>, walk: Walk): ResolvedRoute | null
{
    const { method, path } = route;

    if (!method || !path)
    {
        logger.warn(`Route "${name}" is missing method or path - skipping`, {
            method,
            path,
        });

        return null;
    }

    const { kept, removed } = removeSkipped(walk.inherited, route);
    logRemoved(name, route, removed);

    return {
        name,
        method,
        path,
        middlewares: attach(name, route, kept, walk.depth),
        removed,
        route,
    };
}

/**
 * Drop what the route does not run from what it inherits, innermost level
 * first: a level's survivors add their `skips` before the next level out is
 * read, so a removed skipper removes nothing and siblings never meet.
 */
function removeSkipped(inherited: InheritedMiddleware[], route: RouteDef<any>): { kept: InheritedMiddleware[]; removed: RemovedMiddleware[] }
{
    if (route.skipMiddlewares === '*')
    {
        return { kept: [], removed: inherited.map(mw => ({ name: mw.name, by: '.skip(\'*\')', level: 'route' })) };
    }

    const removers = routeRemovers(route);
    const kept: InheritedMiddleware[] = [];
    const removed: RemovedMiddleware[] = [];

    for (const level of levelsInnerToOuter(inherited))
    {
        const survivors = level.filter(mw => !removers.has(mw.name));
        const dropped = level.filter(mw => removers.has(mw.name));

        removed.unshift(...dropped.map(mw => ({ name: mw.name, ...removers.get(mw.name)! })));
        survivors.forEach(mw => addRemovers(removers, mw.skips, { by: mw.name, level: 'router' }));
        kept.unshift(...survivors);
    }

    return { kept, removed };
}

/** Record a remover for each name not already removed by something deeper. */
function addRemovers(removers: Map<string, Remover>, names: readonly string[], remover: Remover): void
{
    for (const name of names)
    {
        if (!removers.has(name))
        {
            removers.set(name, remover);
        }
    }
}

/** What the route itself removes: its `.skip([...])`, then the `skips` of its own named middlewares. */
function routeRemovers(route: RouteDef<any>): Map<string, Remover>
{
    const removers = new Map<string, Remover>();

    addRemovers(removers, Array.isArray(route.skipMiddlewares) ? route.skipMiddlewares : [], { by: '.skip', level: 'route' });

    for (const mw of route.middlewares ?? [])
    {
        if (isNamedMiddleware(mw))
        {
            addRemovers(removers, mw.skips ?? [], { by: mw.name, level: 'route' });
        }
    }

    return removers;
}

/** The inherited list, which is in depth order, cut into one array per depth, the deepest first. */
function levelsInnerToOuter(inherited: InheritedMiddleware[]): InheritedMiddleware[][]
{
    const levels = new Map<number, InheritedMiddleware[]>();

    for (const mw of inherited)
    {
        levels.set(mw.depth, [...(levels.get(mw.depth) ?? []), mw]);
    }

    return [...levels.values()].reverse();
}

/**
 * The chain in run order: what survived of the inherited list, then the
 * route's own. A name runs once, at its outermost place; a plain handler
 * once per reference; an entry with no name is never collapsed by name.
 */
function attach(name: string, route: RouteDef<any>, kept: InheritedMiddleware[], depth: number): ChainMiddleware[]
{
    const chain: ChainMiddleware[] = [];
    const names = new Set<string>();
    const handlers = new Set<MiddlewareHandler>();
    const own = (route.middlewares ?? []).map(mw => isNamedMiddleware(mw)
        ? { name: mw.name, source: 'route' as const, depth, handler: mw.handler }
        : { name: '', source: 'route' as const, depth, handler: mw });

    for (const mw of [...kept.map(chainEntry), ...own])
    {
        const duplicate = mw.name ? names.has(mw.name) : mw.source === 'route' && handlers.has(mw.handler);
        if (duplicate)
        {
            logger.debug(`🔄 Skipping duplicate middleware '${mw.name}' for route: ${route.method} ${route.path}`, { name });
            continue;
        }

        names.add(mw.name);
        handlers.add(mw.handler);
        chain.push(mw);
    }

    return chain;
}

function chainEntry({ name, source, depth, handler }: InheritedMiddleware): ChainMiddleware
{
    return { name, source, depth, handler };
}

function logRemoved(name: string, route: RouteDef<any>, removed: readonly RemovedMiddleware[]): void
{
    if (route.skipMiddlewares === '*')
    {
        logger.debug(`⏭️  Skipping all middlewares (*) for route: ${route.method} ${route.path}`, { name });

        return;
    }

    for (const { name: skipped, by, level } of removed)
    {
        const verb = by === '.skip' ? 'Skipping' : 'Auto-skipping';
        logger.debug(`⏭️  ${verb} middleware '${skipped}' for route: ${route.method} ${route.path}`, { name, by, level });
    }
}

function isRouter(value: unknown): value is Router<any>
{
    return value !== null &&
        typeof value === 'object' &&
        'routes' in value &&
        '_routes' in value;
}

function isRouteDef(value: unknown): value is RouteDef<any>
{
    return value !== null &&
        typeof value === 'object' &&
        'handler' in value;
}

function isNamedMiddleware(value: unknown): value is NamedMiddleware<any>
{
    return value !== null &&
        typeof value === 'object' &&
        'name' in value &&
        'handler' in value &&
        '_name' in value;
}
