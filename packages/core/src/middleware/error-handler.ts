/**
 * Error Handler Middleware
 *
 * Handles SerializableError with automatic serialization and standard errors
 */
import { randomBytes } from 'node:crypto';

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { carriedStatusCode, errorLogLevel, isSerializableError } from '@spfn/core/errors';
import type { SerializableError, SerializedError } from '@spfn/core/errors';
import { describeError, logger } from '@spfn/core/logger';
import type { DatabaseErrorDescription, ErrorDescription } from '@spfn/core/logger';
import { env } from '@spfn/core/config';
import { loggedError, loggedPath, loggedUrl } from './logged-path';

const errorLogger = logger.child('@spfn/core:error-handler');

/**
 * Options for ErrorHandler middleware
 */
export interface ErrorHandlerOptions
{
    /**
     * Include stack trace in error response
     *
     * Useful for debugging in development, should be disabled in production.
     *
     * @default env.NODE_ENV !== 'production'
     */
    includeStack?: boolean;

    /**
     * Enable error logging to console
     *
     * Logs errors with appropriate level (warn for 4xx, error for 5xx).
     *
     * @default true
     */
    enableLogging?: boolean;

    /**
     * Attach the `error` envelope to every error response
     *
     * The envelope is `{ code, message, requestId }` sitting next to the
     * existing `__type` and `message` fields, never replacing them: a web
     * client restores its error class from `__type` while a generated client
     * in another language classifies by `code` alone and cannot read a
     * discriminator it has no registry for.
     *
     * Turn it off only to keep error bodies byte-identical to an older
     * release. A route reached by a generated client needs it.
     *
     * @default true
     */
    errorEnvelope?: boolean;

    /**
     * Callback invoked when an error occurs
     *
     * Called asynchronously without blocking the response.
     * Useful for external error notifications (Slack, PagerDuty, etc.)
     */
    onError?: (
        err: Error,
        context: OnErrorContext,
    ) => Promise<void> | void;
}

/**
 * Context passed to onError callback
 *
 * `request` copies only values known to be safe. `headers` names every request
 * header and carries the value of a header on core's allow-list alone (accept,
 * content-type, user-agent, the SPFN client descriptors, …), `'***'` for any
 * other — a credential, a proof, an IP address and a header nobody has judged
 * alike. `Referer` carries the referring page's origin and path (redacted under
 * a declared prefix) and its query parameters by name with the value `'***'`,
 * no fragment, and is `'***'` when it is not an http(s) URL (`loggedUrl`). `query` names
 * every parameter and carries no value (`'***'`).
 */
export interface OnErrorContext
{
    statusCode: number;
    path: string;
    method: string;
    requestId?: string;
    timestamp: string;
    userId?: string;
    request: {
        headers: Record<string, string>;
        query: Record<string, string>;
    };
}

interface ErrorWithStatusCode extends Error
{
    statusCode?: number;
    details?: Record<string, unknown>;
}

interface ErrorLogData extends Record<string, unknown>
{
    type: string;
    statusCode: number;
    path: string;
    method: string;
}

type Description = ErrorDescription | DatabaseErrorDescription;

interface StandardErrorResponse
{
    __type: string;
    message: string;
    /** Outside production, a database error's description in place of its message, cause and stack */
    database?: Description;
    /** Outside production, any other error's description in place of its message, cause and stack */
    description?: Description;
}

/**
 * The machine-readable half of an error response.
 *
 * `code` repeats what `__type` already says. The repetition is the point: a
 * generated client in another language has no error registry to look a
 * discriminator up in, so it classifies by one documented field and refuses
 * anything else. `requestId` is what a user can read out to support.
 */
interface ErrorEnvelope
{
    code: string;
    message: string;
    requestId: string;
}

/**
 * Attach the envelope to an already-serialized error body.
 *
 * `code` and `message` are read back out of the body rather than off the error
 * so the two halves of the response can never disagree — whatever masking the
 * caller applied to the body applies to the envelope too.
 */
function withEnvelope<T extends { __type: string; message: string }>(
    body: T,
    c: Context,
): T & { error: ErrorEnvelope }
{
    return {
        ...body,
        error: {
            code: body.__type,
            message: body.message,
            requestId: resolveRequestId(c),
        },
    };
}

/**
 * The request id the envelope carries.
 *
 * RequestLogger sets one per request; without it there is nothing to correlate
 * a report with, so one is minted for this response alone.
 */
