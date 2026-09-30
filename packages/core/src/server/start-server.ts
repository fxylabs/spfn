/**
 * Start SPFN Server
 *
 * Starts and configures the SPFN HTTP server with graceful shutdown.
 */

import { serve } from '@hono/node-server';
import { existsSync } from 'fs';
import type { Context, Hono } from 'hono';
import type { Server } from 'http';
import { join } from 'path';

import { closeCache, initCache } from '@spfn/core/cache';
import { closeDatabase, initDatabase, getDatabase } from '@spfn/core/db';
import { initBoss, stopBoss, registerJobs } from '../job';
import { attachWSHandler } from '../event/ws/handler';
import { SSETokenManager, CacheTokenStore } from '../event/sse/token-manager';
import { wireEventRouterCache, closeEventTransport } from '../event/cache-transport';
import { serverLogger } from './logger';
import { printBanner } from './banner';
import { createServer } from './create-server';
import { loadEnv } from '../env/loader';
import { loadAppConfig, resolveServerAddress } from '../app-config';
import {
    applyServerTimeouts,
    applyGlobalFetchTimeouts,
    buildMiddlewareOrder,
    buildStartupConfig,
    getFetchTimeoutConfig,
    getShutdownTimeout,
    getTimeoutConfig,
    resolveEndpointMiddlewares,
} from './helpers';
import { runEnvBootCheck } from './env-boot-check';
import { runMigrationBootGate } from './migration-gate';
import { getShutdownManager, resetShutdownManager } from './shutdown-manager';

import type { ServerConfig, ServerInstance } from './types';
import { validateServerConfig } from './validation';
import { env } from '@spfn/core/config';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_LISTENERS = 15;

const TIMEOUTS = {
    SERVER_CLOSE: 5000,
    DATABASE_CLOSE: 5000,
    REDIS_CLOSE: 5000,
    PRODUCTION_ERROR_SHUTDOWN: 10000,
} as const;

/**
 * Where a compiled `server.config` can be, in the order it is looked for.
 *
 * Both extensions are listed because `spfn build` runs tsup, and tsup picks the
 * extension from the app's `package.json`: `.mjs` normally, `.js` when the app
 * declares `"type": "module"`. Only `.mjs` used to be listed, so an app with
 * that declaration silently lost its entire configuration in production — no
 * middlewares, no routes, no infrastructure switches — and the raw
 * `src/server/server.config.ts` fallback cannot stand in, because plain node
 * resolves neither TypeScript nor the `@/` path aliases the file is written
 * with.
 */
const CONFIG_FILE_PATHS = [
    '.spfn/server/server.config.mjs',
    '.spfn/server/server.config.js',
    '.spfn/server/server.config',
    'src/server/server.config',
    'src/server/server.config.ts',
] as const;

/**
 * The config the app wrote, as opposed to a config file the build produced.
 * Its presence means the app meant to configure the server, which is what makes
 * loading nothing worth reporting.
 */
const AUTHORED_CONFIG_PATH = 'src/server/server.config.ts';

// ============================================================================
// Types
// ============================================================================

interface InfrastructureConfig
{
    database: boolean;
    redis: boolean;
}

/**
 * Shutdown state manager to prevent race conditions
 */
interface ShutdownState
{
    isShuttingDown: boolean;
}

// ============================================================================
// Module State
// ============================================================================

/**
 * Track whether process-level shutdown handlers have been registered
 * Process handlers should only be registered once
 */
