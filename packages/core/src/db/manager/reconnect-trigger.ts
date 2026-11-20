/**
 * Reconnect Trigger — Query-error driven pool rebuild
 *
 * Complements the periodic health check with a fast-path: when application
 * queries start failing with connection-level errors, we do not wait up to
 * DB_HEALTH_CHECK_INTERVAL (default 60s) to notice. A sliding-window counter
 * trips a force-reconnect as soon as the failure rate crosses a threshold.
 *
 * Why this exists:
 *  - postgres.js transparently drops dead sockets and opens new ones on the
 *    next query. A single `SELECT 1` on the periodic interval can therefore
 *    false-pass while user-facing queries keep hitting the remaining dead
 *    sockets in the pool.
 *  - This module observes real query errors and, when it sees a burst of
 *    connection-level failures, calls triggerForceReconnect() which performs
 *    the same atomic-swap rebuild as the health check.
 *
 * Configuration (env vars, hardcoded defaults):
 *  - DB_RECONNECT_ERROR_THRESHOLD (default 3): errors needed in window
 *  - DB_RECONNECT_ERROR_WINDOW_MS (default 10000): sliding window size
 */

import { ConnectionError } from '@spfn/core/errors';
import { logger } from '@spfn/core/logger';
import { POSTGRES_JS_CONNECTION_CODES } from '../../logger/error-description';
import { parseNumber } from '@spfn/core/env';

import { isReconnectingNow, triggerForceReconnect } from './health-check';

const dbLogger = logger.child('@spfn/core:database');

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Node.js socket/network error codes that indicate a lost connection
 */
const NODE_NET_ERROR_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
]);

/**
 * PostgreSQL SQLSTATE prefixes / codes that indicate server-side connection loss
 *
 * - Class 08: connection exception (all members)
 * - 53300: too_many_connections
 * - 57P01..03: admin_shutdown / crash_shutdown / cannot_connect_now
 */
function isConnectionSqlState(code: string): boolean
{
    if (code.startsWith('08')) return true;
    if (code === '53300') return true;
    if (code === '57P01' || code === '57P02' || code === '57P03') return true;

    return false;
}

/**
 * Walk an error and all its causes (cause, original, error, err, inner)
 * yielding each candidate so we can inspect nested driver errors that were
 * wrapped by Repository / route layers.
 */
function* unwrap(error: unknown): Generator<Record<string, unknown>>
{
    const seen = new Set<unknown>();
    const stack: unknown[] = [error];

    while (stack.length > 0)
    {
        const current = stack.pop();
        if (!current || typeof current !== 'object' || seen.has(current))
        {
            continue;
        }
        seen.add(current);

        const obj = current as Record<string, unknown>;
        yield obj;

        for (const key of ['cause', 'original', 'error', 'err', 'inner'])
        {
            const nested = obj[key];
            if (nested && typeof nested === 'object' && !seen.has(nested))
            {
                stack.push(nested);
            }
        }
    }
}

/**
 * Determine whether an error looks like a pool/connection failure
 *
 * Returns true when any layer in the error chain exposes a connection-level
 * code (postgres.js driver code, Node network errno, PG SQLSTATE class 08 etc.)
 * or is an instance of our own ConnectionError wrapper.
 *
 * Returns false for query errors (syntax, constraint violations, etc.) — those
 * should NOT trigger a pool rebuild.
 */
export function isConnectionLevelError(error: unknown): boolean
{
    if (!error) return false;

    if (error instanceof ConnectionError) return true;

    for (const candidate of unwrap(error))
    {
        if (candidate instanceof ConnectionError) return true;

        const code = candidate.code;
        if (typeof code === 'string')
        {
            if (POSTGRES_JS_CONNECTION_CODES.has(code)) return true;
            if (NODE_NET_ERROR_CODES.has(code)) return true;
            if (isConnectionSqlState(code)) return true;
        }
    }

    return false;
}

// ============================================================================
// Sliding-window counter
// ============================================================================

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 10_000;
const MIN_WINDOW_MS = 1_000;

/**
 * Read a positive-integer env var with a hard minimum and a fallback default.
 *
 * Used once at module load — runtime tuning is not supported on purpose:
 *  - reportDatabaseError is on the error hot path; env reads would be wasteful
 *  - threshold/window are operational knobs, not things that should flip per-call
 *
 * Invalid values silently fall back to the default rather than crashing the
 * process at import time — the reconnect trigger is advisory, not load-bearing.
 */
