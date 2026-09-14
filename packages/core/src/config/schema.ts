/**
 * Core Package Environment Variable Schema
 *
 * Centralized schema definition for all environment variables used in @spfn/core.
 * This provides type safety, validation, and documentation for environment configuration.
 *
 * @module config/schema
 */

import {
    defineEnvSchema,
    envEnum,
    envNumber,
    envBoolean,
    envUrl,
    envString,
    parsePostgresUrl,
    parseRedisUrl,
} from '@spfn/core/env';

/**
 * Core package environment variable schema
 *
 * Defines all environment variables with:
 * - Type information
 * - Default values
 * - Validation rules
 * - Documentation
 *
 * @example
 * ```typescript
 * import { coreEnvSchema } from '@spfn/core/config';
 *
 * // Access schema information
 * console.log(coreEnvSchema.DB_POOL_MAX.description);
 * console.log(coreEnvSchema.DB_POOL_MAX.default);
 * ```
 */
export const coreEnvSchema = defineEnvSchema({
    // ========================================================================
    // Core Environment
    // ========================================================================

    NODE_ENV: envEnum(['local', 'development', 'staging', 'production', 'test'] as const, {
        description: 'Node.js runtime environment',
        default: 'local',
        nextjs: true,
    }),

    // ========================================================================
    // Database - Connection
    // ========================================================================

    DATABASE_URL: envString({
        description: 'Primary database connection URL',
        required: false,
        sensitive: true,
        validator: parsePostgresUrl,
        examples: ['postgresql://user:password@localhost:5432/dbname'],
    }),

    DATABASE_WRITE_URL: envString({
        description: 'Write database URL (master-replica pattern)',
        required: false,
        sensitive: true,
        validator: parsePostgresUrl,
        examples: ['postgresql://user:password@master:5432/dbname'],
    }),

    DATABASE_READ_URL: envString({
        description: 'Read database URL (master-replica pattern)',
        required: false,
        sensitive: true,
        validator: parsePostgresUrl,
        examples: ['postgresql://user:password@replica:5432/dbname'],
    }),

    // ========================================================================
    // Database - Connection Pool
    // ========================================================================

    DB_POOL_MAX: envNumber({
        description: 'Maximum number of database connections in pool',
        default: 10,
        examples: [10, 20, 50],
    }),

    DB_POOL_READ_MAX: envNumber({
        description: 'Maximum connections for the read-replica pool. Defaults to DB_POOL_MAX. Set lower so write.max + read.max stays under the server max_connections (each process otherwise opens up to 2 × DB_POOL_MAX when a replica is configured).',
        required: false,
        examples: [5, 10, 20],
    }),

    DB_POOL_IDLE_TIMEOUT: envNumber({
        description: 'Database connection idle timeout in seconds',
        default: 30,
        examples: [20, 30, 60],
    }),

    // ========================================================================
    // Database - Retry Configuration
    // ========================================================================

    DB_RETRY_MAX: envNumber({
        description: 'Maximum number of database connection retry attempts',
        default: 3,
        examples: [3, 5, 10],
    }),

    DB_RETRY_INITIAL_DELAY: envNumber({
        description: 'Initial delay between database retry attempts (milliseconds)',
        default: 100,
        examples: [50, 100, 200],
    }),

    DB_RETRY_MAX_DELAY: envNumber({
        description: 'Maximum delay cap for database retry attempts (milliseconds)',
        default: 10000,
        examples: [5000, 10000, 30000],
    }),

    DB_RETRY_FACTOR: envNumber({
        description: 'Exponential backoff factor for database retry delays',
        default: 2,
        examples: [2, 1.5, 3],
    }),

    // ========================================================================
    // Database - Health Check
    // ========================================================================

    DB_HEALTH_CHECK_ENABLED: envBoolean({
        description: 'Enable periodic database health checks',
        default: true,
        examples: [true, false],
    }),

    DB_HEALTH_CHECK_INTERVAL: envNumber({
        description: 'Database health check interval (milliseconds)',
        default: 60000,
        examples: [30000, 60000, 120000],
    }),

    DB_HEALTH_CHECK_RECONNECT: envBoolean({
        description: 'Reconnect to database on health check failure',
        default: true,
        examples: [true, false],
    }),

    DB_HEALTH_CHECK_MAX_RETRIES: envNumber({
        description: 'Maximum health check retry attempts before marking as failed',
        default: 3,
        examples: [3, 5, 10],
    }),

    DB_HEALTH_CHECK_RETRY_INTERVAL: envNumber({
        description: 'Interval between health check retry attempts (milliseconds)',
        default: 5000,
        examples: [5000, 10000, 15000],
    }),

    // ========================================================================
    // Database - Monitoring
    // ========================================================================

    DB_MONITORING_ENABLED: envBoolean({
        description: 'Enable database query performance monitoring',
        default: false,
        examples: [true, false],
    }),

    DB_MONITORING_SLOW_THRESHOLD: envNumber({
        description: 'Slow query threshold for monitoring (milliseconds)',
        default: 1000,
        examples: [500, 1000, 2000],
    }),

    DB_MONITORING_LOG_QUERIES: envBoolean({
        description: 'Log all database queries (not just slow queries)',
        default: false,
        examples: [true, false],
    }),

    // ========================================================================
    // Database - Transaction
    // ========================================================================

    TRANSACTION_TIMEOUT: envNumber({
        description: 'Transaction timeout in milliseconds',
        default: 30000,
        examples: [10000, 30000, 60000],
    }),

    TRANSACTION_IDLE_TIMEOUT: envNumber({
        description: 'Max time (ms) a transaction may sit idle (no running query) before Postgres terminates it and reclaims the pooled connection. Guards against external I/O held inside a transaction starving the connection pool. 0 disables.',
        default: 30000,
        examples: [10000, 30000, 0],
    }),

    // ========================================================================
    // Jobs (pg-boss)
    // ========================================================================

    JOB_POLLING_INTERVAL_SECONDS: envNumber({
        description: 'How often each pg-boss worker polls the DB for new jobs (seconds). Lower = faster pickup, more idle SELECT load; higher = less DB chatter, slower pickup. Per-job override via job options.',
        default: 2,
        examples: [1, 2, 10],
    }),

    // ========================================================================
    // Database - Development
    // ========================================================================

    DB_DEBUG_TRACE: envBoolean({
        description: 'Enable detailed debug tracing for database operations',
        default: false,
        examples: [true, false],
    }),

    // ========================================================================
    // Database - Migrations
    // ========================================================================

    SPFN_ALLOW_PENDING_MIGRATIONS: envBoolean({
        description: 'Start the server even when a function package or the project has migrations the database has not applied. Off by default: a server booted with pending migrations fails only at request time, as an opaque 500. The flag equivalent is `spfn dev --allow-pending-migrations`.',
        default: false,
        examples: [true, false],
    }),

    // ========================================================================
    // Drizzle ORM
    // ========================================================================

    DRIZZLE_SCHEMA_PATH: envString({
        description: 'Entity registry file spfn db push/generate/studio load when src/server/entities/ holds no entity file, or when the registry exports a table no file there defines',
        required: false,
        default: './src/server/entities/config.ts',
        examples: ['./src/db/schema.ts', './src/server/entities/config.ts'],
    }),

    DRIZZLE_OUT_DIR: envString({
        description: 'Output directory for Drizzle migrations',
        required: false,
        default: './drizzle',
        examples: ['./drizzle', './migrations'],
    }),

    // ========================================================================
    // Logger - Core
    // ========================================================================

    SPFN_LOG_LEVEL: envEnum(['debug', 'info', 'warn', 'error', 'fatal'] as const, {
        description: 'Minimum log level to output',
        default: 'info',
    }),

    // ========================================================================
    // Cache (Redis/Valkey)
    // ========================================================================

    CACHE_URL: envString({
        description: 'Single Redis/Valkey instance URL',
        required: false,
        sensitive: true,
        validator: parseRedisUrl,
        examples: ['redis://localhost:6379', 'rediss://secure.cache.com:6380'],
    }),

    CACHE_WRITE_URL: envString({
        description: 'Master Redis/Valkey URL for writes (master-replica pattern)',
        required: false,
        sensitive: true,
        validator: parseRedisUrl,
        examples: ['redis://master:6379'],
    }),

    CACHE_READ_URL: envString({
        description: 'Replica Redis/Valkey URL for reads (master-replica pattern)',
        required: false,
        sensitive: true,
        validator: parseRedisUrl,
        examples: ['redis://replica:6379'],
    }),

    CACHE_SENTINEL_HOSTS: envString({
        description: 'Comma-separated Redis Sentinel hosts',
        required: false,
        examples: ['sentinel1:26379,sentinel2:26379'],
    }),

    CACHE_CLUSTER_NODES: envString({
        description: 'Comma-separated Redis Cluster nodes',
        required: false,
        examples: ['node1:6379,node2:6379,node3:6379'],
    }),

    CACHE_MASTER_NAME: envString({
        description: 'Redis Sentinel master name',
        required: false,
        examples: ['mymaster'],
    }),

    CACHE_PASSWORD: envString({
        description: 'Redis/Valkey authentication password',
        required: false,
        sensitive: true,
        examples: ['your-redis-password'],
    }),

    CACHE_TLS_REJECT_UNAUTHORIZED: envBoolean({
        description: 'Verify TLS certificates for secure Redis connections',
        default: true,
        examples: [true, false],
    }),

    CACHE_MAX_RETRIES_PER_REQUEST: envNumber({
        description: 'Max ioredis retries per command before it rejects (fail fast instead of hanging on a cache outage). ioredis default is 20.',
        default: 3,
        examples: [1, 3, 20],
    }),

    CACHE_ENABLE_OFFLINE_QUEUE: envBoolean({
        description: 'Queue commands while the cache is disconnected (true) vs reject immediately for strict fail-fast (false). Default true keeps resilience to brief blips.',
        default: true,
        examples: [true, false],
    }),

    // ========================================================================
    // Database - Query limits
    // ========================================================================

    DB_MAX_ROWS: envNumber({
        description: 'Safety ceiling for rows returned by repository findMany (0 = unlimited). When >0, an unbounded query is capped and an explicit limit is clamped, guarding against accidentally loading a whole large table.',
        default: 0,
        examples: [0, 1000, 10000],
    }),

    // ========================================================================
    // Server - Core
    // ========================================================================

    // PORT and HOST are deliberately absent.
    //
    // They were declared here with defaults of 4000 and 'localhost', and a
    // schema default is indistinguishable from a value someone set — so
    // `env.PORT` was never undefined, and the resolution order had to consult
    // the environment last to avoid it winning every time. That is what made an
    // injected port unreachable. The server's address now resolves through
    // `@spfn/core/app-config`: SPFN_PORT, then spfn.config.js, then the
    // default, with the default existing in exactly one place.
    //
    // `PORT` is also Next.js's own variable, and two processes are started.

    // ========================================================================
    // Server - Timeout
    // ========================================================================

    SERVER_TIMEOUT: envNumber({
        description: 'Request timeout in milliseconds',
        default: 120000,
        examples: [60000, 120000, 300000],
    }),

    SERVER_KEEPALIVE_TIMEOUT: envNumber({
        description: 'Keep-alive timeout in milliseconds',
        default: 65000,
        examples: [30000, 65000, 120000],
    }),

    SERVER_HEADERS_TIMEOUT: envNumber({
        description: 'Headers timeout in milliseconds',
        default: 60000,
        examples: [30000, 60000, 120000],
    }),

    SHUTDOWN_TIMEOUT: envNumber({
        description: 'Graceful shutdown timeout in milliseconds (must be less than k8s terminationGracePeriodSeconds minus preStop sleep, with safety margin)',
        default: 280000,
        examples: [30000, 120000, 280000],
    }),

    // ========================================================================
    // Fetch (Node.js undici) - outbound HTTP request timeout
    // ========================================================================

    FETCH_CONNECT_TIMEOUT: envNumber({
        description: 'Fetch TCP connection timeout in milliseconds (time to establish socket connection to upstream server)',
        default: 10000,
        examples: [5000, 10000, 30000],
    }),

    FETCH_HEADERS_TIMEOUT: envNumber({
        description: 'Fetch headers timeout in milliseconds (time to receive response headers after request sent)',
        default: 300000,
        examples: [120000, 300000, 600000],
    }),

    FETCH_BODY_TIMEOUT: envNumber({
        description: 'Fetch body timeout in milliseconds (time between body data chunks from upstream server)',
        default: 300000,
        examples: [120000, 300000, 600000],
    }),

    // ========================================================================
    // Next.js Integration
    // ========================================================================

    SPFN_API_URL: envUrl({
        description: 'SPFN API URL (used by Next.js to call backend)',
        required: true,
        nextjs: true,
        examples: ['http://localhost:8790', 'https://api.your-app.com'],
    }),

    NEXT_PUBLIC_SPFN_API_URL: envUrl({
        description: 'SPFN API URL (used by Next.js to call backend)',
        required: true,
        nextjs: true,
        examples: ['http://localhost:8790', 'https://api.your-app.com'],
    }),

    SPFN_APP_URL: envUrl({
        description: 'Next.js application URL (used by SPFN server)',
        required: false,
        nextjs: true,
        examples: ['http://localhost:3790', 'https://your-app.com'],
    }),

    RPC_PROXY_TIMEOUT: envNumber({
        description: 'RPC proxy request timeout in milliseconds (AbortController timeout for proxied requests to backend, should be shorter than FETCH_HEADERS_TIMEOUT)',
        default: 120000,
        nextjs: true,
        examples: [60000, 120000, 280000],
    }),

    // ========================================================================
    // Proxy → Backend trust (HMAC signing)
    // ========================================================================

    SPFN_PROXY_SECRET: envString({
        description: 'Shared secret for signing proxy→backend requests (HMAC-SHA256). Read by BOTH processes — the Next.js proxy (to sign) and the SPFN backend (to verify) — so it belongs in .env.local (loaded by both; the backend reads it via loadEnv, Next.js reads it server-side without exposing it to the browser). Set the SAME value on both. Leave unset to disable proxy-guard signing.',
        required: false,
        sensitive: true,
        nextjs: true,
        examples: ['<32+ byte random hex>', 'v2:<32+ byte random hex>'],
    }),

    SPFN_PROXY_SECRET_PREVIOUS: envString({
        description: 'Previous (grace) proxy keys still accepted for verification during rotation — comma-separated <keyId>:<secret>. The proxy never signs with these; they only keep requests signed with the prior key verifying until a rollout settles. Backend-only (verification), so it belongs in .env.server, NOT exposed to the Next.js process.',
        required: false,
        sensitive: true,
        nextjs: false,
        examples: ['v1:<old secret>', 'v1:<old>,v0:<older>'],
    }),

    TRUSTED_PROXY_HOPS: envNumber({
        description: 'Number of trusted reverse proxies in front of the Next.js proxy (e.g. cloud LB + nginx = 2). Read by the proxy to extract the real client IP from the inbound X-Forwarded-For (counting from the right, which your own infra appends and a client cannot spoof) and forward it to the backend for rate limiting. Set it to your actual hop count; too low trusts a client-spoofable entry, too high collapses users behind a shared proxy IP.',
        default: 1,
        nextjs: true,
        examples: [1, 2, 3],
    }),

    // ========================================================================
    // Rate limiting (global default limiter)
    // ========================================================================

    RATE_LIMIT_MODE: envEnum(['off', 'on'] as const, {
        description: 'Global default rate limiter. "off": only routes tagged with rateLimitPolicy() are limited. "on": every named-middleware route gets the default limit too (opt out per route with .skip([\'rateLimit\'])). Health/SSE/WebSocket endpoints are always exempt. Overridden by defineServerConfig().rateLimit({ mode }).',
        default: 'off',
    }),

    RATE_LIMIT_DEFAULT_LIMIT: envNumber({
        description: 'Max requests per window for the global default limiter (RATE_LIMIT_MODE=on), counted per route and per client IP.',
        default: 100,
        examples: [60, 100, 300],
    }),

    RATE_LIMIT_DEFAULT_WINDOW_MS: envNumber({
        description: 'Window length in milliseconds for the global default limiter.',
        default: 60000,
        examples: [1000, 60000],
    }),

    RATE_LIMIT_FAIL_CLOSED: envBoolean({
        description: 'When the cache (Redis/Valkey) backing the limiter is unavailable, reject with 429 instead of counting in-process. Default false: the limiter falls back to per-process counters, so limits still apply — but the effective limit multiplies by the instance count, since each process counts alone. Set true only where a shared count is required and refusing traffic is preferable to a looser one.',
        default: false,
    }),

    // ========================================================================
    // Outbound request safety (SSRF)
    // ========================================================================

    SAFE_FETCH_BLOCK_PRIVATE_IPS: envBoolean({
        description: 'Default for safeFetch (@spfn/core/security): block outbound requests that resolve to private/reserved IP ranges, including the cloud metadata address. Keep true in production; set false only for trusted internal-network calls in development. Overridden by defineServerConfig().outboundFetch({ blockPrivateIps }).',
        default: true,
    }),
});
