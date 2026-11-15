/**
 * SPFN Next.js Proxy Interceptor Execution Engine
 */

import { getPath } from 'hono/utils/url';

import type {
    InterceptorRule,
    RequestInterceptor,
    ResponseInterceptor,
    RequestInterceptorContext,
    ResponseInterceptorContext,
    RouteMapEntry,
} from './types';

/**
 * Check if path matches pattern
 *
 * Supports:
 * - Wildcards: '/_auth/*' matches '/_auth/login'
 * - Path params: '/users/:id' matches '/users/123'
 * - RegExp: /^\/_auth\/.+$/ matches '/_auth/login'
 * - Exact match: '/_auth/login' matches '/_auth/login'
 * - All: '*' matches any path
 *
 * @param path - Request path to test
 * @param pattern - Pattern to match against
 * @returns True if path matches pattern
 */
export function matchPath(path: string, pattern: string | RegExp): boolean
{
    // Match all
    if (pattern === '*')
    {
        return true;
    }

    // RegExp pattern
    if (pattern instanceof RegExp)
    {
        return pattern.test(path);
    }

    return pathPatternRegExp(pattern).test(path);
}

/**
 * A string path pattern as the RegExp `matchPath` tests it with.
 *
 * '/_auth/*' -> /^\/_auth\/.*$/, '/users/:id' -> /^\/users\/[^/]+$/
 */
function pathPatternRegExp(pattern: string): RegExp
{
    const regexPattern = pattern
        .replace(/\*/g, '.*')
        .replace(/:[^/]+/g, '[^/]+')
        .replace(/\//g, '\\/');

    return new RegExp(`^${regexPattern}$`);
}

/**
 * Check if method matches pattern
 *
 * @param method - Request method (e.g., 'POST')
 * @param pattern - Method pattern (e.g., 'POST' or ['POST', 'PUT'])
 * @returns True if method matches pattern
 */
export function matchMethod(
    method: string,
    pattern?: string | string[],
): boolean
{
    // No method filter = match all
    if (!pattern)
    {
        return true;
    }

    // Single method
    if (typeof pattern === 'string')
    {
        return method.toUpperCase() === pattern.toUpperCase();
    }

    // Multiple methods
    return pattern.some((m) => m.toUpperCase() === method.toUpperCase());
}

/**
 * Filter interceptors that match the request
 *
 * @param rules - All interceptor rules
 * @param path - Request path
 * @param method - Request method
 * @returns Matched interceptors
 */
export function filterMatchingInterceptors(
    rules: InterceptorRule[],
    path: string,
    method: string,
): InterceptorRule[]
{
    return rules.filter((rule) => 
    {
        return matchPath(path, rule.pathPattern) && matchMethod(method, rule.method);
    });
}

/**
 * The path the backend routes a proxied path as.
 *
 * The proxy hands `${apiUrl}${path}` to fetch, whose URL parser resolves dot
 * segments (`/a/../b`, `%2e%2e` included); the backend's router then decodes
 * percent-encoded characters other than `/` (`%61` is `a`). Two spellings that
 * reach the same handler come out the same here, which is what a lookup by
 * path has to compare — not the spelling the request arrived with.
 */
function routedPath(path: string): string
{
    return getPath(new Request(new URL(path, 'http://backend.invalid')));
}

/** A route map entry with its path template compiled once. */
interface CompiledRouteEntry
{
    entry: RouteMapEntry;
    path: RegExp;
}

/** Compiled entries per route map object; a map is compiled on its first lookup. */
const compiledRouteMaps = new WeakMap<Record<string, RouteMapEntry>, CompiledRouteEntry[]>();

/**
 * The entries of `routeMap` with their templates compiled. A route map is a
 * generated constant, so it is compiled once rather than per request.
 */
function compiledEntriesOf(routeMap: Record<string, RouteMapEntry>): CompiledRouteEntry[]
{
    let compiled = compiledRouteMaps.get(routeMap);

    if (!compiled)
    {
        compiled = Object.values(routeMap).map(entry => ({ entry, path: pathPatternRegExp(entry.path) }));
        compiledRouteMaps.set(routeMap, compiled);
    }

    return compiled;
}

/**
 * The entry of a route map a proxied request reaches, by method and path.
 *
 * The other way to the declaration of a route than `ctx.route`, for a caller
 * that must not take it from the map the application generated — a package
 * reading its own routes from the map it ships, say, so that what its routes
 * declare does not depend on the application having regenerated its copy.
 * Matched as interceptors are (`matchMethod`, and the entry's template as
 * `matchPath` reads it), on the path the backend will route rather than the
 * one presented. Templates are compiled once per map object, not per request:
 * the map is read on every mutating request, so a map is assumed not to change
 * after its first lookup — true of a generated map.
 *
 * @param routeMap - The map to look in
 * @param method - The route's method, as `ctx.method` carries it
 * @param path - The request path, as `ctx.path` carries it
 * @returns the entry, or undefined when no route in the map is reached
 */
export function findRouteEntry(
    routeMap: Record<string, RouteMapEntry>,
    method: string,
    path: string,
): RouteMapEntry | undefined
{
    const routed = routedPath(path);

    return compiledEntriesOf(routeMap)
        .find(compiled => matchMethod(method, compiled.entry.method) && compiled.path.test(routed))
        ?.entry;
}

/**
 * Execute request interceptors in chain
 *
 * Interceptors are executed in order:
 * 1. First registered interceptor
 * 2. Second registered interceptor
 * 3. ... and so on
 *
 * Each interceptor must call next() to continue the chain.
 * If next() is not called, the chain stops and remaining interceptors are skipped.
 *
 * @param context - Request interceptor context
 * @param interceptors - Interceptors to execute
 */
export async function executeRequestInterceptors(
    context: RequestInterceptorContext,
    interceptors: RequestInterceptor[],
): Promise<void>
{
    let index = 0;

    const next = async (): Promise<void> => 
    {
        if (index >= interceptors.length)
        {
            return;
        }

        const interceptor = interceptors[index];
        index++;

        await interceptor(context, next);
    };

    await next();
}

/**
 * Execute response interceptors in chain
 *
 * Interceptors are executed in order:
 * 1. First registered interceptor
 * 2. Second registered interceptor
 * 3. ... and so on
 *
 * Each interceptor must call next() to continue the chain.
 * If next() is not called, the chain stops and remaining interceptors are skipped.
 *
 * @param context - Response interceptor context
 * @param interceptors - Interceptors to execute
 */
export async function executeResponseInterceptors(
    context: ResponseInterceptorContext,
    interceptors: ResponseInterceptor[],
): Promise<void>
{
    let index = 0;

    const next = async (): Promise<void> => 
    {
        if (index >= interceptors.length)
        {
            return;
        }

        const interceptor = interceptors[index];
        index++;

        await interceptor(context, next);
    };

    await next();
}
