/**
 * Route Map Generator
 *
 * Generates a route map file containing routeName → {method, path} mappings.
 * This allows RPC proxy to resolve routes without importing the full router.
 *
 * The router is loaded and walked, not parsed from source. A source parser sees
 * the spelling rather than the router: `defineRouter({ createUser })` written on
 * one line, an aliased key `create: createUser`, and a nested router assembled by
 * a second `defineRouter(` in the same file are all ordinary ways to write a
 * router, and all of them used to leave routes out of the map. The RPC client
 * addresses a route by name, so a dropped name is a route that typechecks and
 * 404s. Walking the loaded router registers exactly what `registerRoutes`
 * registers, whatever the source looks like.
 *
 * The map carries the routes of every package router the app mounts with
 * `.packages()`, not only the app's own. A package ships a client that addresses
 * its routes by name — `authApi.login`, `monitorApi.getStats` — and the app's
 * `createRpcProxy` resolves a name in the single map it was constructed with, so
 * a package route in nobody's map is a call that resolves nowhere. The app
 * therefore merges nothing by hand: `{ ...routeMap, ...authRouteMap }` is a
 * no-op today and `{ ...routeMap }` is the whole of it. (`eventRouteMap` is the
 * exception that stays — it is a hand-written constant, not a mounted router.)
 *
 * @example
 * ```typescript
 * // .spfnrc.ts
 * import { defineConfig, defineGenerator } from '@spfn/core/codegen';
 *
 * export default defineConfig({
 *     generators: [
 *         defineGenerator({
 *             name: '@spfn/core:route-map',
 *             routerPath: './src/server/router.ts',
 *             outputPath: './src/generated/route-map.ts',
 *         })
 *     ]
 * });
 * ```
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import type { HttpMethod, RouteDef, Router } from '@spfn/core/route';
import { logger } from '@spfn/core/logger';
import type { Generator, GeneratorOptions } from '../core/generator';
import { assertUnconditionalRegistration } from './contract-guard';
import { isRouter, loadRouterModule, pinNodeEnv, resolveRouterExport, type ResolvedRouter } from './router-module';

const genLogger = logger.child('@spfn/core:route-map-generator');

// ============================================================================
// Types
// ============================================================================

export interface RouteMapGeneratorConfig
{
    /**
     * Generator name (required for package-based loading)
     */
    name: '@spfn/core:route-map';

    /**
     * Path to the router file (relative to project root)
     * @example './src/server/router.ts'
     */
    routerPath: string;

    /**
     * Output path for generated route map (relative to project root)
     * @default './src/generated/route-map.ts'
     */
    outputPath?: string;

    /**
     * Extra file patterns to watch, for routes outside src/server/routes
     *
     * @deprecated Ignored. The map is read from the loaded router, which reaches
     * every route through its own imports wherever they live, so there is no
     * longer a set of directories to scan. Still accepted so an existing
     * `.spfnrc.ts` keeps working; the watch patterns it produced are unchanged.
     */
    additionalRouteDirs?: string[];
}

/** Thrown when the router cannot produce a route map at all. */
export class RouteMapGeneratorError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'RouteMapGeneratorError';
    }
}

interface CollectedRoute
{
    method: string;
    path: string;

    /** Where the route was found, for a collision message. */
    trail: string;

    /**
     * The definition itself, so that one route reached twice is not two routes.
     *
     * A package that exports one set of routes under two routers — a router and
     * a sub-router an app may mount beside it — hands an app that mounts both
     * the same `RouteDef` object under the same name twice. That is one route
     * with two mounts, not an ambiguity, and the app cannot resolve it by
     * renaming anything of its own. No first-party package ships that shape
     * today; the rule is keyed on object identity so that the day one does, the
     * app that mounts both still builds.
     */
    def: RouteDef<any>;
}

/** One entry of a router's `_packageRouters`, as the generated header describes it. */
interface PackageMount
{
    /** The trail of the mount: `router.packages[0]`. */
    label: string;

    /** How many routes it contributed, which is zero for an unmapped router. */
    count: number;

    /** Why it contributed nothing, when it contributed nothing. */
    skipped?: string;

