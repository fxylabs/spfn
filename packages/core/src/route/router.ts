/**
 * Router Definition
 *
 * Provides router composition and middleware management
 */

import type { NamedMiddleware } from './define-middleware';
import type { RouteDef } from './route-builder';

/**
 * Router definition - holds all routes
 */
export interface Router<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>> {
    routes: TRoutes;
    _routes: TRoutes;
    _packageRouters: Router<any>[];
    _globalMiddlewares: NamedMiddleware<string>[];

    /** The contract version these routes publish, or null when uncontracted. */
    _contractVersion: string | null;

    /**
     * Whether a client ever addresses these routes by name.
     *
     * True for an ordinary router. A mounted package router that is true here
     * has its routes written into the app's generated route map, which is what
     * lets the package's own client (`authApi.login`) resolve a name through the
     * app's RPC proxy. It is also what makes an app route sharing a name with a
     * package route a defect worth refusing a build over: the map holds one
     * entry per name, so one of the two paths would become unreachable while the
     * generated types still describe the app's route.
     *
     * False says no client names these routes: they are reached by URL, by
     * something that was handed the URL, so nothing of them belongs in the map
     * and a name they share with an app route is only a shared name.
     * `createOpsRouter` sets it — `spfn ops` invokes an ops command over the URL
     * the manifest gave it.
     */
    _publishesRouteMap: boolean;

    /**
     * Register package routers (type-hidden)
     *
     * Package routes are:
     * - Recognized by RPC proxy and backend
     * - NOT exposed in client types (use package's own API like authApi, cmsApi)
     *
     * @example
     * ```ts
     * import { authRouter } from '@spfn/auth/server';
     * import { cmsAppRouter } from '@spfn/cms/server';
     *
     * export const appRouter = defineRouter({
     *     getRoot,
     *     getStatus,
     * })
     * .packages([authRouter, cmsAppRouter]);
     *
     * // Client usage:
     * // api.getRoot.call({})     - app routes
     * // authApi.login.call({})   - package API
     * ```
     */
    packages(routers: Router<any>[]): Router<TRoutes>;

    /**
     * Register global middlewares
     *
     * Applied to all routes unless explicitly skipped via .skip()
     *
     * @example
     * ```ts
     * import { authMiddleware, loggingMiddleware } from './middlewares';
     *
     * export const appRouter = defineRouter({
     *     getRoot,
     *     getStatus,
     * })
     * .packages([authRouter])
     * .use([authMiddleware, loggingMiddleware]);
     * ```
     */
    use(middlewares: NamedMiddleware<string>[]): Router<TRoutes>;

    /**
     * Declare the contract version these routes publish.
     *
     * A client compiled against this server — a mobile app in a store — is
     * generated from one version of the contract and cannot be updated when the
     * server changes. The server announces this version on every response so
     * that client can tell whether the two ends still agree.
     *
     * This is the version's source. A released snapshot is written to
     * `contracts/released/<version>.json` from what is declared here, so the
     * filename follows the code rather than the code having to be told what the
     * filename said.
     *
     * Only a server with contracted routes needs it. Without it the contract
     * generator still writes `current.json` and still runs the compatibility
     * gate; what it cannot do is cut a release or announce a version.
     *
     * @example
     * ```ts
     * export const appRouter = defineRouter({ getRoot, listItems })
     *     .contractVersion('1.2.0')
     *     .packages([authRouter]);
     * ```
     */
    contractVersion(version: string): Router<TRoutes>;
}

/**
 * Everything a router carries, so that a chainable method rebuilding the router
 * states what it changes and cannot silently drop what it does not.
 */
interface RouterState<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>
{
    routes: TRoutes;
    packageRouters: Router<any>[];
    globalMiddlewares: NamedMiddleware<string>[];
    contractVersion: string | null;
    publishesRouteMap: boolean;
}

/**
 * Create a Router instance with chainable methods
 */
