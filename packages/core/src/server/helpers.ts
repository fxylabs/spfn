import type { Hono, Handler, MiddlewareHandler } from 'hono';
import type { Server } from 'http';
import { Agent, setGlobalDispatcher } from 'undici';
import { getDatabase, migrationTargets } from '@spfn/core/db';
import { getCache } from '@spfn/core/cache';
import { env } from '@spfn/core/config';
import { getMigrationSnapshot } from './migration-gate';
import { getShutdownManager } from './shutdown-manager';
import type { NamedMiddleware, Router } from '@spfn/core/route';
import type { ServerConfig } from './types';

// ============================================================================
// Types
// ============================================================================

interface ServiceStatus
{
    status: string;
    error?: string;
}

interface MigrationTargetHealth
{
    name: string;
    total: number;
    applied: number;
    pending: number;
    pendingTags: string[];
}

/**
 * Migration drift as a readiness probe can see it.
 *
 * `status` is `unknown` when there was nothing to check (no database, no
 * migrations) or the check itself failed — never conflated with `up_to_date`.
 * The overall health `status` is deliberately left alone: reporting drift must
 * not, by itself, take a running deployment out of rotation. A probe that wants
 * that asserts `migrations.pending === 0` explicitly.
 */
interface MigrationHealth
{
    status: 'up_to_date' | 'pending' | 'unknown';
    pending: number;
    checkedAt: string;
    targets: MigrationTargetHealth[];
    reason?: string;
}

interface HealthCheckResponse
{
    status: 'ok' | 'degraded';
    timestamp: string;
    services?: {
        database: ServiceStatus;
        redis: ServiceStatus;
    };
    migrations?: MigrationHealth;
}

