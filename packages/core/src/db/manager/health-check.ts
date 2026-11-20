/**
 * Database Health Check
 *
 * Periodic health checks for database connections with automatic reconnection.
 * Monitors both write and read database instances and attempts recovery on failure.
 *
 * Key design decisions:
 * - Atomic swap: new connections are created and tested BEFORE replacing global state
 * - Health check interval survives reconnection attempts (never stopped during reconnect)
 * - isReconnecting flag prevents concurrent reconnection attempts
 */

import type { Sql } from 'postgres';

import { logger } from '@spfn/core/logger';
import { createDatabaseFromEnv } from './factory';
import type { DatabaseOptions, HealthCheckConfig } from './config';
import { buildHealthCheckConfig, buildMonitoringConfig } from './config';
import {
    getHealthCheckInterval,
    setHealthCheckInterval,
    getWriteClient,
    getReadClient,
    setWriteInstance,
    setReadInstance,
    setWriteClient,
    setReadClient,
    setMonitoringConfig,
    getInitOptions,
    getWriteInstance,
    getIsClosing,
    getDatabaseProvider,
} from './global-state';
import type { DrizzleDatabase, GetDatabaseFn } from './types';

const dbLogger = logger.child('@spfn/core:database');

/**
 * Connection close timeout in seconds
 */
const CLIENT_CLOSE_TIMEOUT = 5;

/**
 * Flag to prevent concurrent reconnection attempts
 */
let isReconnecting = false;

/**
 * Check whether a reconnection attempt is currently running
 *
 * Used by reportDatabaseError and forceReconnectDatabase to avoid
 * triggering parallel rebuilds on top of an in-flight one.
 */
export function isReconnectingNow(): boolean
{
    return isReconnecting;
}

// ============================================================================
// Helper Functions (Private)
// ============================================================================

/**
 * Test a single database connection
 *
 * @param db - Database instance to test
 * @throws Error if connection test fails
 * @internal
 */
async function testDatabaseConnection(
    db: DrizzleDatabase,
): Promise<void>
{
    await db.execute('SELECT 1');
}

/**
 * Perform health check on database connections
 *
 * Tests both write and read connections.
 *
 * @param getDatabase - Function to get database instance
 * @throws Error if health check fails
 * @internal
 */
async function performHealthCheck(getDatabase: GetDatabaseFn): Promise<void>
{
    const write = getDatabase('write');
    const read = getDatabase('read');

    await testDatabaseConnection(write);

    // Check read connection if different from write
    if (read !== write)
    {
        await testDatabaseConnection(read);
    }
}

/**
 * Close a raw postgres client with timeout
 *
 * Ignores errors to prevent cleanup failures from blocking reconnection.
 *
 * @param client - Raw postgres client to close
 * @internal
 */
async function closeClient(client: Sql): Promise<void>
{
    try
    {
        await client.end({ timeout: CLIENT_CLOSE_TIMEOUT });
    }
    catch
    {
        // Ignore cleanup errors (client may already be closed)
    }
}

/**
 * Reconnect database using atomic swap
 *
 * Creates new connections first, tests them, then swaps global state.
 * Old clients are closed after the swap. If creation fails, old state is preserved.
 *
 * @param options - Optional database configuration
 * @returns true if reconnection successful, false otherwise
 * @internal
 */
