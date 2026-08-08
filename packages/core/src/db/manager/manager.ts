/**
 * Global Database instance manager
 * Provides singleton access to database across all modules
 * Supports Primary + Replica pattern with separate read/write instances
 */

import type { Sql } from 'postgres';

import { logger } from '@spfn/core/logger';
import { createDatabaseFromEnv } from './factory';
import { toPosixPath } from './path-utils';
import type { DatabaseInitOptions, MonitoringConfig } from './config.js';
import { buildHealthCheckConfig, buildMonitoringConfig } from './config.js';
import { env } from '@spfn/core/config';
import {
    getWriteInstance,
    setWriteInstance,
    getReadInstance,
    setReadInstance,
    getWriteClient,
    setWriteClient,
    getReadClient,
    setReadClient,
    getMonitoringConfig,
    setMonitoringConfig,
    setInitOptions,
    getInitPromise,
    setInitPromise,
    getInitProvider,
    setInitProvider,
    getClosePromise,
    setClosePromise,
    getIsClosing,
    setIsClosing,
    getDatabaseProvider,
    setDatabaseProviderInstance,
} from './global-state';
import {
    startHealthCheck,
    stopHealthCheck,
    triggerForceReconnect,
} from './health-check';
import type {
    DatabaseProvider,
    DbConnectionType,
    DefaultDatabase,
    DrizzleDatabase,
} from './types';
import type { DatabaseClients } from './config';

const dbLogger = logger.child('@spfn/core:database');

/**
 * Connection close timeout in seconds
 */
const DB_CONNECTION_CLOSE_TIMEOUT = 5;

/**
 * Number of stack trace lines to skip when detecting caller
 */
const STACK_TRACE_SKIP_LINES = 3;

/**
 * Regular expressions for parsing stack trace lines
 */
const STACK_TRACE_PATTERNS = {
    withParens: /\((.+):(\d+):(\d+)\)/,
    withoutParens: /at (.+):(\d+):(\d+)/,
};

// NOTE: lifecycle locks live in global-state so HMR module instances and
// reconnect paths observe the same initialization and close operations.

// ============================================================================
// Helper Functions (Private)
// ============================================================================

/**
 * Cleanup database connections
 *
 * Closes write and read client connections with timeout.
 * Ignores cleanup errors to ensure all cleanup attempts complete.
 *
 * @param writeClient - Write client to cleanup
 * @param readClient - Read client to cleanup
 * @internal
 */
async function cleanupDatabaseConnections(
    writeClient: Sql | undefined,
    readClient: Sql | undefined,
): Promise<void>
{
    const cleanupPromises: Promise<void>[] = [];

    if (writeClient)
    {
        cleanupPromises.push(
            writeClient.end({ timeout: DB_CONNECTION_CLOSE_TIMEOUT }).catch((err) => 
            {
                dbLogger.debug('Write client cleanup failed', { error: err });
            }),
        );
    }

    if (readClient && readClient !== writeClient)
    {
        cleanupPromises.push(
            readClient.end({ timeout: DB_CONNECTION_CLOSE_TIMEOUT }).catch((err) => 
            {
                dbLogger.debug('Read client cleanup failed', { error: err });
            }),
        );
    }

    await Promise.allSettled(cleanupPromises);
}

/**
 * Close a single database client connection
 *
 * @param client - Database client to close
 * @param type - Connection type ('write' or 'read')
 * @internal
 */
async function closeDatabaseClient(client: Sql, type: 'write' | 'read'): Promise<void>
{
    const typeName = type.charAt(0).toUpperCase() + type.slice(1);
    dbLogger.debug(`Closing ${type} connection...`);

    try
    {
        await client.end({ timeout: DB_CONNECTION_CLOSE_TIMEOUT });
        dbLogger.debug(`${typeName} connection closed`);
    }
    catch (err: unknown)
    {
        const error = err instanceof Error ? err : new Error(String(err));
        dbLogger.error(`Error closing ${type} connection`, error);
    }
}

/**
 * Test database connections
 *
 * Executes a simple SELECT 1 query on both write and read connections.
 *
 * @param write - Write database instance
 * @param read - Read database instance
 * @throws Error if connection test fails
 * @internal
 */