    /**
     * Where a route it holds had already been collected, if one had.
     *
     * A mount reaching only routes another mount already collected contributes
     * nothing without being skipped, so without this its header line would read
     * `— no routes` and give no reason.
     */
    sharedWith?: string;

    /** The first path segment of each route it contributed, for the header line. */
    prefixes: Set<string>;
}

/** Everything one walk of the router produced. */
interface Collection
{
    /** The app's own routes, in walk order. */
    app: Map<string, CollectedRoute>;

    /** The routes of every mounted package router that publishes a map, in walk order. */
    packages: Map<string, CollectedRoute>;

    /** Every `.packages()` mount, contributing or not, in the order it was mounted. */
    mounts: PackageMount[];

    /**
     * Package routers already walked.
     *
     * `.packages()` copies a mounted router's own `_packageRouters` up to the
     * top level while leaving them in place below it, so one nested package
     * router is reachable by two trails. The second walk would collect nothing
     * either way — `addRoute`'s identity rule sees the same `RouteDef` under
     * the same name and collapses it — so this is not what keeps a router from
     * colliding with itself. It skips the work, and it is what lets the mount's
     * header line say where the routes were already reached.
     */
    visited: Map<Router<any>, string>;
}

// ============================================================================
// Loading
// ============================================================================

function isRouteDef(value: unknown): value is RouteDef<any>
{
    return value !== null
        && typeof value === 'object'
        && 'handler' in value;
}

const ROUTER_EXPORTS = ['appRouter', 'default', 'router'];

function loadRouter(cwd: string, absoluteRouterPath: string): ResolvedRouter
{
    const module = loadRouterModule({
        cwd,
        absoluteRouterPath,
        subject: 'route map',
        fail: message => new RouteMapGeneratorError(message),
    });

    const resolved = resolveRouterExport(module, ROUTER_EXPORTS);

    if (resolved)
    {
        return resolved;
    }

    throw new RouteMapGeneratorError(
        `No router found in ${relative(cwd, absoluteRouterPath)}. `
        + `Looked for: ${ROUTER_EXPORTS.join(', ')}. `
        + 'Export the defineRouter() result under one of those names.',
    );
}

// ============================================================================
// Collection
// ============================================================================

/**
 * Written as a record rather than a list so that a new `HttpMethod` does not
 * compile until it is named here.
 */
const HTTP_METHODS: Record<HttpMethod, true> = { GET: true, POST: true, PUT: true, PATCH: true, DELETE: true };

/** Which map a route is collected into, and so which collision it can be part of. */
type Origin = 'app' | 'package';

function duplicateNameError(
    origin: Origin,
    name: string,
    existing: CollectedRoute,
    where: string,
): RouteMapGeneratorError
{
    if (origin === 'app')
    {
        return new RouteMapGeneratorError(
            `Two routes are both named "${name}" (${existing.trail} and ${where}). `
            + 'The RPC client addresses a route by its name alone, and a nested route registers under its own '
            + 'key, so a name must be unique across the whole router.',
        );
    }

    return new RouteMapGeneratorError(
        `Two package routers both register a route named "${name}" (${existing.trail} and ${where}). `
        + 'Both are written into this app\'s route map, which holds one entry per name, so one of the two '
        + 'packages would have its client call the other package\'s path. Nothing of this app\'s can be renamed '
        + 'to fix it: drop one of the two mounts, or raise the name with the package that took it second.',
    );
}

/**
 * Collect one route, or say why it is not in the map.
 *
 * Returns what was collected, which is what lets a mount count and describe
 * what it contributed without counting a route twice.
 */
