/**
 * Revoke-All Link Tokens Repository
 *
 * Data access for the signed sign-out-everywhere link. Extends BaseRepository
 * for transaction-context detection and read/write splitting.
 *
 * `consume` is one statement and returns the account only if THIS call was the
 * one that spent the link. Two requests arriving with the same token therefore
 * produce one revocation and one refusal, rather than both reading an unspent
 * row and both proceeding — a read-then-write would lose that race, and the
 * race is the interesting one for a credential sitting in a mailbox.
 *
 * Every lookup filters to a usable row rather than returning whatever it finds.
 * Unknown, expired, spent, superseded, out of generation and not-an-active-
 * account are one refusal to the caller, so there is nothing to learn from
 * telling them apart — and a filter in the statement cannot be forgotten the
 * way a state check can.
 */

import { keyRevokeAllTokens } from '../entities/key-revoke-all-tokens';
import type { KeyRevokeAllToken, NewKeyRevokeAllToken } from '../entities/key-revoke-all-tokens';
import { users } from '../entities/users';
import { BaseRepository } from '@spfn/core/db';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

/** What a live link says about itself, for the describe call that changes nothing. */
export interface LiveRevokeAllLink
{
    userId: number;
    expiresAt: Date;
}

export class KeyRevokeAllTokensRepository extends BaseRepository
{
    /**
     * Write an issued link row.
     * Write primary.
     */
    async create(data: NewKeyRevokeAllToken): Promise<KeyRevokeAllToken>
    {
        const result = await this.db
            .insert(keyRevokeAllTokens)
            .values(data)
            .returning();

        return result[0];
    }

    /**
     * Supersede every live link for an account, so issuing a new one retires the
     * previous one rather than leaving two capabilities in a mailbox.
     *
     * Write primary.
     *
     * @returns number of rows superseded
     */
    async supersedeAllLiveByUserId(userId: number): Promise<number>
    {
        const result = await this.db
            .update(keyRevokeAllTokens)
            .set({ supersededAt: new Date() })
            .where(
                and(
                    eq(keyRevokeAllTokens.userId, userId),
                    isNull(keyRevokeAllTokens.consumedAt),
                    isNull(keyRevokeAllTokens.supersededAt),
                ),
            )
            .returning();

        return result.length;
    }

    /**
     * Find a link that could still be spent right now, without spending it.
     *
     * Joined to the account on both the generation and an active status, so the
     * describe call answers exactly what consume would: a link issued before a
     * password reset, or for an account since suspended or anonymized, is not
     * live here either.
     *
     * Read replica.
     */
    async findLiveByTokenHash(tokenHash: string): Promise<LiveRevokeAllLink | null>
    {
        const result = await this.readDb
            .select({ userId: keyRevokeAllTokens.userId, expiresAt: keyRevokeAllTokens.expiresAt })
            .from(keyRevokeAllTokens)
            .innerJoin(users, eq(users.id, keyRevokeAllTokens.userId))
            .where(
                and(
                    eq(keyRevokeAllTokens.tokenHash, tokenHash),
                    isNull(keyRevokeAllTokens.consumedAt),
                    isNull(keyRevokeAllTokens.supersededAt),
                    gt(keyRevokeAllTokens.expiresAt, new Date()),
                    eq(keyRevokeAllTokens.keyEpoch, users.keyEpoch),
                    eq(users.status, 'active'),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Spend a link, and answer with the account it belonged to.
     *
     * One UPDATE with every condition in it and `RETURNING`, rather than a read
     * and a write: the row is claimed by whichever request the database serves
     * first, and the other matches nothing. Nothing opens a transaction around
     * it, so the claim is not held open across the revocation that follows.
     *
     * Write primary.
     *
     * @returns the account id, or null if the link was not spendable by this call
     */
    async consume(tokenHash: string): Promise<number | null>
    {
        const rows = await this.db.execute(sql`
            UPDATE ${keyRevokeAllTokens} t
            SET consumed_at = now()
            FROM ${users} u
            WHERE t.user_id = u.id
              AND t.token_hash = ${tokenHash}
              AND t.consumed_at IS NULL
              AND t.superseded_at IS NULL
              AND t.expires_at > now()
              AND t.key_epoch = u.key_epoch
              AND u.status = 'active'
            RETURNING t.user_id AS "userId"
        `) as unknown as { userId: number | string }[];

        return rows[0] ? Number(rows[0].userId) : null;
    }

    /**
     * Delete rows nothing can be learned from any more.
     *
     * Two ages, because the two states stop mattering at different times. An
     * expired row is kept a week so a support question about a link that was
     * mailed can still be answered; a spent or superseded one is kept a day,
     * since the refusal it produces is already indistinguishable from the one an
     * unknown token gets and the row is only bookkeeping after that.
     *
     * Write primary.
     *
     * @returns number of rows deleted
     */
    async purge(expiredBefore: Date, settledBefore: Date): Promise<number>
    {
        const result = await this.db
            .delete(keyRevokeAllTokens)
            .where(
                // A null never satisfies `<`, so an unspent row is only ever
                // matched by the expiry arm.
                or(
                    lt(keyRevokeAllTokens.expiresAt, expiredBefore),
                    lt(keyRevokeAllTokens.consumedAt, settledBefore),
                    lt(keyRevokeAllTokens.supersededAt, settledBefore),
                ),
            )
            .returning();

        return result.length;
    }
}

// Default instance export
export const keyRevokeAllTokensRepository = new KeyRevokeAllTokensRepository();
