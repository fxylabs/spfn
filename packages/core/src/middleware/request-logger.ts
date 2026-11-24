/**
 * Request Logger Middleware
 *
 * Automatic API request/response logging with performance monitoring
 */
import { randomBytes } from 'crypto';
import type { Context, Next } from 'hono';
import { alreadySentToClient, logger } from '@spfn/core/logger';
import { getClientIp } from './client-ip';
import { isRedactedPath, loggedError, loggedPath } from './logged-path';

/**
 * Options for RequestLogger middleware
 */
export interface RequestLoggerOptions
{
    /**
     * Paths to exclude from logging
     *
     * Supports exact match and prefix match (e.g., '/health' excludes '/health/db'),
     * against the decoded path the router matches (`/%68ealth` is `/health`).
     *
     * A noise filter: an excluded request writes no request lines, but every other
     * line that names its path still does. To keep a path out of every line, declare
     * it with `defineServerConfig().logging({ redactPaths })` (see `loggedPath`).
     *
     * `/_core/health` is where the built-in health endpoint always answers, so a
     * readiness probe usually points there rather than at `/health`. Leaving it
     * out of the default fills the log with one line per probe interval.
     *
     * @default ['/_core/health', '/health', '/ping', '/favicon.ico']
     *
     * @example
     * ```typescript
     * excludePaths: ['/health', '/metrics', '/_next']
     * ```
     */
    excludePaths?: string[];

    /**
     * Threshold in milliseconds for marking requests as slow
     *
     * Slow requests are logged with `slow: true` flag.
     *
     * @default 1000
     */
    slowRequestThreshold?: number;
}

/**
 * @deprecated Use RequestLoggerOptions instead
 */
export type RequestLoggerConfig = RequestLoggerOptions;

const DEFAULT_CONFIG: Required<RequestLoggerConfig> = {
    excludePaths: ['/_core/health', '/health', '/ping', '/favicon.ico'],
    slowRequestThreshold: 1000,
};

/**
 * Generate cryptographically secure request ID
 */
function generateRequestId(): string
{
    const timestamp = Date.now();
    const randomPart = randomBytes(6).toString('hex');

    return `req_${timestamp}_${randomPart}`;
}

/**
 * A parsed JSON body's shape: every key kept, every leaf replaced by its JSON
 * type (`'<string>'`, `'<number>'`, `'<boolean>'`, `'<null>'`), an array by
 * its elements' shapes.
 *
 * The body is request data the framework does not own, and no list of field
 * names can say which of an application's fields is secret: a name left off
 * such a list was logged with its value. The shape names the fields that
 * caused a failure and carries none of their values.
 */
function jsonShape(value: unknown): unknown
{
    if (Array.isArray(value))
    {
        return value.map(jsonShape);
    }

    if (value === null)
    {
        return '<null>';
    }

    if (typeof value === 'object')
    {
        return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, jsonShape(field)]));
    }

    return `<${typeof value}>`;
}

/**
 * Request logger middleware for Hono
 *
 * Logs incoming requests with method, path, IP, and user agent.
 * Logs completed requests with status code and duration.
 * Automatically generates unique request IDs. A failed write's request body is
 * logged as its shape (field names and JSON types), never its values.
 *
 * @param options - Configuration options
 * @returns Hono middleware function
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { RequestLogger } from '@spfn/core/middleware';
 *
 * const app = new Hono();
 *
 * // Add request logging
 * app.use(RequestLogger({
 *     excludePaths: ['/health', '/metrics'],
 *     slowRequestThreshold: 2000,
 * }));
 *
 * // Access request ID in handlers
 * app.get('/users', (c) => {
 *     const requestId = c.get('requestId');
 *     return c.json({ requestId });
 * });
 * ```
 */
export function RequestLogger(options?: RequestLoggerOptions)
{
    const cfg = { ...DEFAULT_CONFIG, ...options };
    const apiLogger = logger.child('@spfn/core:api');

    return async (c: Context, next: Next) =>
    {
        // Matched against the decoded path the router serves, so a
        // percent-encoded spelling of an excluded path is excluded too
        const isExcluded = cfg.excludePaths.some(excludePath =>
            c.req.path === excludePath || c.req.path.startsWith(excludePath + '/'),
        );

        if (isExcluded)
        {
            return next();
        }

        const path = loggedPath(c);

        const requestId = generateRequestId();
        c.set('requestId', requestId);

        const method = c.req.method;
        const userAgent = c.req.header('user-agent');

        // Same resolution as rate limiting (see client-ip.ts).
        const ip = getClientIp(c);

        const startTime = Date.now();

        apiLogger.info('Request received', {
            requestId,
            method,
            path,
            ip,
            userAgent,
        });

        try
        {
            await next();

            const duration = Date.now() - startTime;
            const status = c.res.status;

            const logData: Record<string, any> = {
                requestId,
                method,
                path,
                status,
                duration,
            };

            const isSlowRequest = duration >= cfg.slowRequestThreshold;
            if (isSlowRequest)
            {
                logData.slow = true;
            }

            // Add detailed error information for 4xx/5xx responses. Under a
            // redacted path prefix the response body is left out: it may be
            // built from the path (a NotFoundError may name the segment)
            if (status >= 400 && !isRedactedPath(c))
            {
                try
                {
                    // Clone response to read body without consuming it. The
                    // error handler built it from a description: its `error`
                    // envelope is the body's data, not a caught value
                    logData.response = alreadySentToClient(await c.res.clone().json());
                }
                catch
                {
                    // Response is not JSON or already consumed - ignore
                }

                // Add the request body's shape for POST/PUT/PATCH to see which
                // fields the failed write carried
                if (['POST', 'PUT', 'PATCH'].includes(method))
                {
                    try
                    {
                        // Hono keeps the body the route already parsed
                        logData.request = jsonShape(await c.req.json());
                    }
                    catch
                    {
                        // Body is not JSON or already consumed - ignore
                    }
                }
            }

            const logLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
            apiLogger[logLevel]('Request completed', logData);
        }
        catch (error)
        {
            const duration = Date.now() - startTime;

            apiLogger.error('Request failed', loggedError(c, error), {
                requestId,
                method,
                path,
                duration,
            });

            throw error;
        }
    };
}
