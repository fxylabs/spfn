/**
 * AsyncLocalStorage-based Transaction Context
 *
 * Uses Node.js AsyncLocalStorage to propagate transactions throughout the async call chain.
 *
 * Features:
 * - AsyncLocalStorage-based context management
 * - Type-safe transaction propagation across async chains
 * - Transaction ID tracking for debugging and tracing
 * - Nested transaction detection and logging
 * - Transaction nesting level tracking
 */
import { AsyncLocalStorage } from 'async_hooks';
import { logger } from '@spfn/core/logger'; // Assuming logger is accessible
import type {
    DatabaseTransaction,
    DefaultDatabase,
    DrizzleDatabase,
} from '../manager/types';

/**
 * Transaction type belonging to a PostgreSQL Drizzle database.
 */
export type TransactionDB<TDatabase extends DrizzleDatabase = DefaultDatabase> =
    DatabaseTransaction<TDatabase>;

const txLogger = logger.child('@spfn/core:transaction');

/**
 * afterCommit callback type
 */
export type AfterCommitCallback = () => void | Promise<void>;

/**
 * beforeCommit callback type
 */
export type BeforeCommitCallback = () => void | Promise<void>;

/**
 * afterRollback callback type
 */
export type AfterRollbackCallback = () => void | Promise<void>;

/**
 * Serializes the savepoint frames opened directly off one transaction context
 *
 * @see createNestedFrameGate
 */
export type NestedFrameGate = {
    /** Run `frame` once every frame queued before it on this context has finished */
    run<T>(frame: () => Promise<T>): Promise<T>;
};

/**
 * Transaction context stored in AsyncLocalStorage
 */
export type TransactionContext<TDatabase extends DrizzleDatabase = DrizzleDatabase> = {
    /** The actual Drizzle transaction object */
    tx: TransactionDB<TDatabase>;
    /** Unique transaction ID for logging and tracing */
    txId: string;
    level: number;
    /** beforeCommit callbacks registered in THIS frame (root or savepoint) */
    beforeCommitCallbacks: BeforeCommitCallback[];
    /** afterCommit callbacks registered in THIS frame (root or savepoint) */
    afterCommitCallbacks: AfterCommitCallback[];
    /** afterRollback callbacks registered in THIS frame (root or savepoint) */
    afterRollbackCallbacks: AfterRollbackCallback[];
    /** Serializes the savepoint frames opened directly off THIS context */
    nestedFrames: NestedFrameGate;
};

/** The contention notice is a property of the process, not of a transaction */
let concurrentNestingReported = false;

/**
 * Say once, on the first contention, that concurrent nested calls serialize
 *
 * Per-call it would be noise: `Promise.all` over nested calls is legal and its
 * every element would log. Once per process it is the one line that explains
 * both the lost concurrency and — if the caller ever writes the deadlocking
 * shape — the hang.
 */
function reportConcurrentNesting(): void
{
    if (concurrentNestingReported)
    {
        return;
    }

    concurrentNestingReported = true;

    txLogger.warn('Concurrent nested transactions are serialized', {
        reason: 'sibling SAVEPOINTs share the outer transaction\'s connection, where one sibling\'s ROLLBACK TO would discard the other\'s writes',
        hint: 'await nested calls one at a time, or pass requiresNew: true to give a branch its own connection. A nested call whose callback awaits a sibling started after it deadlocks.',
    });
}

