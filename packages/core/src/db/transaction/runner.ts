/**
 * Transaction Runner
 *
 * Standalone transaction execution utility for scripts, migrations, and CLI commands.
 * Provides the same transaction management capabilities as the Transactional middleware
 * but without Hono dependency.
 *
 * Features:
 * - Automatic transaction management (start/commit/rollback)
 * - Transaction propagation via AsyncLocalStorage
 * - PostgreSQL-level timeout with automatic rollback guarantee
 * - Execution time tracking and slow transaction warnings
 * - UUID-based transaction IDs for debugging
 *
 * Timeout Implementation:
 * Uses PostgreSQL `SET LOCAL statement_timeout` to ensure database-level timeout
 * enforcement. This guarantees that long-running transactions are actually rolled
 * back at the database level, preventing data inconsistency.
 *
 * Nesting:
 * A call made while another transaction is already open on the async call chain
 * takes a SAVEPOINT on that transaction's connection instead of opening a second
 * one. Nested calls made off the same transaction run one at a time, because
 * their savepoints share that connection. Pass `requiresNew: true` to opt out
 * and get an independent transaction on a connection of its own.
 *
 * @example
 * ```typescript
 * import { runInTransaction } from '@spfn/core/db';
 * import { users } from './schema';
 *
 * // Simple usage
 * const user = await runInTransaction(async (tx) => {
 *   const [user] = await tx.insert(users).values({ name: 'John' }).returning();
 *   return user;
 * });
 *
 * // With options
 * await runInTransaction(
 *   async (tx) => {
 *     await tx.insert(users).values({ name: 'Jane' });
 *     await tx.insert(profiles).values({ userId: 1 });
 *   },
 *   {
 *     context: 'migration:add-user',
 *     timeout: 60000,
 *     slowThreshold: 2000,
 *   }
 * );
 * ```
 */
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';
import { logger } from '@spfn/core/logger';
import { getDatabase } from '../manager';
import {
    asyncContext,
    createNestedFrameGate,
    runWithTransaction,
    getTransactionContext,
    type TransactionContext,
    type TransactionDB,
    type AfterCommitCallback,
    type BeforeCommitCallback,
    type AfterRollbackCallback,
} from './context';
import { TransactionError } from '@spfn/core/errors';
import { env } from '@spfn/core/config';
import type { DefaultDatabase, DrizzleDatabase } from '../manager/types';

/**
 * PostgreSQL maximum timeout value (max int4)
 */
const MAX_TIMEOUT_MS = 2147483647;
const txLogger = logger.child('@spfn/core:transaction');

/**
 * Emit a status log line under a backstop
 *
 * The commit/rollback status lines sit at points where a throwing logger would
 * be destructive and never useful: on the rollback path it would replace the
 * error that caused the rollback and skip the afterRollback callbacks; on the
 * success path it would report a failure for a transaction that already
 * committed and drop the afterCommit queue. A broken logger changes neither.
 */
function logSafely(emit: () => void): void
{
    try
    {
        emit();
    }
    catch
    {
        // Reporting a logging failure would need the logger. Stay silent.
    }
}

/**
 * Run the beforeCommit callbacks, in registration order, inside the transaction
 *
 * The queue is SNAPSHOT before the pass. A callback that itself calls
 * onBeforeCommit would otherwise grow the array while we walk it, and a
 * self-registering callback would spin forever inside an open transaction,
 * holding a pooled connection — statement_timeout cannot save us there, because
 * no statement is running. The semantics that follow are documented on
 * onBeforeCommit: a callback registered during the pass does not run for this
 * commit.
 *
 * These run after the user callback resolved, so the transaction is still healthy
 * and a callback may issue statements that join the same commit. A throw is
 * deliberately NOT caught: it escapes writeDb.transaction(), which rolls the
 * transaction back, and the afterRollback callbacks then fire. Later callbacks
 * are skipped — the transaction they would have run in is already doomed.
 */