function resolveRequestId(c: Context): string
{
    const existing = c.get('requestId') as string | undefined;

    return existing ?? randomBytes(16).toString('hex');
}

// An allow-list, not a deny-list: a header not named here is a header nobody has judged, so its value stays out.
const LOGGED_HEADERS = new Set([
    'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection',
    'content-length', 'content-type', 'host', 'origin', 'pragma', 'referer', 'user-agent',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user',
    'x-forwarded-proto', 'x-forwarded-host', 'x-request-id',
    'x-spfn-client-kind', 'x-spfn-client-version', 'x-spfn-client-contract-version',
    'x-spfn-auth-profile', 'x-spfn-proxy-signature-version',
]);

/**
 * The value `OnErrorContext` carries for one header: its own for a header in
 * `LOGGED_HEADERS`, `'***'` for any other. `Referer` is the URL of the page
 * that made the request, so only its origin and path are copied, and its query
 * by name (`loggedUrl`).
 */
function loggedHeaderValue(name: string, value: string): string
{
    if (!LOGGED_HEADERS.has(name))
    {
        return '***';
    }

    return name === 'referer' ? loggedUrl(value) : value;
}

/**
 * Every request header by name, each with its `loggedHeaderValue`
 */
function extractHeaders(c: Context): Record<string, string>
{
    const headers: Record<string, string> = {};

    c.req.raw.headers.forEach((value, key) =>
    {
        headers[key] = loggedHeaderValue(key.toLowerCase(), value);
    });

    return headers;
}

/**
 * Every query parameter by name, every value `'***'`: which of an
 * application's query names carries a secret (`?token=`, `?code=`) is the
 * application's to know, not core's.
 */
function extractQuery(c: Context): Record<string, string>
{
    return Object.fromEntries(Object.keys(c.req.query()).map(name => [name, '***']));
}

/**
 * Build onError context from Hono context
 */
function buildOnErrorContext(c: Context, statusCode: number): OnErrorContext
{
    const auth = c.get('auth') as { userId?: string } | undefined;

    return {
        statusCode,
        path: loggedPath(c),
        method: c.req.method,
        requestId: c.get('requestId') as string | undefined,
        timestamp: new Date().toISOString(),
        userId: auth?.userId,
        request: {
            headers: extractHeaders(c),
            query: extractQuery(c),
        },
    };
}

/**
 * Log error with appropriate level based on status code. The error is
 * `loggedError`'s description: under a redacted path prefix it carries no
 * message, which may quote the path.
 */
function logError(
    c: Context,
    err: Error,
    logData: ErrorLogData,
    includeStack: boolean,
): void
{
    const logLevel = errorLogLevel(err);

    if (includeStack)
    {
        errorLogger[logLevel]('Error occurred', loggedError(c, err), logData);
    }
    else
    {
        // Without `includeStack` the line names the error but carries no trace
        errorLogger[logLevel]('Error occurred', { ...logData, error: loggedError(c, err, { stack: false }) });
    }
}

/**
 * Whether the error is, or was caused by, a database error
 */
function isDatabaseDescription(description: Description): boolean
{
    if (description.kind === 'database')
    {
        return true;
    }

    return description.cause !== undefined && isDatabaseDescription(description.cause);
}

/**
 * The body for an error that is not a SerializableError. Production gets a
 * generic message only. Outside production the body carries the error's
 * description — never its message, cause or stack, which may hold raw SQL,
 * bound values or an internal host — in `database` for a database error and in
 * `description` for any other.
 */
function standardErrorResponse(err: Error, includeStack: boolean): StandardErrorResponse
{
    if (!includeStack)
    {
        return { __type: 'Error', message: 'Internal Server Error' };
    }

    const description = describeError(err);

    if (isDatabaseDescription(description))
    {
        return { __type: 'Error', message: 'Database error', database: description };
    }

    return { __type: 'Error', message: 'Internal Server Error', description };
}

/**
 * The answer of a typed error: its `toJSON()` with the diagnostic keys the
 * handler owns written by the handler alone. `stack` is such a key — a
 * `stack` the error's own serializer returns is removed in every mode, and in
 * development the frames of `describeError(err)` take its place when there
 * are any, never the raw stack with its message line.
 */
function serializeTypedError(err: SerializableError, includeStack: boolean): SerializedError
{
    const { stack: _serializerStack, ...serialized }: SerializedError = err.toJSON();
    const frames = includeStack ? describeError(err).stack : undefined;

    return frames ? { ...serialized, stack: frames } : serialized;
}

