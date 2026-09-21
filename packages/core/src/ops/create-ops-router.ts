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
import { route, type RouteDef } from '../route/route-builder';
import { defineUnmappedRouter, type Router } from '../route/router';
import {
    collectOpsCommands,
    OpsRouterError,
    type OpsCommand,
    type OpsManifest,
    type OpsModuleDescriptor,
} from './manifest';
import { defineOpsModule, type OpsModule } from './module';
import { opsRoutePatternsOverlap } from './route-overlap';

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

    /**
     * Build the server-side scope guard for a module command. Required when
     * modules are mounted. `@spfn/auth`'s `requireOpsScope` is the standard
     * implementation, but core remains independent of that package.
     */
    authorize?: (...scopes: string[]) => MiddlewareHandler | NamedMiddleware<string>;

    /** Capability ops modules this application explicitly chooses to expose. */
    modules?: readonly OpsModule[];
}

interface CompiledModuleRoute
{
    route: RouteDef<any>;
    scopes: readonly string[];
}

interface CompiledModuleSurface
{
    descriptors: OpsModuleDescriptor[];
    commands: OpsCommand[];
    routes: Record<string, CompiledModuleRoute>;
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
            + 'Build ops routes with `opsRoute` rather than `route` — it applies the namespace, '
            + 'so the path a definition carries is only the part the app owns.',
        );
    }

    if (def.path === OPS_MANIFEST_PATH)
    {
        throw new OpsRouterError(
            `Ops route "${name}" claims "${OPS_MANIFEST_PATH}", which is reserved for the manifest. `
            + 'The manifest is registered first, so this route would never answer.',
        );
    }
}

/**
 * The reserved name is checked for every entry, route and nested router
 * alike, because the merge cannot refuse a duplicate key on its own. The
 * manifest is merged in first and the app's entries spread over it, so an
 * entry under this name would replace the manifest — the ops surface would
 * then announce nothing and the CLI would discover no commands at all.
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
 * It is rebuilt unmapped, like the surface that holds it: a nested ops router
 * publishes no route map either.
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

    let rebuilt = defineUnmappedRouter(
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

function compileModules(
    modules: readonly OpsModule[],
    appCommands: readonly OpsCommand[],
): CompiledModuleSurface
{
    const descriptors: OpsModuleDescriptor[] = [];
    const commands: OpsCommand[] = [];
    const routes: Record<string, CompiledModuleRoute> = {};
    const moduleIds = new Set<string>();
    const commandNames = new Set(appCommands.map(command => command.name));
    const routeSignatures = new Map(
        appCommands.map(command => [`${command.method} ${command.path}`, command.name]),
    );

    for (const rawModule of modules)
    {
        const module = defineOpsModule(rawModule);

        if (moduleIds.has(module.id))
        {
            throw new OpsRouterError(`Two ops modules use id "${module.id}".`);
        }
        moduleIds.add(module.id);

        descriptors.push({
            id: module.id,
            source: module.source,
            contractVersion: module.contractVersion,
            summary: module.summary,
        });

        for (const [localName, definition] of Object.entries(module.commands))
        {
            const name = `${module.id}.${localName}`;
            if (commandNames.has(name))
            {
                throw new OpsRouterError(`Two ops commands are named "${name}".`);
            }
            commandNames.add(name);

            const method = definition.route.method!;
            const path = definition.route.path!;
            const signature = `${method} ${path}`;
            const existing = routeSignatures.get(signature);
            if (existing)
            {
                throw new OpsRouterError(
                    `Ops commands "${existing}" and "${name}" both use ${signature}.`,
                );
            }

            // Whether the two patterns can claim a common URL, not whether the
            // app route sits in the module's namespace. An app route at exactly
            // `/_ops/<moduleId>` shares the prefix but can never be reached by
            // a `/_ops/<moduleId>/<command>` request, and refusing it would
            // fail a legitimate app at boot.
            const overlappingAppCommand = appCommands.find(command =>
                command.method === method && opsRoutePatternsOverlap(command.path, path));
            if (overlappingAppCommand)
            {
                throw new OpsRouterError(
                    `App ops command "${overlappingAppCommand.name}" at ${method} ${overlappingAppCommand.path} `
                    + `overlaps module command "${name}" at ${method} ${path}. `
                    + 'Which one answers cannot depend on route registration order.',
                );
            }
            routeSignatures.set(signature, name);

            commands.push({
                name,
                module: module.id,
                summary: definition.summary,
                effect: definition.effect,
                scopes: [...definition.scopes],
                method,
                path,
                input: collectOpsCommands({ [localName]: definition.route })[0]!.input,
            });
            routes[name] = { route: definition.route, scopes: definition.scopes };
        }
    }

    descriptors.sort((a, b) => a.id.localeCompare(b.id));
    commands.sort((a, b) => a.name.localeCompare(b.name));

    return { descriptors, commands, routes };
}

function secureModuleRoutes(
    routes: Record<string, CompiledModuleRoute>,
    auth: NamedMiddleware<string>,
    authorize: NonNullable<OpsRouterOptions['authorize']>,
): Record<string, RouteDef<any>>
{
    const secured: Record<string, RouteDef<any>> = {};

    for (const [name, definition] of Object.entries(routes))
    {
        assertOpsName(name);
        assertOpsRoute(name, definition.route);
        secured[name] = {
            ...definition.route,
            middlewares: [
                auth,
                authorize(...definition.scopes),
                ...(definition.route.middlewares ?? []),
            ],
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

    const modules = options.modules ?? [];
    if (modules.length > 0 && !options.authorize)
    {
        throw new OpsRouterError(
            'createOpsRouter requires an authorize scope factory when modules are mounted.',
        );
    }

    const appCommands = collectOpsCommands(routes);
    const moduleSurface = compileModules(modules, appCommands);
    const commands = [...appCommands, ...moduleSurface.commands]
        .sort((a, b) => a.name.localeCompare(b.name));

    const manifest: OpsManifest = {
        manifestVersion: 1,
        ...(moduleSurface.descriptors.length > 0 ? { modules: moduleSurface.descriptors } : {}),
        commands,
    };

    const secured = secureRoutes(routes, options.auth);
    const securedModules = moduleSurface.descriptors.length > 0
        ? secureModuleRoutes(moduleSurface.routes, options.auth, options.authorize!)
        : {};

    const manifestRoute = route.get(OPS_MANIFEST_PATH)
        .use([options.auth])
        .handler(async () => manifest);

    // The manifest goes first, so no route in this object can answer its path.
    // A route pattern that happens to cover `/_ops/_manifest` — `/_ops/:name`,
    // say — is then only a route the app never reaches through that one URL,
    // not a surface-wide outage where the CLI cannot discover any command.
    //
    // The ordering reaches no further than this object. `registerRoutes`
    // registers a router's own routes before its package routers, so a pattern
    // the app declares in its own router still shadows the manifest — as it
    // shadows every other package route, which is a property of where the app
    // put that pattern rather than of this factory.
    // `defineUnmappedRouter`, not `defineRouter`: no ops route map is published
    // for an app to merge, and `spfn ops` invokes a command over the URL the
    // manifest gave it rather than by name through the RPC client. So an ops
    // command and an app route sharing a name overwrite nothing, and the
    // route-map generator must not refuse the build over it — naming an ops
    // command after the surface it inspects is the natural instinct.
    return defineUnmappedRouter({
        [OPS_MANIFEST_NAME]: manifestRoute,
        ...secured,
        ...securedModules,
    } as Record<string, RouteDef<any>>);
}
