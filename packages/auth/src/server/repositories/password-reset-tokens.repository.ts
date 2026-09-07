/**
 * Password Reset Tokens Repository
 *
 * Data access for the password reset flow. Extends BaseRepository for
 * transaction-context detection and read/write splitting.
 *
 * `consume` and `complete` update conditionally and return the row only if THIS
 * call was the one that moved it. Two concurrent confirms — or two concurrent
 * password submits — therefore produce one winner and one refusal, rather than
 * both proceeding on a row they each read as unclaimed. Read-then-write would
 * lose that race.
 *
 * The `findLive*` lookups filter to usable rows rather than returning anything
 * they find. Every refusal on this flow is the same 401 whatever caused it, so
 * there is nothing for a caller to learn from the difference — and a filter in
 * the query cannot be forgotten by a caller the way a state check can.
 */

import { passwordResetTokens } from '../entities/password-reset-tokens';
import type { NewPasswordResetToken, PasswordResetToken } from '../entities/password-reset-tokens';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, gt, isNull } from 'drizzle-orm';

export class PasswordResetTokensRepository extends BaseRepository
{
    /**
     * Create a reset link row.
     * Write primary.
     */
    async create(data: NewPasswordResetToken): Promise<PasswordResetToken>
    {
        const result = await this.db
            .insert(passwordResetTokens)
            .values(data)
            .returning();

        return result[0];
    }

    /**
     * Find a link that can still be exchanged for a setup session: unconsumed,
     * not superseded, not completed, not expired.
     *
     * Read replica.
     */
    async findLiveByTokenHash(tokenHash: string): Promise<PasswordResetToken | null>
    {
        const result = await this.readDb
            .select()
            .from(passwordResetTokens)
            .where(
                and(
                    eq(passwordResetTokens.tokenHash, tokenHash),
                    isNull(passwordResetTokens.consumedAt),
                    isNull(passwordResetTokens.supersededAt),
                    isNull(passwordResetTokens.completedAt),
                    gt(passwordResetTokens.expiresAt, new Date()),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Find a setup session that can still be used to set a password.
     * Read replica.
     */
    async findLiveSetupBySecretHash(setupSecretHash: string): Promise<PasswordResetToken | null>
    {
        const result = await this.readDb
            .select()
            .from(passwordResetTokens)
            .where(
                and(
                    eq(passwordResetTokens.setupSecretHash, setupSecretHash),
                    isNull(passwordResetTokens.supersededAt),
                    isNull(passwordResetTokens.completedAt),
                    gt(passwordResetTokens.setupExpiresAt, new Date()),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Consume a link and open a setup session on it, but only if it is still
     * unconsumed and not superseded.
     *
     * @returns the updated row, or null if another request claimed it first
     */
    async consume(
        id: number,
        setupSecretHash: string,
        setupExpiresAt: Date,
    ): Promise<PasswordResetToken | null>
    {
        const result = await this.db
            .update(passwordResetTokens)
            .set({
                consumedAt: new Date(),
                setupSecretHash,
                setupExpiresAt,
            })
            .where(
                and(
                    eq(passwordResetTokens.id, id),
                    isNull(passwordResetTokens.consumedAt),
                    isNull(passwordResetTokens.supersededAt),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * Mark a setup session as completed, but only if it has not completed
     * already.
     *
     * @returns the updated row, or null if another request completed it first
     */
    async complete(id: number): Promise<PasswordResetToken | null>
    {
        const result = await this.db
            .update(passwordResetTokens)
            .set({ completedAt: new Date() })
            .where(
                and(
                    eq(passwordResetTokens.id, id),
                    isNull(passwordResetTokens.completedAt),
                    isNull(passwordResetTokens.supersededAt),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * Supersede every live link for an account, so requesting a new one
     * invalidates the previous one and any setup session opened from it.
     *
     * Write primary.
     *
     * @returns number of rows superseded
     */
    async supersedeAllLiveByUserId(userId: number): Promise<number>
    {
        const result = await this.db
            .update(passwordResetTokens)
            .set({ supersededAt: new Date() })
            .where(
                and(
                    eq(passwordResetTokens.userId, userId),
                    isNull(passwordResetTokens.supersededAt),
                    isNull(passwordResetTokens.completedAt),
                ),
            )
            .returning();

        return result.length;
    }
}

// Default instance export
export const passwordResetTokensRepository = new PasswordResetTokensRepository();
