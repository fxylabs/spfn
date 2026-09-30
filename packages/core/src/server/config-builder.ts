/**
 * Server Config Builder
 *
 * Provides a fluent API for building server configuration
 */

import type { MiddlewareHandler } from 'hono';
import type { ServerConfig } from './types';
import type { Router } from '@spfn/core/route';
import type { JobRouter, BossOptions } from '../job';
import type { EventRouterDef } from '../event/router';
import type { SSEHandlerConfig, SSEAuthConfig } from '../event/sse/types';
import type { WSRouterDef, WSHandlerConfig, WSAuthConfig, WSMessageHandlers } from '../event/ws/types';
import type { EventDef } from '../event/types';
import { mergeJobRouters } from '../job/job-router';
import { serverLogger } from './logger';

// ============================================================================
// Types
// ============================================================================

type Lifecycle = NonNullable<ServerConfig['lifecycle']>;

type LifecycleKey = keyof Lifecycle;

// ============================================================================
// Helper Functions
// ============================================================================

function collectHooks<K extends LifecycleKey>(
    lifecycles: Lifecycle[],
    key: K,
): NonNullable<Lifecycle[K]>[]
{
    return lifecycles
        .map(lc => lc[key])
        .filter((hook): hook is NonNullable<Lifecycle[K]> => hook !== undefined);
}

function createMergedHook<T extends (...args: any[]) => void | Promise<void>>(
    hooks: T[],
): T | undefined
{
    if (hooks.length === 0)
    {
        return undefined;
    }

    return (async (...args: Parameters<T>) =>
    {
        for (const hook of hooks)
        {
            await hook(...args);
        }
    }) as T;
}

export class ServerConfigBuilder
{
    private config: ServerConfig = {};
    private lifecycles: NonNullable<ServerConfig['lifecycle']>[] = [];

    /**
     * Set server port
     */
    port(port: number): this
    {
        this.config.port = port;

        return this;
    }

    /**
     * Set server hostname
     */
    host(host: string): this
    {
        this.config.host = host;

        return this;
    }

    /**
     * Set CORS configuration
     */
    cors(cors: ServerConfig['cors']): this
    {
        this.config.cors = cors;

        return this;
    }

    /**
     * Configure built-in middleware
     */
    middleware(middleware: ServerConfig['middleware']): this
    {
        this.config.middleware = middleware;

        return this;
    }

    /**
     * Add custom middleware
     */
    use(handlers: MiddlewareHandler[]): this
    {
        this.config.use = handlers;

        return this;
    }

    /**
     * Add named middlewares for route-level skip control
     */
    middlewares(middlewares: ServerConfig['middlewares']): this
    {
        this.config.middlewares = middlewares;

        return this;
    }

    /**
     * Configure proxy-guard (verify trusted-proxy signature + origin → clientType)
     */
    proxyGuard(proxyGuard: ServerConfig['proxyGuard']): this
    {
        this.config.proxyGuard = proxyGuard;

        return this;
    }

    /**
     * Configure rate limiting: an optional global default limiter plus the named
     * policies that `rateLimitPolicy(name, fallback)` tags resolve against.
     *
     * @example
     * ```typescript
     * .rateLimit({
     *     mode: 'on',
     *     default: { limit: 100, windowMs: 60_000 },
     *     policies: { 'auth-login': { limit: 5, windowMs: 60_000 } },
     * })
     * ```
     */
    rateLimit(rateLimit: ServerConfig['rateLimit']): this
    {
        this.config.rateLimit = rateLimit;

        return this;
    }

    /**
     * Configure the SSRF policy for outbound `safeFetch` calls (webhooks,
     * callbacks). Private/reserved IPs are blocked by default.
     *
     * @example
     * ```typescript
     * .outboundFetch({ allowHosts: ['hooks.slack.com'] })
     * ```
     */
    outboundFetch(outboundFetch: ServerConfig['outboundFetch']): this
    {
        this.config.outboundFetch = outboundFetch;

        return this;
    }

    /**
     * Register define-route based router
     *
     * Router-level middleware (`.use()`) and package routers (`.packages()`) travel
     * with the router itself and are applied by `registerRoutes` when the routes are
     * mounted — this method only records which router to mount.
     *
     * It deliberately does **not** copy `router._globalMiddlewares` into
     * `config.middlewares`: that copy used to make `registerRoutes` see the same
     * middleware twice (once from the config list, once from the router it was
     * handed) and attach both to every route. Middleware that verifies a JWT survives
     * running twice; middleware that consumes one-shot state — a nonce replay ledger —
     * rejects its own request the second time round.
     *
     * @example
     * ```typescript
     * const appRouter = defineRouter({
     *   getUser: route.get('/users/:id')...
     * })
     * .packages([authRouter, cmsAppRouter])
     * .use([authMiddleware]);
     *
     * export default defineServerConfig()
     *   .routes(appRouter)  // .use() middleware applied once, at registration
     *   .build();
     * ```
     */
    routes(router: Router<any>): this
    {
        this.config.routes = router;

        return this;
    }