async function testDatabaseConnections(
    write: DrizzleDatabase | undefined,
    read: DrizzleDatabase | undefined,
): Promise<void>
{
    if (write)
    {
        await write.execute('SELECT 1');

        // Test read connection if different from write
        if (read && read !== write)
        {
            await read.execute('SELECT 1');
        }
    }
}

function validateDatabaseProvider(provider: DatabaseProvider<DrizzleDatabase>): void
{
    if (typeof provider.kind !== 'string' || !provider.kind.trim())
    {
        throw new Error('Database provider kind must be a non-empty string');
    }
}

function registerDatabaseProvider<TDatabase extends DrizzleDatabase>(
    provider: DatabaseProvider<TDatabase>,
): DatabaseClients<TDatabase>
{
    setDatabaseProviderInstance(provider);
    setWriteInstance(provider.write);
    setReadInstance(provider.read ?? provider.write);

    return {
        write: provider.write,
        read: provider.read ?? provider.write,
    };
}

async function closeDatabaseProvider(
    provider: DatabaseProvider<DrizzleDatabase>,
    context: string,
): Promise<void>
{
    if (!provider.close)
    {
        return;
    }

    try
    {
        await provider.close();
    }
    catch (error: unknown)
    {
        const closeError = error instanceof Error ? error : new Error(String(error));
        dbLogger.error(`Error closing ${provider.kind || 'unknown'} database provider`, closeError, {
            context,
        });
    }
}

/**
 * Get caller information from stack trace
 */
function getCallerInfo(): string | undefined
{
    try
    {
        const stack = new Error().stack;
        if (!stack) return undefined;

        const lines = stack.split('\n');
        // Skip first 3 lines: Error, getCallerInfo, getDatabase
        for (let i = STACK_TRACE_SKIP_LINES; i < lines.length; i++)
        {
            const line = toPosixPath(lines[i]);
            // Find first meaningful caller (not node_modules/@spfn/core/db)
            if (!line.includes('node_modules') && !line.includes('/db/manager/'))
            {
                // Extract file:line from stack line
                const match = line.match(STACK_TRACE_PATTERNS.withParens) || line.match(STACK_TRACE_PATTERNS.withoutParens);
                if (match)
                {
                    const fullPath = match[1];
                    // Get relative path from project root
                    const parts = fullPath.split('/');
                    const srcIndex = parts.lastIndexOf('src');
                    if (srcIndex !== -1)
                    {
                        const relativePath = parts.slice(srcIndex).join('/');

                        return `${relativePath}:${match[2]}`;
                    }

                    return `${fullPath}:${match[2]}`;
                }
                break;
            }
        }
    }
    catch (error: unknown)
    {
        // Stack trace parsing failed - log for debugging
        dbLogger.debug('Failed to extract caller info from stack trace', {
            error: error instanceof Error ? error.message : String(error),
        });
    }

    return undefined;
}

/**
 * Create database not initialized error message
 *
 * @param type - Database connection type ('read' or 'write')
 * @returns Error with descriptive message for uninitialized database
 *
 * @internal
 */
function createNotInitializedError(type: DbConnectionType): Error
{
    return new Error(
        `Database not initialized (type: ${type}). Call initDatabase() first or set DATABASE_URL environment variable.`,
    );
}

/**
 * Get global database instance
 *
 * @param type - Connection type ('read' or 'write', defaults to 'write')
 * @returns Database instance (never undefined)
 * @throws Error if database is not initialized
 *
 * @example
 * ```typescript
 * import { getDatabase } from '@spfn/core/db';
 *
 * // Always returns a valid instance or throws
 * const db = getDatabase();
 * const users = await db.select().from(usersTable);
 *
 * // For read operations (uses replica if available, falls back to primary)
 * const dbRead = getDatabase('read');
 * const posts = await dbRead.select().from(postsTable);
 * ```
 */