function addRoute(
    name: string,
    routeDef: RouteDef<any>,
    trail: string[],
    into: Map<string, CollectedRoute>,
    origin: Origin,
): CollectedRoute | undefined
{
    const where = trail.join('.');

    // Skipped rather than refused: `registerRoutes` warns and skips it too, so
    // the map that leaves it out still names every route the server answers —
    // which is the whole of what a refusal here would be protecting.
    if (!routeDef.method || !routeDef.path)
    {
        genLogger.warn(
            `Route "${where}" has no method or path and is left out of the map. `
            + 'The RPC client resolves a name to a method and a path, so both are required. '
            + 'A route reaches this state by being registered before .handler() was called — '
            + 'the server skips it too.',
        );

        return undefined;
    }

    // The map is typed `HttpMethod`, and `registerRoutes` lowercases whatever it
    // is given before handing it to Hono — so `method: 'get'` registers happily
    // at runtime and would emit a generated file that does not compile.
    if (!Object.hasOwn(HTTP_METHODS, routeDef.method))
    {
        throw new RouteMapGeneratorError(
            `Route "${where}" declares the method "${routeDef.method}", which is not an HttpMethod `
            + `(${Object.keys(HTTP_METHODS).join(', ')}). The generated map is typed HttpMethod, so naming it `
            + 'would write a file that does not compile.',
        );
    }

    const existing = into.get(name);
    if (existing)
    {
        // The same route, reached through two mounts, is one route: a package
        // that exports its routes under two routers hands both to an app that
        // mounts both, and the entry either mount writes is the same entry.
        //
        // Only for a package route. The app's own router reaches one name twice
        // by registering one route both at the top level and inside a nested
        // group, and that stays refused even though the two entries are
        // identical: it is the app's own spelling, so the app can fix it by
        // dropping one registration, and leaving it silent would hide a
        // grouping the author meant to be a second route.
        if (origin === 'package' && existing.def === routeDef)
        {
            return undefined;
        }

        throw duplicateNameError(origin, name, existing, where);
    }

    const collected: CollectedRoute = {
        method: routeDef.method,
        path: routeDef.path,
        trail: where,
        def: routeDef,
    };

    into.set(name, collected);

    return collected;
}

/** `/_auth/login` → `/_auth`: what the header line says a mount's routes live under. */
function pathPrefix(path: string): string
{
    const [, first] = path.split('/');

    return first ? `/${first}` : path;
}

/**
 * Every route a mounted package router registers, at any depth below it.
 *
 * These are written into the app's map beside the app's own routes. A package
 * ships a client that addresses its routes by name — `authApi.login`,
 * `monitorApi.getStats` — and the app's `createRpcProxy` resolves that name in
 * the single map it was constructed with, so a name in nobody's map resolves
 * nowhere.
 *
 * A router whose `_publishesRouteMap` is false contributes nothing, and neither
 * does anything below it: no client names those routes. That is the ops surface
 * (`createOpsRouter`), whose routes `spfn ops` invokes over the URL the manifest
 * gave it, and whose own sub-routers carry the flag too.
 *
 * The flag is read on the router being walked rather than on the mount that
 * reached it. So an unmapped router nested inside a mapped package router is
 * left out while its parent contributes, and a mapped router nested inside an
 * unmapped one is left out with it — what the flag says is whether a client
 * names these routes, which nesting does not change either way.
 */
function collectPackageRoutes(
    router: Router<any>,
    trail: string[],
    mount: PackageMount,
    collection: Collection,
): void
{
    if (router._publishesRouteMap === false || collection.visited.has(router))
    {
        return;
    }

    collection.visited.set(router, trail.join('.'));

    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            collectPackageRoutes(entry, [...trail, name], mount, collection);
            continue;
        }

        if (!isRouteDef(entry))
        {
            genLogger.warn(
                `Package router entry "${[...trail, name].join('.')}" is neither a route nor a router `
                + `(got ${typeof entry}) and is left out of the map. \`registerRoutes\` skips it too.`,
            );

            continue;
        }

        const collected = addRoute(name, entry, [...trail, name], collection.packages, 'package');

        if (collected)
        {
            mount.count += 1;
            mount.prefixes.add(pathPrefix(collected.path));

            continue;
        }

        const already = collection.packages.get(name);

        if (already?.def === entry)
        {
            mount.sharedWith ??= already.trail;
        }
    }

    for (const [index, nested] of (router._packageRouters ?? []).entries())
    {
        collectPackageRoutes(nested, [...trail, `packages[${index}]`], mount, collection);
    }
}

