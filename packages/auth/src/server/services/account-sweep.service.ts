/**
 * @spfn/auth - Sweeps over credential state, one account at a time
 *
 * A sweep deletes rows that the account's own requests write under its lock
 * (`usersRepository.lockAccount`): pending keys and their challenges, an
 * unconfirmed enrolment. One statement across accounts would take those rows
 * in an order no request agrees with, so each account is swept in its own
 * transaction, its lock first — never two accounts' locks in one.
 *
 * A run is bounded twice: it is handed at most `SWEEP_BATCH` accounts, and it
 * starts no account once `SWEEP_BUDGET_MS` has passed — a busy account costs a
 * full `ACCOUNT_LOCK_TIMEOUT_MS`, in sequence. What a run leaves, the next one
 * finds. Each run logs one summary line.
 */

import { runInTransaction } from '@spfn/core/db';
import { AccountBusyError } from '@spfn/auth/errors';

import { authLogger } from '../logger';
import { usersRepository } from '../repositories';

/** Accounts one sweep run is handed, at most. */
export const SWEEP_BATCH = 500;

/** Wall time after which a sweep run starts no further account. */
export const SWEEP_BUDGET_MS = 60_000;

/** What one run did, for its summary line. */
interface SweepRun
{
    rows: number;
    swept: number;
    busy: number;
    deferred: number;
}

/**
 * Run `sweep` for each account, each in its own transaction under that
 * account's lock, until the list or the time budget runs out. An account whose
 * lock stays busy past the bound is left for the next run; any other failure
 * stops the sweep.
 *
 * @returns the sum of what each account's sweep returned
 */
export async function sweepEachAccount(
    userIds: number[],
    context: string,
    sweep: (userId: number) => Promise<number>,
    budgetMs: number = SWEEP_BUDGET_MS,
): Promise<number>
{
    const run: SweepRun = { rows: 0, swept: 0, busy: 0, deferred: 0 };
    const deadline = Date.now() + budgetMs;

    for (const [index, userId] of userIds.entries())
    {
        if (Date.now() >= deadline)
        {
            run.deferred = userIds.length - index;
            break;
        }

        const rows = await sweepOne(userId, context, sweep);

        if (rows === null)
        {
            run.busy += 1;
        }
        else
        {
            run.swept += 1;
            run.rows += rows;
        }
    }

    authLogger.service.info('Sweep run', { context, accounts: userIds.length, ...run });

    return run.rows;
}

/** One account's sweep under its lock; null when the lock stayed busy past the bound. */
async function sweepOne(
    userId: number,
    context: string,
    sweep: (userId: number) => Promise<number>,
): Promise<number | null>
{
    return await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        return await sweep(userId);
    }, { context }).catch((error: unknown) => error instanceof AccountBusyError ? null : Promise.reject(error));
}