export function getDatabase<TDatabase extends DrizzleDatabase = DefaultDatabase>(
    type?: DbConnectionType,
): TDatabase
{
    const writeInst = getWriteInstance();
    const readInst = getReadInstance();

    // Detailed debug logging with caller info (only if DB_DEBUG_TRACE is enabled in non-production)
    if (env.DB_DEBUG_TRACE && env.NODE_ENV !== 'production')
    {
        const caller = getCallerInfo();
        dbLogger.debug('getDatabase() called', {
            type: type ?? 'write',
            hasWrite: !!writeInst,
            hasRead: !!readInst,
            caller,
        });
    }

    if (type === 'read')
    {
        const db = readInst ?? writeInst;
        if (!db)
        {
            throw createNotInitializedError('read');
        }

        return db as TDatabase;
    }

    // Default: 'write' type
    if (!writeInst)
    {
        throw createNotInitializedError('write');
    }

    return writeInst as TDatabase;
}

/**
 * Set global database instances (for testing or manual configuration)
 *
 * This function directly sets database instances without creating connections
 * or performing validation. It's primarily intended for testing scenarios.
 *
 * @param write - Database write instance (pass undefined to clear)
 * @param read - Database read instance (optional, defaults to write, pass undefined to clear)
 *
 * @remarks
 * **Important:** To properly close database connections with cleanup, use `closeDatabase()` instead.
 * This function only updates the global instances without closing the underlying connections.
 * Setting both to undefined will clear the instances but leave connections open, which may cause resource leaks.
 *
 * @example
 * ```typescript
 * import { setDatabase } from '@spfn/core/db';
 * import { drizzle } from 'drizzle-orm/postgres-js';
 * import postgres from 'postgres';
 *
 * // Set custom database instances (testing)
 * const writeClient = postgres('postgresql://primary:5432/mydb');
 * const readClient = postgres('postgresql://replica:5432/mydb');
 * setDatabase(drizzle({ client: writeClient }), drizzle({ client: readClient }));
 *
 * // Clear instances (not recommended - use closeDatabase() instead)
 * setDatabase(undefined, undefined);
 * ```
 */
export function setDatabase<TDatabase extends DrizzleDatabase = DefaultDatabase>(
    write: TDatabase | undefined,
    read?: TDatabase | undefined,
): void
{
    if (getIsClosing())
    {
        throw new Error('Cannot set database while closing');
    }

    if (getInitPromise())
    {
        throw new Error('Cannot set database while initialization is in progress');
    }

    if (getDatabaseProvider())
    {
        throw new Error(
            'An external database provider is active. Call closeDatabase() before setting a database manually.',
        );
    }

    if (getWriteClient() || getReadClient())
    {
        throw new Error(
            'Managed database connections are active. Call closeDatabase() before setting a database manually.',
        );
    }

    setDatabaseProviderInstance(undefined);
    setWriteInstance(write);
    setReadInstance(read ?? write);
}

/**
 * Register an externally owned PostgreSQL Drizzle provider.
 *
 * This is the synchronous/manual counterpart to `initDatabase({ provider })`.
 * It performs no connection test. Use `closeDatabase()` to invoke the
 * provider's close callback and clear the global instances.
 */
export function setDatabaseProvider<TDatabase extends DrizzleDatabase>(
    provider: DatabaseProvider<TDatabase>,
): DatabaseClients<TDatabase>
{
    validateDatabaseProvider(provider);

    const activeProvider = getDatabaseProvider();
    if (getIsClosing())
    {
        throw new Error('Cannot set database provider while closing');
    }

    if (getInitPromise())
    {
        throw new Error('Cannot set database provider while initialization is in progress');
    }

    if (activeProvider === provider)
    {
        return {
            write: provider.write,
            read: provider.read ?? provider.write,
        };
    }

    if (getWriteInstance() || getReadInstance() || getWriteClient() || getReadClient() || activeProvider)
    {
        throw new Error(
            'Database already initialized. Call closeDatabase() before registering a different provider.',
        );
    }

    return registerDatabaseProvider(provider);
}

