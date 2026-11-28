/**
 * MFA Verifications Repository
 *
 * Data access for "when did this credential last prove the second factor".
 * Extends BaseRepository for transaction-context detection and read/write
 * splitting.
 *
 * One row per credential — a device key, or an application profile with the
 * key id its verifier reported — replaced rather than appended to: only the
 * newest verification decides anything, and a history of them would be a table
 * that grows with every step-up for no reader.
 */

import { and, eq, isNull, lt, type SQL } from 'drizzle-orm';

import { mfaVerifications } from '../entities/mfa-verifications';
import type { MfaVerification, MfaVerificationProof } from '../entities/mfa-verifications';
import type { StartingCredential } from '../lib/deferred-stamp';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

/** The row a credential's verification is, by the columns that name it. */
function credentialIs(userId: number, credential: StartingCredential): SQL
{
    return credential.kind === 'deviceKey'
        ? and(eq(mfaVerifications.keyId, credential.keyId), eq(mfaVerifications.userId, userId))!
        : and(
            eq(mfaVerifications.userId, userId),
            eq(mfaVerifications.profile, credential.profile),
            eq(mfaVerifications.profileKeyId, credential.keyId),
        )!;
}

/** The columns naming a credential's row: a device key's id, or a profile and the key id its verifier reported. */
function credentialColumns(credential: StartingCredential)
{
    return credential.kind === 'deviceKey'
        ? { keyId: credential.keyId }
        : { profile: credential.profile, profileKeyId: credential.keyId };
}

export class MfaVerificationsRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<MfaVerificationsRepository> = {
        record: { account: userId => userId },
        moveToKeyId: { account: userId => userId },
        deleteByUserId: { account: userId => userId },
        deleteVerifiedBeforeOf: { account: userId => userId },
    };

    /** When this credential last stepped up on this account, if it ever did. */
    async findFor(userId: number, credential: StartingCredential): Promise<MfaVerification | null>
    {
        const result = await this.readDb
            .select()
            .from(mfaVerifications)
            .where(credentialIs(userId, credential))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Record a fresh verification for this credential, replacing any earlier
     * one — its method and, for a passkey, which passkey proved it. A device
     * key's row is its key id's; an application profile's is the profile's and
     * the reported key id's, and never a device key's row, even when the two
     * ids are the same string.
     */
    async record(userId: number, credential: StartingCredential, proof: MfaVerificationProof): Promise<void>
    {
        const recorded = { userId, method: proof.method, passkeyId: proof.method === 'passkey' ? proof.passkeyId : null };

        await this.db
            .insert(mfaVerifications)
            .values({ ...credentialColumns(credential), ...recorded })
            .onConflictDoUpdate({
                target: credential.kind === 'deviceKey'
                    ? mfaVerifications.keyId
                    : [mfaVerifications.userId, mfaVerifications.profile, mfaVerifications.profileKeyId],
                set: { ...recorded, verifiedAt: new Date() },
            });
    }

    /**
     * Carry a device key's verification across a key rotation.
     *
     * Scoped by owner, so a caller naming somebody else's key moves nothing,
     * and to device keys: an application profile has no replacement. Nothing
     * to move is not an error: a device that never stepped up rotates exactly
     * as it does today.
     */
    async moveToKeyId(userId: number, fromKeyId: string, toKeyId: string): Promise<void>
    {
        await this.db
            .update(mfaVerifications)
            .set({ keyId: toKeyId })
            .where(and(
                eq(mfaVerifications.keyId, fromKeyId),
                eq(mfaVerifications.userId, userId),
                isNull(mfaVerifications.profile),
            ));
    }

    /** Accounts holding a verification from before `cutoff`, at most `limit`, for the sweep. */
    async findAccountsVerifiedBefore(cutoff: Date, limit: number): Promise<number[]>
    {
        const rows = await this.db
            .selectDistinct({ userId: mfaVerifications.userId })
            .from(mfaVerifications)
            .where(lt(mfaVerifications.verifiedAt, cutoff))
            .orderBy(mfaVerifications.userId)
            .limit(limit);

        return rows.map(row => row.userId);
    }

    /**
     * Delete one account's verifications from before `cutoff`, whatever
     * credential holds them — a device key's, and an application profile's,
     * which no key row's deletion ever cascades onto. Its caller holds the
     * account's lock, under which `record` writes.
     *
     * @returns rows deleted
     */
    async deleteVerifiedBeforeOf(userId: number, cutoff: Date): Promise<number>
    {
        const deleted = await this.db
            .delete(mfaVerifications)
            .where(and(eq(mfaVerifications.userId, userId), lt(mfaVerifications.verifiedAt, cutoff)))
            .returning({ id: mfaVerifications.id });

        return deleted.length;
    }

    /** Forget every credential's verification — what disabling the second factor means. */
    async deleteByUserId(userId: number): Promise<void>
    {
        await this.db.delete(mfaVerifications).where(eq(mfaVerifications.userId, userId));
    }
}

// Default instance export
export const mfaVerificationsRepository = new MfaVerificationsRepository();