let processHandlersRegistered = false;

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Start SPFN server
 *
 * Automatically loads server.config.ts if exists
 * Validates the environment (core's registry + `config.env.registries`) and
 * exits with code 1 when a variable is missing or invalid
 * Automatically initializes Database and Redis from environment
 * Sets up graceful shutdown handlers for SIGTERM and SIGINT
 *
 * @returns ServerInstance with server, app, config, and close() method
 */
export async function startServer(config?: ServerConfig): Promise<ServerInstance>
{
    loadEnv();

    const finalConfig = await loadAndMergeConfig(config);

    // As soon as the app's registries are known — they come with server.config.
    // A missing variable stops the boot here instead of failing a request later.
    if (!runEnvBootCheck(finalConfig).valid)
    {
        serverLogger.error('Refusing to start: fix the environment variables listed above.');
        process.exit(1);
    }

    const { host, port, debug } = finalConfig;

    validateServerConfig(finalConfig);

    // Validate required config values
    if (!host || !port)
    {
        throw new Error('Server host and port are required');
    }

    if (debug)
    {
        logMiddlewareOrder(finalConfig);
    }

    // Create shutdown state for this server instance
    const shutdownState: ShutdownState = {
        isShuttingDown: false,
    };

    try
    {
        await initializeInfrastructure(finalConfig);

        // Pending migrations become an opaque 500 on the first request that touches
        // a missing column — refuse here instead, where the fix is one command.
        await runMigrationBootGate(finalConfig);

        const app = await createServer(finalConfig);
        const server = startHttpServer(app, host, port);

        // Initialize WebSocket server if configured
        let wsCleanup: (() => Promise<void>) | undefined;
        if (finalConfig.websockets)
        {
            wsCleanup = await initializeWebSocket(server as Server, app, finalConfig);
        }

        const timeouts = getTimeoutConfig(finalConfig.timeout);
        applyServerTimeouts(server as Server, timeouts);

        const fetchTimeouts = getFetchTimeoutConfig(finalConfig.fetchTimeout);
        applyGlobalFetchTimeouts(fetchTimeouts);

        logServerTimeouts(timeouts);
        printBanner({
            mode: debug ? 'Development' : 'Production',
            host,
            port,
        });

        logServerStarted(debug, host, port, finalConfig, timeouts);

        const shutdownServer = createShutdownHandler(server as Server, finalConfig, shutdownState, wsCleanup);
        const shutdown = createGracefulShutdown(shutdownServer, finalConfig, shutdownState);

        // Register process-level handlers
        registerProcessHandlers(shutdown);

        const serverInstance: ServerInstance = {
            server,
            app,
            config: finalConfig,
            close: async () =>
            {
                serverLogger.info('Manual server shutdown requested');
                await shutdownServer();
            },
        };

        // Execute afterStart hook from config
        if (finalConfig.lifecycle?.afterStart)
        {
            serverLogger.debug('Executing afterStart hook...');
            try
            {
                await finalConfig.lifecycle.afterStart(serverInstance);
            }
            catch (error)
            {
                serverLogger.error('afterStart hook failed', error as Error);
                // Don't throw - server is already running
                // Just log the error and continue
            }
        }

        return serverInstance;
    }
    catch (error)
    {
        const err = error as Error;
        serverLogger.error('Server initialization failed', err);

        await cleanupOnFailure(finalConfig);

        throw error;
    }
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * `cwd` is a parameter so a test can point at a fixture directory without
 * moving the whole process, which the rest of the suite would notice.
 */
export async function loadAndMergeConfig(
    config?: ServerConfig,
    cwd: string = process.cwd(),
): Promise<ServerConfig>
{
    let fileConfig: ServerConfig = {};
    let loadedConfigPath: string | null = null;

    // Try loading config files in priority order
    for (const configPath of CONFIG_FILE_PATHS)
    {
        const fullPath = join(cwd, configPath);
        if (existsSync(fullPath))
        {
            try
            {
                const configModule = await import(fullPath);
                fileConfig = configModule.default ?? {};
                loadedConfigPath = configPath;
                break;
            }
            catch (error)
            {
                serverLogger.error(`Failed to load config from ${configPath} - file exists but import failed`, error as Error);
                // Continue trying other config files instead of failing
            }
        }
    }

    if (loadedConfigPath)
    {
        serverLogger.debug(`Loaded configuration from ${loadedConfigPath}`);
    }
    else if (existsSync(join(cwd, AUTHORED_CONFIG_PATH)))
    {
        // The app wrote a configuration and the server is running without it.
        // Reported at warn, because the failure is otherwise invisible: the
        // server starts, and what is missing — middlewares, routes,
        // infrastructure switches — only shows up as behaviour nobody asked for.
        serverLogger.warn(
            `⚠️  ${AUTHORED_CONFIG_PATH} exists but no configuration was loaded, so this server `
            + 'is running on defaults: no middlewares, no routes and no infrastructure settings '
            + 'from it. Run "spfn build" so the compiled config lands in .spfn/server/.',
        );
    }
    else
    {
        serverLogger.debug('No configuration file found, using defaults');
    }

    const appConfig = await loadAppConfig(cwd);

    warnOnDeprecatedAddress(config, fileConfig);

    // Three layers and no more: environment, spfn.config.js, default. The
    // deprecated `.port()` / `.host()` sit between the file and the default
    // until they are removed, so an app that has not moved yet keeps its
    // address.
    const address = resolveServerAddress(appConfig, {
        port: config?.port ?? fileConfig?.port,
        host: config?.host ?? fileConfig?.host,
    });

    return {
        ...fileConfig,
        ...config,
        port: address.port,
        host: address.host,
    };
}

/**
 * `.port()` and `.host()` moved to `spfn.config.js`, where both ports sit side
 * by side and every deployment file can read them. They keep working for one
 * release; this is the only notice an app gets.
 */
function warnOnDeprecatedAddress(config?: ServerConfig, fileConfig?: ServerConfig): void
{
    const used = [
        (config?.port ?? fileConfig?.port) !== undefined ? '.port()' : null,
        (config?.host ?? fileConfig?.host) !== undefined ? '.host()' : null,
    ].filter(Boolean);

    if (used.length > 0)
    {
        serverLogger.warn(
            `⚠️  ${used.join(' and ')} in server.config is deprecated and will be removed. `
            + 'Move the address to spfn.config.js — `ports: { next, server }` and `host` — '
            + 'so the Dockerfile, the compose file and next.config can read the same value.',
        );
    }
}

// ============================================================================
// Infrastructure Management
// ============================================================================

/**
 * Determine which infrastructure components should be initialized
 */
function getInfrastructureConfig(config: ServerConfig): InfrastructureConfig
{
    return {
        database: config.infrastructure?.database !== false,
        redis: config.infrastructure?.redis !== false,
    };
}

async function initializeInfrastructure(config: ServerConfig): Promise<void>
{
    if (config.lifecycle?.beforeInfrastructure)
    {
        serverLogger.debug('Executing beforeInfrastructure hook...');
        await config.lifecycle.beforeInfrastructure(config);
    }

    const infraConfig = getInfrastructureConfig(config);

    if (infraConfig.database)
    {
        serverLogger.debug('Initializing database...');
        await initDatabase(config.database);
    }
    else
    {
        serverLogger.debug('Database initialization disabled');
    }

    if (infraConfig.redis)
    {
        serverLogger.debug('Initializing Redis...');
        await initCache();
    }
    else
    {
        serverLogger.debug('Redis initialization disabled');
    }

    if (config.lifecycle?.afterInfrastructure)
    {
        serverLogger.debug('Executing afterInfrastructure hook...');
        await config.lifecycle.afterInfrastructure();
    }

    // Initialize jobs if configured
    if (config.jobs)
    {
        const dbUrl = env.DATABASE_URL;
        if (!dbUrl)
        {
            throw new Error(
                'Jobs require database connection. ' +
                'Ensure DATABASE_URL is set or database is enabled.',
            );
        }

        serverLogger.debug('Initializing pg-boss...');
        await initBoss({
            connectionString: dbUrl,
            ...config.jobsConfig,
        });

        serverLogger.debug('Registering jobs...');
        await registerJobs(config.jobs);
    }

    // Initialize workflows if configured
    if (config.workflows)
    {
        const infraConfig = getInfrastructureConfig(config);
        if (!infraConfig.database)
        {
            throw new Error(
                'Workflows require database connection. ' +
                'Ensure database is enabled in infrastructure config.',
            );
        }

        serverLogger.debug('Initializing workflow engine...');
        config.workflows._init(
            getDatabase(),
            config.workflowsConfig,
        );
        serverLogger.info('Workflow engine initialized');
    }
}

// ============================================================================
// HTTP Server Management
// ============================================================================

function startHttpServer(app: Hono, host: string, port: number): ReturnType<typeof serve>
{
    serverLogger.debug(`Starting server on ${host}:${port}...`);

    return serve({
        fetch: app.fetch,
        port,
        hostname: host,
    });
}

async function initializeWebSocket(
    server: Server,
    app: Hono,
    config: ServerConfig,
): Promise<() => Promise<void>>
{
    const wsRouter = config.websockets!;
    const wsConfig = config.websocketsConfig ?? {};
    const authConfig = wsConfig.auth;
    const wsPath = wsConfig.path ?? '/ws';
    const debug = config.debug ?? process.env.NODE_ENV === 'development';

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
                    if (debug) serverLogger.info('WS token store: cache (Redis/Valkey)');
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

        // Register the WS token endpoint on the Hono app. The path replaces the WS
        // path's last segment with `token`, so the default '/ws' becomes '/token'.
        const tokenPath = wsPath.replace(/\/[^/]+$/, '/token');
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

        if (debug) serverLogger.info(`✓ WS token endpoint registered at POST ${tokenPath}`);
    }

    // Auto-wire cross-pod event broadcast (Redis pub/sub) for WS events.
    // Events shared with the SSE router are wired once; no-op without a cache.
    await wireEventRouterCache(wsRouter, {
        multiInstance: wsConfig.multiInstance,
        channelPrefix: wsConfig.channelPrefix,
    });

    return await attachWSHandler(server, wsRouter, wsConfig, tokenManager);
}

function logMiddlewareOrder(config: ServerConfig): void
{
    const middlewareOrder = buildMiddlewareOrder(config);
    serverLogger.debug('Middleware execution order', {
        order: middlewareOrder,
    });
}

function logServerTimeouts(timeouts: {
    request: number;
    keepAlive: number;
    headers: number;
}): void
{
    serverLogger.info('Server timeouts configured', {
        request: `${timeouts.request}ms`,
        keepAlive: `${timeouts.keepAlive}ms`,
        headers: `${timeouts.headers}ms`,
    });
}

function logServerStarted(
    debug: boolean | undefined,
    host: string,
    port: number,
    config: ServerConfig,
    timeouts: { request: number; keepAlive: number; headers: number },
): void
{
    const startupConfig = buildStartupConfig(config, timeouts);

    serverLogger.info('Server started successfully', {
        mode: debug ? 'development' : 'production',
        host,
        port,
        config: startupConfig,
    });
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

function createShutdownHandler(
    server: Server,
    config: ServerConfig,
    shutdownState: ShutdownState,
    wsCleanup?: () => Promise<void>,
): () => Promise<void>
{
    return async () =>
    {
        // Prevent re-entry
        if (shutdownState.isShuttingDown)
        {
            serverLogger.debug('Shutdown already in progress for this instance, skipping');

            return;
        }

        shutdownState.isShuttingDown = true;

        const shutdownTimeout = getShutdownTimeout(config.shutdown);
        const shutdownManager = getShutdownManager();

        // Immediately mark as draining so health check returns 503
        // and trackOperation() rejects new work
        shutdownManager.beginShutdown();

        // ── Phase 1: Stop accepting new connections ──
        serverLogger.info('Phase 1: Closing HTTP server (stop accepting new connections)...');
        await closeHttpServer(server);

        // ── Phase 1.5: Close WebSocket server ──
        if (wsCleanup)
        {
            serverLogger.info('Phase 1.5: Closing WebSocket server...');
            try
            {
                await wsCleanup();
                serverLogger.info('WebSocket server closed');
            }
            catch (error)
            {
                serverLogger.error('WebSocket server close failed', error as Error);
            }
        }

        // ── Phase 2: Stop pg-boss (stop accepting new jobs) ──
        if (config.jobs)
        {
            serverLogger.info('Phase 2: Stopping pg-boss...');
            try
            {
                await stopBoss();
                serverLogger.info('pg-boss stopped');
            }
            catch (error)
            {
                serverLogger.error('pg-boss stop failed', error as Error);
            }
        }

        // ── Phase 3: Drain — wait for all tracked operations to complete ──
        // Use 80% of remaining shutdown timeout for drain + hooks
        const drainTimeout = Math.floor(shutdownTimeout * 0.8);
        serverLogger.info(`Phase 3: Draining tracked operations (timeout: ${drainTimeout}ms)...`);
        await shutdownManager.execute(drainTimeout);

        // ── Phase 4: Execute beforeShutdown lifecycle hook (backward compat) ──
        if (config.lifecycle?.beforeShutdown)
        {
            serverLogger.info('Phase 4: Executing beforeShutdown lifecycle hook...');
            try
            {
                await config.lifecycle.beforeShutdown();
            }
            catch (error)
            {
                serverLogger.error('beforeShutdown lifecycle hook failed', error as Error);
            }
        }

        // ── Phase 5: Close infrastructure (DB, Redis) ──
        serverLogger.info('Phase 5: Closing infrastructure...');
        const infraConfig = getInfrastructureConfig(config);

        if (infraConfig.database)
        {
            await closeInfrastructure(closeDatabase, 'Database', TIMEOUTS.DATABASE_CLOSE);
        }

        if (infraConfig.redis)
        {
            // Quit the event pub/sub subscriber (a duplicate connection) before
            // the cache write/read connections it was duplicated from.
            await closeEventTransport();
            await closeInfrastructure(closeCache, 'Redis', TIMEOUTS.REDIS_CLOSE);
        }

        serverLogger.info('Server shutdown completed');
    };
}

/**
 * Close HTTP server with timeout
 */
async function closeHttpServer(server: Server): Promise<void>
{
    let timeoutId: NodeJS.Timeout | undefined;

    await Promise.race([
        new Promise<void>((resolve, reject) =>
        {
            server.close((err) =>
            {
                if (timeoutId) clearTimeout(timeoutId);

                if (err)
                {
                    serverLogger.error('HTTP server close error', err);
                    reject(err);
                }
                else
                {
                    serverLogger.info('HTTP server closed');
                    resolve();
                }
            });
        }),
        new Promise<void>((_, reject) =>
        {
            timeoutId = setTimeout(() =>
            {
                reject(new Error(`HTTP server close timeout after ${TIMEOUTS.SERVER_CLOSE}ms`));
            }, TIMEOUTS.SERVER_CLOSE);
        }),
    ]).catch((error) =>
    {
        if (timeoutId) clearTimeout(timeoutId);
        serverLogger.warn('HTTP server close timeout, forcing shutdown', error as Error);
    });
}

/**
 * Close infrastructure component with timeout
 */
async function closeInfrastructure(
    closeFn: () => Promise<void>,
    name: string,
    timeout: number,
): Promise<void>
{
    let timeoutId: NodeJS.Timeout | undefined;

    try
    {
        await Promise.race([
            closeFn().then(() =>
            {
                if (timeoutId) clearTimeout(timeoutId);
            }),
            new Promise<void>((_, reject) =>
            {
                timeoutId = setTimeout(() =>
                {
                    reject(new Error(`${name} close timeout after ${timeout}ms`));
                }, timeout);
            }),
        ]);
        serverLogger.info(`${name} connections closed successfully`);
    }
    catch (error)
    {
        if (timeoutId) clearTimeout(timeoutId);
        serverLogger.error(`${name} close failed or timed out`, error as Error);
        // Continue with shutdown even if close fails
    }
}

function createGracefulShutdown(
    shutdownServer: () => Promise<void>,
    config: ServerConfig,
    shutdownState: ShutdownState,
): (signal: string) => Promise<void>
{
    return async (signal: string) =>
    {
        // Prevent re-entry
        if (shutdownState.isShuttingDown)
        {
            serverLogger.warn(`${signal} received but shutdown already in progress, ignoring`);

            return;
        }

        serverLogger.info(`${signal} received, starting graceful shutdown...`);

        const shutdownTimeout = getShutdownTimeout(config.shutdown);
        let timeoutId: NodeJS.Timeout | undefined;

        try
        {
            await Promise.race([
                shutdownServer().then(() =>
                {
                    if (timeoutId) clearTimeout(timeoutId);
                }),
                new Promise<never>((_, reject) =>
                {
                    timeoutId = setTimeout(() =>
                    {
                        reject(new Error(`Graceful shutdown timeout after ${shutdownTimeout}ms`));
                    }, shutdownTimeout);
                }),
            ]);

            if (timeoutId) clearTimeout(timeoutId);
            serverLogger.info('Graceful shutdown completed successfully');
            process.exit(0);
        }
        catch (error)
        {
            if (timeoutId) clearTimeout(timeoutId);
            const err = error as Error;

            if (err.message && err.message.includes('timeout'))
            {
                serverLogger.error('Graceful shutdown timeout, forcing exit', err);
            }
            else
            {
                serverLogger.error('Error during graceful shutdown', err);
            }

            process.exit(1);
        }
    };
}

// ============================================================================
// Error Handlers
// ============================================================================

/**
 * Handle process errors - log and continue, don't kill the server
 */
function handleProcessError(errorType: string): void
{
    serverLogger.warn(`${errorType} occurred - server continues running. Check logs above for details.`);
}

function registerProcessHandlers(
    shutdown: (signal: string) => Promise<void>,
): void
{
    // Prevent duplicate registration
    if (processHandlersRegistered)
    {
        serverLogger.debug('Process handlers already registered, skipping');

        return;
    }

    processHandlersRegistered = true;

    // Increase max listeners to prevent warnings in development with hot reload
    const currentMax = process.getMaxListeners();
    if (currentMax < DEFAULT_MAX_LISTENERS)
    {
        process.setMaxListeners(DEFAULT_MAX_LISTENERS);
    }

    process.on('SIGTERM', () =>
    {
        shutdown('SIGTERM').catch((error) =>
        {
            serverLogger.error('SIGTERM handler failed', error as Error);
            process.exit(1);
        });
    });

    process.on('SIGINT', () =>
    {
        shutdown('SIGINT').catch((error) =>
        {
            serverLogger.error('SIGINT handler failed', error as Error);
            process.exit(1);
        });
    });

    process.on('uncaughtException', (error) =>
    {
        // Enhanced logging for EADDRINUSE errors
        if (error.message?.includes('EADDRINUSE'))
        {
            serverLogger.error('Port conflict detected - detailed trace:', error, {
                code: (error as any).code,
                port: (error as any).port,
                address: (error as any).address,
                syscall: (error as any).syscall,
            });
        }
        else
        {
            serverLogger.error('Uncaught exception', error);
        }

        handleProcessError('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason, promise) =>
    {
        // Enhanced error logging with promise context extraction
        if (reason instanceof Error)
        {
            // Import formatUnhandledRejection dynamically to avoid circular deps
            import('../logger/formatters').then(({ formatUnhandledRejection }) =>
            {
                const { error, context } = formatUnhandledRejection(reason, promise);

                serverLogger.error('Unhandled promise rejection', error, context);
            }).catch(() =>
            {
                // Fallback if formatUnhandledRejection fails
                serverLogger.error('Unhandled promise rejection', reason, {
                    promise,
                });
            });
        }
        else
        {
            serverLogger.error('Unhandled promise rejection', {
                reason,
                promise,
            });
        }

        handleProcessError('UNHANDLED_REJECTION');
    });

    serverLogger.debug('Process-level shutdown handlers registered successfully');
}

// ============================================================================
// Cleanup
// ============================================================================

async function cleanupOnFailure(config: ServerConfig): Promise<void>
{
    try
    {
        serverLogger.debug('Cleaning up after initialization failure...');

        // Only cleanup resources that were enabled for initialization
        const infraConfig = getInfrastructureConfig(config);

        if (infraConfig.database)
        {
            await closeInfrastructure(closeDatabase, 'Database', TIMEOUTS.DATABASE_CLOSE);
        }

        if (infraConfig.redis)
        {
            await closeEventTransport();
            await closeInfrastructure(closeCache, 'Redis', TIMEOUTS.REDIS_CLOSE);
        }

        resetShutdownManager();
        serverLogger.debug('Cleanup completed');
    }
    catch (cleanupError)
    {
        serverLogger.error('Cleanup failed', cleanupError as Error);
    }
}
