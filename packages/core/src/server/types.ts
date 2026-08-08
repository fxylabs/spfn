import type { Hono, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { serve } from '@hono/node-server';
import type { Router, NamedMiddleware } from '@spfn/core/route';
import type { OnErrorContext, ProxyGuardConfig, RateLimitOptions } from '@spfn/core/middleware';
import type { SafeFetchPolicy } from '@spfn/core/security';
import type { JobRouter, BossOptions } from '../job';
import type { EventRouterDef } from '../event/router';
import type { SSEHandlerConfig } from '../event/sse/types';
import type { WSRouterDef, WSHandlerConfig } from '../event/ws/types';
import type { DatabaseProvider } from '@spfn/core/db';

/**
 * Workflow router interface for @spfn/core integration
 *
 * This is a minimal interface that avoids circular dependency with @spfn/workflow.
 * The actual WorkflowRouter from @spfn/workflow implements this interface.
 */
export interface WorkflowRouterLike
{
    /**
     * Initialize the workflow engine
     * Called by server during infrastructure initialization
     *
     * @internal
     */
     
    _init: (db: any, options?: { largeOutputThreshold?: number }) => void;
}

/**
 * CORS configuration options - inferred from hono/cors
 */
type CorsConfig = Parameters<typeof cors>[0];

/**
 * Server Configuration Options
 *
 * Level 2: Partial customization with server.config.ts
 */
export interface ServerConfig
{
    /**
     * Server port (default: 4000)
     */
    port?: number;

    /**
     * Server hostname (default: 'localhost')
     */
    host?: string;

    /**
     * CORS configuration
     * Set to false to disable default CORS middleware
     */
    cors?: CorsConfig | false;

    /**
     * Enable/disable built-in middleware
     */
    middleware?:
    {
        /**
         * Request logger (default: true)
         */
        logger?: boolean;

        /**
         * CORS (default: true)
         */
        cors?: boolean;

        /**
         * Error handler (default: true)
         */
        errorHandler?: boolean;

        /**
         * Callback invoked when an error occurs (passed to ErrorHandler)
         *
         * Called asynchronously without blocking the response.
         *
         * @example
         * ```typescript
         * import { createErrorSlackNotifier } from '@spfn/notification/server';
         *
         * middleware: {
         *     onError: createErrorSlackNotifier({ minStatusCode: 500 }),
         * }
         * ```
         */
        onError?: (
            err: Error,
            context: OnErrorContext,
        ) => Promise<void> | void;
    };

    /**
     * Additional custom middleware
     */
    use?: MiddlewareHandler[];

    /**
     * Proxy-guard: verify requests came through the trusted Next.js RPC proxy
     * (HMAC signature) and/or an allowed browser origin, then tag `clientType`.
     * Lets the backend reject direct-to-backend calls that bypass the proxy.
     *
     * Disabled by default (`mode: 'off'`). Requires the same `SPFN_PROXY_SECRET`
     * on the proxy and the backend. See PROXY-BACKEND-AUTH-SPEC.md.
     *
     * @example
     * ```typescript
     * .proxyGuard({ mode: 'strict', allowedOrigins: ['https://app.example.com'] })
     * ```
     */
    proxyGuard?: Omit<ProxyGuardConfig, 'nonceStore'> & {
        /**
         * Enable hard replay rejection via a Redis nonce store. Evaluated in BOTH modes
         * (tag observes replays, strict rejects). Requires a cache (CACHE_URL); without
         * one, falls back to the timestamp window. Degrades to the window if the store
         * is briefly unavailable. @default false
         */
        nonce?: boolean;
    };

    /**
     * Rate limiting: an optional global default limiter plus named policies.
     *
     * `mode: 'on'` applies `default` to every named-middleware route (opt out
     * with `.skip(['rateLimit'])`); `policies` lets packages tag sensitive routes
     * via `rateLimitPolicy(name, fallback)` while this app tunes the numbers in
     * one place. Backed by the shared cache (CACHE_URL); without a cache it fails
     * open unless `default.failClosed` is set. Disabled by default (`mode: 'off'`).
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
    rateLimit?: {
        /** 'on' applies the default limiter to every route. @default 'off' */
        mode?: 'off' | 'on';

        /** Default policy applied to all routes when `mode` is 'on'. */
        default?: RateLimitOptions;

        /** Named policies referenced by `rateLimitPolicy(name, fallback)` tags. */
        policies?: Record<string, RateLimitOptions>;
    };

    /**
     * SSRF policy for outbound requests made via `safeFetch` (`@spfn/core/security`).
     * Sets the process-wide default used by webhook/callback senders. Private and
     * reserved IPs are blocked by default; set `allowHosts` to restrict to a known
     * set of upstreams, or `blockPrivateIps: false` for trusted internal calls.
     *
     * @example
     * ```typescript
     * .outboundFetch({ allowHosts: ['hooks.slack.com'] })
     * ```
     */
    outboundFetch?: SafeFetchPolicy;

    /**
     * Global middlewares with names for route-level skip control
     * Use defineMiddleware() for type-safe middleware definitions
     *
     * @example
     * ```typescript
     * import { defineMiddleware } from '@spfn/core/server';
     *
     * const authMiddleware = defineMiddleware('auth', async (c, next) => {
     *   // auth logic
     *   await next();
     * });
     *
     * export default defineServerConfig()
     *   .middlewares([authMiddleware, rateLimitMiddleware])
     *   .build();
     * ```
     */
    middlewares?: readonly NamedMiddleware[];

    /**
     * define-route based router
     * Routes defined with route.get()...handler() style
     * Will be automatically registered before file-based routes
     *
     * @example
     * ```typescript
     * import { defineRouter, route } from '@spfn/core/route';
     *
     * const appRouter = defineRouter({
     *   getUser: route.get('/users/:id')...
     *   createUser: route.post('/users')...
     * });
     *
     * export default defineServerConfig()
     *   .routes(appRouter)
     *   .build();
     * ```
     */
    routes?: Router<any>;

    /**
     * Background jobs router
     * Jobs defined with job()...handler() style
     * Uses pg-boss for PostgreSQL-based job queue
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
     *   .jobs(jobRouter)
     *   .build();
     * ```
     */
    jobs?: JobRouter<any>;

    /**
     * pg-boss configuration options
     * Only used if jobs router is provided
     */
    jobsConfig?: Omit<BossOptions, 'connectionString'>;

    /**
     * Event router for SSE (Server-Sent Events) subscription
     * Enables real-time event streaming to frontend clients
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
     * ```
     */
    events?: EventRouterDef<any>;

    /**
     * SSE configuration options
     * Only used if events router is provided
     */
    eventsConfig?: SSEHandlerConfig & {
        /**
         * SSE endpoint path
         * @default '/events/stream'
         */
        path?: string;
    };

    /**
     * WebSocket router for bidirectional real-time communication
     *
     * @example
     * ```typescript
     * import { defineWSRouter } from '@spfn/core/event/ws';
     *
     * export default defineServerConfig()
     *   .websockets(wsRouter)       // → WS /ws
     *   .build();
     * ```
     */
    websockets?: WSRouterDef<any, any>;

    /**
     * WebSocket configuration options
     * Only used if websockets router is provided
     */
    websocketsConfig?: WSHandlerConfig & {
        /**
         * WebSocket endpoint path
         * @default '/ws'
         */
        path?: string;
    };

    /**
     * Enable debug mode (default: NODE_ENV === 'development')
     */
    debug?: boolean;

    /**
     * Database configuration
     */
    database?: {
        /**
         * Externally owned PostgreSQL Drizzle provider.
         *
         * When supplied, SPFN skips DATABASE_URL/postgres.js initialization
         * and closes the provider during graceful shutdown.
         */
        provider?: DatabaseProvider;

        /**
         * Connection pool configuration
         * Overrides environment variables and defaults
         */
        pool?: {
            /**
             * Maximum number of connections in pool
             * @default Production: 20, Development: 10
             * @env DB_POOL_MAX
             */
            max?: number;

            /**
             * Idle connection timeout in seconds
             * @default Production: 30, Development: 20
             * @env DB_POOL_IDLE_TIMEOUT
             */
            idleTimeout?: number;
        };

        /**
         * Health check configuration
         * Periodic checks to ensure database connection is alive
         */
        healthCheck?: {
            /**
             * Enable/disable health checks
             * @default true
             * @env DB_HEALTH_CHECK_ENABLED
             */
            enabled?: boolean;

            /**
             * Health check interval in milliseconds
             * @default 60000 (60 seconds)
             * @env DB_HEALTH_CHECK_INTERVAL
             */
            interval?: number;

            /**
             * Enable automatic reconnection on failure
             * @default true
             * @env DB_HEALTH_CHECK_RECONNECT
             */
            reconnect?: boolean;

            /**
             * Maximum reconnection attempts
             * @default 3
             * @env DB_HEALTH_CHECK_MAX_RETRIES
             */
            maxRetries?: number;

            /**
             * Delay between reconnection attempts in milliseconds
             * @default 5000 (5 seconds)
             * @env DB_HEALTH_CHECK_RETRY_INTERVAL
             */
            retryInterval?: number;
        };

        /**
         * Query performance monitoring configuration
         * Tracks slow queries and logs performance metrics
         */
        monitoring?: {
            /**
             * Enable/disable query performance monitoring
             * @default true in development, false in production
             * @env DB_MONITORING_ENABLED
             */
            enabled?: boolean;

            /**
             * Slow query threshold in milliseconds
             * Queries exceeding this duration will be logged as warnings
             * @default 1000 (1 second)
             * @env DB_MONITORING_SLOW_THRESHOLD
             */
            slowThreshold?: number;

            /**
             * Log actual SQL queries in performance logs
             * ⚠️ Warning: May expose sensitive data in logs
             * @default false
             * @env DB_MONITORING_LOG_QUERIES
             */
            logQueries?: boolean;
        };
    };

    /**
     * Server timeout configuration
     * Controls HTTP server timeout behavior for security and resource management
     */
    timeout?: {
        /**
         * Request timeout in milliseconds
         * Time limit for entire request/response cycle
         * Set to 0 to disable (not recommended in production)
         * @default 120000 (2 minutes)
         * @env SERVER_TIMEOUT
         */
        request?: number;

        /**
         * Keep-alive timeout in milliseconds
         * How long to keep idle HTTP connections open for reuse
         * Should be slightly longer than load balancer timeout (typically 60s)
         * @default 65000 (65 seconds)
         * @env SERVER_KEEPALIVE_TIMEOUT
         */
        keepAlive?: number;

        /**
         * Headers timeout in milliseconds
         * Time limit for receiving complete HTTP request headers
         * Protects against Slowloris attacks
         * @default 60000 (60 seconds)
         * @env SERVER_HEADERS_TIMEOUT
         */
        headers?: number;
    };

    /**
     * Fetch (outbound HTTP) timeout configuration
     * Controls Node.js undici global dispatcher timeouts for fetch() calls
     * Applies to all outbound HTTP requests made via fetch() in this process
     */
    fetchTimeout?: {
        /**
         * TCP connection timeout in milliseconds
         * Time to establish socket connection to upstream server
         * @default 10000 (10 seconds)
         * @env FETCH_CONNECT_TIMEOUT
         */
        connect?: number;

        /**
         * Response headers timeout in milliseconds
         * Time to receive complete response headers after request sent
         * @default 300000 (5 minutes)
         * @env FETCH_HEADERS_TIMEOUT
         */
        headers?: number;

        /**
         * Body data timeout in milliseconds
         * Maximum time between body data chunks from upstream server
         * @default 300000 (5 minutes)
         * @env FETCH_BODY_TIMEOUT
         */
        body?: number;
    };

    /**
     * Graceful shutdown configuration
     * Controls server shutdown behavior during SIGTERM/SIGINT signals
     */
    shutdown?: {
        /**
         * Graceful shutdown timeout in milliseconds
         * Maximum time to wait for in-flight operations to drain and resource cleanup
         * After timeout, forces process.exit() before k8s SIGKILL
         *
         * Formula: terminationGracePeriodSeconds - preStopSleep - safetyMargin
         * Default: 300s - 5s - 15s = 280s
         *
         * @default 280000 (280 seconds)
         * @env SHUTDOWN_TIMEOUT
         */
        timeout?: number;
    };

    /**
     * Health check endpoint configuration
     * Provides monitoring endpoints for Kubernetes probes and load balancers
     */
    healthCheck?: {
        /**
         * Enable health check endpoint
         * @default true
         * @env HEALTH_CHECK_ENABLED
         */
        enabled?: boolean;

        /**
         * Health check endpoint path
         * @default '/health'
         * @env HEALTH_CHECK_PATH
         */
        path?: string;

        /**
         * Include detailed status (DB, Redis, etc.)
         * Detailed mode checks connectivity to external services
         * @default false in production, true in development
         * @env HEALTH_CHECK_DETAILED
         */
        detailed?: boolean;
    };

    /**
     * Migration boot gate
     *
     * Before serving, the server compares the migrations shipped by installed
     * function packages (and by `src/server/drizzle`) against what the database
     * records as applied, and refuses to start when any are still pending —
     * otherwise the mismatch surfaces only at request time, as an opaque 500.
     *
     * Skipped when the app initializes no database or ships no migrations.
     */
    migrations?: {
        /**
         * Start anyway when migrations are pending, logging a warning that lists
         * them. The environment equivalent is `SPFN_ALLOW_PENDING_MIGRATIONS=true`;
         * this field wins over it.
         *
         * @default false
         * @env SPFN_ALLOW_PENDING_MIGRATIONS
         */
        allowPending?: boolean;
    };

    /**
     * Infrastructure initialization control
     * Controls automatic initialization of database and Redis
     *
     * Both are initialized unless set to `false` — the credentials are not
     * sniffed. A server that needs no database must say so, otherwise boot
     * fails with `No database configuration found`. A component set to `false`
     * is reported as `disabled` by the health endpoint and never degrades it.
     *
     * @default Both enabled
     */
    infrastructure?: {
        /**
         * Enable/disable automatic database initialization
         * @default true
         */
        database?: boolean;

        /**
         * Enable/disable automatic Redis initialization
         * @default true
         */
        redis?: boolean;
    };

    /**
     * Workflow router for workflow orchestration
     *
     * Automatically initializes the workflow engine after database is ready.
     * Workflows are defined using @spfn/workflow package.
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
     *     .workflows(workflowRouter)
     *     .build();
     * ```
     */
    workflows?: WorkflowRouterLike;

    /**
     * Workflow engine configuration
     * Only used if workflows router is provided
     */
    workflowsConfig?: {
        /**
         * Large output threshold in bytes
         * Outputs larger than this will be stored in external storage
         * @default 1024 * 1024 (1MB)
         */
        largeOutputThreshold?: number;
    };

    /**
     * Server lifecycle hooks for custom infrastructure setup and management
     * Allows initialization of custom services and resources at different stages
     */
    lifecycle?: {
        /**
         * Hook: Run before infrastructure initialization
         * Execute before database and Redis are initialized
         * Use this for pre-initialization setup (logging, monitoring, etc.)
         *
         * @param config - The final server configuration
         * @example
         * ```typescript
         * beforeInfrastructure: async (config) => {
         *   await initMonitoring();
         *   await setupCustomLogger();
         * }
         * ```
         */
        beforeInfrastructure?: (config: ServerConfig) => Promise<void>;

        /**
         * Hook: Run after infrastructure (DB/Redis) is initialized
         * Database and Redis instances are available via getDatabase() and getRedis()
         * Use this for:
         * - Running migrations
         * - Seeding initial data
         * - Initializing services that depend on DB/Redis
         *
         * @example
         * ```typescript
         * import { getDatabase } from '@spfn/core/db';
         * import { migrate } from 'drizzle-orm/postgres-js/migrator';
         *
         * afterInfrastructure: async () => {
         *   const db = getDatabase();
         *   await migrate(db, { migrationsFolder: './drizzle' });
         *   await seedInitialData(db);
         * }
         * ```
         */
        afterInfrastructure?: () => Promise<void>;

        /**
         * Hook: Run before routes are loaded
         * Use this to add global middleware or prepare the app before routes
         *
         * @param app - The Hono app instance
         * @example
         * ```typescript
         * beforeRoutes: async (app) => {
         *   app.use('/*', globalMiddleware());
         * }
         * ```
         */
        beforeRoutes?: (app: Hono) => void | Promise<void>;

        /**
         * Hook: Run after routes are loaded
         * Use this to add fallback handlers or final middleware
         *
         * @param app - The Hono app instance
         * @example
         * ```typescript
         * afterRoutes: async (app) => {
         *   app.notFound((c) => c.json({ error: 'Not Found' }, 404));
         * }
         * ```
         */
        afterRoutes?: (app: Hono) => void | Promise<void>;

        /**
         * Hook: Run after server starts successfully
         * Server is listening and ready to accept requests
         * Receives the server instance for runtime access
         *
         * @param instance - The server instance with server, app, config, and close()
         * @example
         * ```typescript
         * afterStart: async (instance) => {
         *   console.log(`Server ready at http://${instance.config.host}:${instance.config.port}`);
         *   await notifyHealthCheckService();
         * }
         * ```
         */
        afterStart?: (instance: ServerInstance) => Promise<void>;

        /**
         * Hook: Run before graceful shutdown
         * Infrastructure (DB/Redis) is still available
         * Use this to cleanup custom resources and services
         *
         * @example
         * ```typescript
         * beforeShutdown: async () => {
         *   await closeMessageQueue();
         *   await closeSearchService();
         * }
         * ```
         */
        beforeShutdown?: () => Promise<void>;
    };
}

/**
 * App Factory Function
 *
 * Level 3: Full control with app.ts
 */
export type AppFactory = () => Promise<Hono> | Hono;

/**
 * Server Instance
 *
 * Returned by startServer() to provide access to server internals
 * Allows programmatic control over the server lifecycle
 */
export interface ServerInstance
{
    /**
     * Underlying Node.js HTTP server
     * Provides low-level access to the HTTP server instance
     */
    server: ReturnType<typeof serve>;

    /**
     * Hono app instance
     * Allows runtime route registration and middleware management
     */
    app: Hono;

    /**
     * Final server configuration used
     * Contains resolved values from all sources (runtime > file > env > defaults)
     */
    config: ServerConfig;

    /**
     * Manually close the server
     * Performs graceful shutdown: stops accepting connections, closes DB/Redis, exits process
     *
     * @example
     * ```typescript
     * const instance = await startServer({ port: 3000 });
     *
     * // Later...
     * await instance.close(); // Clean shutdown
     * ```
     */
    close: () => Promise<void>;
}
