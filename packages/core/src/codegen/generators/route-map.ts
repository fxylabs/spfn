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
import { loadRouterModule, pinNodeEnv } from './router-module';

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
}

// ============================================================================
// Loading
// ============================================================================

function isRouter(value: unknown): value is Router<any>
{
    return value !== null
        && typeof value === 'object'
        && 'routes' in value
        && '_routes' in value;
}

function isRouteDef(value: unknown): value is RouteDef<any>
{
    return value !== null
        && typeof value === 'object'
        && 'handler' in value;
}

function loadRouter(cwd: string, absoluteRouterPath: string): Router<any>
{
    const module = loadRouterModule({
        cwd,
        absoluteRouterPath,
        subject: 'route map',
        fail: message => new RouteMapGeneratorError(message),
    });

    const candidates = ['appRouter', 'default', 'router'];

    for (const name of candidates)
    {
        const candidate = module[name];

        if (isRouter(candidate))
        {
            return candidate;
        }
    }

    throw new RouteMapGeneratorError(
        `No router found in ${relative(cwd, absoluteRouterPath)}. `
        + `Looked for: ${candidates.join(', ')}. `
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

function addRoute(name: string, routeDef: RouteDef<any>, trail: string[], found: Map<string, CollectedRoute>): void
{
    const where = trail.join('.');

    if (!routeDef.method || !routeDef.path)
    {
        throw new RouteMapGeneratorError(
            `Route "${where}" has no method or path. `
            + 'The RPC client resolves a name to a method and a path, so both are required. '
            + 'A route reaches this state by being registered before .handler() was called — '
            + 'the server drops it too, which is why the map refuses to name it.',
        );
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

    const existing = found.get(name);
    if (existing)
    {
        throw new RouteMapGeneratorError(
            `Two routes are both named "${name}" (${existing.trail} and ${where}). `
            + 'The RPC client addresses a route by its name alone, and a nested route registers under its own '
            + 'key, so a name must be unique across the whole router.',
        );
    }

    found.set(name, { method: routeDef.method, path: routeDef.path, trail: where });
}

/**
 * Every name a package router registers, at any depth below it.
 *
 * Nothing here is emitted — a package publishes its own route map — but the
 * names are needed, because they are the ones that can quietly take an app
 * route's place. Collection is deliberately lenient: an entry a package
 * registers is not the app developer's to fix, and refusing their build over it
 * would help nobody. `registerRoutes` skips such an entry too.
 */
function collectPackageNames(router: Router<any>, trail: string[], names: Map<string, string>): void
{
    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            collectPackageNames(entry, [...trail, name], names);
        }
        else if (isRouteDef(entry) && !names.has(name))
        {
            names.set(name, [...trail, name].join('.'));
        }
    }

    for (const [index, packageRouter] of (router._packageRouters ?? []).entries())
    {
        collectPackageNames(packageRouter, [...trail, `packages[${index}]`], names);
    }
}

/**
 * Walk the router the way `registerRoutes` walks it.
 *
 * A nested route registers under its own key — the parent's key names the
 * grouping, not the route — so the map is flat and the trail exists only to
 * point at both sides of a collision.
 *
 * `_packageRouters` is walked for their names alone, never for their routes: a
 * package publishes its own route map and the app merges the two
 * (`{ ...routeMap, ...authRouteMap }` in a generated `rpc.ts`). Emitting them
 * here would duplicate every package route.
 *
 * Only string keys are collected, because `Object.entries` is what the runtime
 * iterates: a symbol-keyed entry is invisible to `registerRoutes` and so has no
 * route to name in the map either.
 */
function collectRoutes(
    router: Router<any>,
    trail: string[],
    found: Map<string, CollectedRoute>,
    packageNames: Map<string, string>,
): void
{
    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            collectRoutes(entry, [...trail, name], found, packageNames);
            continue;
        }

        if (!isRouteDef(entry))
        {
            throw new RouteMapGeneratorError(
                `Router entry "${[...trail, name].join('.')}" is neither a route nor a router (got ${typeof entry}). `
                + 'The server skips it, and a map that skipped it too would leave a name the client can call '
                + 'and the server never answers.',
            );
        }

        addRoute(name, entry, [...trail, name], found);
    }

    for (const [index, packageRouter] of (router._packageRouters ?? []).entries())
    {
        collectPackageNames(packageRouter, [...trail, `packages[${index}]`], packageNames);
    }
}

/**
 * Refuse an app route whose name a package router also registers.
 *
 * Both are registered at runtime, at their own paths, and the app's proxy merges
 * the two maps as `{ ...routeMap, ...authRouteMap }` — so the *package* entry
 * wins the name. The typed client would say `api.logout` is the app's own route
 * while every call went to the package's path.
 *
 * A package route colliding with another package's route is not refused: which
 * of them wins is decided by the order the app spreads their maps, which this
 * generator neither sees nor writes.
 */
function assertNoPackageCollision(found: Map<string, CollectedRoute>, packageNames: Map<string, string>): void
{
    for (const [name, where] of packageNames)
    {
        const route = found.get(name);

        if (!route)
        {
            continue;
        }

        throw new RouteMapGeneratorError(
            `The app route "${name}" (${route.trail}) is also registered by a package router (${where}). `
            + 'The app merges the two maps as { ...routeMap, ...packageRouteMap }, so the package entry wins the '
            + 'name at runtime while the generated types still describe the app\'s route — every call would go to '
            + 'the package\'s path. Rename the app route.',
        );
    }
}

/** The map the file is written from: app routes only, and no name a package took. */
function collectRouteMap(router: Router<any>): Map<string, CollectedRoute>
{
    const found = new Map<string, CollectedRoute>();
    const packageNames = new Map<string, string>();

    collectRoutes(router, ['router'], found, packageNames);
    assertNoPackageCollision(found, packageNames);

    return found;
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

/**
 * Generate route map file content
 */
function generateRouteMapContent(routes: Map<string, CollectedRoute>): string
{
    const lines: string[] = [
        '/**',
        ' * Route Map (Auto-generated)',
        ' *',
        ' * DO NOT EDIT - This file is generated by @spfn/core:route-map generator',
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

    for (const [name, route] of routes)
    {
        lines.push(`    ${toObjectKey(name)}: { method: '${route.method}', path: ${toStringLiteral(route.path)} },`);
    }

    lines.push('};');
    lines.push('');
    lines.push('export type RouteMap = typeof routeMap;');
    lines.push('');
    lines.push('export type RouteName = keyof RouteMap;');
    lines.push('');

    return lines.join('\n');
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
            assertUnconditionalRegistration(routerPath, readFileSync(absoluteRouterPath, 'utf-8'));

            const routes = collectRouteMap(loadRouter(cwd, absoluteRouterPath));

            if (debug)
            {
                genLogger.info(`Found ${routes.size} routes`, { names: [...routes.keys()] });
            }

            const outputDir = dirname(absoluteOutputPath);
            if (!existsSync(outputDir))
            {
                mkdirSync(outputDir, { recursive: true });
            }

            writeFileSync(absoluteOutputPath, generateRouteMapContent(routes), 'utf-8');

            genLogger.info(`Generated route map: ${relative(cwd, absoluteOutputPath)} (${routes.size} routes)`);
        },
    };
}

// ============================================================================
// Export for package-based loading
// ============================================================================

export default createRouteMapGenerator;
