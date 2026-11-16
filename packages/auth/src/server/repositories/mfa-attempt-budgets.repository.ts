/**
 * MFA Attempt Budgets Repository
 *
 * Data access for the account's second-factor failure budget
 * (`entities/mfa-attempt-budgets.ts`). Extends BaseRepository for
 * transaction-context detection and read/write splitting.
 *
 * Both reads are on the primary: a lock a replica has not seen yet is a lock
 * that does not hold.
 */

import { eq, sql, type SQL } from 'drizzle-orm';

import {
    mfaAttemptBudgets,
    MFA_ATTEMPT_LIMIT,
    MFA_ATTEMPT_WINDOW_MS,
    MFA_LOCK_MS,
} from '../entities/mfa-attempt-budgets';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

/** A failure this call counted: how many the trailing window now holds, and the lock it set, if any. */
export interface CountedFailure
{
    failures: number;
    lockedUntil: Date | null;
}

export class MfaAttemptBudgetsRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<MfaAttemptBudgetsRepository> = {
        spendFailure: { account: userId => userId },
    };

    /** Until when the account accepts no proof, or null when it is not locked now. Primary. */
    async lockedUntil(userId: number): Promise<Date | null>
    {
        const result = await this.db
            .select({ lockedUntil: mfaAttemptBudgets.lockedUntil })
            .from(mfaAttemptBudgets)
            .where(eq(mfaAttemptBudgets.userId, userId))
            .limit(1);
        const lockedUntil = result[0]?.lockedUntil ?? null;

        return lockedUntil && lockedUntil.getTime() > Date.now() ? lockedUntil : null;
    }

    /**
     * Count one wrong proof, unless the account is locked.
     *
     * One conditional upsert. The row's failure times become this one and
     * those still inside the trailing window, the most recent
     * `MFA_ATTEMPT_LIMIT` of them (`recentFailures`); the failure that brings
     * them to the limit sets `locked_until` in the same statement; and the
     * statement writes nothing while `locked_until` is in the future — so of
     * any number of concurrent failures exactly one reaches the limit, and it
     * is the only one that sees `lockedUntil` set on its result. A success
     * writes nothing here: failures leave the count only with the window.
     *
     * @returns the failure counted, or null when the account was locked and nothing was counted
     */
    async spendFailure(userId: number): Promise<CountedFailure | null>
    {
        const now = new Date();
        const failedAt = recentFailures(now);

        const result = await this.db
            .insert(mfaAttemptBudgets)
            .values({
                userId,
                failedAt: [now],
                lockedUntil: MFA_ATTEMPT_LIMIT <= 1 ? lockedUntilAfter(now) : null,
            })
            .onConflictDoUpdate({
                target: mfaAttemptBudgets.userId,
                set: {
                    failedAt,
                    lockedUntil: sql`CASE WHEN cardinality(${failedAt}) >= ${MFA_ATTEMPT_LIMIT}
                        THEN ${at(lockedUntilAfter(now))} ELSE NULL END`,
                },
                setWhere: sql`${mfaAttemptBudgets.lockedUntil} IS NULL OR ${mfaAttemptBudgets.lockedUntil} <= ${at(now)}`,
            })
            .returning({
                failures: sql<number>`cardinality(${mfaAttemptBudgets.failedAt})`.mapWith(Number),
                lockedUntil: mfaAttemptBudgets.lockedUntil,
            });

        return result[0] ?? null;
    }
}

/**
 * The row's failure times with one more at `now`: those the trailing window
 * still holds, the most recent `MFA_ATTEMPT_LIMIT`, newest first.
 */
function recentFailures(now: Date): SQL
{
    const windowStart = new Date(now.getTime() - MFA_ATTEMPT_WINDOW_MS);

    return sql`ARRAY(
        SELECT failed FROM unnest(array_append(${mfaAttemptBudgets.failedAt}, ${at(now)})) AS failed
        WHERE failed > ${at(windowStart)}
        ORDER BY failed DESC
        LIMIT ${MFA_ATTEMPT_LIMIT}
    )`;
}

function lockedUntilAfter(failure: Date): Date
{
    return new Date(failure.getTime() + MFA_LOCK_MS);
}

/** A moment as a bound `timestamptz`: a `Date` inside sql`` does not bind (postgres.js). */
function at(moment: Date): SQL
{
    return sql`${moment.toISOString()}::timestamptz`;
}

// Default instance export
export const mfaAttemptBudgetsRepository = new MfaAttemptBudgetsRepository();
