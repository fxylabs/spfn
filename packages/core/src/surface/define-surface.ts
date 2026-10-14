/**
 * Command Surface
 *
 * A namespace of commands an app exposes to a caller that is not its own
 * frontend — operators on `/_ops`, an issuer's signed tokens on `/_app`, any
 * other machine caller on a namespace the app picks. An app develops the
 * commands as ordinary routes; `defineSurface` turns them into a mountable
 * package router that:
 *
 * - requires every route to carry the surface's namespace, applied by the
 *   surface's own `route`, so a command is recognizable by its path and can
 *   never shadow an app route;
 * - injects the given auth middleware into every command, so a command
 *   reachable without authentication cannot be created by accident — there is
 *   no opt-out;
 * - serves `GET <namespace>/_manifest`, the self-description a client
 *   discovers commands from, registered first so no command takes its URL.
 *   The manifest is the one route that may be public, and only when the
 *   surface says so: its commands stay behind auth regardless.
 *
 * What the path looks like after the namespace is the app's business, decided
 * when the route is written — this factory does not audit its shape.
 *
 * The auth middleware lives with the app's auth stack (`@spfn/auth` ships
 * `opsTokenAuth` and `signedTokenAuth`); core owns only the structure, so a
 * surface has no opinion about how a credential is stored or verified.
 * `@spfn/core/ops` is this factory fixed to `/_ops`.
 *
 * @example
 * ```ts
 * import { defineSurface } from '@spfn/core/surface';
 * import { signedTokenAuth } from '@spfn/auth/server';
 *
 * export const app = defineSurface({
 *     namespace: '/_app',
 *     auth: signedTokenAuth({ keysUrl, iss, aud }),
 *     manifest: 'public',
 * });
 *
 * export const pageAdd = app.route.post('/pages')     // POST /_app/pages
 *     .input({ body: PageAddBody })
 *     .handler(async (c) => pagesRepository.add((await c.data()).body));
 *
 * // mounted like any package router, beside `/_ops`:
 * export const appRouter = defineRouter({ ... }).packages([app.router({ pageAdd }), opsRouter]);
 * ```
 */

import type { MiddlewareHandler } from 'hono';
import type { NamedMiddleware } from '../route/define-middleware';
import { route, type RouteDef } from '../route/route-builder';
import { defineUnmappedRouter, type Router } from '../route/router';
import { SurfaceError } from './error';
import {
    collectSurfaceCommands,
    type SurfaceCommand,
    type SurfaceManifest,
    type SurfaceModuleDescriptor,
} from './manifest';
import { isSurfaceEffect, validateSurfaceModule, type SurfaceModule, type SurfaceModuleCommand } from './module';
import {
    assertNamespace,
    manifestNameOf,
    manifestPathOf,
    surfaceRouteBuilder,
    type SurfaceRouteBuilder,
} from './namespace';
import { routePatternsOverlap } from './route-overlap';
import { capitalized, SURFACE_WORDING, type SurfaceWording } from './wording';

type SurfaceMiddleware = NamedMiddleware<string> | MiddlewareHandler;

/**
 * Build the guard for one command, or `undefined` for none. Called once per
 * command when the router is built; the guard runs after `auth` and before the
 * command's own middlewares.
 *
 * The command is the manifest entry, so its `effect` is there to read — a
 * guard can be stricter for a `destructive` command than for a `read`.
 */
export type SurfaceAuthorize = (command: SurfaceCommand) => SurfaceMiddleware | undefined;

export interface SurfaceOptions
{
    /** Every command lives under it, e.g. `/_app`. Must be a plain absolute path. */
    namespace: string;

    /**
     * The middleware that authenticates every command. Required — a surface
     * without authentication is refused at definition time, not discovered in
     * production.
     */
    auth: NamedMiddleware<string>;

    /** Per-command guard. Required when modules are mounted. */
    authorize?: SurfaceAuthorize;

    /**
     * `'authenticated'` (default): the manifest carries `auth` like every
     * command. `'public'`: it carries none and skips a global `auth`
     * middleware, so a caller can discover commands before it holds a token.
     */
    manifest?: 'authenticated' | 'public';

