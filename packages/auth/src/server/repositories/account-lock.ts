/**
 * The record of which accounts the current transaction holds the lock of
 * (`UsersRepository.lockAccount`), and the two checks run against it.
 *
 * - A second account's lock in one transaction is refused always
 *   (`SecondAccountLockError`): two accounts, locked in either order by two
 *   transactions, are a deadlock nothing upstream orders away, and the record
 *   that names it costs one set per transaction.
 * - A credential write without its account's lock (`assertAccountLocked`) is a
 *   test instrument: it throws only while `SPFN_AUTH_ASSERT_ACCOUNT_LOCK` is
 *   `'1'`, which the package's test run sets. A writer that reaches its
 *   statement without the lock is a defect the test suite names, not a request
 *   refused in production.
 */

import { getTransactionContext, onAfterRollback } from '@spfn/core/db';

/**
 * Locked accounts per root transaction.
 *
 * Keyed by the root's user binding — the one object every savepoint frame of a
 * root shares (`TransactionContext.user`) — because a lock taken in a
 * savepoint is held by the root transaction, not by the frame.
 */
const lockedAccounts = new WeakMap<object, Set<number>>();

/** Whether this run checks the account lock — the package's test run does. */
export function accountLockChecked(): boolean
{
    return process.env.SPFN_AUTH_ASSERT_ACCOUNT_LOCK === '1';
}

/**
 * A transaction asked for a second account's lock. An internal error — a
 * defect in the caller's shape, answered 500 — never a refusal of the request.
 */
export class SecondAccountLockError extends Error
{
    constructor(userId: number, held: readonly number[])
    {
        super(`account ${userId} locked by a transaction that already holds account ${held.join(', ')} (usersRepository.lockAccount)`);
        this.name = 'SecondAccountLockError';
    }
}

/**
 * Note that this transaction now holds the account's lock. A savepoint that
 * rolls back releases the row lock it took, so it takes the record with it.
 *
 * A transaction holds one account's lock at most: the second one throws
 * `SecondAccountLockError` here, before its statement runs, in every run.
 */
export function recordAccountLock(userId: number): void
{
    const root = getTransactionContext()?.user;
    if (!root)
    {
        return;
    }

    const held = lockedAccounts.get(root) ?? new Set<number>();
    if (held.size > 0 && !held.has(userId))
    {
        throw new SecondAccountLockError(userId, [...held]);
    }

    const isNew = !held.has(userId);
    lockedAccounts.set(root, held.add(userId));

    if (isNew)
    {
        onAfterRollback(() => void held.delete(userId));
    }
}

/**
 * Throw, under test, when the current transaction does not hold the account's
 * lock — the invariant `UsersRepository.lockAccount` states.
 */
export function assertAccountLocked(userId: number, writer: string): void
{
    if (!accountLockChecked())
    {
        return;
    }

    const root = getTransactionContext()?.user;
    if (!root || !lockedAccounts.get(root)?.has(userId))
    {
        throw new Error(`${writer} wrote credential state of account ${userId} without its lock (usersRepository.lockAccount)`);
    }
}
