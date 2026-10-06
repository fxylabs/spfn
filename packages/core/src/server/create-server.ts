/**
 * Create Hono Server
 *
 * Creates and configures a Hono application instance.
 */

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { existsSync } from 'fs';
import { join } from 'path';

import { registerRoutes, defineMiddleware, type RegisteredRoute } from '@spfn/core/route';
import { ErrorHandler, RequestLogger, rateLimit, setRateLimitPolicies, setRateLimitFailClosedDefault } from '@spfn/core/middleware';
import { setDefaultSafeFetchPolicy } from '@spfn/core/security';
import { env } from '@spfn/core/config';
import { createSSEHandler } from '../event/sse/handler';
import { DEFAULT_SSE_STREAM_PATH, sseTokenPath } from '../event/sse/paths';
import { SSETokenManager, CacheTokenStore } from '../event/sse/token-manager';
import { wireEventRouterCache } from '../event/cache-transport';
import { createHealthCheckHandler, resolveEndpointMiddlewares } from './helpers';
import { CORE_NAMESPACE, CORE_HEALTH_PATH, CORE_TIME_PATH, LEGACY_HEALTH_PATH } from './namespace';
import { createCoreTimeRouter } from './server-time';
import { serverLogger } from './logger';

import type { ServerConfig, AppFactory } from './types';
import type { EventRouterContract } from '../event/router';
import type { NonceStore, RateLimitOptions } from '@spfn/core/middleware';

// Tracks configs whose global rate-limit middleware has already been injected,
// so a repeated createServer on the same config doesn't prepend it twice.
const rateLimitApplied = new WeakSet<object>();

// Extend Hono context with error handler flag
declare module 'hono'
{
    interface ContextVariableMap
    {
        errorHandlerEnabled?: boolean;
    }
}

/**
 * Create Hono app with automatic configuration
 *
 * Levels:
 * 1. No app.ts -> Full auto config
 * 2. server.config.ts -> Partial customization
 * 3. app.ts -> Full control (no auto config)
 */
export async function createServer(config?: ServerConfig): Promise<Hono>
{
    // Publish the outbound SSRF policy before any route or handler can call safeFetch.
    applyOutboundFetch(config);

    const cwd = process.cwd();
    const appPath = join(cwd, 'src', 'server', 'app.ts');
    const appJsPath = join(cwd, 'src', 'server', 'app');

    // Level 3: Full control with app.ts
    if (existsSync(appPath) || existsSync(appJsPath))
    {
        return await loadCustomApp(appPath, appJsPath, config);
    }

    // Level 1 & 2: Auto config
    return await createAutoConfiguredApp(config);
}

async function loadCustomApp(
    appPath: string,
    appJsPath: string,
    config?: ServerConfig,
): Promise<Hono>
{
    // Determine which path exists to avoid duplicate checks
    const actualPath = existsSync(appPath) ? appPath : appJsPath;
    const appModule = await import(actualPath);
    const appFactory: AppFactory = appModule.default;

    if (!appFactory)
    {
        throw new Error('app.ts must export a default function that returns a Hono app');
    }

    const app = await appFactory();

    // Always run: registers policies + fail-closed default even for a custom app
    // that wires its own routes (so rateLimitPolicy tags still resolve). Injection
    // of the global default only takes effect when routes are registered below.
    applyRateLimit(config);

    // Register routes (if provided via config)
    if (config?.routes)
    {
        const routes = registerRoutes(app, config.routes, config.middlewares);
        logRegisteredRoutes(routes, config?.debug ?? false);
    }

    return app;
}