/**
 * Create the gate that serializes one context's nested (SAVEPOINT) frames
 *
 * Sibling savepoints are two frames on ONE connection, and `ROLLBACK TO` unwinds
 * the connection — not a branch of it. Left concurrent, a sibling that fails
 * discards every row the other sibling wrote after its savepoint was taken, and
 * the surviving sibling reports success. So a frame opens only once the frame
 * queued before it has closed — returned, or unwound with ROLLBACK TO — which
 * puts each sibling's writes strictly inside its own savepoint again.
 * `Promise.all` over nested calls keeps working; it just stops overlapping.
 *
 * The gate belongs to the context the frames are opened off, NOT to the root, so
 * it never blocks depth: a frame holds its PARENT's gate while its own gate —
 * fresh, uncontended — serializes its children. `requiresNew` takes no gate at
 * all; it runs on its own connection, where nothing interleaves.
 *
 * The one shape this cannot save is a frame that awaits a sibling queued BEHIND
 * it: the waiter holds the gate, so the sibling it waits for never opens, and no
 * statement is running for a timeout to interrupt. That is a deadlock (the
 * reverse order is fine — a sibling created first has already run), documented as
 * misuse — see the transaction README. Detecting it would mean tracking which
 * pending promise a callback is blocked on, which the runner cannot see; a
 * timeout would have to guess at how long a legitimate sibling may run and would
 * abort transactions for being slow. What is cheap and honest is a notice the
 * first time frames actually contend, so the hazard is on the record before it
 * ever hangs.
 */
export function createNestedFrameGate(): NestedFrameGate
{
    let tail: Promise<unknown> = Promise.resolve();
    let pending = 0;

    return {
        run<T>(frame: () => Promise<T>): Promise<T>
        {
            if (pending > 0)
            {
                reportConcurrentNesting();
            }

            pending++;

            const result = tail.then(frame);

            // The rejection is swallowed on the QUEUE only — a failed frame must
            // not cancel the frames behind it — while `result` itself still
            // rejects for the caller that opened the frame
            tail = result.then(() => void pending--, () => void pending--);

            return result;
        },
    };
}

/**
 * Global AsyncLocalStorage instance for transaction context
 */
export const asyncContext = new AsyncLocalStorage<TransactionContext>();

/**
 * Get current transaction object and metadata from AsyncLocalStorage
 *
 * @returns TransactionContext if available, null otherwise
 */
export function getTransactionContext<TDatabase extends DrizzleDatabase = DefaultDatabase>(): TransactionContext<TDatabase> | null
{
    return (asyncContext.getStore() as TransactionContext<TDatabase> | undefined) ?? null;
}

/**
 * Get current transaction from AsyncLocalStorage
 *
 * @returns Transaction if available, null otherwise
 */
export function getTransaction<TDatabase extends DrizzleDatabase = DefaultDatabase>(): TransactionDB<TDatabase> | null
{
    const context = getTransactionContext<TDatabase>();

    return context?.tx ?? null;
}

/**
 * Get current transaction ID from AsyncLocalStorage
 *
 * @returns Transaction ID if available, null otherwise
 */
export function getTransactionId(): string | null
{
    const context = getTransactionContext();

    return context?.txId ?? null;
}

/**
 * Run a function within a transaction context
 *
 * The transaction will be available to all async operations within the callback
 * via getTransaction().
 *
 * @param tx - Drizzle transaction object
 * @param txId - Unique ID for the transaction
 * @param callback - Function to run within transaction context
 * @returns Result of the callback
 */
export function runWithTransaction<T, TDatabase extends DrizzleDatabase = DefaultDatabase>(
    tx: TransactionDB<TDatabase>,
    txId: string, // Add txId parameter
    callback: () => Promise<T>,
): Promise<T>
{
    const existingContext = getTransactionContext();

    // Determine the current transaction nesting level
    const newLevel = existingContext ? existingContext.level + 1 : 1;

    if (existingContext)
    {
        // Nested transaction: the runner opened this one off the outer
        // transaction's tx, so Drizzle issued a SAVEPOINT on its connection.
        // Debug, not info: nesting is the documented default, so there is
        // nothing for an operator to do about a line that fires on every
        // nested call.
        txLogger.debug('Nested transaction started (SAVEPOINT)', {
            outerTxId: existingContext.txId,
            innerTxId: txId,
            level: newLevel,
        });
    }
    else
    {
        // Root transaction
        txLogger.debug('Root transaction context set', { txId, level: newLevel });
    }

    // Store transaction, new ID, and the current nesting level.
    //
    // Every context gets hook queues of its OWN — a savepoint does not share
    // the root's. A hook belongs to the frame that registered it, because that
    // frame's outcome decides whether the work it guards survives: the runner
    // hands a resolved savepoint's queues to its parent, and a savepoint that
    // rolls back runs its afterRollback queue and drops the other two. Shared
    // queues would fire a rolled-back savepoint's hooks at the root's commit.
    //
    // The frame gate is per-context for its own reason: it serializes the
    // frames opened off THIS context, so every level needs its own or a nested
    // call would wait on the gate its own parent is holding.
    return asyncContext.run(
        {
            tx,
            txId,
            level: newLevel,
            beforeCommitCallbacks: [],
            afterCommitCallbacks: [],
            afterRollbackCallbacks: [],
            nestedFrames: createNestedFrameGate(),
        } as TransactionContext,
        callback,
    );
}