function readPositiveIntEnv(key: string, defaultValue: number, min: number): number
{
    const raw = process.env[key];
    if (raw === undefined) return defaultValue;
    try
    {
        return parseNumber(raw, { min, integer: true });
    }
    catch
    {
        return defaultValue;
    }
}

const ERROR_THRESHOLD = readPositiveIntEnv('DB_RECONNECT_ERROR_THRESHOLD', DEFAULT_THRESHOLD, 1);
const ERROR_WINDOW_MS = readPositiveIntEnv('DB_RECONNECT_ERROR_WINDOW_MS', DEFAULT_WINDOW_MS, MIN_WINDOW_MS);

/**
 * Timestamps (ms) of recent connection-level errors within the window.
 * Module-local state — intentionally process-local, not on globalThis,
 * because the counter is purely advisory and should reset on HMR.
 */
const errorTimestamps: number[] = [];

/**
 * Errors that have already been fed into the reconnect trigger.
 *
 * Prevents double-counting when the same underlying failure is caught at
 * multiple layers — e.g. BaseRepository.withContext reports the raw pg
 * error, then wraps it in a RepositoryError which the @Transactional
 * middleware also catches and reports. Without dedup, a single failure
 * would add two entries to the sliding window and effectively halve the
 * threshold for transactional-repo routes.
 *
 * Strategy: walk the error chain, add every object to the WeakSet. A
 * subsequent report that shares ANY object in its chain is skipped.
 * Uses WeakSet so entries GC with the errors themselves — no leak.
 */
const reportedErrors = new WeakSet<object>();

/**
 * Reset the internal error counter
 *
 * Exposed for tests that need a clean slate between cases. Does not clear
 * the WeakSet (which is GC-backed and self-cleans with error lifetimes).
 */
export function resetConnectionErrorCounter(): void
{
    errorTimestamps.length = 0;
}

/**
 * Check whether any object in the error chain has already been reported,
 * and if not, mark every object in the chain as reported.
 *
 * Returns true when the error chain had already been seen (caller should skip),
 * false when this is a fresh error (caller should proceed and count).
 */
function checkAndMarkReported(error: unknown): boolean
{
    let alreadySeen = false;
    const toMark: object[] = [];

    for (const candidate of unwrap(error))
    {
        if (reportedErrors.has(candidate))
        {
            alreadySeen = true;
        }
        toMark.push(candidate);
    }

    if (alreadySeen) return true;

    for (const obj of toMark)
    {
        reportedErrors.add(obj);
    }

    return false;
}

/**
 * Report a database error to the reconnect trigger
 *
 * Call this from any site that catches a query error before rethrowing.
 * It is a no-op for non-connection-level errors. When the threshold is
 * crossed it calls triggerForceReconnect() in the background — callers
 * should NOT await it.
 *
 * Safe to call from any context: catches its own errors so it cannot
 * disrupt the calling catch block. Deduplicates across error-chain
 * re-wrapping so one failure counts exactly once regardless of how many
 * catch layers it passes through.
 */
export function reportDatabaseError(error: unknown): void
{
    try
    {
        if (!isConnectionLevelError(error)) return;
        if (isReconnectingNow()) return;
        if (checkAndMarkReported(error)) return;

        const now = Date.now();
        errorTimestamps.push(now);

        // Prune entries that fell outside the sliding window
        const cutoff = now - ERROR_WINDOW_MS;
        while (errorTimestamps.length > 0 && errorTimestamps[0] < cutoff)
        {
            errorTimestamps.shift();
        }

        if (errorTimestamps.length < ERROR_THRESHOLD) return;

        // Threshold crossed — reset immediately so we don't queue multiple
        // triggers while the first one is still running.
        errorTimestamps.length = 0;

        dbLogger.error('Connection-error threshold crossed, forcing pool rebuild', {
            threshold: ERROR_THRESHOLD,
            windowMs: ERROR_WINDOW_MS,
        });

        triggerForceReconnect('query_error_threshold').catch((error: unknown) =>
        {
            dbLogger.error('Forced reconnect after error threshold failed', { error });
        });
    }
    catch (err: unknown)
    {
        // Reporter must never throw — swallow so the original error path
        // (caller's catch block) continues unchanged.
        dbLogger.debug('reportDatabaseError itself threw, ignoring', { error: err });
    }
}