/**
 * Initialize a database provider or create postgres.js clients from environment variables
 * Automatically called by server startup
 *
 * Supported environment variables:
 * - DATABASE_URL (single primary)
 * - DATABASE_WRITE_URL + DATABASE_READ_URL (primary + replica)
 * - DB_POOL_MAX (connection pool max size)
 * - DB_POOL_IDLE_TIMEOUT (connection idle timeout in seconds)
 * - DB_HEALTH_CHECK_ENABLED (enable health checks, default: true)
 * - DB_HEALTH_CHECK_INTERVAL (health check interval in ms, default: 60000)
 * - DB_HEALTH_CHECK_RECONNECT (enable auto-reconnect, default: true)
 * - DB_HEALTH_CHECK_MAX_RETRIES (max reconnection attempts, default: 3)
 * - DB_HEALTH_CHECK_RETRY_INTERVAL (retry interval in ms, default: 5000)
 * - DB_MONITORING_ENABLED (enable query monitoring, default: true in dev, false in prod)
 * - DB_MONITORING_SLOW_THRESHOLD (slow query threshold in ms, default: 1000)
 * - DB_MONITORING_LOG_QUERIES (log actual SQL queries, default: false)
 * - DB_DEBUG_TRACE (enable detailed getDatabase() call tracing with caller info, default: false)
 *
 * Configuration priority:
 * 1. options parameter (ServerConfig)
 * 2. Environment variables
 * 3. Defaults (based on NODE_ENV)
 *
 * @param options - Optional database configuration (pool settings, etc.)
 * @returns Object with write and read instances
 *
 * @example
 * ```typescript
 * import { initDatabase } from '@spfn/core/db';
 *
 * // Manual initialization (not needed if using server startup)
 * const { write, read } = await initDatabase();
 * if (write) {
 *   console.log('Database connected');
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Custom pool configuration
 * const { write, read } = await initDatabase({
 *   pool: { max: 50, idleTimeout: 60 }
 * });
 * ```
 */
export async function initDatabase<TDatabase extends DrizzleDatabase = DefaultDatabase>(
    options?: DatabaseInitOptions<TDatabase>,
): Promise<DatabaseClients<TDatabase>>
{
    // Prevent initialization during close operation
    if (getIsClosing())
    {
        throw new Error('Cannot initialize database while closing');
    }

    // Already initialized
    const writeInst = getWriteInstance();
    if (writeInst)
    {
        const activeProvider = getDatabaseProvider();
        if (!activeProvider && !getWriteClient())
        {
            throw new Error(
                'Database was registered manually. Use getDatabase() directly or call closeDatabase() before initDatabase().',
            );
        }

        if (options?.provider !== activeProvider)
        {
            const detail = options?.provider
                ? 'a different provider was supplied'
                : 'the active external provider was not supplied';
            throw new Error(`Database already initialized: ${detail}`);
        }

        dbLogger.debug('Database already initialized');

        return {
            write: writeInst as TDatabase,
            read: getReadInstance() as TDatabase | undefined,
        };
    }

    // Initialization in progress - wait for it to complete
    const activeInitPromise = getInitPromise();
    if (activeInitPromise)
    {
        if (options?.provider !== getInitProvider())
        {
            throw new Error('Database initialization already in progress with a different provider');
        }

        dbLogger.debug('Database initialization in progress, waiting...');

        return await activeInitPromise as DatabaseClients<TDatabase>;
    }

    // Start initialization with lock
    setInitProvider(options?.provider);
    const currentInit = (async () =>
    {
        try
        {
            if (options?.provider)
            {
                const provider = options.provider;

                try
                {
                    validateDatabaseProvider(provider);
                    await testDatabaseConnections(provider.write, provider.read);

                    if (getIsClosing())
                    {
                        throw new Error('Database closed during initialization');
                    }

                    const monConfig = buildMonitoringConfig(options.monitoring);
                    const result = registerDatabaseProvider(provider);
                    setInitOptions(options);
                    setMonitoringConfig(monConfig);

                    dbLogger.info('Database provider connected', {
                        kind: provider.kind,
                        hasReplica: !!(provider.read && provider.read !== provider.write),
                    });

                    return result;
                }
                catch (error: unknown)
                {
                    await closeDatabaseProvider(provider, 'initialization_failed');

                    if (error instanceof Error && (
                        error.message === 'Database provider kind must be a non-empty string'
                        || error.message === 'Database closed during initialization'
                    ))
                    {
                        throw error;
                    }

                    const message = error instanceof Error ? error.message : 'Unknown error';
                    throw new Error(`Database connection test failed: ${message}`);
                }
            }

            // Auto-detect from environment
            const result = await createDatabaseFromEnv(options);

            // Test connections
            try
            {
                await testDatabaseConnections(result.write, result.read);
            }
            catch (error: unknown)
            {
                // Connection test failed - cleanup and throw
                await cleanupDatabaseConnections(result.writeClient, result.readClient);

                const message = error instanceof Error ? error.message : 'Unknown error';
                throw new Error(`Database connection test failed: ${message}`);
            }

            // Check if database was closed during initialization
            if (getIsClosing())
            {
                dbLogger.warn('Database closed during initialization, cleaning up...');
                await cleanupDatabaseConnections(result.writeClient, result.readClient);
                throw new Error('Database closed during initialization');
            }

            // Store instances in globalThis
            setWriteInstance(result.write);
            setReadInstance(result.read);
            setWriteClient(result.writeClient);
            setReadClient(result.readClient);

            // Persist init options so forceReconnectDatabase() and health-check
            // recovery can rebuild the pool with the same configuration.
            setInitOptions(options);

            const hasReplica = result.read && result.read !== result.write;
            dbLogger.info(
                hasReplica
                    ? 'Database connected (Primary + Replica)'
                    : 'Database connected',
            );

            // Start health check (automatic)
            const healthCheckConfig = buildHealthCheckConfig(options?.healthCheck);
            if (healthCheckConfig.enabled)
            {
                startHealthCheck(healthCheckConfig, options, getDatabase);
            }

            // Initialize monitoring configuration
            const monConfig = buildMonitoringConfig(options?.monitoring);
            setMonitoringConfig(monConfig);
            if (monConfig.enabled)
            {
                dbLogger.info('Database query monitoring enabled', {
                    slowThreshold: `${monConfig.slowThreshold}ms`,
                    logQueries: monConfig.logQueries,
                });
            }

            return { write: getWriteInstance(), read: getReadInstance() };
        }
        finally
        {
            // Clear lock after initialization completes (success or failure)
            setInitPromise(undefined);
            setInitProvider(undefined);
        }
    })();
    setInitPromise(currentInit);

    return await currentInit as DatabaseClients<TDatabase>;
}

