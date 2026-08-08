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
 * Create a Router instance with chainable methods
 */
function createRouterInstance<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>(
    routes: TRoutes,
    packageRouters: Router<any>[] = [],
    globalMiddlewares: NamedMiddleware<string>[] = [],
    contractVersion: string | null = null,
): Router<TRoutes>
{
    return {
        routes,
        _routes: routes,
        _packageRouters: packageRouters,
        _globalMiddlewares: globalMiddlewares,
        _contractVersion: contractVersion,

        packages(routers: Router<any>[]): Router<TRoutes>
        {
            const newPackageRouters = [...this._packageRouters, ...routers];

            // Also include nested package routers if any
            for (const pkgRouter of routers)
            {
                if (pkgRouter._packageRouters?.length > 0)
                {
                    newPackageRouters.push(...pkgRouter._packageRouters);
                }
            }

            return createRouterInstance(
                this.routes,
                newPackageRouters,
                this._globalMiddlewares,
                this._contractVersion,
            );
        },

        use(middlewares: NamedMiddleware<string>[]): Router<TRoutes>
        {
            return createRouterInstance(
                this.routes,
                this._packageRouters,
                [...this._globalMiddlewares, ...middlewares],
                this._contractVersion,
            );
        },

        contractVersion(version: string): Router<TRoutes>
        {
            assertContractVersion(version);

            return createRouterInstance(
                this.routes,
                this._packageRouters,
                this._globalMiddlewares,
                version,
            );
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
    return createRouterInstance(routes);
}
