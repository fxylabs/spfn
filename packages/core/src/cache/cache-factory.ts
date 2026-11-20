/**
 * Cache factory with automatic environment variable detection
 */

import type { Redis, Cluster, RedisOptions, ClusterOptions } from 'ioredis';
import { logger } from '@spfn/core/logger';
import { env } from '@spfn/core/config';

/**
 * Connection-resilience options applied to every cache client.
 *
 * ioredis defaults to an unbounded offline command queue and 20 retries per
 * request, so a post-startup cache outage can buffer every command and hang
 * awaits. Bound retries (CACHE_MAX_RETRIES_PER_REQUEST, default 3) so commands
 * fail fast instead of hanging; CACHE_ENABLE_OFFLINE_QUEUE (default true) can be
 * set false for strict fail-fast (reject immediately while disconnected).
 */
function resilienceOptions(): Pick<RedisOptions, 'maxRetriesPerRequest' | 'enableOfflineQueue'>
{
    return {
        maxRetriesPerRequest: env.CACHE_MAX_RETRIES_PER_REQUEST,
        enableOfflineQueue: env.CACHE_ENABLE_OFFLINE_QUEUE,
    };
}

const cacheLogger = logger.child('@spfn/core:cache');

export interface CacheClients {
    /** Primary cache for writes (or both read/write if no replica) */
    write?: Redis | Cluster;
    /** Replica cache for reads (optional, falls back to write) */
    read?: Redis | Cluster;
}

/**
 * Check if any cache configuration exists in environment
 */
function hasCacheConfig(): boolean
{
    return !!(
        process.env.CACHE_URL ||
        process.env.CACHE_WRITE_URL ||
        process.env.CACHE_READ_URL ||
        process.env.CACHE_SENTINEL_HOSTS ||
        process.env.CACHE_CLUSTER_NODES
    );
}

/**
 * Create cache client with TLS support
 */
function createClient(
    RedisClient: new (url: string, options?: RedisOptions) => Redis,
    url: string,
): Redis
{
    const options: RedisOptions = { ...resilienceOptions() };

    // TLS support for secure connections
    if (url.startsWith('rediss://'))
    {
        options.tls = {
            rejectUnauthorized: process.env.CACHE_TLS_REJECT_UNAUTHORIZED !== 'false',
        };
    }

    return new RedisClient(url, options);
}

/**
 * Create cache client(s) from environment variables
 *
 * Supported patterns (priority order):
 * 1. Single instance: CACHE_URL
 * 2. Master-Replica: CACHE_WRITE_URL + CACHE_READ_URL
 * 3. Sentinel: CACHE_SENTINEL_HOSTS + CACHE_MASTER_NAME
 * 4. Cluster: CACHE_CLUSTER_NODES
 *
 * @returns Cache client(s) or undefined if no configuration found
 *
 * @example
 * ```bash
 * # Single (most common)
 * CACHE_URL=redis://localhost:6379
 * CACHE_URL=rediss://secure.cache.com:6380  # TLS
 *
 * # Master-Replica
 * CACHE_WRITE_URL=redis://master:6379
 * CACHE_READ_URL=redis://replica:6379
 *
 * # Sentinel
 * CACHE_SENTINEL_HOSTS=sentinel1:26379,sentinel2:26379
 * CACHE_MASTER_NAME=mymaster
 * CACHE_PASSWORD=secret
 *
 * # Cluster
 * CACHE_CLUSTER_NODES=node1:6379,node2:6379,node3:6379
 * CACHE_PASSWORD=secret
 * ```
 */
export async function createCacheFromEnv(): Promise<CacheClients>
{
    // Quick exit if no cache config
    if (!hasCacheConfig())
    {
        cacheLogger.info('No cache configuration found - running without cache');

        return { write: undefined, read: undefined };
    }

    try
    {
        // Dynamic import to avoid bundling if not used
        const ioredis = await import('ioredis');
        const RedisClient = ioredis.default;

        // Get environment variables
        const singleUrl = process.env.CACHE_URL;
        const writeUrl = process.env.CACHE_WRITE_URL;
        const readUrl = process.env.CACHE_READ_URL;
        const clusterNodes = process.env.CACHE_CLUSTER_NODES;
        const sentinelHosts = process.env.CACHE_SENTINEL_HOSTS;
        const masterName = process.env.CACHE_MASTER_NAME;
        const password = process.env.CACHE_PASSWORD;

        // 1. Single instance (most common - highest priority)
        if (singleUrl && !writeUrl && !readUrl && !clusterNodes)
        {
            const client = createClient(RedisClient, singleUrl);
            cacheLogger.debug('Created single cache instance', { url: singleUrl.replace(/:[^:@]+@/, ':***@') });

            return { write: client, read: client };
        }

        // 2. Master-Replica pattern (both URLs required)
        if (writeUrl && readUrl)
        {
            const write = createClient(RedisClient, writeUrl);
            const read = createClient(RedisClient, readUrl);
            cacheLogger.debug('Created master-replica cache instances');

            return { write, read };
        }

        // 3. Sentinel pattern
        if (sentinelHosts && masterName)
        {
            const sentinels = sentinelHosts.split(',').map((host) =>
            {
                const [hostname, port] = host.trim().split(':');

                return { host: hostname, port: Number(port) || 26379 };
            });

            const options: RedisOptions = {
                ...resilienceOptions(),
                sentinels,
                name: masterName,
                password,
            };

            const client = new RedisClient(options);
            cacheLogger.debug('Created sentinel cache instance', { masterName, sentinels: sentinels.length });

            return { write: client, read: client };
        }

        // 4. Cluster pattern
        if (clusterNodes)
        {
            const nodes = clusterNodes.split(',').map((node) =>
            {
                const [host, port] = node.trim().split(':');

                return { host, port: Number(port) || 6379 };
            });

            const clusterOptions: ClusterOptions = {
                redisOptions: {
                    ...resilienceOptions(),
                    password,
                },
            };

            const cluster = new RedisClient.Cluster(nodes, clusterOptions);
            cacheLogger.debug('Created cluster cache instance', { nodes: nodes.length });

            return { write: cluster, read: cluster };
        }

        // 5. Fallback: Single URL with other configs present
        if (singleUrl)
        {
            const client = createClient(RedisClient, singleUrl);
            cacheLogger.debug('Created cache instance (fallback)', { url: singleUrl.replace(/:[^:@]+@/, ':***@') });

            return { write: client, read: client };
        }

        // No valid configuration
        cacheLogger.info('No valid cache configuration found - running without cache');

        return { write: undefined, read: undefined };
    }
    catch (error)
    {
        if (error instanceof Error)
        {
            // Check if it's a missing dependency error
            if (error.message.includes('Cannot find module'))
            {
                cacheLogger.warn(
                    'Cache client library not installed',
                    error,
                    {
                        suggestion: 'Install ioredis to enable cache: pnpm install ioredis',
                        mode: 'disabled',
                    },
                );
            }
            else
            {
                cacheLogger.warn(
                    'Failed to create cache client',
                    error,
                    { mode: 'disabled' },
                );
            }
        }
        else
        {
            cacheLogger.warn(
                'Failed to create cache client',
                { error, mode: 'disabled' },
            );
        }

        return { write: undefined, read: undefined };
    }
}

/**
 * Create single cache client (backward compatibility)
 * Only returns write instance
 */
export async function createSingleCacheFromEnv(): Promise<Redis | Cluster | undefined>
{
    const { write } = await createCacheFromEnv();

    return write;
}
