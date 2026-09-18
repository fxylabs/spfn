/**
 * MFA Verifications Repository
 *
 * Data access for "when did this device last prove the second factor". Extends
 * BaseRepository for transaction-context detection and read/write splitting.
 *
 * One row per device key, replaced rather than appended to: only the newest
 * verification decides anything, and a history of them would be a table that
 * grows with every step-up for no reader.
 */

import { BaseRepository } from '@spfn/core/db';
import { and, eq } from 'drizzle-orm';

import { mfaVerifications } from '../entities/mfa-verifications';
import type { MfaVerification, MfaVerificationMethod } from '../entities/mfa-verifications';

export class MfaVerificationsRepository extends BaseRepository
{
    /** When this device last stepped up, if it ever did. */
    async findByKeyId(keyId: string): Promise<MfaVerification | null>
    {
        const result = await this.readDb
            .select()
            .from(mfaVerifications)
            .where(eq(mfaVerifications.keyId, keyId))
            .limit(1);

        return result[0] ?? null;
    }

    /** Record a fresh verification for this device, replacing any earlier one. */
    async record(keyId: string, userId: number, method: MfaVerificationMethod): Promise<void>
    {
        await this.db
            .insert(mfaVerifications)
            .values({ keyId, userId, method })
            .onConflictDoUpdate({
                target: mfaVerifications.keyId,
                set: { userId, method, verifiedAt: new Date() },
            });
    }

    /**
     * Carry a verification across a key rotation.
     *
     * Scoped by owner, so a caller naming somebody else's key moves nothing.
     * Nothing to move is not an error: a device that never stepped up rotates
     * exactly as it does today.
     */
    async moveToKeyId(userId: number, fromKeyId: string, toKeyId: string): Promise<void>
    {
        await this.db
            .update(mfaVerifications)
            .set({ keyId: toKeyId })
            .where(and(eq(mfaVerifications.keyId, fromKeyId), eq(mfaVerifications.userId, userId)));
    }

    /** Forget every device's verification — what disabling the second factor means. */
    async deleteByUserId(userId: number): Promise<void>
    {
        await this.db.delete(mfaVerifications).where(eq(mfaVerifications.userId, userId));
    }
}

// Default instance export
export const mfaVerificationsRepository = new MfaVerificationsRepository();