/**
 * Close the active database provider or postgres.js connections and clean up
 *
 * Invokes an external provider's close callback, or closes postgres.js pools with timeout.
 * Should be called during graceful shutdown or after tests.
 *
 * @example
 * ```typescript
 * import { closeDatabase } from '@spfn/core/db';
 *
 * // During graceful shutdown
 * process.on('SIGTERM', async () => {
 *     await closeDatabase();
 *     process.exit(0);
 * });
 *
 * // In tests
 * afterAll(async () => {
 *     await closeDatabase();
 * });
 * ```
 */
export async function closeDatabase(): Promise<void>
{
    const activeClosePromise = getClosePromise();
    if (activeClosePromise)
    {
        dbLogger.debug('Database close already in progress');

        return await activeClosePromise;
    }

    const currentClose = (async () =>
    {
        // Set closing flag early to prevent new operations.
        // Shared via global-state so reconnect paths in health-check.ts observe it.
        setIsClosing(true);

        // Wait for any in-progress initialization to complete before closing
        const activeInitPromise = getInitPromise();
        if (activeInitPromise)
        {
            dbLogger.debug('Waiting for database initialization to complete before closing...');

            try
            {
                await activeInitPromise;
            }
            catch (_error: unknown)
            {
                // Initialization failed, but we still need to cleanup any partial state
                dbLogger.debug('Initialization failed during close, proceeding with cleanup');
            }
        }

        const writeInst = getWriteInstance();
        const readInst = getReadInstance();
        const provider = getDatabaseProvider();
        if (!writeInst && !readInst && !provider)
        {
            dbLogger.debug('No database connections to close');

            return;
        }

        try
        {
            // Stop health check
            stopHealthCheck();

            const closePromises: Promise<void>[] = [];

            if (provider)
            {
                closePromises.push(closeDatabaseProvider(provider, 'shutdown'));
            }

            // Close write client
            const writeC = getWriteClient();
            if (writeC)
            {
                closePromises.push(closeDatabaseClient(writeC, 'write'));
            }

            // Close read client (if different from write)
            const readC = getReadClient();
            if (readC && readC !== writeC)
            {
                closePromises.push(closeDatabaseClient(readC, 'read'));
            }

            // Wait for all connections to close (use allSettled to ensure all cleanup attempts complete)
            await Promise.allSettled(closePromises);

            dbLogger.info('All database connections closed');
        }
        finally
        {
            // Always clear instances and reset flag
            setWriteInstance(undefined);
            setReadInstance(undefined);
            setWriteClient(undefined);
            setReadClient(undefined);
            setDatabaseProviderInstance(undefined);
            setMonitoringConfig(undefined);
            setInitOptions(undefined);
        }
    })();

    setClosePromise(currentClose);
    try
    {
        await currentClose;
    }
    finally
    {
        if (getClosePromise() === currentClose)
        {
            setClosePromise(undefined);
            setIsClosing(false);
        }
    }
}

