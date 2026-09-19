/**
 * MFA Challenges Repository
 *
 * Data access for the row that stands between a registered-but-inactive key and
 * a session. Extends BaseRepository for transaction-context detection and
 * read/write splitting.
 *
 * Every lookup here is by `challenge_hash` and never by id. The secret is what
 * the caller holds; the hash is what this table has, so a row can only be found
 * by someone who already had the secret — a guess reaches no row at all, which
 * is what keeps a guess from touching another challenge's `attempts`.
 */

import { BaseRepository } from '@spfn/core/db';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import { mfaChallenges, MFA_CHALLENGE_ATTEMPT_LIMIT } from '../entities/mfa-challenges';
import type { MfaChallenge, NewMfaChallenge } from '../entities/mfa-challenges';
import { userPublicKeys } from '../entities/user-public-keys';

export class MfaChallengesRepository extends BaseRepository
{
    /** Park a fresh challenge. The caller has already written the pending key. */
    async create(data: NewMfaChallenge): Promise<MfaChallenge>
    {
        return await this._create(mfaChallenges, data);
    }

    /**
     * The challenge this secret names, whatever state it is in.
     *
     * Reads the primary rather than the replica: `verify` decides whether a key
     * becomes usable, and a replica lagging behind the 202 that created the row
     * would refuse a challenge the caller was handed a moment ago.
     */
    async findByHash(challengeHash: string): Promise<MfaChallenge | null>
    {
        const result = await this.db
            .select()
            .from(mfaChallenges)
            .where(eq(mfaChallenges.challengeHash, challengeHash))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * The live challenge already outstanding for this key, if there is one.
     *
     * What makes a retried registration resume rather than collide: a native
     * client reusing its keyId, or an OAuth state replayed from the back button,
     * gets the challenge it was already given instead of a 409 about a key it
     * does own.
     */
    async findLiveByKeyId(userId: number, keyId: string): Promise<MfaChallenge | null>
    {
        const result = await this.db
            .select()
            .from(mfaChallenges)
            .where(and(
                eq(mfaChallenges.userId, userId),
                eq(mfaChallenges.keyId, keyId),
                isNull(mfaChallenges.verifiedAt),
                gt(mfaChallenges.expiresAt, new Date()),
            ))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Spend the challenge, or answer false because somebody else already did.
     *
     * A conditional UPDATE and not a read followed by a write: two verifies
     * arriving together would both pass a read, and a challenge is single use.
     * Every condition the caller checked is restated here, so the row that is
     * marked is a row that was still spendable at the moment it was marked.
     */
    async markVerified(id: number, keyEpoch: number): Promise<boolean>
    {
        const result = await this.db
            .update(mfaChallenges)
            .set({ verifiedAt: new Date() })
            .where(and(
                eq(mfaChallenges.id, id),
                eq(mfaChallenges.keyEpoch, keyEpoch),
                isNull(mfaChallenges.verifiedAt),
                gt(mfaChallenges.expiresAt, new Date()),
            ))
            .returning();

        return result.length > 0;
    }

    /**
     * Count a wrong proof, and say whether that was the last one allowed.
     *
     * The increment is on the row the presented secret actually hashed to, which
     * is the whole reason lookup is by hash: there is no id for a caller to name,
     * so no counter but their own can be moved.
     */
    async countFailure(id: number): Promise<boolean>
    {
        const result = await this.db
            .update(mfaChallenges)
            .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
            .where(eq(mfaChallenges.id, id))
            .returning({ attempts: mfaChallenges.attempts });

        return (result[0]?.attempts ?? 0) >= MFA_CHALLENGE_ATTEMPT_LIMIT;
    }

    /**
     * Point an inactive key at the challenge that gates it.
     *
     * A second statement rather than a column on the insert, because the
     * challenge references the key: the key row has to exist before the
     * challenge can, so the back-reference is written once both do. Both run
     * inside the registering route's transaction.
     */
    async markKeyPending(keyId: string, challengeId: number): Promise<void>
    {
        await this.db
            .update(userPublicKeys)
            .set({ pendingMfaChallengeId: challengeId })
            .where(eq(userPublicKeys.keyId, keyId));
    }

    /**
     * Give a live challenge a fresh secret, leaving everything else alone.
     *
     * What a retried registration gets. The row keeps its id, its expiry and its
     * spent attempts, so retrying is not a way to reset the counter or buy
     * another ten minutes; only the secret is new, because the old one was never
     * stored and cannot be handed out twice.
     */
    async resecret(id: number, challengeHash: string): Promise<boolean>
    {
        const result = await this.db
            .update(mfaChallenges)
            .set({ challengeHash })
            .where(and(
                eq(mfaChallenges.id, id),
                isNull(mfaChallenges.verifiedAt),
                gt(mfaChallenges.expiresAt, new Date()),
            ))
            .returning({ id: mfaChallenges.id });

        return result.length > 0;
    }

    /**
     * Delete the pending key a challenge was gating, which takes the challenge
     * with it through the cascade.
     *
     * Scoped to `pending_mfa_challenge_id`, so a key that has since been
     * activated is never deleted by a late failure or a sweep.
     */
    async dropPendingKey(keyId: string, challengeId: number): Promise<void>
    {
        await this.db
            .delete(userPublicKeys)
            .where(and(
                eq(userPublicKeys.keyId, keyId),
                eq(userPublicKeys.pendingMfaChallengeId, challengeId),
            ));
    }

    /**
     * Mark a key active and no longer pending — what a verified challenge buys.
     *
     * Conditioned on the challenge id, so this can only activate the key that
     * challenge was minted for.
     */
    async activateKey(keyId: string, challengeId: number): Promise<void>
    {
        await this.db
            .update(userPublicKeys)
            .set({ isActive: true, pendingMfaChallengeId: null })
            .where(and(
                eq(userPublicKeys.keyId, keyId),
                eq(userPublicKeys.pendingMfaChallengeId, challengeId),
            ));
    }

    /**
     * Clear out challenges nobody finished, and the keys they were gating.
     *
     * The key goes first and the cascade takes its challenge; the second delete
     * catches a challenge whose key was already removed some other way. Both are
     * bounded by the same cutoff — a spent challenge is kept until then, so a
     * replay inside the window meets "already verified" rather than "unknown".
     *
     * @returns how many challenge rows are gone
     */
    async sweepFinished(cutoff: Date): Promise<number>
    {
        const finished = or(lte(mfaChallenges.expiresAt, cutoff), sql`${mfaChallenges.verifiedAt} is not null`);

        await this.db
            .delete(userPublicKeys)
            .where(sql`${userPublicKeys.pendingMfaChallengeId} in (
                select ${mfaChallenges.id} from ${mfaChallenges} where ${finished}
            )`);

        const deleted = await this.db
            .delete(mfaChallenges)
            .where(finished)
            .returning({ id: mfaChallenges.id });

        return deleted.length;
    }
}

// Default instance export
export const mfaChallengesRepository = new MfaChallengesRepository();