async function createAutoConfiguredApp(config?: ServerConfig): Promise<Hono>
{
    const app = new Hono();

    const middlewareConfig = config?.middleware ?? {};
    const enableLogger = middlewareConfig.logger !== false;
    const enableCors = middlewareConfig.cors !== false;
    const enableErrorHandler = middlewareConfig.errorHandler !== false;

    // 1. Set error handler flag in context
    if (enableErrorHandler)
    {
        app.use('*', async (c, next) =>
        {
            c.set('errorHandlerEnabled', true);
            await next();
        });
    }

    // 2. Default middleware
    applyDefaultMiddleware(app, config, enableLogger, enableCors);

    // 2.5 Proxy-guard (trusted-proxy signature + origin verification)
    await applyProxyGuard(app, config);

    // 2.6 Rate limit: register named policies + optional global default limiter
    applyRateLimit(config);

    // 3. Server time — before application middleware and routes so a client can
    //    synchronize before it has a proof or session.
    registerCoreTimeEndpoint(app, config);

    // 4. Custom middleware
    if (Array.isArray(config?.use))
    {
        config.use.forEach(mw => app.use('*', mw));
    }

    // 5. Built-in health endpoint — before app routes and before the
    //    beforeRoutes hook, on purpose. Hono answers with whichever handler was
    //    registered first, and a middleware only wraps handlers registered after
    //    it, so this position is what keeps a probe unauthenticated and keeps
    //    the path unclaimable by an app.
    registerCoreHealthEndpoint(app, config);

    // 6. beforeRoutes hook from config
    await executeBeforeRoutesHook(app, config);

    // 7. Load routes
    const appRoutes = await loadAppRoutes(app, config);

    // 7.5 Where /health went — after app routes, so an app that declares that
    //     path keeps it. A signpost, not an endpoint.
    registerMovedHealthSignpost(app, config, appRoutes);
    warnOnShadowedOptInPath(config, appRoutes);
    warnOnCoreNamespaceRoutes(appRoutes);

    // 8. Register SSE endpoint (if events router provided)
    await registerSSEEndpoint(app, config);

    // 9. afterRoutes hook from config
    await executeAfterRoutesHook(app, config);

    // 10. Error handler
    if (enableErrorHandler)
    {
        app.onError(ErrorHandler({ onError: config?.middleware?.onError }));
    }

    return app;
}

function applyDefaultMiddleware(
    app: Hono,
    config: ServerConfig | undefined,
    enableLogger: boolean,
    enableCors: boolean,
): void
{
    if (enableLogger)
    {
        app.use('*', RequestLogger());
    }

    if (enableCors)
    {
        // Only apply cors if config.cors is not explicitly false
        // This handles both config.cors = undefined and config.cors = {...options}
        const corsOptions = config?.cors !== false ? config?.cors : undefined;
        app.use('*', cors(corsOptions));
    }
}

async function applyProxyGuard(app: Hono, config?: ServerConfig): Promise<void>
{
    const proxyGuardConfig = config?.proxyGuard;
    const mode = proxyGuardConfig?.mode ?? 'off';

    if (mode === 'off')
    {
        return;
    }

    const { createProxyGuard, createCacheNonceStore, createInMemoryNonceStore } = await import('@spfn/core/middleware');

    // Optionally enable Redis-backed nonce replay rejection
    let nonceStore: NonceStore | undefined;
    if (proxyGuardConfig?.nonce)
    {
        try
        {
            const { getCache } = await import('@spfn/core/cache');
            const cache = getCache();
            if (cache)
            {
                nonceStore = createCacheNonceStore(cache);
                serverLogger.info('Proxy-guard nonce replay rejection: cache (Redis/Valkey)');
            }
            else
            {
                nonceStore = createInMemoryNonceStore();
                serverLogger.info('Proxy-guard nonce replay rejection: in-memory (single instance only — use a cache for multi-instance)');
            }
        }
        catch
        {
            nonceStore = createInMemoryNonceStore();
            serverLogger.warn('Proxy-guard nonce: cache module unavailable — using in-memory store (single instance only)');
        }
    }

    // Auto-skip endpoints that browsers reach WITHOUT going through the RPC proxy
    // (so they carry no proxy signature): health probes, the SSE stream (EventSource
    // can't send custom headers), and WebSocket upgrades. The SSE *token* endpoint
    // (POST) is deliberately NOT skipped — it goes through the proxy like any RPC
    // call and mints credentials, so it must stay guarded.
    // Every path health answers on, not just one: a probe reaches the server
    // directly and carries no proxy signature, so in strict mode a guard that
    // does not skip it rejects every readiness check — the pod would never enter
    // rotation and nothing would say why. /health is in the list while the
    // signpost lives there, because an operator whose probe broke needs to read
    // the 410 rather than a rejection.
    const autoSkip = [CORE_HEALTH_PATH, CORE_TIME_PATH, LEGACY_HEALTH_PATH];
    if (config?.healthCheck?.path)
    {
        autoSkip.push(config.healthCheck.path);
    }
    if (config?.events)
    {
        autoSkip.push(config.eventsConfig?.path ?? '/events/stream');
    }
    if (config?.websockets)
    {
        autoSkip.push(config.websocketsConfig?.path ?? '/ws');
    }
    const skipPaths = [...(proxyGuardConfig?.skipPaths ?? []), ...autoSkip];

    app.use('*', createProxyGuard({
        mode,
        secret: proxyGuardConfig?.secret,
        previousSecrets: proxyGuardConfig?.previousSecrets,
        windowMs: proxyGuardConfig?.windowMs,
        allowedOrigins: proxyGuardConfig?.allowedOrigins,
        maxBodyBytes: proxyGuardConfig?.maxBodyBytes,
        nonceStore,
        nonceFailClosed: proxyGuardConfig?.nonceFailClosed,
        skipPaths,
    }));

    serverLogger.info(`✓ Proxy-guard enabled (mode: ${mode})`);
}

