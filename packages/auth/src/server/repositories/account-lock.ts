/**
 * The record of which accounts the current transaction holds the lock of
 * (`UsersRepository.lockAccount`), and the two checks run against it.
 *
 * - A lock taken with no transaction open is refused always
 *   (`AccountLockOutsideTransactionError`), before any statement: the row lock
 *   would end with its own statement, and the writes it was taken for would
 *   run unserialised.
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

/** The two public lock methods of `UsersRepository`, as a refusal names them. */
export type AccountLockMethod = 'lockAccount' | 'lockAccountByEmailOrPhone';

/**
 * An account lock asked for with no transaction open. An internal error — a
 * defect in the caller's shape, answered 500. The message names the method
 * and, for `lockAccount(id)`, the account id: never an email, a phone or any
 * other text the caller passed.
 */
export class AccountLockOutsideTransactionError extends Error
{
    constructor(method: AccountLockMethod, userId?: number)
    {
        const account = userId === undefined ? '' : ` of account ${userId}`;

        super(`usersRepository.${method}${account} called with no transaction open: the lock would end with its own statement (wrap the call and the writes it protects in runInTransaction)`);
        this.name = 'AccountLockOutsideTransactionError';
    }
}

/**
 * The root transaction an account lock is taken in — its user binding, the
 * key of `lockedAccounts`. With none open this throws
 * `AccountLockOutsideTransactionError`, in every run: call it before the lock
 * sends any statement.
 */
export function lockingRoot(method: AccountLockMethod, userId?: number): object
{
    const root = getTransactionContext()?.user;
    if (!root)
    {
        throw new AccountLockOutsideTransactionError(method, userId);
    }

    return root;
}

/**
 * Note that `root` (`lockingRoot`) now holds the account's lock. A savepoint
 * that rolls back releases the row lock it took, so it takes the record with it.
 *
 * A transaction holds one account's lock at most: the second one throws
 * `SecondAccountLockError` here, before its statement runs, in every run.
 */
export function recordAccountLock(root: object, userId: number): void
{
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
