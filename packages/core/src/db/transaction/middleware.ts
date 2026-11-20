/**
 * Transactional Middleware
 *
 * Wraps route handlers in a database transaction.
 * Auto-commits on success, auto-rolls back on error.
 *
 * Features:
 * - Automatic transaction management (start/commit/rollback)
 * - Transaction propagation via AsyncLocalStorage
 * - Nested transaction detection and logging
 * - Hono Context error detection
 * - Transaction timeout with configurable threshold
 * - Execution time tracking and slow transaction warnings
 * - UUID-based transaction IDs for debugging
 * - PostgreSQL error conversion to custom errors — driver-raised errors only;
 *   application and third-party errors reach the caller untouched
 */
import { createMiddleware } from 'hono/factory';
import { SerializableError } from '@spfn/core/errors';
// Package specifier: the declared prefixes live in the middleware entry's one copy
import { loggedPath } from '@spfn/core/middleware';
import { fromPostgresError } from '../postgres-errors';
import { reportDatabaseError } from '../manager/reconnect-trigger';
import { isDriverError } from '../../logger/error-description';
import { runInTransaction } from './runner';

/**
 * Transaction middleware options
 */
export interface TransactionalOptions
{
    /**
     * Slow transaction warning threshold in milliseconds
     * @default 1000 (1 second)
     */
    slowThreshold?: number;

    /**
     * Enable transaction logging
     * @default true
     */
    enableLogging?: boolean;

    /**
     * Transaction timeout in milliseconds
     *
     * If transaction exceeds this duration, it will be aborted with TransactionError.
     *
     * @default 30000 (30 seconds) or TRANSACTION_TIMEOUT environment variable
     *
     * @example
     * ```typescript
     * // Default timeout (30s or TRANSACTION_TIMEOUT env var)
     * Transactional()
     *
     * // Custom timeout for specific route (60s)
     * Transactional({ timeout: 60000 })
     *
     * // Disable timeout
     * Transactional({ timeout: 0 })
     * ```
     */
    timeout?: number;

    /**
     * Idle-in-transaction timeout in milliseconds — Postgres reclaims the pooled
     * connection if the transaction sits idle (e.g. the handler awaits external
     * I/O) longer than this. A backstop against pool starvation, not a license
     * to do non-DB work inside a transaction. `0` disables it.
     *
     * @default 30000 (30s) or TRANSACTION_IDLE_TIMEOUT environment variable
     */
    idleTimeout?: number;

    /**
     * Run in an independent transaction instead of joining an ambient one.
     *
     * Only bites when the middleware itself runs nested — a sub-app mounted
     * under a route that already applied `Transactional()`, or a handler invoked
     * from inside `runInTransaction`. By default that inner run takes a SAVEPOINT
     * on the outer transaction; `requiresNew: true` gives it a real `BEGIN` on a
     * second pooled connection, with its own timeouts and its own hook queues.
     *
     * See `RunInTransactionOptions.requiresNew` for the pool and self-deadlock
     * costs — they apply here unchanged.
     *
     * @default false
     */
    requiresNew?: boolean;
}

/**
 * Transaction middleware for Hono routes
 *
 * Automatically wraps route handlers in a database transaction.
 * Commits on success, rolls back on error.
 *
 * @example
 * ```typescript
 * // In your route file
 * export const middlewares = [Transactional()];
 *
 * export async function POST(c: RouteContext) {
 *   // All DB operations run in a transaction
 *   const [user] = await db.insert(users).values(body).returning();
 *   await db.insert(profiles).values({ userId: user.id });
 *   // Auto-commits on success
 *   return c.json(user, 201);
 * }
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * export const middlewares = [
 *   Transactional({
 *     slowThreshold: 2000,    // Warn if transaction takes > 2s
 *     enableLogging: false,   // Disable logging
 *     timeout: 60000,         // 60 second timeout for long operations
 *   })
 * ];
 * ```
 *
 * 🔄 Transaction behavior:
 * - Success: Auto-commit
 * - Error: Auto-rollback
 * - Detects context.error to trigger rollback
 * - Hooks: this delegates to runInTransaction, so onBeforeCommit, onAfterCommit
 *   and onAfterRollback behave exactly as they do there. afterRollback callbacks
 *   have already run by the time the error reaches the conversion below.
 *
 * 📊 Transaction logging:
 * - Auto-logs transaction start/commit/rollback
 * - Measures and records execution time
 * - Warns about slow transactions (default: > 1s)
 */
export function Transactional(options: TransactionalOptions = {})
{
    return createMiddleware(async (c, next) =>
    {
        const route = `${c.req.method} ${loggedPath(c)}`;

        try
        {
            // Run route handler within transaction
            await runInTransaction(
                async () =>
                {
                    // Execute handler
                    await next();

                    // Detect if Hono caught an error and stored it in context.error
                    // Context type doesn't officially define error property, so we extend it
                    type ContextWithError = typeof c & { error?: Error };

                    const contextWithError = c as ContextWithError;
                    if (contextWithError.error)
                    {
                        // Throw to rollback transaction
                        throw contextWithError.error;
                    }
                },
                {
                    context: route,
                    ...options,
                },
            );
        }
        catch (error)
        {
            // Feed connection-level errors to the reconnect-trigger before
            // rethrowing. No-op for non-connection errors.
            reportDatabaseError(error);

            // 프레임워크 에러 계열(SerializableError)은 그대로 throw.
            //
            // DatabaseError·TransactionError를 포함해 statusCode와 toJSON() 봉투를
            // 이미 갖춘 모든 에러가 여기에 들어온다 — 애플리케이션이 직접 정의한
            // 403 거부 에러처럼 code 필드를 달고 있어도 마찬가지다. 변환은 그런
            // 에러에게서 상태 코드와 봉투를 빼앗을 뿐이다 (issue #82).
            if (error instanceof SerializableError)
            {
                throw error;
            }

            // 진짜 드라이버가 올린 PostgreSQL 에러만 변환
            if (isDriverError(error))
            {
                throw fromPostgresError(error);
            }

            // 그 외 모든 에러는 그대로 throw (InvalidCredentialsError 등 비즈니스 로직 에러)
            throw error;
        }
    });
}