async function runBeforeCommitCallbacks(callbacks: BeforeCommitCallback[]): Promise<void>
{
    for (const cb of [...callbacks])
    {
        await cb();
    }
}

/**
 * Run the afterRollback callbacks, in registration order, after a rollback
 *
 * For a root that is outside any transaction context; for a savepoint frame it
 * is inside the parent's (see discardFrameHooks). Nothing here depends on which.
 *
 * The rollback error is already on its way to the caller, so nothing here may
 * replace it: each callback's failure is logged through logSafely, so neither a
 * broken callback nor a broken logger can stop the rest. The opening debug line
 * goes through logSafely for the same reason — a throw there would skip every
 * callback. Callbacks are awaited so they complete before the error leaves the
 * runner.
 */
async function runAfterRollbackCallbacks(
    callbacks: AfterRollbackCallback[],
    txId: string,
    context: string,
    enableLogging: boolean,
): Promise<void>
{
    if (enableLogging)
    {
        logSafely(() => txLogger.debug('Executing afterRollback callbacks', {
            txId,
            context,
            count: callbacks.length,
        }));
    }

    for (const cb of callbacks)
    {
        await Promise.resolve()
            .then(cb)
            .catch((err) => logSafely(() =>
            {
                txLogger.error('afterRollback callback failed', {
                    txId,
                    context,
                    error: err instanceof Error ? err.message : String(err),
                });
            }));
    }
}

/**
 * The three hook queues of one transaction frame — root or savepoint
 */
type FrameHooks = Pick<
    TransactionContext,
    'beforeCommitCallbacks' | 'afterCommitCallbacks' | 'afterRollbackCallbacks'
>;

/**
 * Hand a resolved savepoint frame's hooks to the frame it was opened off
 *
 * A savepoint that resolved is only as durable as its parent: its writes now
 * stand or fall with the parent's, so its hooks do too. Appending — rather than
 * merging by time — puts them after everything the parent registered before
 * the nested call and before anything it registers after, which is the order a
 * reader of the call chain expects. Promotion repeats at every level, so a hook
 * reaches the root only if every frame between them resolved.
 */
function promoteFrameHooks(frame: FrameHooks, parent: FrameHooks): void
{
    parent.beforeCommitCallbacks.push(...frame.beforeCommitCallbacks);
    parent.afterCommitCallbacks.push(...frame.afterCommitCallbacks);
    parent.afterRollbackCallbacks.push(...frame.afterRollbackCallbacks);
}

/**
 * Settle a savepoint frame that rolled back to its SAVEPOINT
 *
 * Its writes are gone NOW, whatever the root does next, so its afterRollback
 * callbacks run now — awaited, failures logged, exactly like a root's. Its
 * beforeCommit and afterCommit callbacks are dropped: the work they guard or
 * announce will never commit. The parent transaction is still open here, so a
 * callback runs inside the parent's context and its DB work joins the parent.
 * The original error is rethrown, never replaced.
 *
 * The pass runs in a CLONE of the parent's context with a fresh frame gate.
 * This code runs inside the frame's own gated run on the parent's gate, so a
 * compensation that calls runInTransaction would otherwise queue a savepoint
 * behind the very frame waiting for it, and the root would hang. The clone
 * keeps the parent's tx, level and hook arrays — shared by the spread, so a
 * hook the compensation registers lands on the parent's queues — while its
 * nested calls open off a gate nobody holds. The pass itself still runs inside
 * the outer gated run, so the next sibling waits until it has finished.
 */
async function discardFrameHooks(
    frame: FrameHooks,
    parent: TransactionContext,
    error: unknown,
    txId: string,
    context: string,
    enableLogging: boolean,
): Promise<never>
{
    await asyncContext.run(
        { ...parent, nestedFrames: createNestedFrameGate() },
        () => runAfterRollbackCallbacks(frame.afterRollbackCallbacks, txId, context, enableLogging),
    ).catch(() => undefined);

    throw error;
}

/**
 * Transaction runner options
 */