/** One entry of a router's `_packageRouters`, walked and described for the generated header. */
function mountPackageRouter(router: Router<any>, label: string, collection: Collection): PackageMount
{
    const mount: PackageMount = { label, count: 0, prefixes: new Set() };
    const alreadyAt = collection.visited.get(router);

    // Said before the walk, because the walk is what makes both true of it.
    if (router._publishesRouteMap === false)
    {
        mount.skipped = 'publishes no route map';
    }
    else if (alreadyAt)
    {
        mount.skipped = `already reached through ${alreadyAt}`;
    }

    collectPackageRoutes(router, [label], mount, collection);

    // Said after the walk, because the walk is what found the other mount.
    if (mount.count === 0 && !mount.skipped && mount.sharedWith)
    {
        mount.skipped = `every route it holds was already collected through ${mount.sharedWith}`;
    }

    collection.mounts.push(mount);

    return mount;
}

/**
 * Walk the router the way `registerRoutes` walks it.
 *
 * A nested route registers under its own key — the parent's key names the
 * grouping, not the route — so the map is flat and the trail exists only to
 * point at both sides of a collision.
 *
 * `_packageRouters` is walked into a second map rather than this one, because
 * the generated file keeps the app's own routes first and in their own order:
 * an app that mounts nothing regenerates byte-identically, and an app that
 * mounts something has the routes that are not its own written below a line
 * that says so.
 *
 * Only string keys are collected, because `Object.entries` is what the runtime
 * iterates: a symbol-keyed entry is invisible to `registerRoutes` and so has no
 * route to name in the map either.
 */
function collectRoutes(router: Router<any>, trail: string[], collection: Collection): void
{
    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            collectRoutes(entry, [...trail, name], collection);
            continue;
        }

        // Skipped rather than refused, for the reason `addRoute` skips a route
        // with no method: the server skips it, so a map without it is complete.
        if (!isRouteDef(entry))
        {
            genLogger.warn(
                `Router entry "${[...trail, name].join('.')}" is neither a route nor a router (got ${typeof entry}) `
                + 'and is left out of the map. `registerRoutes` skips it too, so no name the client can call goes '
                + 'unanswered.',
            );

            continue;
        }

        addRoute(name, entry, [...trail, name], collection.app, 'app');
    }

    for (const [index, packageRouter] of (router._packageRouters ?? []).entries())
    {
        mountPackageRouter(packageRouter, `${trail.join('.')}.packages[${index}]`, collection);
    }
}

/**
 * Refuse an app route whose name a package router also registers.
 *
 * Both are registered at runtime, at their own paths, and both are written into
 * this one map — which holds one entry per name. The name would resolve to
 * whichever of the two the map ended up holding while the generated types still
 * describe the app's route, so every call the typed client made against the
 * app's route could go to the package's path.
 *
 * A collision with a router that publishes no map is not refused: nothing of
 * that router is written here, so the app route keeps its name and its path.
 */
function assertNoPackageCollision(collection: Collection): void
{
    for (const [name, route] of collection.packages)
    {
        const appRoute = collection.app.get(name);

        if (!appRoute)
        {
            continue;
        }

        throw new RouteMapGeneratorError(
            `The app route "${name}" (${appRoute.trail}) is also registered by a package router (${route.trail}). `
            + 'Both go into this app\'s generated route map, which holds one entry per name, so one of the two '
            + 'paths becomes unreachable while the typed client still describes the app\'s route. Rename the app '
            + 'route.',
        );
    }
}

/** The map the file is written from: the app's own routes, then its mounted packages'. */
function collectRouteMap(router: Router<any>): Collection
{
    const collection: Collection = {
        app: new Map(),
        packages: new Map(),
        mounts: [],
        visited: new Map(),
    };

    collectRoutes(router, ['router'], collection);
    assertNoPackageCollision(collection);

    return collection;
}

// ============================================================================
// Generator
// ============================================================================