/**
 * Force an immediate database pool rebuild
 *
 * Destroys the current postgres.js pool(s) and rebuilds them with the same
 * configuration passed to the original `initDatabase()` call (or whatever
 * was detected from environment variables). Uses the same atomic-swap
 * strategy as the periodic health check: new connections are created and
 * tested BEFORE the old ones are torn down, so `getDatabase()` callers never
 * observe a missing instance.
 *
 * Use this when application code detects that the pool is stuck and does not
 * want to wait for the next periodic health check tick. Concurrent calls are
 * coalesced — if a reconnect is already in progress, this resolves to `false`
 * without starting a second one.
 *
 * @param reason - Short label describing why the rebuild was requested (for logs)
 * @returns `true` if a reconnection ran, `false` if one was already in-flight.
 *          Resolves after the rebuild completes (success or max retries exhausted).
 *
 * @example
 * ```typescript
 * import { forceReconnectDatabase } from '@spfn/core/db';
 *
 * app.post('/admin/db/reconnect', async (c) => {
 *     const ran = await forceReconnectDatabase('admin_request');
 *     return c.json({ reconnected: ran });
 * });
 * ```
 */
export async function forceReconnectDatabase(reason = 'manual'): Promise<boolean>
{
    if (getDatabaseProvider())
    {
        dbLogger.debug('Force reconnect skipped: database is externally provided', { reason });

        return false;
    }

    return await triggerForceReconnect(reason);
}

/**
 * Get database connection info (for debugging)
 *
 * Returns the current state of database connections without throwing errors.
 * Useful for health checks, monitoring, and debugging initialization issues.
 *
 * @returns Connection status information
 * - `hasWrite`: Whether write database instance is initialized
 * - `hasRead`: Whether read database instance is initialized
 * - `isReplica`: Whether read and write are different instances (Primary + Replica setup)
 *
 * @example
 * ```typescript
 * import { getDatabaseInfo } from '@spfn/core/db';
 *
 * const info = getDatabaseInfo();
 * console.log(`Write: ${info.hasWrite}, Read: ${info.hasRead}, Replica: ${info.isReplica}`);
 *
 * // Check before using database
 * if (!info.hasWrite) {
 *   console.warn('Database not initialized');
 * }
 *
 * // Detect Primary + Replica setup
 * if (info.isReplica) {
 *   console.log('Using Primary + Replica configuration');
 * }
 * ```
 */
export function getDatabaseInfo(): {
    hasWrite: boolean;
    hasRead: boolean;
    isReplica: boolean;
    providerKind?: string;
}
{
    const writeInst = getWriteInstance();
    const readInst = getReadInstance();

    return {
        hasWrite: !!writeInst,
        hasRead: !!readInst,
        isReplica: !!(readInst && readInst !== writeInst),
        providerKind: getDatabaseProvider()?.kind,
    };
}

/**
 * Get current monitoring configuration
 *
 * Returns the monitoring configuration that was set during database initialization.
 * Used by Repository to determine if and how to monitor query performance.
 *
 * @returns Current monitoring configuration or undefined if database not initialized
 *
 * @example
 * ```typescript
 * import { getDatabaseMonitoringConfig } from '@spfn/core/db';
 *
 * const config = getDatabaseMonitoringConfig();
 * if (config?.enabled) {
 *   console.log(`Slow query threshold: ${config.slowThreshold}ms`);
 * }
 * ```
 */
export function getDatabaseMonitoringConfig(): MonitoringConfig | undefined
{
    return getMonitoringConfig();
}
