/**
 * Start SPFN Server
 *
 * Starts and configures the SPFN HTTP server with graceful shutdown.
 */

import { serve } from '@hono/node-server';
import type { Context, Hono } from 'hono';
import type { Server } from 'http';

import { closeCache, initCache } from '@spfn/core/cache';
import { closeDatabase, initDatabase, getDatabase } from '@spfn/core/db';
import { initBoss, stopBoss, stopFetching, registerJobs } from '../job';
import { attachWSHandler } from '../event/ws/handler';
import type { SSETokenManager } from '../event/sse/token-manager';
import { wireEventRouterCache, closeEventTransport } from '../event/cache-transport';
import { serverLogger } from './logger';
import { printBanner } from './banner';
import { createServer } from './create-server';
import { loadServerConfigFile } from './config-file';
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
    resolveStreamTokenManager,
} from './helpers';
import { runEnvBootCheck } from './env-boot-check';
import { runMigrationBootGate } from './migration-gate';
import { runTenancyBootGate } from './tenancy-gate';
import { endShutdownRun, resetShutdownManager, startShutdownRun } from './shutdown-manager';
import type { ShutdownManager } from './shutdown-manager';
import { createShutdownBudget, JOB_FAIL_TIME } from './shutdown-budget';
import type { ShutdownBudget, ShutdownInfrastructure } from './shutdown-budget';

import type { ServerConfig, ServerInstance } from './types';
import { validateServerConfig } from './validation';
import { markServerProcess } from '../module-evaluation';
import { env } from '@spfn/core/config';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_LISTENERS = 15;

const TIMEOUTS = {
    DATABASE_CLOSE: 5000,
    REDIS_CLOSE: 5000,
    PRODUCTION_ERROR_SHUTDOWN: 10000,
} as const;

// ============================================================================
// Types
// ============================================================================

interface InfrastructureConfig
{
    database: boolean;
    redis: boolean;
}

/**
 * One server run's shutdown state: whether its shutdown began (to prevent
 * re-entry), and the manager its drain and hooks run on
 */