/**
 * Wire rate limiting before routes register.
 *
 * Always publishes the named-policy registry (so `rateLimitPolicy()` tags resolve
 * even when the global default is off). When enabled, prepends a named 'rateLimit'
 * middleware carrying the default policy — routes opt out with `.skip(['rateLimit'])`
 * and policy tags override it via their `skips: ['rateLimit']`. Health, SSE and
 * WebSocket endpoints register outside the named-middleware pipeline, so they are
 * naturally exempt from the global default.
 */
function applyRateLimit(config?: ServerConfig): void
{
    const rl = config?.rateLimit;

    // These are idempotent (plain reassignment) and must run on every path —
    // including a Level-3 custom app — so policy tags resolve and fail-closed
    // reaches them whether or not the global default limiter is enabled.
    setRateLimitPolicies(rl?.policies);
    setRateLimitFailClosedDefault(env.RATE_LIMIT_FAIL_CLOSED);

    const enabled = (rl?.mode ?? env.RATE_LIMIT_MODE) === 'on';
    if (!enabled || !config || rateLimitApplied.has(config))
    {
        return;
    }

    // Guard against a second prepend if createServer runs twice on the same config
    // (register-routes does not dedup server-level middlewares against each other,
    // so two 'rateLimit' entries would silently halve the effective limit).
    rateLimitApplied.add(config);

    const defaultPolicy: RateLimitOptions = {
        limit: rl?.default?.limit ?? env.RATE_LIMIT_DEFAULT_LIMIT,
        windowMs: rl?.default?.windowMs ?? env.RATE_LIMIT_DEFAULT_WINDOW_MS,
        failClosed: rl?.default?.failClosed ?? env.RATE_LIMIT_FAIL_CLOSED,
    };

    const globalRateLimit = defineMiddleware('rateLimit', rateLimit(defaultPolicy));

    config.middlewares = [globalRateLimit, ...(config.middlewares ?? [])];

    serverLogger.info(`✓ Rate limit default enabled (${defaultPolicy.limit} per ${defaultPolicy.windowMs}ms)`);
}

/**
 * Publish the process-wide SSRF policy used by `safeFetch` (`@spfn/core/security`).
 * App config wins; otherwise the `SAFE_FETCH_BLOCK_PRIVATE_IPS` env sets the default.
 */
function applyOutboundFetch(config?: ServerConfig): void
{
    const policy = config?.outboundFetch ?? { blockPrivateIps: env.SAFE_FETCH_BLOCK_PRIVATE_IPS };

    setDefaultSafeFetchPolicy(policy);
}

function resolveHealthCheck(config?: ServerConfig): { enabled: boolean; path?: string; detailed: boolean }
{
    const healthCheckConfig = config?.healthCheck ?? {};

    return {
        enabled: healthCheckConfig.enabled !== false,
        // No default. An unset `path` means the endpoint answers at
        // CORE_HEALTH_PATH and nowhere else — a default here is what used to put
        // it on /health without anyone asking.
        path: healthCheckConfig.path,
        detailed: healthCheckConfig.detailed ?? process.env.NODE_ENV === 'development',
    };
}

