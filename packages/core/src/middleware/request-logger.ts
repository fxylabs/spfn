/**
 * Request Logger Middleware
 *
 * Automatic API request/response logging with performance monitoring
 */
import { randomBytes } from 'crypto';
import type { Context, Next } from 'hono';
import { alreadySentToClient, logger } from '@spfn/core/logger';
import { getClientIp } from './client-ip';

/**
 * Options for RequestLogger middleware
 */
export interface RequestLoggerOptions
{
    /**
     * Paths to exclude from logging
     *
     * Supports exact match and prefix match (e.g., '/health' excludes '/health/db').
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
     * Field names to mask in logged request bodies
     *
     * Case-insensitive partial matching (e.g., 'password' masks 'userPassword').
     *
     * @default ['password', 'token', 'apiKey', 'secret', 'authorization']
     *
     * @example
     * ```typescript
     * sensitiveFields: ['password', 'creditCard', 'ssn']
     * ```
     */
    sensitiveFields?: string[];

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
    sensitiveFields: ['password', 'token', 'apiKey', 'secret', 'authorization'],
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
 * Mask sensitive data with circular reference handling
 */
export function maskSensitiveData(
    obj: any,
    sensitiveFields: string[],
    seen = new WeakSet(),
): any
{
    if (!obj || typeof obj !== 'object') return obj;

    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);

    const lowerFields = sensitiveFields.map(f => f.toLowerCase());
    const masked = Array.isArray(obj) ? [...obj] : { ...obj };

    for (const key in masked)
    {
        const lowerKey = key.toLowerCase();

        if (lowerFields.some(field => lowerKey.includes(field)))
        {
            masked[key] = '***MASKED***';
        }
        else if (typeof masked[key] === 'object' && masked[key] !== null)
        {
            masked[key] = maskSensitiveData(masked[key], sensitiveFields, seen);
        }
    }

    return masked;
}

/**
 * Request logger middleware for Hono
 *
 * Logs incoming requests with method, path, IP, and user agent.
 * Logs completed requests with status code and duration.
 * Automatically generates unique request IDs and masks sensitive data.
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
 *     sensitiveFields: ['password', 'token'],
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
        const path = new URL(c.req.url).pathname;

        // Support both exact match and prefix match for excluded paths
        const isExcluded = cfg.excludePaths.some(excludePath =>
            path === excludePath || path.startsWith(excludePath + '/'),
        );

        if (isExcluded)
        {
            return next();
        }

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

            // Add detailed error information for 4xx/5xx responses
            if (status >= 400)
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

                // Add request body for POST/PUT/PATCH to see what data caused the error
                if (['POST', 'PUT', 'PATCH'].includes(method))
                {
                    try
                    {
                        // Try to get the already parsed body from context
                        const requestBody = await c.req.json();
                        logData.request = maskSensitiveData(requestBody, cfg.sensitiveFields);
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

            apiLogger.error('Request failed', error as Error, {
                requestId,
                method,
                path,
                duration,
            });

            throw error;
        }
    };
}