interface ShutdownState
{
    isShuttingDown: boolean;
    manager: ShutdownManager;
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
    // Before anything of the app loads: from here on, a second copy of
    // @spfn/core is refused by the import that would bring it in.
    markServerProcess(message => serverLogger.error(message));

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
        manager: startShutdownRun(),
    };

    try
    {
        await initializeInfrastructure(finalConfig);

        // Pending migrations become an opaque 500 on the first request that touches
        // a missing column — refuse here instead, where the fix is one command.
        await runMigrationBootGate(finalConfig);

        const app = await createServer(finalConfig);

        // A tenancy table is isolated only if the app's role is subject to its
        // row-level security policy — refuse a production boot where it is not.
        // After createServer, which imports a custom app.ts and with it the
        // tables its routes use; before anything listens.
        await runTenancyBootGate();

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
                serverLogger.error('afterStart hook failed', { error });
                // Don't throw - server is already running
                // Just log the error and continue
            }
        }

        return serverInstance;
    }
    catch (error)
    {
        serverLogger.error('Server initialization failed', { error });

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
    const loaded = await loadServerConfigFile(cwd);
    const fileConfig: ServerConfig = loaded?.config ?? {};

    if (loaded)
    {
        serverLogger.debug(`Loaded configuration from ${loaded.path}`);
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
        // The app's own manager, or the default one on the cache (multi-instance support)
        tokenManager = resolveStreamTokenManager(authConfig, 'WS', debug);

        // Register the WS token endpoint on the Hono app. The path replaces the WS
        // path's last segment with `token`, so the default '/ws' becomes '/token'.
        const tokenPath = wsPath.replace(/\/[^/]+$/, '/token');
        // Guard the token endpoint with the app's own middleware — from the server
        // config and from the router's .use(), which registerRoutes owns and this
        // endpoint never passes through.
        const mwHandlers = resolveEndpointMiddlewares(config).map(mw => mw.handler);
        const getSubject = authConfig.getSubject
            ?? ((c: Context) => (c.get('auth') as Record<string, string> | undefined)?.userId ?? null);
        // Tagged like the SSE endpoint's token, so a token minted by a device key
        // that is revoked before the connect is refused there.
        const getKeyId = authConfig.getKeyId
            ?? ((c: Context) => (c.get('auth') as Record<string, string> | undefined)?.keyId);
        const getKeyHolder = authConfig.getKeyHolder
            ?? ((c: Context) => (c.get('auth') as Record<string, string> | undefined)?.userId);

        app.on(['POST'], [tokenPath], ...mwHandlers, async (c: Context) =>
        {
            const subject = getSubject(c);
            if (!subject)
            {
                return c.json({ error: 'Unable to identify subject' }, 401);
            }

            const token = await tokenManager!.issue(subject, {
                keyId: getKeyId(c) ?? undefined,
                keyHolder: getKeyHolder(c) ?? undefined,
            });

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

/**
 * Build the graceful shutdown sequence
 *
 * The job queue is two things and they stop at different times: fetching
 * stops first, so the stopping instance starts no job it may have to fail;
 * sending stays open until everything that may still enqueue — tracked
 * operations, `onShutdown` hooks, `beforeShutdown` — has run. Every phase is
 * bounded by one deadline (see shutdown-budget.ts).
 *
 * @returns a function taking the epoch-ms deadline (default: now + shutdown.timeout)
 */
function createShutdownHandler(
    server: Server,
    config: ServerConfig,
    shutdownState: ShutdownState,
    wsCleanup?: () => Promise<void>,
): (deadline?: number) => Promise<void>
{
    return async (deadline = Date.now() + getShutdownTimeout(config.shutdown)) =>
    {
        if (shutdownState.isShuttingDown)
        {
            serverLogger.debug('Shutdown already in progress for this instance, skipping');

            return;
        }

        shutdownState.isShuttingDown = true;

        const budget = createShutdownBudget(deadline, getShutdownInfrastructure(config));

        serverLogger.info('Shutdown started', {
            deadlineIn: `${deadline - Date.now()}ms`,
            reservedForHooksAndInfrastructure: `${budget.reserved}ms`,
        });

        // Health check returns 503 and trackOperation() rejects new work from here on
        shutdownState.manager.beginShutdown();

        await stopAcceptingWork(server, config, budget, wsCleanup);
        await drainWork(config, budget, shutdownState.manager);
        await stopJobQueue(config, budget);
        await closeInfrastructureWithin(config, budget);

        // This run is over: the next startServer() in the process starts clean
        endShutdownRun(shutdownState.manager);
        serverLogger.info('Server shutdown completed');
    };
}

function getShutdownInfrastructure(config: ServerConfig): ShutdownInfrastructure
{
    return { ...getInfrastructureConfig(config), jobs: Boolean(config.jobs) };
}

/**
 * Phases 1–2: close HTTP and WebSocket, then stop fetching jobs
 *
 * Phase 2 waits for the fetches in flight, so a job enqueued from Phase 3 on
 * is not taken by this instance. Handlers already running continue; `send`
 * keeps working.
 */
async function stopAcceptingWork(
    server: Server,
    config: ServerConfig,
    budget: ShutdownBudget,
    wsCleanup?: () => Promise<void>,
): Promise<void>
{
    serverLogger.info('Phase 1: Closing HTTP server (stop accepting new connections)...');
    await closeHttpServer(server, budget.phase('http'));

    if (wsCleanup)
    {
        serverLogger.info('Phase 1.5: Closing WebSocket server...');
        await runWithin(wsCleanup, 'WebSocket server close', budget.phase('websocket'));
    }

    if (config.jobs)
    {
        const fetchBudget = budget.phase('jobFetch');
        serverLogger.info(`Phase 2: Stopping job fetch, waiting for fetches in flight (budget: ${fetchBudget}ms; sending stays open)...`);
        await stopFetching(fetchBudget);
    }
}

/**
 * Phases 3–4: drain tracked operations, then the hooks — `onShutdown` hooks
 * and `beforeShutdown` share the hooks' budget, which the drain cannot spend.
 * The queue still accepts what they enqueue.
 */
async function drainWork(config: ServerConfig, budget: ShutdownBudget, manager: ShutdownManager): Promise<void>
{
    const drainBudget = budget.phase('drain');
    serverLogger.info(`Phase 3: Draining tracked operations and after-commit callbacks (budget: ${drainBudget}ms)...`);
    await manager.drain(drainBudget);

    const hooksDeadline = Date.now() + budget.phase('hooks');
    serverLogger.info(`Phase 3.5: Running shutdown hooks (budget: ${hooksDeadline - Date.now()}ms)...`);
    await manager.runHooks(hooksDeadline);

    await runBeforeShutdown(config, hooksDeadline - Date.now());
}

/**
 * Phase 4: the `beforeShutdown` lifecycle hook, for what the hooks' budget has left
 */
async function runBeforeShutdown(config: ServerConfig, hookBudget: number): Promise<void>
{
    const beforeShutdown = config.lifecycle?.beforeShutdown;

    if (!beforeShutdown)
    {
        return;
    }

    if (hookBudget <= 0)
    {
        serverLogger.warn('Phase 4: beforeShutdown lifecycle hook skipped: the hooks\' budget is spent');

        return;
    }

    serverLogger.info(`Phase 4: Executing beforeShutdown lifecycle hook (budget: ${hookBudget}ms)...`);
    await runWithin(beforeShutdown, 'beforeShutdown lifecycle hook', hookBudget);
}

/**
 * Phase 5: wait for running job handlers, then stop pg-boss
 *
 * A handler still running when its wait ends has its job failed by core
 * before the database closes: retried on a live instance if attempts remain,
 * left failed on the last one. With less budget than the stop's shortest wait
 * plus the fail, it fails them without waiting.
 */
async function stopJobQueue(config: ServerConfig, budget: ShutdownBudget): Promise<void>
{
    if (!config.jobs)
    {
        return;
    }

    const jobsBudget = budget.phase('jobs');
    serverLogger.info(`Phase 5: Waiting for running job handlers, then stopping pg-boss (budget: ${jobsBudget}ms)...`);
    await runWithin(() => stopBoss(jobsBudget - JOB_FAIL_TIME), 'pg-boss stop', jobsBudget);
}

/**
 * Phase 6: close the database, then the event transport and Redis
 */
async function closeInfrastructureWithin(config: ServerConfig, budget: ShutdownBudget): Promise<void>
{
    const infraConfig = getInfrastructureConfig(config);

    if (infraConfig.database)
    {
        const databaseBudget = budget.phase('database');
        serverLogger.info(`Phase 6: Closing database (budget: ${databaseBudget}ms)...`);
        await closeInfrastructure(closeDatabase, 'Database', databaseBudget);
    }

    if (infraConfig.redis)
    {
        serverLogger.info('Phase 6: Closing event transport and Redis...');
        // Quit the event pub/sub subscriber (a duplicate connection) before
        // the cache write/read connections it was duplicated from.
        await runWithin(closeEventTransport, 'Event transport close', budget.phase('eventTransport'));
        await closeInfrastructure(closeCache, 'Redis', budget.phase('redis'));
    }
}

/**
 * Run a shutdown step for at most `timeout` ms; a failure or timeout is
 * logged and the shutdown continues
 */
async function runWithin(step: () => Promise<void>, name: string, timeout: number): Promise<void>
{
    let timeoutId: NodeJS.Timeout | undefined;

    try
    {
        await Promise.race([
            step(),
            new Promise<void>((_, reject) =>
            {
                timeoutId = setTimeout(() => reject(new Error(`${name} timeout after ${timeout}ms`)), timeout);
            }),
        ]);
        serverLogger.info(`${name} done`);
    }
    catch (error)
    {
        serverLogger.error(`${name} failed or timed out`, { error });
    }
    finally
    {
        clearTimeout(timeoutId);
    }
}

/**
 * Close HTTP server with timeout
 */
async function closeHttpServer(server: Server, timeout: number): Promise<void>
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
                    serverLogger.error('HTTP server close error', { error: err });
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
                reject(new Error(`HTTP server close timeout after ${timeout}ms`));
            }, timeout);
        }),
    ]).catch((error) =>
    {
        if (timeoutId) clearTimeout(timeoutId);
        serverLogger.warn('HTTP server close timeout, forcing shutdown', { error });
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
        serverLogger.error(`${name} close failed or timed out`, { error });
        // Continue with shutdown even if close fails
    }
}

