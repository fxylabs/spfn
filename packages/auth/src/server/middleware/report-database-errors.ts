/**
 * @spfn/auth - Feeding the reconnect trigger from a route without a transaction
 *
 * @module server/middleware/report-database-errors
 */

import type { MiddlewareHandler } from 'hono';
import { reportDatabaseError } from '@spfn/core/db';

/**
 * Hand every error a route answers to `reportDatabaseError`, as
 * `Transactional()` does, without opening a transaction.
 *
 * For a route whose service opens its own transaction after a step that must
 * not run inside one — the app's password rule. Without `Transactional()`
 * nothing else reports what the route's queries fail with, so repeated
 * connection failures there would never force the pool rebuild. Covers the
 * whole handler, the reads before the service's transaction included; errors
 * that are not connection-level are ignored by the reporter, and an error
 * already reported further down is not counted twice.
 */
export function reportDatabaseErrors(): MiddlewareHandler
{
    return async (c, next) =>
    {
        await next().catch((error: unknown) =>
        {
            reportDatabaseError(error);

            throw error;
        });

        reportDatabaseError(c.error);
    };
}
