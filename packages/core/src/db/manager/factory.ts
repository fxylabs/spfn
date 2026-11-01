/**
 * Database factory with automatic environment variable detection
 * Supports: Single primary, Primary + Replica
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';

import { env } from '@spfn/core/config';
import { logger } from '@spfn/core/logger';
import { createDatabaseConnection } from './connection';
import { getPoolConfig, getRetryConfig, type DatabaseOptions, type DatabaseClients, type PoolConfig, type RetryConfig } from './config';
import { createDevelopmentQueryLogger } from '../tenant/query-warning';

const dbLogger = logger.child('@spfn/core:database');
const tenantLogger = logger.child('@spfn/core:tenant');

// ============================================================================
// Types
// ============================================================================

/**
 * Database configuration pattern types
 *
 * Represents different ways to configure database connections via environment variables.
 */
type DatabasePattern =
    | { type: 'write-read'; write: string; read: string }     // Explicit write/read separation
    | { type: 'single'; url: string }                         // Single database
    | { type: 'none' };                                        // No configuration

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if any database configuration exists in environment
 */
function hasDatabaseConfig(): boolean
{
    return env.DATABASE_URL !== undefined ||
           env.DATABASE_WRITE_URL !== undefined ||
           env.DATABASE_READ_URL !== undefined;
}

/**
 * Detect database configuration pattern from environment variables
 *
 * Priority order (highest to lowest):
 * 1. write-read: DATABASE_WRITE_URL + DATABASE_READ_URL (explicit separation)
 * 2. single: DATABASE_URL (most common)
 * 3. single: DATABASE_WRITE_URL (write-only, no replica)
 * 4. none: No configuration found
 *
 * @returns Detected database configuration pattern
 *
 * @example
 * ```typescript
 * const pattern = detectDatabasePattern();
 *
 * if (pattern.type === 'write-read') {
 *   console.log(`Write: ${pattern.write}, Read: ${pattern.read}`);
 * }
 * ```
 */
function detectDatabasePattern(): DatabasePattern
{
    const DATABASE_WRITE_URL = env.DATABASE_WRITE_URL;
    const DATABASE_READ_URL = env.DATABASE_READ_URL;
    const DATABASE_URL = env.DATABASE_URL;

    // Priority 1: Explicit write/read separation (recommended)
    if (DATABASE_WRITE_URL && DATABASE_READ_URL)
    {
        return {
            type: 'write-read',
            write: DATABASE_WRITE_URL,
            read: DATABASE_READ_URL,
        };
    }

    // Priority 2: Single primary (most common)
    if (DATABASE_URL)
    {
        return {
            type: 'single',
            url: DATABASE_URL,
        };
    }

    // Priority 3: Write-only (no replica)
    if (DATABASE_WRITE_URL)
    {
        return {
            type: 'single',
            url: DATABASE_WRITE_URL,
        };
    }

    // No configuration found
    return { type: 'none' };
}

/**
 * Wrap a postgres.js client in drizzle
 *
 * In local and development runs it also attaches the tenant query warning,
 * which reports a query that reads or writes a tenant-aware table without its
 * tenant condition. Other environments get no logger and pay nothing. An unset
 * NODE_ENV is `local` (core's config default), so a deployment leaves the
 * warning off by setting NODE_ENV to `production` or `staging`.
 */
function createDrizzle(client: Sql)
{
    const queryLogger = createDevelopmentQueryLogger(env.NODE_ENV, (message, warning) =>
    {
        tenantLogger.warn(message, { tables: warning.tables, sql: warning.sql });
    });

    return queryLogger ? drizzle({ client, logger: queryLogger }) : drizzle({ client });
}

/**
 * Create write and read database clients
 *
 * Write connection is required and will throw if it fails.
 * Read connection is optional - if it fails, falls back to using write connection with a warning.
 *
 * @param writeUrl - Write database connection string
 * @param readUrl - Read database connection string
 * @param poolConfig - Connection pool configuration
 * @param retryConfig - Retry configuration
 * @returns Database clients
 * @throws Error if write connection fails
 */