export interface RunInTransactionOptions
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
     * Sets PostgreSQL `statement_timeout` to enforce database-level timeout.
     * If transaction exceeds this duration, PostgreSQL will automatically cancel
     * the query and rollback the transaction, ensuring data consistency.
     *
     * Behavior:
     * - `timeout: 0` - Disables timeout (unlimited execution time)
     * - `timeout: null` - Uses default (30s or TRANSACTION_TIMEOUT env var)
     * - `timeout: undefined` - Uses default (30s or TRANSACTION_TIMEOUT env var)
     * - `timeout: N` - Sets timeout to N milliseconds (1 to 2147483647)
     *
     * Note: Timeout is only applied to root transactions. A nested call takes a
     * SAVEPOINT on the outer transaction's connection, where the outer
     * transaction's `SET LOCAL statement_timeout` is already in force — so the
     * nested call genuinely inherits it, and its own `timeout` is ignored (a
     * warning is logged when the caller passed one explicitly). A
     * `requiresNew: true` call is a root and gets its own.
     *
     * @default 30000 (30 seconds) or TRANSACTION_TIMEOUT environment variable
     *
     * @example
     * ```typescript
     * // Use default timeout (30s)
     * await runInTransaction(callback);
     *
     * // Disable timeout for long-running operations
     * await runInTransaction(callback, { timeout: 0 });
     *
     * // Set custom timeout (60s)
     * await runInTransaction(callback, { timeout: 60000 });
     * ```
     */
    timeout?: number;

    /**
     * Idle-in-transaction timeout in milliseconds (root transactions only).
     *
     * Sets PostgreSQL `idle_in_transaction_session_timeout`: if the transaction
     * sits open without running a query for longer than this — e.g. while the
     * handler awaits external I/O inside the transaction — Postgres terminates
     * the session and rolls back, reclaiming the pooled connection instead of
     * letting one stuck request hold it (and its row locks) indefinitely.
     *
     * Do not put external I/O inside a transaction; this is a backstop, not a
     * license. `0` disables it.
     *
     * @default 30000 (30s) or TRANSACTION_IDLE_TIMEOUT environment variable
     */
    idleTimeout?: number;

    /**
     * Context string for logging (e.g., 'migration:add-user', 'script:cleanup')
     * @default 'transaction'
     */
    context?: string;

    /**
     * Run in an independent transaction instead of joining an ambient one.
     *
     * By default a call made while another transaction is open takes a SAVEPOINT
     * on that transaction's connection: its writes commit or roll back with the
     * outer transaction. `requiresNew: true` opens a real `BEGIN` on a SECOND
     * pooled connection instead, so the work commits on its own and survives an
     * outer rollback — an audit trail or a failed-attempt record, for example.
     *
     * Being a root transaction, it gets its own `statement_timeout`,
     * `idle_in_transaction_session_timeout`, and its OWN hook queues:
     * `onBeforeCommit` / `onAfterCommit` / `onAfterRollback` registered inside it
     * fire on ITS outcome, not the outer transaction's.
     *
     * Two costs, both consequences of the second connection:
     * - It holds a second connection for its whole duration, so it counts twice
     *   against the pool. Keep it short and don't fan it out.
     * - It cannot see the outer transaction's uncommitted writes, and it BLOCKS
     *   on any row the outer transaction has locked. Since the outer transaction
     *   is waiting for this call to return, that block is a self-deadlock that
     *   only `statement_timeout` breaks. Never touch rows the outer transaction
     *   wrote.
     *
     * @default false
     *
     * @example
     * ```typescript
     * await runInTransaction(async () =>
     * {
     *     await orderRepo.create(order);
     *
     *     // Lands even if the order below rolls the outer transaction back.
     *     await runInTransaction(
     *         () => auditRepo.record('order.attempted', order.id),
     *         { requiresNew: true },
     *     );
     *
     *     await inventoryRepo.reserve(order.items);   // may throw
     * });
     * ```
     */
    requiresNew?: boolean;
}