/**
 * Register the unproven server-time operation from its exported route contract.
 *
 * It sits before `config.use`, `beforeRoutes` and application routes, so none of
 * the application's authentication surfaces can turn the bootstrap operation
 * into a proved or session-bound call. Proxy-guard is registered earlier but
 * explicitly skips this path.
 */
function registerCoreTimeEndpoint(app: Hono, config?: ServerConfig): void
{
    registerRoutes(app, createCoreTimeRouter(config?.serverTime?.clock));
    serverLogger.debug(`Server time endpoint enabled at ${CORE_TIME_PATH}`);
}

/**
 * The built-in health endpoint, at the one path an app cannot take from it.
 *
 * A readiness probe's path is fixed in places this repository cannot change —
 * `readinessProbe.httpGet.path` in a GitOps manifest, `HEALTHCHECK` in a
 * Dockerfile, a load balancer's console — and a version bump migrates none of
 * them. So the endpoint needs an address that is true regardless of what the app
 * declares, which is what {@link CORE_HEALTH_PATH} is: registered before app
 * routes, and inside a namespace an app declaring it is declaring something it
 * does not own. `/_auth` and `/_ops` already work that way and neither has ever
 * had a shadowing defect.
 *
 * Deliberately without middleware, and registered before the `beforeRoutes`
 * hook. Named middlewares attach per route inside `registerRoutes`, and a Hono
 * middleware only wraps handlers registered after it — so an app that adds a
 * global guard in that hook, which is what the hook is documented for, cannot
 * close the endpoint a probe depends on.
 *
 * A configured `healthCheck.path` is registered here too, beside the canonical
 * one, for a deployment whose probe path is frozen somewhere this repository
 * cannot reach. It is an opt-in and never a default: the endpoint used to land
 * on `/health` because a default put it there, which is how an app route on
 * that path came to be swallowed whole.
 */
function registerCoreHealthEndpoint(app: Hono, config?: ServerConfig): void
{
    const { enabled, path, detailed } = resolveHealthCheck(config);

    if (!enabled)
    {
        return;
    }

    const handler = createHealthCheckHandler(detailed, config?.infrastructure);

    app.get(CORE_HEALTH_PATH, handler);
    serverLogger.debug(`Health check endpoint enabled at ${CORE_HEALTH_PATH}`);

    if (path && path !== CORE_HEALTH_PATH)
    {
        app.get(path, handler);
        serverLogger.debug(`Health check endpoint also answering at ${path}, as configured`);
    }
}

/**
 * `/health` — gone, and saying so where the request arrives.
 *
 * A readiness probe that starts failing shows its operator neither a response
 * body nor a status text: a Kubernetes event says the probe failed and stops
 * there. So the 410 body is for whoever runs `curl`, and the warning is what
 * reaches a log aggregator — once per server, because a probe interval would
 * otherwise turn it into a stream.
 *
 * After app routes, so an app that declares `GET /health` keeps it and never
 * sees this. A signpost is also the one thing here that a `beforeRoutes`
 * middleware may safely wrap: nothing depends on its answer.
 */
function registerMovedHealthSignpost(
    app: Hono,
    config: ServerConfig | undefined,
    appRoutes: RegisteredRoute[],
): void
{
    const { enabled, path } = resolveHealthCheck(config);

    // Disabled means /health was already a 404 before this change, so nothing
    // moved and there is nothing to point at.
    if (!enabled || path === LEGACY_HEALTH_PATH)
    {
        return;
    }

    if (appRoutes.some(r => r.method === 'GET' && r.path === LEGACY_HEALTH_PATH))
    {
        return;
    }

    let warned = false;

    app.get(LEGACY_HEALTH_PATH, (c) =>
    {
        if (!warned)
        {
            warned = true;

            serverLogger.warn(
                `⚠️  GET ${LEGACY_HEALTH_PATH} is answering 410: @spfn/core no longer serves it. `
                + `Point your readiness probe, Dockerfile HEALTHCHECK and load balancer at `
                + `${CORE_HEALTH_PATH}, or restore this path with `
                + `healthCheck({ path: '${LEGACY_HEALTH_PATH}' }). This notice is removed in the `
                + 'next release.',
            );
        }

        return c.json({
            error: 'health endpoint moved',
            movedTo: CORE_HEALTH_PATH,
            detail: `@spfn/core no longer serves ${LEGACY_HEALTH_PATH}. Point your readiness probe, `
                + `Dockerfile HEALTHCHECK and load balancer at ${CORE_HEALTH_PATH}, or restore this `
                + `path with healthCheck({ path: '${LEGACY_HEALTH_PATH}' }).`,
        }, 410);
    });
}