function createRouterInstance<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>(
    state: RouterState<TRoutes>,
): Router<TRoutes>
{
    return {
        routes: state.routes,
        _routes: state.routes,
        _packageRouters: state.packageRouters,
        _globalMiddlewares: state.globalMiddlewares,
        _contractVersion: state.contractVersion,
        _publishesRouteMap: state.publishesRouteMap,

        packages(routers: Router<any>[]): Router<TRoutes>
        {
            const newPackageRouters = [...state.packageRouters, ...routers];

            // Also include nested package routers if any
            for (const pkgRouter of routers)
            {
                if (pkgRouter._packageRouters?.length > 0)
                {
                    newPackageRouters.push(...pkgRouter._packageRouters);
                }
            }

            return createRouterInstance({ ...state, packageRouters: newPackageRouters });
        },

        use(middlewares: NamedMiddleware<string>[]): Router<TRoutes>
        {
            return createRouterInstance({
                ...state,
                globalMiddlewares: [...state.globalMiddlewares, ...middlewares],
            });
        },

        contractVersion(version: string): Router<TRoutes>
        {
            assertContractVersion(version);

            return createRouterInstance({ ...state, contractVersion: version });
        },
    };
}

/**
 * A version that cannot be ordered cannot gate a release.
 *
 * Checked when it is declared rather than when a snapshot is cut: the failure
 * belongs next to the typo, not in a build step that runs much later.
 */
function assertContractVersion(version: string): void
{
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version))
    {
        throw new Error(
            `contractVersion("${version}") is not a version of the form major.minor.patch. `
            + 'The released snapshot is named from this value and releases are compared by it.',
        );
    }
}

/**
 * Define a router with multiple routes (tRPC-style)
 *
 * Supports chainable API for packages and middlewares:
 *
 * @example
 * ```ts
 * // Basic usage
 * export const appRouter = defineRouter({
 *     getRoot,
 *     getStatus,
 *     listExamples,
 * });
 *
 * // With package routers (type-hidden)
 * export const appRouter = defineRouter({
 *     getRoot,
 *     getStatus,
 * })
 * .packages([authRouter, cmsAppRouter]);
 *
 * // With global middlewares
 * export const appRouter = defineRouter({
 *     getRoot,
 *     getStatus,
 * })
 * .packages([authRouter])
 * .use([authMiddleware, loggingMiddleware]);
 *
 * export type AppRouter = typeof appRouter;
 * ```
 *
 * Package routes:
 * - Recognized by RPC proxy and backend for routing
 * - NOT included in AppRouter type (use authApi, cmsApi instead)
 * - Prevents confusion between app API and package APIs
 */
export function defineRouter<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>(
    routes: TRoutes,
): Router<TRoutes>
{
    return createRouterInstance({
        routes,
        packageRouters: [],
        globalMiddlewares: [],
        contractVersion: null,
        publishesRouteMap: true,
    });
}

/**
 * A router no client addresses by name.
 *
 * The app's generated route map carries the routes of every package router the
 * app mounts with `.packages()`, so that a package client calling its own route
 * by name resolves through the app's RPC proxy. A router built here is left out
 * of that map: its routes are reached by URL, by a tool that was told the URL,
 * so no name of theirs has to resolve anywhere and a name shared with an app
 * route is only a shared name.
 *
 * Declared by the package that ships the router, because only it knows whether
 * any client names these routes: `createOpsRouter` and the tracking routes of
 * `@spfn/notification` do it, and any package whose surface is reached by URL
 * may. The obligation is the whole of it — a package whose client *does* name
 * its routes must use `defineRouter`, or those names land in nobody's map and
 * resolve nowhere (and a collision that really would take an app route's entry
 * generates silently). `defineRouter` is the default for exactly that reason: a
 * package that says nothing is carried and checked.
 */
export function defineUnmappedRouter<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>(
    routes: TRoutes,
): Router<TRoutes>
{
    return createRouterInstance({
        routes,
        packageRouters: [],
        globalMiddlewares: [],
        contractVersion: null,
        publishesRouteMap: false,
    });
}
