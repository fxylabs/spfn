/**
 * MFA Recovery Codes Repository
 *
 * Data access for the ten single-use codes of an account's current generation.
 * Extends BaseRepository for transaction-context detection and read/write
 * splitting.
 *
 * Every read is scoped by `(user_id, generation)`. A code from an older
 * generation, or from another account, is not "not found" by accident — it is
 * outside every query this class can make.
 */

import { BaseRepository } from '@spfn/core/db';
import { and, count, eq, isNull, max } from 'drizzle-orm';

import { mfaRecoveryCodes } from '../entities/mfa-recovery-codes';
import type { MfaRecoveryCode } from '../entities/mfa-recovery-codes';

export class MfaRecoveryCodesRepository extends BaseRepository
{
    /**
     * The account's newest generation, or 0 when it has never had codes.
     *
     * 0 rather than null so the caller's `+ 1` is the same expression on both
     * paths: a first enrolment writes generation 1.
     */
    async currentGeneration(userId: number): Promise<number>
    {
        const result = await this.readDb
            .select({ generation: max(mfaRecoveryCodes.generation) })
            .from(mfaRecoveryCodes)
            .where(eq(mfaRecoveryCodes.userId, userId));

        return result[0]?.generation ?? 0;
    }

    /** Write one generation of codes. Write primary. */
    async createGeneration(userId: number, generation: number, hashes: string[]): Promise<void>
    {
        await this.db
            .insert(mfaRecoveryCodes)
            .values(hashes.map(codeHash => ({ userId, generation, codeHash })));
    }

    /** The account's unspent codes of one generation. */
    async listUnused(userId: number, generation: number): Promise<MfaRecoveryCode[]>
    {
        return await this.readDb
            .select()
            .from(mfaRecoveryCodes)
            .where(and(
                eq(mfaRecoveryCodes.userId, userId),
                eq(mfaRecoveryCodes.generation, generation),
                isNull(mfaRecoveryCodes.usedAt),
            ));
    }

    /** How many of a generation are left, for `status` and the "2 remaining" warning. */
    async countUnused(userId: number, generation: number): Promise<number>
    {
        const result = await this.readDb
            .select({ remaining: count() })
            .from(mfaRecoveryCodes)
            .where(and(
                eq(mfaRecoveryCodes.userId, userId),
                eq(mfaRecoveryCodes.generation, generation),
                isNull(mfaRecoveryCodes.usedAt),
            ));

        return result[0]?.remaining ?? 0;
    }

    /**
     * Spend one code, if this call is the one that spends it.
     *
     * One conditional UPDATE, like the WebAuthn challenge consume and for the
     * same reason: two requests arriving with the same code must produce one
     * winner, not two, and a read-then-write would let both read it as unused.
     *
     * @returns true when this call spent the row
     */
    async consume(id: number): Promise<boolean>
    {
        const result = await this.db
            .update(mfaRecoveryCodes)
            .set({ usedAt: new Date() })
            .where(and(eq(mfaRecoveryCodes.id, id), isNull(mfaRecoveryCodes.usedAt)))
            .returning();

        return result.length > 0;
    }

    /** Drop every generation the account has. Write primary. */
    async deleteByUserId(userId: number): Promise<void>
    {
        await this.db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    }
}

// Default instance export
export const mfaRecoveryCodesRepository = new MfaRecoveryCodesRepository();
