/**
 * Ops Router
 *
 * The structure half of SPFN's CLI-first operations surface. An app develops
 * its own ops as ordinary routes — domain operations only that app can name —
 * and this factory turns them into a mountable package router that:
 *
 * - requires every route to come from `opsRoute`, which applies the `/_ops`
 *   namespace, so the surface is recognizable and an ops route can never
 *   shadow an app route;
 * - injects the given auth middleware into every route, the manifest
 *   included, so an unauthenticated ops surface cannot be created by
 *   accident — there is no opt-out;
 * - serves `GET /_ops/_manifest`, the self-description the `spfn ops` CLI
 *   discovers commands from, registered first so no app route takes its URL.
 *
 * What the path looks like after the namespace is the app's business, decided
 * when the ops route is written — this factory does not audit its shape.
 *
 * The auth middleware itself lives with the app's auth stack (`@spfn/auth`
 * ships `opsTokenAuth`); core owns only the structure, so the ops surface has
 * no opinion about how a token is stored or verified.
 *
 * It is the command surface (`@spfn/core/surface`) fixed to `/_ops`, with the
 * scope-factory `authorize` this factory has always taken adapted to the
 * surface's per-command one: applied to module commands only, so every
 * middleware chain is what it was before surfaces existed.
 *
 * @example
 * ```ts
 * import { createOpsRouter, opsRoute } from '@spfn/core/ops';
 * import { opsTokenAuth, requireOpsScope } from '@spfn/auth/server';
 *
 * export const opsRouter = createOpsRouter({
 *     listSignups: opsRoute.get('/signups')            // GET /_ops/signups
 *         .use([requireOpsScope('waitlist:read')])
 *         .handler(async () => signupsRepository.list()),
 * }, { auth: opsTokenAuth });
 *
 * // mounted like any package router:
 * export const appRouter = defineRouter({ ... }).packages([opsRouter]);
 * ```
 */

import type { MiddlewareHandler } from 'hono';
import type { NamedMiddleware } from '../route/define-middleware';
import type { RouteDef } from '../route/route-builder';
import type { Router } from '../route/router';
import { createSurface, type SurfaceAuthorize } from '../surface/define-surface';
import { OpsRouterError } from './error';
import type { OpsModule } from './module';
import { OPS_PATH_ROOT } from './ops-route';
import { OPS_WORDING } from './wording';

/** Every ops route lives under this prefix. */
export const OPS_PATH_PREFIX = '/_ops/';

/** Where the manifest is served. Reserved — an app route cannot claim it. */
export const OPS_MANIFEST_PATH = '/_ops/_manifest';

export interface OpsRouterOptions
{
    /**
     * The middleware that authenticates every ops request. Required — an ops
     * surface without authentication is refused at definition time, not
     * discovered in production.
     */
    auth: NamedMiddleware<string>;

    /**
     * Build the server-side scope guard for a module command. Required when
     * modules are mounted. `@spfn/auth`'s `requireOpsScope` is the standard
     * implementation, but core remains independent of that package.
     */
    authorize?: (...scopes: string[]) => MiddlewareHandler | NamedMiddleware<string>;

    /** Capability ops modules this application explicitly chooses to expose. */
    modules?: readonly OpsModule[];
}

/**
 * The scope factory as a per-command guard: a module command gets
 * `authorize(...its scopes)`, an app command nothing — app commands declare
 * their own guards with `.use()`, as they always have.
 */
function moduleScopeGuard(authorize: OpsRouterOptions['authorize']): SurfaceAuthorize | undefined
{
    if (!authorize)
    {
        return undefined;
    }

    return command => (command.module === undefined ? undefined : authorize(...(command.scopes ?? [])));
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
    if ((options?.modules ?? []).length > 0 && !options.authorize)
    {
        throw new OpsRouterError(
            'createOpsRouter requires an authorize scope factory when modules are mounted.',
        );
    }

    return createSurface({
        namespace: OPS_PATH_ROOT,
        auth: options?.auth,
        authorize: moduleScopeGuard(options?.authorize),
        modules: options?.modules,
    }, OPS_WORDING).router(routes);
}
