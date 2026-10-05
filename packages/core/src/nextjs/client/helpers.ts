import type { Logger } from '@spfn/core/logger';
import type { ErrorRegistry } from '@spfn/core/errors';
import { logger } from '@spfn/core/logger';
import { ApiError } from './errors';
import * as debugLogs from './debug-logs';
import { parseResponseBody } from '../shared';

// Re-export shared utilities
export { buildCookieHeader, parseResponseBody } from '../shared';

const cookieLogger = logger.child('@spfn/core:auto-cookies');

/**
 * Auto-detect cookies from Next.js server environment
 * Returns empty object if not in server environment or if cookies are not accessible
 */
export async function autoDetectServerCookies(): Promise<Record<string, string>>
{
    // Client environment — browser sends cookies automatically
    if (typeof window !== 'undefined')
    {
        return {};
    }

    try
    {
        // Next.js cookies() API is only available in server environment
        const { cookies } = await import('next/headers');
        const cookieStore = await cookies();
        const allCookies = cookieStore.getAll();

        const result = Object.fromEntries(
            allCookies.map(cookie => [cookie.name, cookie.value]),
        );

        cookieLogger.debug('Server cookies detected', {
            count: allCookies.length,
            names: allCookies.map(c => c.name),
        });

        return result;
    }
    catch (error)
    {
        // Server environment but cookies() not accessible
        // (e.g. static generation, build time, or outside request context)
        const err = error as Error;
        cookieLogger.warn('Failed to read server cookies', {
            message: err.message,
            name: err.name,
        });

        return {};
    }
}

/**
 * Why a call was aborted, as recorded by the abort scope that aborted it
 */
export type AbortCause = 'timeout' | 'caller';

/**
 * What a fetch run in an abort scope produced: the response and its parsed body,
 * or the failure together with the abort cause the scope recorded, if any. For a
 * caller abort, `error` is the caller signal's reason.
 */
export type ScopedFetchResult =
    | { ok: true; response: Response; body: any }
    | { ok: false; error: unknown; cause?: AbortCause };

/**
 * One controller that two sources may abort: the call's timer and the caller's signal
 *
 * The first source to fire is recorded as the cause and later ones are ignored, so a
 * caller aborting after the timer fired still reads as a timeout. Composed by hand
 * rather than with `AbortSignal.any` / `AbortSignal.timeout`, which browsers below
 * Safari 17.4 lack.
 */
function openAbortScope(callerSignal: AbortSignal | undefined, timeout: number)
{
    const controller = new AbortController();
    let cause: AbortCause | undefined;

    const abort = (source: AbortCause, reason?: unknown) =>
    {
        cause ??= source;
        controller.abort(reason);
    };
    const onCallerAbort = () => abort('caller', callerSignal?.reason);
    const timeoutId = setTimeout(() => abort('timeout'), timeout);

    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    return {
        signal: controller.signal,
        cause: () => cause,
        stopTimer: () => clearTimeout(timeoutId),
        close: () =>
        {
            clearTimeout(timeoutId);
            callerSignal?.removeEventListener('abort', onCallerAbort);
        },
    };
}

/**
 * Fetch and parse a response inside one abort scope
 *
 * The caller's signal is the one on the final `init`, after interceptors ran. The timer
 * stops when response headers arrive; the caller's abort stays effective until the body
 * is parsed. A failure is returned, not thrown, with the cause the scope recorded —
 * classification reads that record, never the error's name.
 */
export async function fetchInAbortScope(
    url: string,
    init: RequestInit,
    timeout: number,
    customFetch: typeof fetch = fetch,
): Promise<ScopedFetchResult>
{
    const callerSignal = init.signal ?? undefined;

    if (callerSignal?.aborted)
    {
        return { ok: false, error: callerSignal.reason, cause: 'caller' };
    }

    const scope = openAbortScope(callerSignal, timeout);

    try
    {
        const response = await customFetch(url, { ...init, signal: scope.signal });

        scope.stopTimer();

        return { ok: true, response, body: await parseResponseBody(response) };
    }
    catch (error)
    {
        const cause = scope.cause();

        return { ok: false, cause, error: cause === 'caller' ? callerSignal?.reason : error };
    }
    finally
    {
        scope.close();
    }
}

/**
 * Handle error response with deserialization support
 * Attempts to deserialize custom errors if errorRegistry is provided
 * Falls back to ApiError if deserialization fails or is not available
 */
export async function handleErrorResponse(
    response: Response,
    body: any,
    fullUrl: string,
    errorRegistry: ErrorRegistry | undefined,
    debug: boolean,
    logger: Logger,
): Promise<never>
{
    if (debug)
    {
        debugLogs.logErrorResponse(logger, response.status, body);
    }

    // Try to deserialize error if registry is provided
    let deserializedError: Error | null = null;

    if (errorRegistry && body && typeof body === 'object' && '__type' in body)
    {
        if (debug)
        {
            debugLogs.logErrorDeserializationAttempt(logger, body.__type, errorRegistry.getRegisteredTypes());
        }

        try
        {
            deserializedError = errorRegistry.deserialize(body as any);

            if (debug)
            {
                debugLogs.logErrorDeserializationSuccess(logger, deserializedError);
            }
        }
        catch (deserializeError)
        {
            // Deserialization itself failed (type not found, invalid data, etc.)
            if (debug)
            {
                debugLogs.logErrorDeserializationFailure(logger, deserializeError);
            }
            // Fall through to ApiError below
        }
    }
    else if (debug)
    {
        debugLogs.logErrorDeserializationSkipped(logger, errorRegistry, body);
    }

    // If deserialization succeeded, throw the deserialized error
    if (deserializedError)
    {
        if (debug)
        {
            debugLogs.logThrowingDeserializedError(logger, deserializedError);
        }

        throw deserializedError;
    }

    // Fallback to generic ApiError
    if (response.status === 404 && process.env.NODE_ENV !== 'production')
    {
        logger.warn(
            '\n⚠️  404 Not Found\n\n' +
            'Check the following:\n' +
            '  1. Routes are registered in server.config.ts:\n' +
            '     → defineServerConfig().routes(appRouter)\n' +
            '  2. Delete .spfn cache if you recently added new routes:\n' +
            '     → rm -rf .spfn\n',
        );
    }

    throw new ApiError(
        body?.message || `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        fullUrl,
        body,
        'http',
    );
}