/**
 * An app route on the opt-in health path never runs — the built-in is registered
 * before app routes, which is what makes it reachable in the first place.
 *
 * Only an app that asked for the second path can reach this, so it reports a
 * contradiction the app stated rather than a trap the framework set.
 */
function warnOnShadowedOptInPath(config: ServerConfig | undefined, appRoutes: RegisteredRoute[]): void
{
    const { enabled, path } = resolveHealthCheck(config);

    if (!enabled || !path || path === CORE_HEALTH_PATH)
    {
        return;
    }

    const shadowed = appRoutes.filter(r => r.method === 'GET' && r.path === path);

    if (shadowed.length === 0)
    {
        return;
    }

    serverLogger.warn(
        `⚠️  ${shadowed.map(r => r.name).join(', ')} never runs: GET ${path} is served by the `
        + 'built-in health endpoint, which healthCheck({ path }) asked for and which is registered '
        + 'before app routes. Drop that option, or move the route to a path your app owns.',
    );
}

/**
 * An app route inside `/_core/` never runs, and saying so is the whole point of
 * having the namespace: the paths in it are registered before app routes
 * precisely so nothing can take them.
 */
function warnOnCoreNamespaceRoutes(appRoutes: RegisteredRoute[]): void
{
    const inside = appRoutes.filter(r => r.path === CORE_NAMESPACE || r.path.startsWith(`${CORE_NAMESPACE}/`));

    if (inside.length === 0)
    {
        return;
    }

    const names = inside.map(r => `${r.name} (${r.method} ${r.path})`).join(', ');

    serverLogger.warn(
        `⚠️  ${names} never runs: ${CORE_NAMESPACE}/ belongs to @spfn/core and its endpoints are `
        + 'registered before app routes. Move the route to a path your app owns.',
    );
}

async function executeBeforeRoutesHook(app: Hono, config?: ServerConfig): Promise<void>
{
    if (config?.lifecycle?.beforeRoutes)
    {
        await config.lifecycle.beforeRoutes(app);
    }
}

async function loadAppRoutes(app: Hono, config?: ServerConfig): Promise<RegisteredRoute[]>
{
    const debug = isDebugMode(config);

    // Register define-route based routes (if provided)
    if (config?.routes)
    {
        const routes = registerRoutes(app, config.routes, config.middlewares);
        logRegisteredRoutes(routes, debug);

        return routes;
    }

    if (debug)
    {
        serverLogger.warn('⚠️  No routes configured. Use defineServerConfig().routes() to register routes.');
    }

    return [];
}

/**
 * Log registered routes in a formatted table
 */
function logRegisteredRoutes(routes: RegisteredRoute[], debug: boolean): void
{
    if (routes.length === 0)
    {
        if (debug)
        {
            serverLogger.warn('⚠️  No routes registered');
        }

        return;
    }

    // Sort routes by path for better readability
    const sortedRoutes = [...routes].sort((a, b) => a.path.localeCompare(b.path));

    // Calculate max method length for alignment
    const maxMethodLen = Math.max(...sortedRoutes.map(r => r.method.length));

    // Build route list string
    const routeLines = sortedRoutes.map(r =>
        `  ${r.method.padEnd(maxMethodLen)}  ${r.path}`,
    ).join('\n');

    serverLogger.info(`✓ Routes registered (${routes.length}):\n${routeLines}`);
}

async function executeAfterRoutesHook(app: Hono, config?: ServerConfig): Promise<void>
{
    if (config?.lifecycle?.afterRoutes)
    {
        await config.lifecycle.afterRoutes(app);
    }
}

/**
 * Register SSE endpoint for event streaming
 *
 * When auth is enabled:
 * - POST /events/token — issues one-time SSE token (protected by config.middlewares)
 * - GET /events/stream?token=...&events=... — SSE stream (token verified)
 */
