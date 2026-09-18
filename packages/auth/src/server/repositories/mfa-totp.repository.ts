/**
 * MFA TOTP Repository
 *
 * Data access for the one enrolment row an account may have. Extends
 * BaseRepository for transaction-context detection and read/write splitting.
 *
 * `secret_enc` is a ciphertext and is only ever moved through this layer as an
 * opaque string — nothing here decrypts, and nothing here logs a row.
 */

import { BaseRepository } from '@spfn/core/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import { mfaTotp } from '../entities/mfa-totp';
import type { MfaTotp } from '../entities/mfa-totp';

export class MfaTotpRepository extends BaseRepository
{
    /** The account's enrolment row, confirmed or not. */
    async findByUserId(userId: number): Promise<MfaTotp | null>
    {
        const result = await this.readDb
            .select()
            .from(mfaTotp)
            .where(eq(mfaTotp.userId, userId))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Start an enrolment, replacing an unconfirmed one.
     *
     * Upsert rather than insert: calling `enroll` twice is the ordinary case —
     * a user closes the app before scanning — and the second call must hand out
     * a fresh secret rather than a 409. The failed-attempt counter resets with
     * it, which is what makes "start over" the documented remedy for a row that
     * spent its five tries.
     *
     * A **confirmed** row is refused by the service before this is reached, so
     * this can never overwrite a working second factor.
     */
    async startEnrolment(userId: number, secretEnc: string): Promise<MfaTotp>
    {
        const result = await this.db
            .insert(mfaTotp)
            .values({ userId, secretEnc })
            .onConflictDoUpdate({
                target: mfaTotp.userId,
                set: { secretEnc, confirmedAt: null, lastUsedStep: null, failedConfirmAttempts: 0 },
            })
            .returning();

        return result[0];
    }

    /**
     * Mark the enrolment confirmed and record the step its first code spent.
     * Write primary.
     */
    async confirm(userId: number, step: number): Promise<void>
    {
        await this.db
            .update(mfaTotp)
            .set({ confirmedAt: new Date(), lastUsedStep: step, failedConfirmAttempts: 0 })
            .where(eq(mfaTotp.userId, userId));
    }

    /** Record the newest step this account has spent, so it cannot be replayed. */
    async recordUsedStep(userId: number, step: number): Promise<void>
    {
        await this.db
            .update(mfaTotp)
            .set({ lastUsedStep: step })
            .where(eq(mfaTotp.userId, userId));
    }

    /**
     * Count one wrong code against an unconfirmed row.
     *
     * @returns the count after this attempt
     */
    async countFailedConfirm(userId: number): Promise<number>
    {
        const result = await this.db
            .update(mfaTotp)
            .set({ failedConfirmAttempts: sql`${mfaTotp.failedConfirmAttempts} + 1` })
            .where(and(eq(mfaTotp.userId, userId), isNull(mfaTotp.confirmedAt)))
            .returning();

        return result[0]?.failedConfirmAttempts ?? 0;
    }

    /** Rewrite the ciphertext in place, after a read on a retired key. */
    async updateSecret(userId: number, secretEnc: string): Promise<void>
    {
        await this.db
            .update(mfaTotp)
            .set({ secretEnc })
            .where(eq(mfaTotp.userId, userId));
    }

    /** Drop the account's enrolment. Write primary. */
    async deleteByUserId(userId: number): Promise<void>
    {
        await this.db.delete(mfaTotp).where(eq(mfaTotp.userId, userId));
    }

    /**
     * Drop enrolments nobody ever confirmed. The sweep job's statement.
     *
     * @returns number of rows deleted
     */
    async deleteUnconfirmedBefore(cutoff: Date): Promise<number>
    {
        const result = await this.db
            .delete(mfaTotp)
            .where(and(isNull(mfaTotp.confirmedAt), lt(mfaTotp.createdAt, cutoff)))
            .returning();

        return result.length;
    }
}

// Default instance export
export const mfaTotpRepository = new MfaTotpRepository();