    /** Capability modules this application explicitly chooses to expose here. */
    modules?: readonly SurfaceModule[];
}

export interface Surface
{
    /** The validated namespace, as given. */
    readonly namespace: string;

    /** `route` with the namespace applied. */
    readonly route: SurfaceRouteBuilder;

    /**
     * Build the unmapped package router: the manifest first, then the
     * secured commands, then the secured module commands.
     */
    router<TRoutes extends Record<string, RouteDef<any, any, any> | Router<any>>>(routes: TRoutes): Router<any>;
}

/** What `router()` builds from: the options, checked, plus the derived names. */
interface Plan
{
    namespace: string;
    prefix: string;
    manifestPath: string;
    manifestName: string;
    auth: NamedMiddleware<string>;
    authorize?: SurfaceAuthorize;
    manifest: 'authenticated' | 'public';
    modules: readonly SurfaceModule[];
    wording: SurfaceWording;
    requireEffect: boolean;
}

/** How a surface treats an app command that declares no `.effect()`. Internal to core. */
export interface SurfaceRules
{
    /** `true`: refuse it. `false`: announce it without an effect, as `/_ops` always has. */
    requireEffect: boolean;
}

/**
 * The longest summary a command may announce. The same 500 as the CLI's
 * `MAX_SUMMARY_LENGTH` in `spfn/surface`'s manifest trust, so a server never
 * announces a summary its own client would refuse.
 */
const MAX_COMMAND_SUMMARY_LENGTH = 500;

const EFFECT_METHOD = ".effect('read' | 'write' | 'destructive')";

interface CompiledModuleRoute
{
    route: RouteDef<any>;
    command: SurfaceCommand;
}