/**
 * The production answer of an internal error: nothing the driver may have
 * written. `__type` restores the class and `statusCode`, where the instance was
 * given one, is its own status — neither is driver text. Read off the instance,
 * never through its `toJSON()`: an app's serializer that throws would leave the
 * failure unanswered.
 */
function redactedTypedError(err: SerializableError): SerializedError
{
    const statusCode = carriedStatusCode(err);
    const redacted = { __type: err.constructor.name, message: 'Internal server error' };

    return statusCode === undefined ? redacted : { ...redacted, statusCode };
}

/**
 * `Retry-After` for an error that says when to send the request again —
 * `TooManyRequestsError` and `ServiceUnavailableError` carry `retryAfter` in
 * seconds — so a client reads it where HTTP puts it for a 429 or a 503, not
 * only from the body.
 */
function setRetryAfter(c: Context, err: Error): void
{
    const retryAfter = (err as { retryAfter?: unknown }).retryAfter;

    if (typeof retryAfter === 'number' && retryAfter > 0)
    {
        c.header('Retry-After', String(Math.ceil(retryAfter)));
    }
}

/**
 * Error handler middleware for Hono
 *
 * Handles SerializableError with automatic serialization and standard errors.
 * SerializableError instances are serialized using their toJSON() method,
 * preserving custom fields like `resource`, `fields`, etc.
 *
 * Every response also carries an `error` envelope — `{ code, message,
 * requestId }` — for clients that classify by a single documented field
 * instead of restoring an error class from `__type`.
 *
 * @param options - Configuration options
 * @returns Error handler function for Hono's onError hook
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { ErrorHandler } from '@spfn/core/middleware';
 *
 * const app = new Hono();
 *
 * // Register error handler
 * app.onError(ErrorHandler({
 *     includeStack: process.env.NODE_ENV !== 'production',
 *     enableLogging: true,
 * }));
 *
 * // Throw SerializableError in routes
 * app.get('/users/:id', (c) => {
 *     throw new NotFoundError({ message: 'User not found', resource: 'User' });
 *     // Response: { __type: 'NotFoundError', message: 'User not found', resource: 'User',
 *     //             error: { code: 'NotFoundError', message: 'User not found', requestId: '…' } }
 * });
 * ```
 */
export function ErrorHandler(options: ErrorHandlerOptions = {}): (err: Error, c: Context) => Response | Promise<Response>
{
    const {
        includeStack = env.NODE_ENV !== 'production',
        enableLogging = true,
        errorEnvelope = true,
        onError,
    } = options;

    const respond = <T extends { __type: string; message: string }>(
        c: Context,
        body: T,
        statusCode: number,
    ): Response =>
    {
        return c.json(
            errorEnvelope ? withEnvelope(body, c) : body,
            statusCode as ContentfulStatusCode,
        );
    };

    return (err: Error, c: Context) =>
    {
        const path = loggedPath(c);
        const method = c.req.method;

        // Handle SerializableError with automatic serialization
        if (isSerializableError(err))
        {
            const { statusCode } = err;

            if (enableLogging)
            {
                logError(c, err, {
                    type: err.constructor.name,
                    statusCode,
                    path,
                    method,
                }, includeStack);
            }

            // Fire onError callback (non-blocking)
            if (onError)
            {
                const ctx = buildOnErrorContext(c, statusCode);
                Promise.resolve(onError(err, ctx))
                    .catch(error => errorLogger.warn('onError callback failed', { error }));
            }

            // Internal (DB-driver-derived) errors must not leak SQL text, schema
            // names, or parameter values to clients in production. Full detail is
            // kept in the log above; the client gets a generic message.
            if ((err as { internal?: boolean }).internal === true && !includeStack)
            {
                return respond(c, redactedTypedError(err), statusCode);
            }

            setRetryAfter(c, err);

            return respond(c, serializeTypedError(err, includeStack), statusCode);
        }

        // Handle standard errors (fallback)
        const errorWithCode = err as ErrorWithStatusCode;
        const statusCode = errorWithCode.statusCode || 500;

        if (enableLogging)
        {
            logError(c, err, {
                type: err.name || 'Error',
                statusCode,
                path,
                method,
            }, includeStack);
        }

        // Fire onError callback (non-blocking)
        if (onError)
        {
            const ctx = buildOnErrorContext(c, statusCode);
            Promise.resolve(onError(err, ctx))
                .catch(error => errorLogger.warn('onError callback failed', { error }));
        }

        return respond(c, standardErrorResponse(err, includeStack), statusCode);
    };
}