/**
 * A route name is a key in an object literal, and a key that is not an
 * identifier has to be quoted or the generated file will not parse.
 *
 * The source parser could never produce such a name — it read names off
 * `export const` — but `defineRouter({ 'get-user': getUser })` is a legal
 * router that the server registers as `get-user`, so the map has to be able to
 * spell it. `JSON.stringify` is the escaping: double quotes are what it emits,
 * and every other name is left bare so an unchanged project regenerates
 * byte-identically.
 */
function toObjectKey(name: string): string
{
    // `__proto__:` in an object literal sets the prototype instead of defining
    // an own property, and so does `"__proto__":` — the route would vanish from
    // Object.keys and from the proxy's spread. A computed key is the one form
    // that always defines an own property.
    if (name === '__proto__')
    {
        return `[${JSON.stringify(name)}]`;
    }

    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Printable ASCII, minus the two characters a single-quoted literal cannot hold.
 * Every realistic path is in here and is emitted as it always was, so an
 * unchanged project regenerates byte-identically.
 */
const SINGLE_QUOTABLE = /^[\x20-\x26\x28-\x5B\x5D-\x7E]*$/;

/**
 * A path is emitted as a string literal, and a path carrying a quote, a
 * backslash or a line terminator would close it early — or end the line — and
 * leave a `DO NOT EDIT` file whose syntax error points at nothing.
 *
 * `JSON.stringify` handles all of those, so anything outside the plain ASCII a
 * single-quoted literal can hold is handed to it. U+2028 and U+2029 are the
 * exception it does not cover: they are legal in a JSON string and were a line
 * terminator in string literals before ES2019, so they are escaped by hand.
 */
function toStringLiteral(value: string): string
{
    if (SINGLE_QUOTABLE.test(value))
    {
        return `'${value}'`;
    }

    return JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/** One mount, as the generated header lists it. */
function describeMount(mount: PackageMount): string
{
    if (mount.count === 0)
    {
        return `${mount.label} — no routes${mount.skipped ? ` (${mount.skipped})` : ''}`;
    }

    const routes = `${mount.count} route${mount.count === 1 ? '' : 's'}`;

    return `${mount.label} — ${routes} under ${[...mount.prefixes].join(', ')}`;
}

/**
 * The header lines that say which of the entries below are not the app's.
 *
 * A package route in this file is a copy, and a copy is as old as the file: the
 * app used to import the package's own map, which an upgrade changed by itself.
 * So the header says what the copy is and names every mount it came through —
 * the diff after an upgrade then reads as an upgrade rather than as somebody
 * editing a generated file.
 *
 * Nothing is added when no package contributed, so an app that mounts nothing
 * (or mounts only routers that publish no map) regenerates byte-identically to
 * what it has committed.
 */
function packageHeaderLines(collection: Collection): string[]
{
    if (collection.packages.size === 0)
    {
        return [];
    }

    return [
        ' *',
        ' * The entries under the .packages() line below are not this app\'s. They belong',
        ' * to the package routers it mounts, copied in as they were when this file was',
        ' * generated:',
        ...collection.mounts.map(mount => ` *   ${describeMount(mount)}`),
        ' *',
        ' * A package upgrade reaches them only through a regeneration: `spfn build`',
        ' * regenerates before it compiles, a bare `next build` uses what is committed here.',
    ];
}

/**
 * Generate route map file content
 *
 * The environment is written into the header because it decides what the map
 * holds and nothing else records it. A route registered behind a condition the
 * guard cannot see — one hoisted to a variable, one inside an imported route
 * module — is named here only when the generator ran under the environment that
 * registers it, and `spfn build` pins `production` where `spfn dev` leaves
 * `development`. Writing the value makes that difference a line in the diff
 * instead of a route that typechecks in the editor and vanishes at build.
 */
function generateRouteMapContent(collection: Collection, nodeEnv: string): string
{
    const lines: string[] = [
        '/**',
        ' * Route Map (Auto-generated)',
        ' *',
        ' * DO NOT EDIT - This file is generated by @spfn/core:route-map generator',
        ' *',
        ` * Generated with NODE_ENV=${nodeEnv}. A route registered only under one environment is`,
        ' * named here only when the generator ran under it, so this line changing is that',
        ' * difference rather than an edit.',
        ...packageHeaderLines(collection),
        ' */',
        '',
        'import type { HttpMethod } from \'@spfn/core/route\';',
        '',
        'export interface RouteInfo',
        '{',
        '    method: HttpMethod;',
        '    path: string;',
        '}',
        '',
        'export const routeMap: Record<string, RouteInfo> = {',
    ];

    for (const [name, route] of collection.app)
    {
        lines.push(entryLine(name, route));
    }

    if (collection.packages.size > 0)
    {
        lines.push('    // From the package routers this app mounts with .packages(), not its own:');

        for (const [name, route] of collection.packages)
        {
            lines.push(entryLine(name, route));
        }
    }

    lines.push('};');
    lines.push('');
    lines.push('export type RouteMap = typeof routeMap;');
    lines.push('');
    lines.push('export type RouteName = keyof RouteMap;');
    lines.push('');

    return lines.join('\n');
}

/** One `name: { method, path },` line of the map. */
function entryLine(name: string, route: CollectedRoute): string
{
    return `    ${toObjectKey(name)}: { method: '${route.method}', path: ${toStringLiteral(route.path)} },`;
}

/**
 * Create Route Map Generator
 */
export function createRouteMapGenerator(config: RouteMapGeneratorConfig): Generator
{
    const {
        routerPath,
        outputPath = './src/generated/route-map.ts',
        additionalRouteDirs = [],
    } = config;

    if (!routerPath)
    {
        throw new Error(
            '[@spfn/core:route-map] Missing required "routerPath" option.\n\n' +
            'Usage:\n' +
            '  defineGenerator<RouteMapGeneratorConfig>({\n' +
            '    name: \'@spfn/core:route-map\',\n' +
            '    routerPath: \'./src/server/router.ts\',\n' +
            '  })',
        );
    }

    return {
        name: '@spfn/core:route-map',

        // Unchanged, including the deprecated dirs: what the map is *built* from
        // moved to the loaded router, but what a rebuild should be *triggered* by
        // is still every file a route can live in.
        watchPatterns: [
            routerPath,
            'src/server/routes/**/*.ts',
            ...additionalRouteDirs.map(dir => `${dir}/**/*.ts`),
        ],

        runOn: ['watch', 'manual', 'build'],

        async generate(options: GeneratorOptions): Promise<void>
        {
            const { cwd, debug } = options;

            const absoluteRouterPath = join(cwd, routerPath);
            const absoluteOutputPath = join(cwd, outputPath);

            if (!existsSync(absoluteRouterPath))
            {
                genLogger.warn(`Router file not found: ${absoluteRouterPath}`);

                return;
            }

            if (debug)
            {
                genLogger.info('Loading router', { path: absoluteRouterPath });
            }

            pinNodeEnv();

            // Loaded before the guard reads the source, because which router the
            // guard reads is decided by which export the loader found.
            const { router, exportName } = loadRouter(cwd, absoluteRouterPath);

            assertUnconditionalRegistration({
                routerPath,
                source: readFileSync(absoluteRouterPath, 'utf-8'),
                exportName,
                subject: 'route map',
            });

            const collection = collectRouteMap(router);
            const total = collection.app.size + collection.packages.size;

            if (debug)
            {
                genLogger.info(`Found ${total} routes`, {
                    app: [...collection.app.keys()],
                    packages: [...collection.packages.keys()],
                });
            }

            const outputDir = dirname(absoluteOutputPath);
            if (!existsSync(outputDir))
            {
                mkdirSync(outputDir, { recursive: true });
            }

            // Read after `pinNodeEnv`, which is what makes it a value at all when
            // the shell left it unset.
            const nodeEnv = process.env.NODE_ENV ?? 'unset';

            writeFileSync(absoluteOutputPath, generateRouteMapContent(collection, nodeEnv), 'utf-8');

            genLogger.info(
                `Generated route map: ${relative(cwd, absoluteOutputPath)} `
                + `(${collection.app.size} app routes, ${collection.packages.size} from mounted packages)`,
            );
        },
    };
}

// ============================================================================
// Export for package-based loading
// ============================================================================

export default createRouteMapGenerator;