interface CompiledModuleSurface
{
    descriptors: SurfaceModuleDescriptor[];
    commands: SurfaceCommand[];
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

function assertSurfaceRoute(plan: Plan, name: string, def: RouteDef<any>): void
{
    const label = capitalized(plan.wording.noun);

    if (!def.method || !def.path)
    {
        throw new SurfaceError(
            `${label} route "${name}" has no method or path. `
            + 'A command is invoked on the wire, so both are required.',
        );
    }

    if (!def.path.startsWith(plan.prefix))
    {
        throw new SurfaceError(
            `${label} route "${name}" is at "${def.path}", outside "${plan.prefix}". `
            + `Build ${plan.wording.noun} routes with ${plan.wording.builder} rather than \`route\` — it applies the namespace, `
            + 'so the path a definition carries is only the part the app owns.',
        );
    }

    if (def.path === plan.manifestPath)
    {
        throw new SurfaceError(
            `${label} route "${name}" claims "${plan.manifestPath}", which is reserved for the manifest. `
            + 'The manifest is registered first, so this route would never answer.',
        );
    }
}

/**
 * Refuse an app command whose route declares an effect or summary a client
 * could not use — or, on a surface that requires it, no effect at all. A
 * manifest is then never built announcing a command whose effect is unknown,
 * and a defaulted effect is never put in its place: that would be a claim the
 * app did not make, in the field a client reads to decide whether to retry.
 */
function assertCommandMetadata(plan: Plan, name: string, def: RouteDef<any>): void
{
    const label = `${capitalized(plan.wording.noun)} command "${name}"`;

    if (def.effect === undefined && plan.requireEffect)
    {
        throw new SurfaceError(
            `${label} declares no effect. A client reads it to decide whether to call, retry, `
            + `or ask for confirmation, so ${plan.wording.factory} refuses a command without one. `
            + `Declare it on the route with ${EFFECT_METHOD}.`,
        );
    }

    if (def.effect !== undefined && !isSurfaceEffect(def.effect))
    {
        throw new SurfaceError(
            `${label} has invalid effect ${JSON.stringify(def.effect)}. `
            + `A client knows no other, so declare it with ${EFFECT_METHOD}.`,
        );
    }

    assertCommandSummary(label, def.summary);
}

/** Refuse a summary the CLI would refuse: blank, or longer than it accepts. */
function assertCommandSummary(label: string, summary: unknown): void
{
    if (summary === undefined)
    {
        return;
    }

    if (typeof summary !== 'string' || summary.trim().length === 0)
    {
        throw new SurfaceError(
            `${label} has an empty summary. A client would list it as a command described by nothing; `
            + 'give .summary() one line of text, or leave it out.',
        );
    }

    if (summary.length > MAX_COMMAND_SUMMARY_LENGTH)
    {
        throw new SurfaceError(
            `${label} has a summary of ${summary.length} characters, over the ${MAX_COMMAND_SUMMARY_LENGTH} `
            + 'a client accepts — it would drop the command\'s metadata and treat it as destructive. Shorten it.',
        );
    }
}

/**
 * A module command's effect is the module's declaration; its route's own
 * `.effect()` is ignored when it agrees and refused when it does not, because
 * the manifest can announce only one and the route's author meant the other.
 * The route's `.summary()` is not read at all — the module's wins.
 */
function assertModuleRouteEffect(plan: Plan, name: string, definition: SurfaceModuleCommand<any>): void
{
    const routeEffect = definition.route.effect;

    if (routeEffect !== undefined && routeEffect !== definition.effect)
    {
        throw new SurfaceError(
            `${capitalized(plan.wording.noun)} command "${name}" is declared ${JSON.stringify(definition.effect)} `
            + `by its module, but its route says .effect(${JSON.stringify(routeEffect)}). `
            + 'The manifest announces the module\'s declaration, so the two cannot disagree. '
            + 'Drop the route\'s .effect() or make it match.',
        );
    }
}

/**
 * The reserved name is checked for every entry, route and nested router
 * alike, because the merge cannot refuse a duplicate key on its own. The
 * manifest is merged in first and the app's entries spread over it, so an
 * entry under this name would replace the manifest — the surface would then
 * announce nothing and a client would discover no commands at all.
 */
function assertSurfaceName(plan: Plan, name: string): void
{
    if (name === plan.manifestName)
    {
        throw new SurfaceError(
            `${capitalized(plan.wording.noun)} route name "${plan.manifestName}" is reserved for the manifest route.`,
        );
    }
}

/**
 * Rebuild a nested router with the auth middleware injected into its routes,
 * carrying over what the original declared. A plain `defineRouter` of the
 * secured routes would silently drop the router's own `.use()` middlewares —
 * a scope guard among them — leaving those routes reachable by any valid
 * credential.
 *
 * It is rebuilt unmapped, like the surface that holds it: a nested surface
 * router publishes no route map either.
 *
 * Those middlewares are handed down to the routes rather than left on the
 * rebuilt router. Router-level middlewares are registered ahead of every
 * route-level one, so a guard left in place would run before the auth that
 * was injected per route — reading a request no one had authenticated yet.
 *
 * `.packages()` is refused rather than carried: package routes are registered
 * without passing through this factory, so they would join the surface with
 * neither the prefix check nor the auth injection.
 */
function rebuildNestedRouter(
    plan: Plan,
    name: string,
    router: Router<any>,
    commandsByName: ReadonlyMap<string, SurfaceCommand>,
    inherited: ReadonlyArray<NamedMiddleware<string>>,
): Router<any>
{
    if (router._packageRouters?.length > 0)
    {
        throw new SurfaceError(
            `${capitalized(plan.wording.noun)} router "${name}" mounts package routers with .packages(). `
            + 'Their routes bypass the prefix check and the auth injection, so a surface cannot carry them.',
        );
    }

    const handedDown = [...inherited, ...(router._globalMiddlewares ?? [])];

    let rebuilt = defineUnmappedRouter(
        secureRoutes(plan, router.routes, commandsByName, handedDown) as Record<string, RouteDef<any>>,
    );

    if (router._contractVersion)
    {
        rebuilt = rebuilt.contractVersion(router._contractVersion);
    }

    return rebuilt;
}

/**
 * Validate every route and hand back a copy carrying, in order, the auth
 * middleware, the command's guard when `authorize` gave one, the middlewares
 * its enclosing routers declared with `.use()`, and its own. Route-level
 * injection (rather than router-level `.use`) makes the middleware's `skips`
 * declaration effective, so `opsTokenAuth` can auto-skip a server-level `auth`
 * middleware exactly as `oneTimeTokenAuth` does — and it is what puts auth
 * ahead of every group guard.
 *
 * `authorize` is asked for a command's guard only once its own route has
 * passed `assertSurfaceRoute` and `assertCommandMetadata` — an `authorize`
 * written to switch exhaustively on `command.effect` must never be handed one
 * `defineSurface` would otherwise have refused.
 */
function secureRoutes(
    plan: Plan,
    routes: Record<string, RouteDef<any> | Router<any>>,
    commandsByName: ReadonlyMap<string, SurfaceCommand>,
    inherited: ReadonlyArray<NamedMiddleware<string>> = [],
): Record<string, RouteDef<any> | Router<any>>
{
    const secured: Record<string, RouteDef<any> | Router<any>> = {};

    for (const [name, entry] of Object.entries(routes))
    {
        assertSurfaceName(plan, name);

        if (isRouter(entry))
        {
            secured[name] = rebuildNestedRouter(plan, name, entry, commandsByName, inherited);
            continue;
        }

        if (!isRouteDef(entry))
        {
            throw new SurfaceError(
                `${capitalized(plan.wording.noun)} router entry "${name}" is neither a route nor a router.`,
            );
        }

        assertSurfaceRoute(plan, name, entry);
        assertCommandMetadata(plan, name, entry);
        const guard = plan.authorize?.(commandsByName.get(name)!);
        secured[name] = {
            ...entry,
            middlewares: commandChain(plan, name, guard, [...inherited, ...(entry.middlewares ?? [])]),
        };
    }

    return secured;
}

/**
 * A command's middlewares in the order they run: auth, the guard when
 * `authorize` gave one, then the ones the command declared — its enclosing
 * routers' first, its own last.
 *
 * A guard sharing its name with the surface's auth middleware or a declared
 * middleware is refused rather than chained. Registration keeps one
 * middleware per name, so the other one would be dropped without a word —
 * and a guard factory that returns a named middleware per call makes that
 * collision easy to hit by accident.
 */
function commandChain(
    plan: Plan,
    name: string,
    guard: SurfaceMiddleware | undefined,
    declared: readonly SurfaceMiddleware[],
): SurfaceMiddleware[]
{
    if (guard === undefined)
    {
        return [plan.auth, ...declared];
    }

    const guardName = middlewareNameOf(guard);
    if (guardName !== undefined)
    {
        refuseGuardCollision(plan, name, guardName, declared);
    }

    return [plan.auth, guard, ...declared];
}

/** Throw when the guard's name collides with `auth` or a declared middleware. */
function refuseGuardCollision(
    plan: Plan,
    name: string,
    guardName: string,
    declared: readonly SurfaceMiddleware[],
): void
{
    const noun = capitalized(plan.wording.noun);

    if (middlewareNameOf(plan.auth) === guardName)
    {
        throw new SurfaceError(
            `${noun} command "${name}"'s guard shares the name "${guardName}" with the surface's auth `
            + 'middleware. Route registration keeps one middleware per name, so the command\'s guard '
            + 'would never run. Give one of the two a distinct name.',
        );
    }

    if (declared.some(middleware => middlewareNameOf(middleware) === guardName))
    {
        throw new SurfaceError(
            `${noun} command "${name}" declares a middleware named "${guardName}", `
            + 'the name of the guard authorize gave it. Route registration keeps one middleware per name, '
            + 'so the command\'s own guard would never run. Give one of the two a distinct name.',
        );
    }
}

/** The name registration deduplicates by — a plain handler has none. */
function middlewareNameOf(middleware: SurfaceMiddleware): string | undefined
{
    return typeof middleware === 'function' ? undefined : middleware.name;
}

/**
 * Refuse a module command that would collide with a command already claimed:
 * same name, same method and path, or — against an app command — a pattern
 * that can claim a common URL.
 */
function assertModuleCommandFree(
    plan: Plan,
    command: SurfaceCommand,
    appCommands: readonly SurfaceCommand[],
    claimed: { names: Set<string>; signatures: Map<string, string> },
): void
{
    const noun = plan.wording.noun;

    if (claimed.names.has(command.name))
    {
        throw new SurfaceError(`Two ${noun} commands are named "${command.name}".`);
    }

    const signature = `${command.method} ${command.path}`;
    const existing = claimed.signatures.get(signature);
    if (existing)
    {
        throw new SurfaceError(
            `${capitalized(noun)} commands "${existing}" and "${command.name}" both use ${signature}.`,
        );
    }

    // Whether the two patterns can claim a common URL, not whether the app
    // route sits in the module's namespace. An app route at exactly
    // `<namespace>/<moduleId>` shares the prefix but can never be reached by a
    // `<namespace>/<moduleId>/<command>` request, and refusing it would fail a
    // legitimate app at boot.
    const overlapping = appCommands.find(app =>
        app.method === command.method && routePatternsOverlap(app.path, command.path));
    if (overlapping)
    {
        throw new SurfaceError(
            `App ${noun} command "${overlapping.name}" at ${command.method} ${overlapping.path} `
            + `overlaps module command "${command.name}" at ${command.method} ${command.path}. `
            + 'Which one answers cannot depend on route registration order.',
        );
    }

    claimed.names.add(command.name);
    claimed.signatures.set(signature, command.name);
}

function compileModules(plan: Plan, appCommands: readonly SurfaceCommand[]): CompiledModuleSurface
{
    const compiled: CompiledModuleSurface = { descriptors: [], commands: [], routes: {} };
    const moduleIds = new Set<string>();
    const claimed = {
        names: new Set(appCommands.map(command => command.name)),
        signatures: new Map(appCommands.map(command => [`${command.method} ${command.path}`, command.name])),
    };

    for (const rawModule of plan.modules)
    {
        const module = validateSurfaceModule(rawModule, plan.namespace, plan.wording);

        if (moduleIds.has(module.id))
        {
            throw new SurfaceError(`Two ${plan.wording.noun} modules use id "${module.id}".`);
        }
        moduleIds.add(module.id);

        compiled.descriptors.push({
            id: module.id,
            source: module.source,
            contractVersion: module.contractVersion,
            summary: module.summary,
        });

        for (const [localName, definition] of Object.entries(module.commands))
        {
            const command: SurfaceCommand = {
                name: `${module.id}.${localName}`,
                module: module.id,
                summary: definition.summary,
                effect: definition.effect,
                scopes: [...definition.scopes],
                method: definition.route.method!,
                path: definition.route.path!,
                input: collectSurfaceCommands({ [localName]: definition.route }, plan.wording)[0]!.input,
            };

            assertModuleRouteEffect(plan, command.name, definition);
            assertModuleCommandFree(plan, command, appCommands, claimed);
            compiled.commands.push(command);
            compiled.routes[command.name] = { route: definition.route, command };
        }
    }

    compiled.descriptors.sort((a, b) => a.id.localeCompare(b.id));
    compiled.commands.sort((a, b) => a.name.localeCompare(b.name));

    return compiled;
}

function secureModuleRoutes(plan: Plan, routes: Record<string, CompiledModuleRoute>): Record<string, RouteDef<any>>
{
    const secured: Record<string, RouteDef<any>> = {};

    for (const [name, definition] of Object.entries(routes))
    {
        assertSurfaceName(plan, name);
        assertSurfaceRoute(plan, name, definition.route);
        secured[name] = {
            ...definition.route,
            middlewares: commandChain(
                plan,
                name,
                plan.authorize?.(definition.command),
                definition.route.middlewares ?? [],
            ),
        };
    }

    return secured;
}

/**
 * The manifest route. Authenticated, it carries `auth` like every command.
 * Public, it carries none and skips a server-level `auth` by name — the
 * global middleware `opsTokenAuth` and `optionalAuth` auto-skip — which would
 * otherwise demand an app session before the manifest could answer.
 */
function manifestRoute(plan: Plan, manifest: SurfaceManifest): RouteDef<any>
{
    const builder = route.get(plan.manifestPath);

    return (plan.manifest === 'public' ? builder.skip(['auth']) : builder.use([plan.auth]))
        .handler(async () => manifest);
}

function buildRouter(plan: Plan, routes: Record<string, RouteDef<any> | Router<any>>): Router<any>
{
    const appCommands = collectSurfaceCommands(routes, plan.wording);
    const moduleSurface = compileModules(plan, appCommands);
    const commands = [...appCommands, ...moduleSurface.commands]
        .sort((a, b) => a.name.localeCompare(b.name));

    const manifest: SurfaceManifest = {
        manifestVersion: 1,
        ...(moduleSurface.descriptors.length > 0 ? { modules: moduleSurface.descriptors } : {}),
        commands,
    };

    const commandsByName = new Map(appCommands.map(command => [command.name, command]));
    const secured = secureRoutes(plan, routes, commandsByName);
    const securedModules = secureModuleRoutes(plan, moduleSurface.routes);

    // The manifest goes first, so no route in this object can answer its path.
    // A route pattern that happens to cover `<namespace>/_manifest` —
    // `<namespace>/:name`, say — is then only a route the app never reaches
    // through that one URL, not a surface-wide outage where a client cannot
    // discover any command.
    //
    // The ordering reaches no further than this object. `registerRoutes`
    // registers a router's own routes before its package routers, so a pattern
    // the app declares in its own router still shadows the manifest — as it
    // shadows every other package route, which is a property of where the app
    // put that pattern rather than of this factory.
    // `defineUnmappedRouter`, not `defineRouter`: no surface route map is
    // published for an app to merge, and a client invokes a command over the
    // URL the manifest gave it rather than by name through the RPC client. So a
    // command and an app route sharing a name overwrite nothing, and the
    // route-map generator must not refuse the build over it.
    //
    // The namespace marker is non-enumerable, so the router compares and
    // spreads as any other does; `.packages()` reads it to refuse a second
    // surface on this namespace.
    return Object.defineProperty(defineUnmappedRouter({
        [plan.manifestName]: manifestRoute(plan, manifest),
        ...secured,
        ...securedModules,
    } as Record<string, RouteDef<any>>), '_surfaceNamespace', { value: plan.namespace, enumerable: false });
}

function planOf(options: SurfaceOptions, wording: SurfaceWording, rules: SurfaceRules): Plan
{
    assertNamespace(options?.namespace);

    if (!options.auth)
    {
        throw new SurfaceError(
            `${wording.factory} requires an auth middleware ({ auth: ... }). `
            + 'A surface reachable without authentication cannot be created.',
        );
    }

    const modules = options.modules ?? [];
    if (modules.length > 0 && !options.authorize)
    {
        throw new SurfaceError(`${wording.factory} requires an authorize function when modules are mounted.`);
    }

    const manifest = options.manifest ?? 'authenticated';
    if (manifest !== 'authenticated' && manifest !== 'public')
    {
        throw new SurfaceError(
            `${wording.factory} manifest must be 'authenticated' or 'public', got ${JSON.stringify(manifest)}.`,
        );
    }

    return {
        namespace: options.namespace,
        prefix: `${options.namespace}/`,
        manifestPath: manifestPathOf(options.namespace),
        manifestName: manifestNameOf(options.namespace),
        auth: options.auth,
        authorize: options.authorize,
        manifest,
        modules,
        wording,
        requireEffect: rules.requireEffect,
    };
}

/**
 * `defineSurface` with the words its refusals use and the rules it holds app
 * commands to. Internal: `@spfn/core/ops` passes its own so an ops refusal
 * reads as it always has, and so an ops route that never declared an effect
 * boots as it always has.
 */
export function createSurface(options: SurfaceOptions, wording: SurfaceWording, rules: SurfaceRules): Surface
{
    const plan = planOf(options, wording, rules);

    return {
        namespace: plan.namespace,
        route: surfaceRouteBuilder(plan.namespace, wording),
        router: routes => buildRouter(plan, routes),
    };
}

/**
 * Define a command surface on a namespace.
 *
 * The namespace, the auth middleware, and the `authorize` requirement are
 * checked here; routes and modules when `router()` builds the package router.
 * Every app command must declare its effect with
 * `.effect('read' | 'write' | 'destructive')` — `router()` refuses one that
 * does not, so a client is never handed a command it cannot classify.
 * The router is an ordinary `Router` meant to be mounted with `.packages()`,
 * so its routes stay out of the app's client types exactly like other
 * package routes.
 */
export function defineSurface(options: SurfaceOptions): Surface
{
    return createSurface(options, SURFACE_WORDING, { requireEffect: true });
}