function createGracefulShutdown(
    shutdownServer: (deadline: number) => Promise<void>,
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

        // One deadline: the phases' budgets and the forced exit share it
        const shutdownTimeout = getShutdownTimeout(config.shutdown);
        const deadline = Date.now() + shutdownTimeout;
        let timeoutId: NodeJS.Timeout | undefined;

        try
        {
            await Promise.race([
                shutdownServer(deadline).then(() =>
                {
                    if (timeoutId) clearTimeout(timeoutId);
                }),
                new Promise<never>((_, reject) =>
                {
                    timeoutId = setTimeout(() =>
                    {
                        reject(new Error(`Graceful shutdown timeout after ${shutdownTimeout}ms`));
                    }, deadline - Date.now());
                }),
            ]);

            if (timeoutId) clearTimeout(timeoutId);
            serverLogger.info('Graceful shutdown completed successfully');
            process.exit(0);
        }
        catch (error)
        {
            if (timeoutId) clearTimeout(timeoutId);

            if (error instanceof Error && error.message.includes('timeout'))
            {
                serverLogger.error('Graceful shutdown timeout, forcing exit', { error });
            }
            else
            {
                serverLogger.error('Error during graceful shutdown', { error });
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
            serverLogger.error('SIGTERM handler failed', { error });
            process.exit(1);
        });
    });

    process.on('SIGINT', () =>
    {
        shutdown('SIGINT').catch((error) =>
        {
            serverLogger.error('SIGINT handler failed', { error });
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
            serverLogger.error('Uncaught exception', { error });
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
        serverLogger.error('Cleanup failed', { error: cleanupError });
    }
}