/**
 * Register a callback to run after the current transaction commits
 *
 * - Inside a transaction: queued and executed after root transaction commits
 * - Outside a transaction: executed immediately (already "committed")
 * - Nested transactions: the callback belongs to the savepoint that registered
 *   it. It reaches the root only if that savepoint (and every one around it)
 *   resolved; a savepoint that rolls back drops it, even when the root commits
 * - A hook registered after its frame (root or savepoint) has settled is
 *   dropped: the frame's queue was handed on, or discarded, when it settled.
 *   Register hooks in the awaited call chain, not from detached work
 * - Callbacks run outside transaction context (new connection for DB access)
 * - Errors are logged but never thrown (commit already succeeded)
 *
 * @example
 * ```typescript
 * import { onAfterCommit } from '@spfn/core/db';
 *
 * async function submit(spaceId: string, chatId: string)
 * {
 *     const publication = await publicationRepo.create({...});
 *     await requestRepo.updateStatusAtomically(...);
 *
 *     onAfterCommit(() => generateArticle(spaceId, chatId, publication.id));
 *
 *     return publication;
 * }
 * ```
 */
export function onAfterCommit(callback: AfterCommitCallback): void
{
    const context = getTransactionContext();

    if (!context)
    {
        // No active transaction → execute immediately
        Promise.resolve().then(callback).catch((err) =>
        {
            txLogger.error('afterCommit callback failed (no transaction)', {
                error: err instanceof Error ? err.message : String(err),
            });
        });

        return;
    }

    context.afterCommitCallbacks.push(callback);
}

/**
 * Register a callback to run just before the current transaction commits
 *
 * - Inside a transaction: queued and executed after the root callback resolves,
 *   while the transaction is still open — the callback MAY run statements and
 *   they are part of the same commit
 * - Outside a transaction: executed immediately with a WARNING (same rationale as
 *   onAfterCommit — there is nothing left to commit), and the abort semantics
 *   below do not apply: there is no transaction for a throw to roll back
 * - Nested transactions: the callback belongs to the savepoint that registered
 *   it. A savepoint that resolved hands it to the root, where it still runs
 *   before the root's COMMIT (never at the savepoint); one that rolls back
 *   drops it, and the root commits without it
 * - A hook registered after its frame (root or savepoint) has settled is
 *   dropped: the frame's queue was handed on, or discarded, when it settled.
 *   Register hooks in the awaited call chain, not from detached work
 * - Callbacks run in registration order, inside the transaction context
 *   (getTransaction() returns the live tx)
 * - The queue is snapshot before the pass, so a callback registered BY a
 *   beforeCommit callback does not run for this commit — it would otherwise
 *   grow the queue mid-iteration and loop forever inside the open transaction
 * - A throw ABORTS: later callbacks are skipped, the transaction rolls back,
 *   the error propagates to the caller, and afterRollback callbacks fire
 *
 * @example
 * ```typescript
 * import { runInTransaction, onBeforeCommit } from '@spfn/core/db';
 *
 * async function transfer(fromId: string, toId: string, amount: number)
 * {
 *     // The transaction is what gives the check teeth — registered outside one,
 *     // the callback runs immediately and its throw aborts nothing.
 *     await runInTransaction(async () =>
 *     {
 *         await accountRepo.debit(fromId, amount);
 *         await accountRepo.credit(toId, amount);
 *
 *         // Last-moment invariant check: a throw here rolls the whole transfer back.
 *         onBeforeCommit(() => assertNoNegativeBalance(fromId));
 *     });
 * }
 * ```
 */