async function reconnectAndRestore(
    options: DatabaseOptions | undefined,
): Promise<boolean>
{
    // Bail out early if closeDatabase is already tearing down the pool.
    // Without this, a concurrent close() could clear globalThis while we
    // are still awaiting createDatabaseFromEnv, and we would then swap a
    // fresh pool into the just-cleared slot → leaked handles with no
    // cleanup path.
    if (getIsClosing())
    {
        dbLogger.debug('reconnectAndRestore aborted: database is closing');

        return false;
    }

    // Create new connections (old instances remain in place)
    const result = await createDatabaseFromEnv(options);

    if (!result.write)
    {
        return false;
    }

    // Test new connections before swapping
    await testDatabaseConnection(result.write);
    if (result.read && result.read !== result.write)
    {
        await testDatabaseConnection(result.read);
    }

    // Re-check the closing flag right before the swap. createDatabaseFromEnv
    // and testDatabaseConnection both await, so closeDatabase may have been
    // called during that window. If so, tear down the freshly-created pool
    // here rather than leaking it into a globalThis we are about to clear.
    if (getIsClosing())
    {
        dbLogger.warn('reconnectAndRestore: close started mid-rebuild, discarding new pool');
        if (result.writeClient)
        {
            await closeClient(result.writeClient);
        }
        if (result.readClient && result.readClient !== result.writeClient)
        {
            await closeClient(result.readClient);
        }

        return false;
    }

    // Capture old clients for cleanup
    const oldWriteClient = getWriteClient();
    const oldReadClient = getReadClient();

    // Atomic swap: replace global state with new instances
    setWriteInstance(result.write);
    setReadInstance(result.read);
    setWriteClient(result.writeClient);
    setReadClient(result.readClient);

    // Restore monitoring configuration
    const monConfig = buildMonitoringConfig(options?.monitoring);
    setMonitoringConfig(monConfig);

    // Close old clients after swap (fire and forget)
    if (oldWriteClient)
    {
        closeClient(oldWriteClient);
    }
    if (oldReadClient && oldReadClient !== oldWriteClient)
    {
        closeClient(oldReadClient);
    }

    return true;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start database health check
 *
 * Periodically checks database connection health and attempts reconnection if enabled.
 * Automatically started by initDatabase() when health check is enabled.
 *
 * The health check interval survives reconnection attempts - it is never stopped
 * during reconnection, ensuring continuous monitoring even after failures.
 *
 * @param config - Health check configuration
 * @param options - Optional database configuration (pool settings, etc.)
 * @param getDatabase - Function to get database instance (to avoid circular dependency)
 *
 * @example
 * ```typescript
 * import { startHealthCheck } from '@spfn/core/db/manager/health-check';
 *
 * startHealthCheck(
 *   {
 *     enabled: true,
 *     interval: 30000,      // 30 seconds
 *     reconnect: true,
 *     maxRetries: 5,
 *     retryInterval: 10000, // 10 seconds
 *   },
 *   undefined,
 *   getDatabase
 * );
 * ```
 */
export function startHealthCheck(
    config: HealthCheckConfig,
    options: DatabaseOptions | undefined,
    getDatabase: GetDatabaseFn,
): void
{
    const healthCheck = getHealthCheckInterval();
    if (healthCheck)
    {
        dbLogger.debug('Health check already running');

        return;
    }

    dbLogger.info('Starting database health check', {
        interval: `${config.interval}ms`,
        reconnect: config.reconnect,
    });

    const interval = setInterval(async () =>
    {
        // Skip if reconnection is in progress
        if (isReconnecting)
        {
            dbLogger.debug('Health check skipped: reconnection in progress');

            return;
        }

        try
        {
            await performHealthCheck(getDatabase);
            // Health check passed - no need to log (only log failures)
        }
        catch (error: unknown)
        {
            dbLogger.error('Database health check failed', { error });

            // Attempt reconnection if enabled
            if (config.reconnect)
            {
                await attemptReconnection(config, options, 'health_check_failed');
            }
        }
    }, config.interval);

    setHealthCheckInterval(interval);
}

/**
 * Force an immediate reconnection attempt
 *
 * Public entry-point for non-periodic triggers (query-error threshold,
 * operator-driven recovery). Reuses the same retry loop as the health check.
 * Safe to call concurrently — overlapping calls are coalesced by the
 * check-and-set inside attemptReconnection().
 *
 * @param reason - Short label describing what triggered the reconnect (for logs)
 * @returns true if a reconnection actually ran, false if one was already in-flight
 *          or the database has not been initialized yet.
 */
export async function triggerForceReconnect(reason: string): Promise<boolean>
{
    if (getDatabaseProvider())
    {
        dbLogger.debug('Force reconnect skipped: database is externally provided', { reason });

        return false;
    }

    // Do not implicitly initialize the database from a reconnect path.
    // initDatabase() must have run first; otherwise this is almost certainly
    // a test/misconfiguration scenario and we should fail quietly.
    if (!getWriteInstance())
    {
        dbLogger.warn('Force reconnect skipped: database not initialized', { reason });

        return false;
    }

    // Do not start a rebuild on top of an in-progress close.
    if (getIsClosing())
    {
        dbLogger.debug('Force reconnect skipped: database is closing', { reason });

        return false;
    }

    const options = getInitOptions();
    const config = buildHealthCheckConfig(options?.healthCheck);

    dbLogger.warn('Force reconnect triggered', { reason });

    return await attemptReconnection(config, options, reason);
}

/**
 * Attempt database reconnection with retry logic
 *
 * Uses atomic swap to replace connections without clearing global state.
 * Old instances remain available until new connections are verified.
 * The health check interval continues running throughout the process.
 *
 * Concurrency: the first synchronous statement check-and-sets isReconnecting.
 * Under JS's single-threaded model this is atomic — overlapping callers from
 * the periodic interval and from triggerForceReconnect cannot both proceed.
 * The second caller observes isReconnecting=true and returns false without
 * running a parallel rebuild.
 *
 * @param config - Health check configuration
 * @param options - Optional database configuration (pool settings, etc.)
 * @param reason - Trigger label for logs (e.g. 'health_check_failed', 'query_error_threshold')
 * @returns true if this invocation actually ran the reconnect loop, false if
 *          it was coalesced with an already-running attempt.
 */
async function attemptReconnection(
    config: HealthCheckConfig,
    options: DatabaseOptions | undefined,
    reason: string,
): Promise<boolean>
{
    if (getDatabaseProvider())
    {
        dbLogger.debug('Reconnection skipped: database is externally provided', { reason });

        return false;
    }

    // Atomic check-and-set (sync, pre-await) — coalesces concurrent callers.
    if (isReconnecting)
    {
        dbLogger.debug('Reconnection coalesced: attempt already in progress', { reason });

        return false;
    }
    isReconnecting = true;

    dbLogger.warn('Attempting database reconnection', {
        reason,
        maxRetries: config.maxRetries,
        retryInterval: `${config.retryInterval}ms`,
    });

    try
    {
        for (let attempt = 1; attempt <= config.maxRetries; attempt++)
        {
            try
            {
                dbLogger.debug(`Reconnection attempt ${attempt}/${config.maxRetries}`);

                // Wait before retry (skip for first attempt)
                if (attempt > 1)
                {
                    await new Promise(resolve => setTimeout(resolve, config.retryInterval));
                }

                // Attempt reconnection with atomic swap
                const success = await reconnectAndRestore(options);

                if (success)
                {
                    dbLogger.info('Database reconnection successful', { attempt });

                    return true;
                }
                else
                {
                    dbLogger.error(`Reconnection attempt ${attempt} failed: No write database instance created`);
                }
            }
            catch (error: unknown)
            {
                dbLogger.error(`Reconnection attempt ${attempt} failed`, {
                    error,
                    attempt,
                    maxRetries: config.maxRetries,
                });
            }

            if (attempt === config.maxRetries)
            {
                dbLogger.error('Max reconnection attempts reached, will retry on next health check');
            }
        }
    }
    finally
    {
        isReconnecting = false;
    }

    // Retry loop exhausted — we did run, just without success.
    return true;
}

/**
 * Stop database health check
 *
 * Automatically called by closeDatabase().
 * Can also be called manually to stop health checks.
 *
 * @example
 * ```typescript
 * import { stopHealthCheck } from '@spfn/core/db/manager/health-check';
 *
 * stopHealthCheck();
 * ```
 */
export function stopHealthCheck(): void
{
    const healthCheck = getHealthCheckInterval();
    if (healthCheck)
    {
        clearInterval(healthCheck);
        setHealthCheckInterval(undefined);
        dbLogger.info('Database health check stopped');
    }

    // Reset isReconnecting as a defensive measure for stale state (tests,
    // restarts). This is safe because stopHealthCheck() is only called from
    // closeDatabase() in production, which sets isClosing=true BEFORE calling
    // us. The isClosing guards in triggerForceReconnect() and
    // reconnectAndRestore() prevent any racing reconnect from completing its
    // swap into globalThis, so flipping the flag here cannot cause a parallel
    // createDatabaseFromEnv to slip through.
    isReconnecting = false;
}