/**
 * Run a callback function within a database transaction
 *
 * Automatically manages transaction lifecycle:
 * - Commits on success
 * - Rolls back on error
 * - Tracks execution time
 * - Warns about slow transactions
 * - Enforces timeout if configured
 *
 * Called with a transaction already open on the async call chain, it takes a
 * SAVEPOINT on that transaction rather than opening an independent one: the work
 * runs on the same connection, sees the outer transaction's uncommitted writes,
 * and commits with it. A throw that the caller catches unwinds to the SAVEPOINT
 * and leaves the outer transaction healthy; a throw that propagates rolls the
 * whole thing back. Nested calls off one transaction are serialized — see
 * `openTransaction` — so `Promise.all` over them runs them one at a time. Pass
 * `requiresNew: true` for an independent transaction on its own connection.
 *
 * Errors are propagated to the caller without modification.
 * Caller is responsible for error handling and conversion.
 *
 * @param callback - Function to execute within transaction
 * @param options - Transaction options
 * @returns Result of callback function
 * @throws TransactionError if database not initialized or timeout exceeded
 * @throws Any error thrown by callback function
 */
export async function runInTransaction<T, TDatabase extends DrizzleDatabase = DefaultDatabase>(
    callback: (tx: TransactionDB<TDatabase>) => Promise<T>,
    options: RunInTransactionOptions = {},
): Promise<T>
{
    // Get default timeout from environment variable (default: 30 seconds)
    const defaultTimeout = env.TRANSACTION_TIMEOUT;

    const {
        slowThreshold = 1000,
        enableLogging = true,
        context = 'transaction',
        requiresNew = false,
    } = options;

    // Handle timeout: null/undefined → default, 0 → disabled, N → N milliseconds
    const timeout = options.timeout ?? defaultTimeout;

    // Idle-in-transaction backstop: 0 disables, else default from env
    const idleTimeout = options.idleTimeout ?? env.TRANSACTION_IDLE_TIMEOUT;

    // Generate transaction ID for debugging
    const txId = `tx_${randomUUID()}`;

    /**
     * Helper function to validate parameters and throw TransactionError
     */
    const validateAndThrow = (
        condition: boolean,
        message: string,
        logMessage: string,
        metadata: Record<string, unknown>,
    ): void =>
    {
        if (condition)
        {
            const error = new TransactionError({ message, statusCode: 400, details: metadata });

            if (enableLogging)
            {
                txLogger.error(logMessage, { ...metadata, error: error.message });
            }

            throw error;
        }
    };

    // Validate all input parameters before DB access (fail-fast pattern)

    // Validate callback is a function
    validateAndThrow(
        typeof callback !== 'function',
        'Callback must be a function',
        'Invalid callback type',
        { txId, context, callbackType: typeof callback },
    );

    // Validate slowThreshold
    validateAndThrow(
        !Number.isInteger(slowThreshold) || slowThreshold < 0,
        `Invalid slowThreshold value: ${slowThreshold}. Must be a non-negative integer.`,
        'Invalid slowThreshold',
        { txId, context, slowThreshold },
    );

    // Validate timeout value for SQL safety
    validateAndThrow(
        !Number.isInteger(timeout),
        `Invalid timeout value: ${timeout}. Must be an integer.`,
        'Invalid timeout type',
        { txId, context, timeout },
    );

    validateAndThrow(
        timeout < 0,
        `Invalid timeout value: ${timeout}. Timeout must be non-negative (0 to disable, or 1-${MAX_TIMEOUT_MS}ms).`,
        'Invalid timeout range',
        { txId, context, timeout },
    );

    validateAndThrow(
        timeout > MAX_TIMEOUT_MS,
        `Invalid timeout value: ${timeout}. Maximum timeout is ${MAX_TIMEOUT_MS}ms.`,
        'Timeout exceeds maximum',
        { txId, context, timeout, maxTimeout: MAX_TIMEOUT_MS },
    );

    // Validate idleTimeout the same way — it is interpolated into
    // `SET LOCAL idle_in_transaction_session_timeout` via sql.raw (SET commands
    // don't support bind params), so a non-integer would be an injection vector.
    validateAndThrow(
        !Number.isInteger(idleTimeout),
        `Invalid idleTimeout value: ${idleTimeout}. Must be an integer.`,
        'Invalid idleTimeout type',
        { txId, context, idleTimeout },
    );

    validateAndThrow(
        idleTimeout < 0,
        `Invalid idleTimeout value: ${idleTimeout}. Must be non-negative (0 to disable).`,
        'Invalid idleTimeout range',
        { txId, context, idleTimeout },
    );

    validateAndThrow(
        idleTimeout > MAX_TIMEOUT_MS,
        `Invalid idleTimeout value: ${idleTimeout}. Maximum is ${MAX_TIMEOUT_MS}ms.`,
        'idleTimeout exceeds maximum',
        { txId, context, idleTimeout, maxTimeout: MAX_TIMEOUT_MS },
    );

    // Get write database instance (after all input validations)
    const writeDb = getDatabase<TDatabase>('write');
    if (!writeDb)
    {
        const error = new TransactionError({
            message: 'Database not initialized. Cannot start transaction.',
            statusCode: 500,
            details: { txId, context },
        });

        if (enableLogging)
        {
            txLogger.error('Database not initialized', {
                txId,
                context,
                error: error.message,
            });
        }

        throw error;
    }

    // The transaction this call nests into, as a SAVEPOINT on its connection.
    //
    // Null when nothing is open — the plain root case — and null under
    // `requiresNew`, which asks for an independent transaction rather than a
    // savepoint. Everything downstream keyed on `isNested` therefore reads as
    // "this call is not a root": a requiresNew call IS a root, and gets the
    // timeouts and the hook queues of one.
    const savepointOwner = requiresNew ? null : getTransactionContext<TDatabase>();
    const isNested = savepointOwner !== null;

    // Warn only when the caller passed a timeout explicitly: the 30s default
    // would warn on every nested call and bury the case that matters — an
    // explicit timeout the database never sees.
    if (isNested && options.timeout !== undefined && options.timeout > 0 && enableLogging)
    {
        txLogger.warn('Timeout ignored in nested transaction', {
            txId,
            context,
            outerTxId: savepointOwner.txId,
            requestedTimeout: `${timeout}ms`,
            reason: 'the SAVEPOINT runs under the outer transaction\'s statement_timeout; SET LOCAL here would re-scope the whole outer transaction',
        });
    }

    // Log transaction start AFTER all validations pass
    if (enableLogging)
    {
        txLogger.debug('Transaction started', { txId, context });
    }

    // Start timing from actual transaction execution
    const startTime = Date.now();

    // Hook queues of THIS call's frame — root or savepoint.
    //
    // These are ALIASES of the arrays inside the frame's context, not copies,
    // and they are bound on entry to the transaction closure — before the user
    // callback can throw. That is what makes them reachable once the frame has
    // settled, where the AsyncLocalStorage context is already gone: a throw can
    // never lose a registered rollback callback. Callbacks registered later
    // (including hooks promoted from savepoint frames that resolved inside this
    // one) mutate these same arrays, so the runner always sees the full queue.
    let beforeCommitCallbacks: BeforeCommitCallback[] = [];
    let afterCommitCallbacks: AfterCommitCallback[] = [];
    let afterRollbackCallbacks: AfterRollbackCallback[] = [];

    /**
     * Open the transaction this call asked for and run `body` inside it.
     *
     * Three shapes, one body:
     * - Nested: `savepointOwner.tx.transaction(...)`. Drizzle issues
     *   SAVEPOINT / ROLLBACK TO on the connection the outer transaction already
     *   holds, so the work joins it — same connection, outer uncommitted writes
     *   visible, no second pool checkout, no self-deadlock. It runs through the
     *   outer context's frame gate, which holds the frame back until the
     *   previous frame opened off the SAME context has closed: two concurrent
     *   siblings on one connection would otherwise overlap, and the first
     *   `ROLLBACK TO` would take the other sibling's rows with it. The frame's
     *   hooks are settled INSIDE the gated run — promoted to the owner, or
     *   their afterRollback callbacks run — so the next sibling never opens
     *   onto a half-promoted queue or alongside a compensation still writing
     *   on the shared connection.
     * - `requiresNew`: a real BEGIN, and it must enter as a root. Run through
     *   `asyncContext.exit` so the ambient context is invisible to it: otherwise
     *   `runWithTransaction` would hand it the outer transaction's hook queues
     *   and a nested `level`, and its hooks would fire on the outer
     *   transaction's outcome instead of its own.
     * - Root: a real BEGIN, unchanged.
     */
    const openTransaction = (body: (tx: TransactionDB<TDatabase>) => Promise<T>): Promise<T> =>
    {
        if (savepointOwner)
        {
            return savepointOwner.nestedFrames.run(() =>
                (savepointOwner.tx.transaction(body as never) as Promise<T>).then(
                    (result) =>
                    {
                        promoteFrameHooks({ beforeCommitCallbacks, afterCommitCallbacks, afterRollbackCallbacks }, savepointOwner);

                        return result;
                    },
                    (error: unknown) => discardFrameHooks(
                        { beforeCommitCallbacks, afterCommitCallbacks, afterRollbackCallbacks },
                        savepointOwner,
                        error,
                        txId,
                        context,
                        enableLogging,
                    ),
                ),
            );
        }

        if (requiresNew)
        {
            return asyncContext.exit(() => writeDb.transaction(body as never) as Promise<T>);
        }

        return writeDb.transaction(body as never) as Promise<T>;
    };

    // Execute transaction within try-catch to capture all errors
    try
    {
        // Execute transaction with PostgreSQL-level timeout
        const result = await openTransaction(async (tx) =>
        {
            const transaction = tx as TransactionDB<TDatabase>;

            // Set PostgreSQL statement timeout only for root transactions.
            // A SAVEPOINT shares the outer transaction's connection, so SET LOCAL
            // here would re-scope the whole outer transaction — and it does not
            // need to: the outer transaction's timeout already covers it.
            if (timeout > 0 && !isNested)
            {
                // Using sql.raw() because SET commands don't support parameter binding
                await transaction.execute(sql.raw(`SET LOCAL statement_timeout = ${timeout}`));
            }

            // Idle-in-transaction backstop (root only): reclaims the pooled
            // connection if the transaction sits idle (e.g. awaiting external I/O)
            if (idleTimeout > 0 && !isNested)
            {
                await transaction.execute(sql.raw(`SET LOCAL idle_in_transaction_session_timeout = ${idleTimeout}`));
            }

            // Store transaction in AsyncLocalStorage
            return await runWithTransaction(transaction, txId, async () =>
            {
                // Bind the frame's hook queues before running user code, so they
                // survive a throw (see the declarations above). Nested frames
                // need this as much as the root: their queues are their own now
                const ctx = getTransactionContext();
                if (ctx)
                {
                    beforeCommitCallbacks = ctx.beforeCommitCallbacks;
                    afterCommitCallbacks = ctx.afterCommitCallbacks;
                    afterRollbackCallbacks = ctx.afterRollbackCallbacks;
                }

                const innerResult = await callback(transaction);

                // beforeCommit hooks run here: the user callback resolved, so the
                // transaction is still usable, and we are still inside its context
                // and before drizzle issues COMMIT. A savepoint frame's queue is
                // promoted instead and runs here at the root: the driver never
                // releases a savepoint, so there is no earlier boundary to run at
                if (!isNested && beforeCommitCallbacks.length > 0)
                {
                    if (enableLogging)
                    {
                        // Backstopped: a throwing logger must not roll back a
                        // transaction that is about to commit cleanly
                        logSafely(() => txLogger.debug('Executing beforeCommit callbacks', {
                            txId,
                            context,
                            count: beforeCommitCallbacks.length,
                        }));
                    }

                    await runBeforeCommitCallbacks(beforeCommitCallbacks);
                }

                return innerResult;
            });
        });

        // Transaction successful (committed)
        const duration = Date.now() - startTime;

        // Backstopped: the commit already happened, so a throwing logger must
        // not turn a committed transaction into a failed call — nor drop the
        // afterCommit queue below
        if (enableLogging)
        {
            logSafely(() =>
            {
                if (duration >= slowThreshold)
                {
                    txLogger.warn('Slow transaction committed', {
                        txId,
                        context,
                        duration: `${duration}ms`,
                        threshold: `${slowThreshold}ms`,
                        hint: 'A transaction holds a pooled connection (and row locks) for its whole duration. If this is slow because of non-DB work (external API, etc.) inside the transaction, move that work out — it starves the connection pool.',
                    });
                }
                else
                {
                    txLogger.debug('Transaction committed', {
                        txId,
                        context,
                        duration: `${duration}ms`,
                    });
                }
            });
        }

        // Execute afterCommit callbacks (root transaction only, after commit confirmed)
        if (!isNested && afterCommitCallbacks.length > 0)
        {
            if (enableLogging)
            {
                logSafely(() => txLogger.debug('Executing afterCommit callbacks', {
                    txId,
                    context,
                    count: afterCommitCallbacks.length,
                }));
            }

            for (const cb of afterCommitCallbacks)
            {
                Promise.resolve().then(cb).catch((err) => logSafely(() =>
                {
                    txLogger.error('afterCommit callback failed', {
                        txId,
                        context,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }));
            }
        }

        return result;
    }
    catch (error)
    {
        // Transaction failed (rolled back)
        const duration = Date.now() - startTime;

        // Backstopped, and for the same reason as the callback stage below: this
        // line runs BEFORE the afterRollback callbacks and outside their catch,
        // so a throwing logger here would both skip every registered callback and
        // replace the error that caused the rollback. It stays ahead of the
        // callbacks — the rollback record belongs in the log before the arbitrary
        // user code that reacts to it — and is made non-throwing instead.
        if (enableLogging)
        {
            logSafely(() =>
            {
                if (duration >= slowThreshold)
                {
                    txLogger.warn('Slow transaction rolled back', {
                        txId,
                        context,
                        duration: `${duration}ms`,
                        threshold: `${slowThreshold}ms`,
                        error: error instanceof Error ? error.message : String(error),
                        errorType: error instanceof Error ? error.name : 'Unknown',
                        hint: 'If the error is an idle-in-transaction timeout, the transaction held a pooled connection while awaiting non-DB work (external API, etc.). Move that work out of the transaction.',
                    });
                }
                else
                {
                    txLogger.error('Transaction rolled back', {
                        txId,
                        context,
                        duration: `${duration}ms`,
                        error: error instanceof Error ? error.message : String(error),
                        errorType: error instanceof Error ? error.name : 'Unknown',
                    });
                }
            });
        }

        // Execute afterRollback callbacks (root transaction only, rollback done).
        // Awaited so they complete before the error leaves the runner, and run
        // outside the transaction context — getTransactionContext() is null here,
        // so DB work inside them uses a fresh connection like afterCommit does.
        // Nested calls skip this: a savepoint frame already ran its own queue
        // inside the gate (discardFrameHooks), while the parent was still open,
        // and a frame that resolved handed its queue to the parent instead.
        if (!isNested && afterRollbackCallbacks.length > 0)
        {
            // Last backstop: nothing in this stage — not a callback, not a log
            // line — may replace the error that caused the rollback
            await runAfterRollbackCallbacks(afterRollbackCallbacks, txId, context, enableLogging)
                .catch(() => undefined);
        }

        // Re-throw the ORIGINAL error for caller to handle: nothing above may
        // replace it
        throw error;
    }
}