interface StartupConfig
{
    middleware: {
        logger: boolean;
        cors: boolean;
        errorHandler: boolean;
        custom: number;
    };
    healthCheck: {
        enabled: boolean;
        path?: string;
        detailed?: boolean;
    };
    hooks: {
        beforeRoutes: boolean;
        afterRoutes: boolean;
    };
    timeout: {
        request: string;
        keepAlive: string;
        headers: string;
    };
    shutdown: {
        timeout: string;
    };
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Read the cached migration snapshot and shape it for the health payload.
 *
 * The snapshot is recomputed at most once every 30 seconds, so a probe polling
 * every few seconds costs no extra database round-trips.
 */
async function readMigrationHealth(): Promise<MigrationHealth>
{
    const snapshot = await getMigrationSnapshot();

    if (snapshot.state !== 'ok')
    {
        return {
            status: 'unknown',
            pending: 0,
            checkedAt: snapshot.checkedAt,
            targets: [],
            reason: snapshot.reason,
        };
    }

    return {
        status: snapshot.pending > 0 ? 'pending' : 'up_to_date',
        pending: snapshot.pending,
        checkedAt: snapshot.checkedAt,
        targets: migrationTargets(snapshot.status),
    };
}

/**
 * A component the server was told not to initialize is reported as `disabled`
 * and never counts as an error. Without this a server declaring
 * `.infrastructure({ database: false })` answers 503 forever, so a readiness
 * probe never lets it into rotation.
 */
export function createHealthCheckHandler(
    detailed: boolean,
    infrastructure?: ServerConfig['infrastructure'],
): Handler
{
    return async (c) =>
    {
        // Return 503 immediately during shutdown (for k8s readiness probe)
        const shutdownManager = getShutdownManager();
        if (shutdownManager.isShuttingDown())
        {
            return c.json({
                status: 'shutting_down',
                timestamp: new Date().toISOString(),
            }, 503);
        }

        const response: HealthCheckResponse = {
            status: 'ok',
            timestamp: new Date().toISOString(),
        };

        if (detailed)
        {
            const databaseDisabled = infrastructure?.database === false;
            const redisDisabled = infrastructure?.redis === false;

            let dbStatus: string = 'unknown';
            let dbError: string | undefined;

            if (databaseDisabled)
            {
                dbStatus = 'disabled';
            }
            else
            {
                // Try to get database instance
                try
                {
                    const db = getDatabase();
                    try
                    {
                        await db.execute('SELECT 1');
                        dbStatus = 'connected';
                    }
                    catch (error)
                    {
                        dbStatus = 'error';
                        dbError = error instanceof Error ? error.message : String(error);
                    }
                }
                catch (error)
                {
                    // Database not initialized
                    dbStatus = 'not_initialized';
                    dbError = 'Database not available';
                }
            }

            const redis = redisDisabled ? null : getCache();
            let redisStatus: string = redisDisabled
                ? 'disabled'
                : (redis ? 'unknown' : 'not_initialized');
            let redisError: string | undefined;
            if (redis)
            {
                try
                {
                    await redis.ping();
                    redisStatus = 'connected';
                }
                catch (error)
                {
                    redisStatus = 'error';
                    redisError = error instanceof Error ? error.message : String(error);
                }
            }

            response.services = {
                database: {
                    status: dbStatus,
                    ...(dbError && { error: dbError }),
                },
                redis: {
                    status: redisStatus,
                    ...(redisError && { error: redisError }),
                },
            };

            const hasErrors =
                (dbStatus === 'error' || dbStatus === 'not_initialized') ||
                (redisStatus === 'error');
            response.status = hasErrors ? 'degraded' : 'ok';

            response.migrations = await readMigrationHealth();
        }

        const statusCode = response.status === 'ok' ? 200 : 503;

        return c.json(response, statusCode);
    };
}

/**
 * The named middleware guarding an endpoint the server registers by itself — the SSE
 * and WebSocket token endpoints. Those endpoints belong to no router, so they never
 * pass through `registerRoutes` and have to be handed their middleware directly.
 *
 * An app guards its routes from either level: `defineServerConfig().middlewares([...])`
 * or `defineRouter(...).use([...])`. Only the first lands in `config.middlewares` —
 * router-level middleware travels with the router — so both are collected here, or an
 * app that authenticates through its router would publish an unauthenticated token
 * endpoint. Names are deduplicated: a middleware present at both levels runs once.
 */
export function resolveEndpointMiddlewares(config: {
    middlewares?: ReadonlyArray<NamedMiddleware>;
    routes?: Router<any>;
}): NamedMiddleware[]
{
    const candidates: NamedMiddleware[] = [
        ...(config.middlewares ?? []),
        ...(config.routes?._globalMiddlewares ?? []),
    ];

    for (const pkgRouter of config.routes?._packageRouters ?? [])
    {
        candidates.push(...(pkgRouter._globalMiddlewares ?? []));
    }

    const seen = new Set<string>();

    return candidates.filter((mw) =>
    {
        // An unnamed entry is never collapsed — unrelated handlers share the empty name.
        if (!mw.name)
        {
            return true;
        }

        if (seen.has(mw.name))
        {
            return false;
        }

        seen.add(mw.name);

        return true;
    });
}

export function applyServerTimeouts(
    server: Server,
    timeouts: {
        request: number;
        keepAlive: number;
        headers: number;
    },
): void
{
    if ('timeout' in server)
    {
        server.timeout = timeouts.request;
        server.keepAliveTimeout = timeouts.keepAlive;
        server.headersTimeout = timeouts.headers;
    }
}

export function getTimeoutConfig(config?: {
    request?: number;
    keepAlive?: number;
    headers?: number;
}): {
    request: number;
    keepAlive: number;
    headers: number;
}
{
    return {
        request: config?.request ?? env.SERVER_TIMEOUT,
        keepAlive: config?.keepAlive ?? env.SERVER_KEEPALIVE_TIMEOUT,
        headers: config?.headers ?? env.SERVER_HEADERS_TIMEOUT,
    };
}

export function getShutdownTimeout(config?: { timeout?: number }): number
{
    return config?.timeout ?? env.SHUTDOWN_TIMEOUT;
}

export function getFetchTimeoutConfig(config?: {
    connect?: number;
    headers?: number;
    body?: number;
}): {
    connect: number;
    headers: number;
    body: number;
}
{
    return {
        connect: config?.connect ?? env.FETCH_CONNECT_TIMEOUT,
        headers: config?.headers ?? env.FETCH_HEADERS_TIMEOUT,
        body: config?.body ?? env.FETCH_BODY_TIMEOUT,
    };
}

export function applyGlobalFetchTimeouts(timeouts: {
    connect: number;
    headers: number;
    body: number;
}): void
{
    const agent = new Agent({
        connect: { timeout: timeouts.connect },
        headersTimeout: timeouts.headers,
        bodyTimeout: timeouts.body,
    });
    setGlobalDispatcher(agent);
}

export function buildMiddlewareOrder(config: {
    middleware?: {
        logger?: boolean;
        cors?: boolean;
        errorHandler?: boolean;
    };
    use?: MiddlewareHandler[];
    beforeRoutes?: (app: Hono) => void | Promise<void>;
    afterRoutes?: (app: Hono) => void | Promise<void>;
}): string[]
{
    const order: string[] = [];
    const middlewareConfig = config.middleware ?? {};
    const enableLogger = middlewareConfig.logger !== false;
    const enableCors = middlewareConfig.cors !== false;
    const enableErrorHandler = middlewareConfig.errorHandler !== false;

    if (enableLogger) order.push('RequestLogger');
    if (enableCors) order.push('CORS');
    config.use?.forEach((_, i) => order.push(`Custom[${i}]`));
    if (config.beforeRoutes) order.push('beforeRoutes hook');
    order.push('Routes');
    if (config.afterRoutes) order.push('afterRoutes hook');
    if (enableErrorHandler) order.push('ErrorHandler');

    return order;
}

export function buildStartupConfig(
    config: {
        middleware?: {
            logger?: boolean;
            cors?: boolean;
            errorHandler?: boolean;
        };
        use?: MiddlewareHandler[];
        healthCheck?: {
            enabled?: boolean;
            path?: string;
            detailed?: boolean;
        };
        beforeRoutes?: (app: Hono) => void | Promise<void>;
        afterRoutes?: (app: Hono) => void | Promise<void>;
        shutdown?: {
            timeout?: number;
        };
    },
    timeouts: {
        request: number;
        keepAlive: number;
        headers: number;
    },
): StartupConfig
{
    const middlewareConfig = config.middleware ?? {};
    const healthCheckConfig = config.healthCheck ?? {};
    const healthCheckEnabled = healthCheckConfig.enabled !== false;
    const healthCheckPath = healthCheckConfig.path ?? '/health';
    const healthCheckDetailed = healthCheckConfig.detailed ?? (env.NODE_ENV === 'development');

    return {
        middleware: {
            logger: middlewareConfig.logger !== false,
            cors: middlewareConfig.cors !== false,
            errorHandler: middlewareConfig.errorHandler !== false,
            custom: config.use?.length ?? 0,
        },
        healthCheck: healthCheckEnabled ? {
            enabled: true,
            path: healthCheckPath,
            detailed: healthCheckDetailed,
        } : { enabled: false },
        hooks: {
            beforeRoutes: !!config.beforeRoutes,
            afterRoutes: !!config.afterRoutes,
        },
        timeout: {
            request: `${timeouts.request}ms`,
            keepAlive: `${timeouts.keepAlive}ms`,
            headers: `${timeouts.headers}ms`,
        },
        shutdown: {
            timeout: `${config.shutdown?.timeout ?? env.SHUTDOWN_TIMEOUT}ms`,
        },
    };
}
