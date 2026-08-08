/**
 * Ops Router
 *
 * The structure half of SPFN's CLI-first operations surface. An app develops
 * its own ops as ordinary routes — domain operations only that app can name —
 * and this factory turns them into a mountable package router that:
 *
 * - enforces the `/_ops/` path prefix, so the surface is recognizable and an
 *   ops route can never shadow an app route;
 * - injects the given auth middleware into every route, the manifest
 *   included, so an unauthenticated ops surface cannot be created by
 *   accident — there is no opt-out;
 * - serves `GET /_ops/_manifest`, the self-description the `spfn ops` CLI
 *   discovers commands from.
 *
 * The auth middleware itself lives with the app's auth stack (`@spfn/auth`
 * ships `opsTokenAuth`); core owns only the structure, so the ops surface has
 * no opinion about how a token is stored or verified.
 *
 * @example
 * ```ts
 * import { createOpsRouter } from '@spfn/core/ops';
 * import { opsTokenAuth, requireOpsScope } from '@spfn/auth/server';
 *
 * export const opsRouter = createOpsRouter({
 *     listSignups: route.get('/_ops/signups')
 *         .use([requireOpsScope('waitlist:read')])
 *         .handler(async () => signupsRepository.list()),
 * }, { auth: opsTokenAuth });
 *
 * // mounted like any package router:
 * export const appRouter = defineRouter({ ... }).packages([opsRouter]);
 * ```
 */

import type { NamedMiddleware } from '../route/define-middleware';
import { route, type RouteDef } from '../route/route-builder';
import { defineRouter, type Router } from '../route/router';
import { collectOpsCommands, OpsRouterError, type OpsManifest } from './manifest';

/** Every ops route lives under this prefix. */
export const OPS_PATH_PREFIX = '/_ops/';

/** Where the manifest is served. Reserved — an app route cannot claim it. */
export const OPS_MANIFEST_PATH = '/_ops/_manifest';

/** Reserved route name for the injected manifest route. */
const OPS_MANIFEST_NAME = 'getOpsManifest';

export interface OpsRouterOptions
{
    /**
     * The middleware that authenticates every ops request. Required — an ops
     * surface without authentication is refused at definition time, not
     * discovered in production.
     */
    auth: NamedMiddleware<string>;
}

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

function assertOpsRoute(name: string, def: RouteDef<any>): void
{
    if (!def.method || !def.path)
    {
        throw new OpsRouterError(
            `Ops route "${name}" has no method or path. `
            + 'An ops command is invoked on the wire, so both are required.',
        );
    }

    if (!def.path.startsWith(OPS_PATH_PREFIX))
    {
        throw new OpsRouterError(
            `Ops route "${name}" is at "${def.path}", outside "${OPS_PATH_PREFIX}". `
            + 'Every ops route lives under the prefix so the surface stays recognizable '
            + 'and can never shadow an app route.',
        );
    }

    if (shadowsManifestPath(def.path))
    {
        throw new OpsRouterError(
            `Ops route "${name}" is at "${def.path}", which answers "${OPS_MANIFEST_PATH}" — `
            + 'reserved for the manifest. The manifest route is merged in last, so this route would '
            + 'answer it instead and the CLI would stop resolving every command for the whole app.',
        );
    }
}

/**
 * Would a request for the manifest path be answered by this route? A literal
 * clash is the obvious case, but `/_ops/:tenant` matches `/_ops/_manifest`
 * just as well, and Hono answers with the first route registered — the app's,
 * since the manifest is merged in last.
 */