    /**
     * Register background jobs router
     *
     * May be called once per domain router: repeated calls **merge** into one
     * router, the way `.routes()` composes. Calling it several times used to
     * keep only the last router and register nothing else, without warning.
     *
     * The pg-boss `config` is per server, so pass it on one call only.
     *
     * Two names can collide, and both fail loudly:
     * - a router **key** present in two calls throws here, at config time;
     * - two jobs sharing a **`job.name`** (the pg-boss queue name) throw in
     *   `registerJobs()` at boot, before any queue or worker is created.
     *
     * @throws if a router key was already registered by an earlier call
     * @throws if `config` is given when an earlier call already gave one
     *
     * @example
     * ```typescript
     * import { job, defineJobRouter } from '@spfn/core/job';
     *
     * const sendEmail = job('send-email')
     *   .input(Type.Object({ to: Type.String() }))
     *   .handler(async (input) => { ... });
     *
     * const jobRouter = defineJobRouter({ sendEmail });
     *
     * export default defineServerConfig()
     *   .routes(appRouter)
     *   .jobs(jobRouter, { clearOnStart: isDev })   // config on one call only
     *   .jobs(billingJobRouter)                     // merged, not replaced
     *   .build();
     * ```
     */
    jobs(router: JobRouter<any>, config?: Omit<BossOptions, 'connectionString'>): this
    {
        if (config && this.config.jobsConfig)
        {
            throw new Error(
                'jobs(): pg-boss config was already given by an earlier .jobs() call; pass it once',
            );
        }

        this.config.jobs = this.config.jobs
            ? mergeJobRouters(this.config.jobs, router)
            : router;

        if (config)
        {
            this.config.jobsConfig = config;
        }

        return this;
    }

    /**
     * Register event router for SSE (Server-Sent Events)
     *
     * Enables real-time event streaming to frontend clients.
     * Events defined with defineEvent() can be subscribed by:
     * - Backend: .subscribe() for internal handlers
     * - Jobs: .on(event) for background processing
     * - Frontend: SSE stream for real-time updates
     *
     * @example
     * ```typescript
     * import { defineEvent, defineEventRouter } from '@spfn/core/event';
     *
     * const userCreated = defineEvent('user.created', Type.Object({
     *   userId: Type.String(),
     * }));
     *
     * const eventRouter = defineEventRouter({ userCreated });
     *
     * export default defineServerConfig()
     *   .routes(appRouter)
     *   .events(eventRouter)  // → GET /events/stream
     *   .build();
     *
     * // Custom path
     * .events(eventRouter, { path: '/sse' })
     * ```
     */
    events<TRouter extends EventRouterDef<any>>(
        router: TRouter,
        config?: Omit<SSEHandlerConfig, 'auth'> & { path?: string; auth?: SSEAuthConfig<TRouter> },
    ): this
    {
        this.config.events = router;
        if (config)
        {
            // SSEAuthConfig<TRouter> is assignable to SSEHandlerAuthConfig at runtime
            this.config.eventsConfig = config as SSEHandlerConfig & { path?: string };
        }

        return this;
    }

    /**
     * Register WebSocket router for bidirectional real-time communication
     *
     * Enables type-safe WebSocket connections with:
     * - Server→client event push (via defineEvent + emit)
     * - Client→server message handling (via messages in defineWSRouter)
     *
     * @example
     * ```typescript
     * // src/server/ws.ts
     * export const wsRouter = defineWSRouter({
     *     events: { userUpdated, notification },
     *     messages: {
     *         ping: ({ ws }) => ws.send('pong', {}),
     *     },
     * });
     *
     * // server.config.ts
     * export default defineServerConfig()
     *     .websockets(wsRouter)              // → WS /ws
     *     .websockets(wsRouter, {
     *         path: '/realtime',             // custom path
     *         auth: { enabled: true },       // token authentication
     *     })
     *     .build();
     * ```
     */
    websockets<
        TEvents extends Record<string, EventDef<any>>,
        TMessages extends WSMessageHandlers,
    >(
        router: WSRouterDef<TEvents, TMessages>,
        config?: Omit<WSHandlerConfig, 'auth'> & { path?: string; auth?: WSAuthConfig<WSRouterDef<TEvents, TMessages>> },
    ): this
    {
        this.config.websockets = router;
        if (config)
        {
            this.config.websocketsConfig = config as WSHandlerConfig & { path?: string };
        }

        return this;
    }

    /**
     * Enable/disable debug mode
     */
    debug(enabled: boolean): this
    {
        this.config.debug = enabled;

        return this;
    }

    /**
     * Configure database settings
     */
    database(database: ServerConfig['database']): this
    {
        this.config.database = database;

        return this;
    }

