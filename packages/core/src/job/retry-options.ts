/**
 * Retry options, translated from the job API's units to pg-boss's
 */

import type { JobOptions } from './types';

export interface PgBossRetryOptions
{
    retryLimit: number;
    retryDelay: number;
    retryBackoff: boolean;
}

/**
 * The retry options every enqueue path hands to pg-boss
 *
 * `JobOptions.retryDelay` is in milliseconds; pg-boss reads `retryDelay` in
 * seconds. Passing it through unchanged turned a documented 5-second retry
 * into 5000 seconds (83 minutes). A delay under one second rounds up to one,
 * so a non-zero delay never becomes an immediate retry.
 */
export function toPgBossRetryOptions(options?: JobOptions): PgBossRetryOptions
{
    return {
        retryLimit: options?.retryLimit ?? 3,
        retryDelay: Math.ceil((options?.retryDelay ?? 1000) / 1000),
        // Exponential backoff by default — a failed cohort (e.g. a provider 429)
        // would otherwise all retry at the same fixed offset (thundering herd).
        retryBackoff: options?.retryBackoff ?? true,
    };
}