async function registerSSEEndpoint(app: Hono, config?: ServerConfig): Promise<void>
{
    if (!config?.events)
    {
        return;
    }

    const eventsConfig = config.eventsConfig ?? {};
    const streamPath = eventsConfig.path ?? DEFAULT_SSE_STREAM_PATH;
    const authConfig = eventsConfig.auth;

    assertEventContractServed(config.events._contract, streamPath, !!authConfig?.enabled);
    const debug = isDebugMode(config);

    let tokenManager: SSETokenManager | undefined;

    if (authConfig?.enabled)
    {
        // Auto-detect cache for token store (multi-instance support)
        let store = authConfig.store;
        if (!store)
        {
            try
            {
                const { getCache } = await import('@spfn/core/cache');
                const cache = getCache();
                if (cache)
                {
                    store = new CacheTokenStore(cache);
                    if (debug)
                    {
                        serverLogger.info('SSE token store: cache (Redis/Valkey)');
                    }
                }
            }
            catch
            {
                // Cache module not available, use in-memory
            }
        }

        const externalManager = typeof authConfig.tokenManager === 'function'
            ? authConfig.tokenManager()
            : authConfig.tokenManager;

        tokenManager = externalManager ?? new SSETokenManager({
            ttl: authConfig.tokenTtl,
            store,
        });

        const tokenPath = sseTokenPath(streamPath);

        // Guard the token endpoint with the app's own middleware — from the server
        // config and from the router's .use(), which registerRoutes owns and this
        // endpoint never passes through.
        const mwHandlers = resolveEndpointMiddlewares(config).map(mw => mw.handler);
        const getSubject = authConfig.getSubject
            ?? ((c: Context) => (c.get('auth') as Record<string, string> | undefined)?.userId ?? null);

        app.on(['POST'], [tokenPath], ...mwHandlers, async (c: Context) =>
        {
            const subject = getSubject(c);
            if (!subject)
            {
                return c.json({ error: 'Unable to identify subject' }, 401);
            }

            const token = await tokenManager!.issue(subject);

            return c.json({ token });
        });

        if (debug)
        {
            serverLogger.info(`✓ SSE token endpoint registered at POST ${tokenPath}`);
        }
    }

    // Auto-wire cross-pod event broadcast (Redis pub/sub) when a cache is present.
    // Without a cache this is a no-op and events stay in-process.
    const transport = await wireEventRouterCache(config.events, {
        multiInstance: eventsConfig.multiInstance,
        channelPrefix: eventsConfig.channelPrefix,
    });

    // Register SSE stream handler
    app.get(streamPath, createSSEHandler(config.events, eventsConfig, tokenManager));

    if (debug)
    {
        const eventNames = config.events.eventNames as string[];
        serverLogger.info(`✓ SSE endpoint registered at ${streamPath}`, {
            events: eventNames,
            auth: !!authConfig?.enabled,
            transport,
        });
    }
}

/**
 * Refuse to boot when the event router's contract describes a stream this
 * server does not serve.
 *
 * The contract is generated from the router alone — the generator never reads
 * the server config — so this is the one place the two meet. Without it a
 * document could promise `/sse` or token exchange while `.events()` serves
 * something else, and a released client would fail at runtime instead of the
 * server failing here, before anything is served.
 */
function assertEventContractServed(
    contract: EventRouterContract | undefined,
    streamPath: string,
    authEnabled: boolean,
): void
{
    if (!contract)
    {
        return;
    }

    const contractPath = contract.streamPath ?? DEFAULT_SSE_STREAM_PATH;

    if (contractPath !== streamPath)
    {
        throw new Error(
            `SSE event router contract declares streamPath ${contractPath} but .events() registers ${streamPath}; `
            + 'the contract would describe a path the server does not serve',
        );
    }

    const servedAuth = authEnabled ? 'tokenExchange' : 'none';

    if (contract.auth !== servedAuth)
    {
        throw new Error(
            `SSE event router contract declares auth ${contract.auth} but .events() serves auth ${servedAuth}; `
            + 'the contract would describe an auth mode the server does not serve',
        );
    }
}

/**
 * Determine if debug mode is enabled
 */
function isDebugMode(config?: ServerConfig): boolean
{
    return config?.debug ?? process.env.NODE_ENV === 'development';
}