    /**
     * Configure server timeout settings
     */
    timeout(timeout: ServerConfig['timeout']): this
    {
        this.config.timeout = timeout;

        return this;
    }

    /**
     * Configure graceful shutdown settings
     */
    shutdown(shutdown: ServerConfig['shutdown']): this
    {
        this.config.shutdown = shutdown;

        return this;
    }

    /**
     * Configure health check endpoint
     */
    healthCheck(healthCheck: ServerConfig['healthCheck']): this
    {
        this.config.healthCheck = healthCheck;

        return this;
    }

    /**
     * Supply the clock used by the built-in `GET /_core/time` capability.
     * Production servers normally keep the default `Date.now()` clock; this is
     * exposed so tests can assert an exact wire value without replacing globals.
     */
    serverTime(serverTime: ServerConfig['serverTime']): this
    {
        this.config.serverTime = serverTime;

        return this;
    }

    /**
     * Configure infrastructure initialization
     */
    infrastructure(infrastructure: ServerConfig['infrastructure']): this
    {
        this.config.infrastructure = infrastructure;

        return this;
    }

    /**
     * Configure the migration boot gate
     *
     * @example
     * ```typescript
     * // A harness that applies migrations itself, after the server is up
     * export default defineServerConfig()
     *     .migrations({ allowPending: true })
     *     .build();
     * ```
     */
    migrations(migrations: ServerConfig['migrations']): this
    {
        this.config.migrations = migrations;

        return this;
    }

    /**
     * Hand the app's env registries to the boot check
     *
     * `@spfn/core`'s own registry is always checked; the registries given here
     * are checked with it, before the server listens.
     *
     * @example
     * ```typescript
     * import { envRegistry } from '@/server/config/env.config';
     *
     * export default defineServerConfig()
     *     .env({ registries: [envRegistry] })
     *     .build();
     * ```
     */
    env(env: ServerConfig['env']): this
    {
        this.config.env = env;

        return this;
    }

    /**
     * Register workflow router for workflow orchestration
     *
     * Automatically initializes the workflow engine after database is ready.
     *
     * @example
     * ```typescript
     * import { defineWorkflowRouter } from '@spfn/workflow';
     *
     * const workflowRouter = defineWorkflowRouter([
     *     provisionTenant,
     *     deprovisionTenant,
     * ]);
     *
     * export default defineServerConfig()
     *     .routes(appRouter)
     *     .workflows(workflowRouter)
     *     .build();
     * ```
     */
    workflows(
        router: ServerConfig['workflows'],
        config?: ServerConfig['workflowsConfig'],
    ): this
    {
        this.config.workflows = router;
        if (config)
        {
            this.config.workflowsConfig = config;
        }

        return this;
    }

    /**
     * Configure lifecycle hooks
     * Can be called multiple times - hooks will be executed in registration order
     */
    lifecycle(lifecycle: ServerConfig['lifecycle']): this
    {
        if (lifecycle)
        {
            this.lifecycles.push(lifecycle);
        }

        return this;
    }

    /**
     * Build and return the final configuration
     */
    build(): ServerConfig
    {
        if (this.lifecycles.length > 0)
        {
            serverLogger.info('Merging lifecycles', { count: this.lifecycles.length });
            this.config.lifecycle = this.mergeLifecycles();
        }

        return this.config;
    }

    private mergeLifecycles(): Lifecycle
    {
        return {
            beforeInfrastructure: createMergedHook(
                collectHooks(this.lifecycles, 'beforeInfrastructure'),
            ),
            afterInfrastructure: createMergedHook(
                collectHooks(this.lifecycles, 'afterInfrastructure'),
            ),
            beforeRoutes: createMergedHook(
                collectHooks(this.lifecycles, 'beforeRoutes'),
            ),
            afterRoutes: createMergedHook(
                collectHooks(this.lifecycles, 'afterRoutes'),
            ),
            afterStart: createMergedHook(
                collectHooks(this.lifecycles, 'afterStart'),
            ),
            beforeShutdown: createMergedHook(
                collectHooks(this.lifecycles, 'beforeShutdown'),
            ),
        };
    }
}

/**
 * Create a new server configuration builder
 *
 * @example
 * ```typescript
 * // server.config.ts
 * import { defineServerConfig, route, defineRouter } from '@spfn/core/server';
 * import { Type } from '@sinclair/typebox';
 *
 * const appRouter = defineRouter({
 *   getUser: route.get('/users/:id')
 *     .input({ params: Type.Object({ id: Type.String() }) })
 *     .handler(async (c) => {
 *       const { params } = await c.data();
 *       return { id: params.id, name: 'John' };
 *     }),
 * });
 *
 * export default defineServerConfig()
 *   .port(3000)
 *   .routes(appRouter)
 *   .middleware({ logger: true, cors: true })
 *   .debug(true)
 *   .build();
 * ```
 */
export function defineServerConfig(): ServerConfigBuilder
{
    return new ServerConfigBuilder();
}