async function createWriteReadClients(
    writeUrl: string,
    readUrl: string,
    poolConfig: PoolConfig,
    retryConfig: RetryConfig,
): Promise<DatabaseClients>
{
    let writeClient: Sql | undefined;
    let readClient: Sql | undefined;

    try
    {
        // Write connection is required - must succeed
        writeClient = await createDatabaseConnection(writeUrl, poolConfig, retryConfig);
    }
    catch (error)
    {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        dbLogger.error('Failed to connect to write database', errorObj);
        throw new Error(`Write database connection failed: ${errorObj.message}`, { cause: error });
    }

    // Read connection is optional - fallback to write if it fails.
    // The read pool can be sized independently (readMax) so the two pools don't
    // each open `max` connections for a total of 2 × max per process.
    const readPoolConfig = { ...poolConfig, max: poolConfig.readMax ?? poolConfig.max };

    try
    {
        readClient = await createDatabaseConnection(readUrl, readPoolConfig, retryConfig);

        return {
            write: createDrizzle(writeClient),
            read: createDrizzle(readClient),
            writeClient,
            readClient,
        };
    }
    catch (error)
    {
        const errorObj = error instanceof Error ? error : new Error(String(error));

        // Log warning but continue with write connection as fallback
        dbLogger.warn(
            'Failed to connect to read database (replica). Falling back to write database for read operations.',
            {
                error: errorObj.message,
                readUrl: readUrl.replace(/:[^:@]+@/, ':***@'), // Mask password in logs
                fallbackBehavior: 'Using write connection for both read and write operations',
            },
        );

        // Use write connection for both read and write
        return {
            write: createDrizzle(writeClient),
            read: createDrizzle(writeClient),
            writeClient,
            readClient: writeClient,
        };
    }
}

/**
 * Create single database client (used for both read and write)
 *
 * @param url - Database connection string
 * @param poolConfig - Connection pool configuration
 * @param retryConfig - Retry configuration
 * @returns Database clients
 */
async function createSingleClient(
    url: string,
    poolConfig: PoolConfig,
    retryConfig: RetryConfig,
): Promise<DatabaseClients>
{
    const client = await createDatabaseConnection(url, poolConfig, retryConfig);
    const db = createDrizzle(client);

    return {
        write: db,
        read: db,
        writeClient: client,
        readClient: client,
    };
}

/**
 * Create database client(s) from environment variables
 *
 * Supported patterns (priority order):
 * 1. Primary + Replica: DATABASE_WRITE_URL + DATABASE_READ_URL
 * 2. Single primary: DATABASE_URL
 *
 * @param options - Optional database configuration (pool settings, etc.)
 * @returns Database client(s)
 * @throws {Error} If no database configuration is found or connection fails
 *
 * @example
 * ```bash
 * # Single primary (most common)
 * DATABASE_URL=postgresql://localhost:5432/mydb
 *
 * # Primary + Replica
 * DATABASE_WRITE_URL=postgresql://primary:5432/mydb
 * DATABASE_READ_URL=postgresql://replica:5432/mydb
 * ```
 *
 * @example
 * ```typescript
 * // Custom pool configuration
 * const db = await createDatabaseFromEnv({
 *   pool: { max: 50, idleTimeout: 60 }
 * });
 * ```
 */
export async function createDatabaseFromEnv(options?: DatabaseOptions): Promise<DatabaseClients>
{
    // Quick exit if no database config
    if (!hasDatabaseConfig())
    {
        const error = new Error(
            'No database configuration found. Please set DATABASE_URL, DATABASE_WRITE_URL, or DATABASE_READ_URL environment variable.',
        );

        dbLogger.error('No database configuration found', {
            cwd: process.cwd(),
            nodeEnv: env.NODE_ENV,
            checkedVars: ['DATABASE_URL', 'DATABASE_WRITE_URL', 'DATABASE_READ_URL'],
        });

        throw error;
    }

    try
    {
        const poolConfig = getPoolConfig(options?.pool);
        const retryConfig = getRetryConfig();
        const pattern = detectDatabasePattern();

        // Create database clients based on detected pattern
        switch (pattern.type)
        {
            case 'write-read':
                return await createWriteReadClients(
                    pattern.write,
                    pattern.read,
                    poolConfig,
                    retryConfig,
                );

            case 'single':
                return await createSingleClient(pattern.url, poolConfig, retryConfig);
        }
    }
    catch (error)
    {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        dbLogger.error(
            'Failed to create database connection',
            errorObj,
            {
                stage: 'initialization',
                hasWriteUrl: process.env.DATABASE_WRITE_URL !== undefined,
                hasReadUrl: process.env.DATABASE_READ_URL !== undefined,
                hasUrl: process.env.DATABASE_URL !== undefined,
            },
        );

        throw new Error(`Database connection failed: ${errorObj.message}`, { cause: error });
    }

    throw new Error('No database pattern detected despite passing config check');
}
