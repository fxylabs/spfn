/**
 * WebAuthn Challenges Repository
 *
 * Data access for the one-time nonces the two WebAuthn ceremonies hand out.
 * Extends BaseRepository for transaction-context detection and read/write
 * splitting.
 *
 * `consume` is one conditional UPDATE and returns the row only if THIS call was
 * the one that spent it. Read-then-write would lose that race: two verifies
 * arriving with the same challenge would both read it as live and both proceed,
 * which is the replay the challenge exists to stop.
 */

import { webauthnChallenges } from '../entities/webauthn-challenges';
import type {
    NewWebAuthnChallenge,
    WebAuthnChallenge,
    WebAuthnChallengeKind,
} from '../entities/webauthn-challenges';
import { BaseRepository } from '@spfn/core/db';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';

export class WebAuthnChallengesRepository extends BaseRepository
{
    /**
     * Park a freshly minted challenge.
     * Write primary.
     */
    async create(data: NewWebAuthnChallenge): Promise<WebAuthnChallenge>
    {
        const result = await this.db
            .insert(webauthnChallenges)
            .values(data)
            .returning();

        return result[0];
    }

    /**
     * Spend a challenge, if it is still live and was minted for this ceremony.
     *
     * The whole refusal — unknown, expired, already spent, wrong kind — is this
     * one statement's WHERE clause, so nothing can read a challenge as usable in
     * one step and spend it in another. The caller compares `userId` on the row
     * it gets back; that is the one condition left outside, because a
     * discoverable login has no user to match and must still spend the row.
     *
     * @returns the row this call spent, or null if there was nothing to spend
     */
    async consume(
        challengeHash: string,
        kind: WebAuthnChallengeKind,
    ): Promise<WebAuthnChallenge | null>
    {
        const result = await this.db
            .update(webauthnChallenges)
            .set({ consumedAt: new Date() })
            .where(and(
                eq(webauthnChallenges.challengeHash, challengeHash),
                eq(webauthnChallenges.kind, kind),
                isNull(webauthnChallenges.consumedAt),
                gt(webauthnChallenges.expiresAt, new Date()),
            ))
            .returning();

        return result[0] ?? null;
    }

    /**
     * Drop challenges nobody can present any more.
     *
     * Write primary.
     *
     * @returns number of rows deleted
     */
    async deleteExpired(): Promise<number>
    {
        const result = await this.db
            .delete(webauthnChallenges)
            .where(lt(webauthnChallenges.expiresAt, new Date()))
            .returning();

        return result.length;
    }
}

// Default instance export
export const webauthnChallengesRepository = new WebAuthnChallengesRepository();