export function onBeforeCommit(callback: BeforeCommitCallback): void
{
    const context = getTransactionContext();

    if (!context)
    {
        // No active transaction → nothing to run before, execute immediately.
        // Warn first: the caller most likely wanted the abort semantics, and
        // here there is no transaction to abort — a throwing callback only
        // reaches the log line below, while the write it meant to prevent has
        // already committed on its own.
        txLogger.warn(
            'beforeCommit callback ran immediately (no transaction): a throw cannot abort anything',
        );

        Promise.resolve().then(callback).catch((err) =>
        {
            txLogger.error('beforeCommit callback failed (no transaction)', {
                error: err instanceof Error ? err.message : String(err),
            });
        });

        return;
    }

    context.beforeCommitCallbacks.push(callback);
}

/**
 * Register a callback to run after the current transaction rolled back
 *
 * - Inside a transaction: queued and executed once the work registered with it
 *   is rolled back, before the causing error leaves runInTransaction / the
 *   middleware
 * - Outside a transaction: no-op with a warning — there is no rollback to wait for
 * - Nested transactions: the callback belongs to the savepoint that registered
 *   it. If that savepoint rolls back, the callback runs right then, awaited
 *   before the error leaves the nested runInTransaction, and never again — the
 *   root's own afterRollback callbacks do not run when the root commits. If the
 *   savepoint resolved, the callback passes to the root and runs only if the
 *   root rolls back
 * - After a ROOT rollback, callbacks run outside any transaction context (new
 *   connection for DB access). After a SAVEPOINT rollback the root is still
 *   open: getTransactionContext() is the parent's, so DB work in the callback
 *   joins the parent transaction and commits or rolls back with it
 * - A statement that FAILS in a savepoint's callback aborts the parent
 *   transaction: the error is logged and swallowed here, but the root's next
 *   statement then fails with 25P02 (current transaction is aborted). If the
 *   root runs none, its COMMIT fails with the callback's error. Either way,
 *   everything the root wrote rolls back. A compensation may call
 *   runInTransaction itself — that opens a savepoint on the parent, which
 *   contains such a failure — and hooks it registers belong to the parent
 * - A hook registered after its frame (root or savepoint) has settled is
 *   dropped: the frame's queue was handed on, or discarded, when it settled.
 *   Register hooks in the awaited call chain, not from detached work
 * - Errors are logged but never thrown: the original error keeps propagating
 *   unchanged, never replaced by a callback failure
 *
 * @example
 * ```typescript
 * import { runInTransaction, onAfterRollback } from '@spfn/core/db';
 *
 * async function importAvatar(userId: string, file: Blob)
 * {
 *     // Upload first: external I/O never belongs inside the transaction.
 *     const key = await objectStore.put(file);
 *
 *     await runInTransaction(async () =>
 *     {
 *         await userRepo.updateAvatar(userId, key);
 *
 *         // The upload cannot roll back on its own — undo it if the write never lands.
 *         onAfterRollback(() => objectStore.delete(key));
 *     });
 * }
 * ```
 */
export function onAfterRollback(callback: AfterRollbackCallback): void
{
    const context = getTransactionContext();

    if (!context)
    {
        // No active transaction → no rollback can ever happen, so the callback
        // would never run. Drop it loudly instead of silently.
        txLogger.warn('afterRollback callback ignored (no transaction)');

        return;
    }

    context.afterRollbackCallbacks.push(callback);
}