function shadowsManifestPath(path: string): boolean
{
    const pattern = path
        .split('/')
        .map((segment) =>
        {
            if (segment.startsWith(':') || segment === '*')
            {
                return '[^/]+';
            }

            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');

    return new RegExp(`^${pattern}$`).test(OPS_MANIFEST_PATH);
}

/**
 * The reserved name is checked for every entry, route and nested router
 * alike: the manifest route is merged in last, so an entry under this name
 * would be overwritten rather than refused — its routes would still be
 * announced by the manifest and answer 404 when invoked.
 */
function assertOpsName(name: string): void
{
    if (name === OPS_MANIFEST_NAME)
    {
        throw new OpsRouterError(
            `Ops route name "${OPS_MANIFEST_NAME}" is reserved for the manifest route.`,
        );
    }
}

/**
 * Rebuild a nested router with the auth middleware injected into its routes,
 * carrying over what the original declared. A plain `defineRouter` of the
 * secured routes would silently drop the router's own `.use()` middlewares —
 * a `requireOpsScope` guard among them — leaving those routes reachable by
 * any valid ops token.
 *
 * Those middlewares are handed down to the routes rather than left on the
 * rebuilt router. Router-level middlewares are registered ahead of every
 * route-level one, so a guard left in place would run before the auth that
 * was injected per route — reading a request no one had authenticated yet.
 *
 * `.packages()` is refused rather than carried: package routes are registered
 * without passing through this factory, so they would join the ops surface
 * with neither the prefix check nor the auth injection.
 */
function rebuildNestedRouter(
    name: string,
    router: Router<any>,
    auth: NamedMiddleware<string>,
    inherited: ReadonlyArray<NamedMiddleware<string>>,
): Router<any>
{
    if (router._packageRouters?.length > 0)
    {
        throw new OpsRouterError(
            `Ops router "${name}" mounts package routers with .packages(). `
            + 'Their routes bypass the prefix check and the auth injection, so an ops surface cannot carry them.',
        );
    }

    const handedDown = [...inherited, ...(router._globalMiddlewares ?? [])];

    let rebuilt = defineRouter(
        secureRoutes(router.routes, auth, handedDown) as Record<string, RouteDef<any>>,
    );

    if (router._contractVersion)
    {
        rebuilt = rebuilt.contractVersion(router._contractVersion);
    }

    return rebuilt;
}

/**
 * Validate every route and hand back a copy carrying, in order, the auth
 * middleware, the middlewares its enclosing routers declared with `.use()`,
 * and its own. Route-level injection (rather than router-level `.use`) makes
 * the middleware's `skips` declaration effective, so `opsTokenAuth` can
 * auto-skip a server-level `auth` middleware exactly as `oneTimeTokenAuth`
 * does — and it is what puts auth ahead of every group guard.
 */
function secureRoutes(
    routes: Record<string, RouteDef<any> | Router<any>>,
    auth: NamedMiddleware<string>,
    inherited: ReadonlyArray<NamedMiddleware<string>> = [],
): Record<string, RouteDef<any> | Router<any>>
{
    const secured: Record<string, RouteDef<any> | Router<any>> = {};

    for (const [name, entry] of Object.entries(routes))
    {
        assertOpsName(name);

        if (isRouter(entry))
        {
            secured[name] = rebuildNestedRouter(name, entry, auth, inherited);
            continue;
        }

        if (!isRouteDef(entry))
        {
            throw new OpsRouterError(`Ops router entry "${name}" is neither a route nor a router.`);
        }

        assertOpsRoute(name, entry);
        secured[name] = {
            ...entry,
            middlewares: [auth, ...inherited, ...(entry.middlewares ?? [])],
        };
    }

    return secured;
}

/**
 * Build the app's ops surface from its ops routes.
 *
 * Returns an ordinary `Router` meant to be mounted with `.packages()`, so ops
 * routes stay out of the app's client types exactly like other package
 * routes.
 */
export function createOpsRouter<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>(
    routes: TRoutes,
    options: OpsRouterOptions,
): Router<any>
{
    if (!options?.auth)
    {
        throw new OpsRouterError(
            'createOpsRouter requires an auth middleware ({ auth: ... }). '
            + 'An ops surface reachable without authentication cannot be created.',
        );
    }

    const manifest: OpsManifest = {
        manifestVersion: 1,
        commands: collectOpsCommands(routes),
    };

    const secured = secureRoutes(routes, options.auth);

    const manifestRoute = route.get(OPS_MANIFEST_PATH)
        .use([options.auth])
        .handler(async () => manifest);

    return defineRouter({
        ...secured,
        [OPS_MANIFEST_NAME]: manifestRoute,
    } as Record<string, RouteDef<any>>);
}
