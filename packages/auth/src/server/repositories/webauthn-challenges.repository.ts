/**
 * WebAuthn Challenges Repository
 *
 * Data access for the one-time nonces the WebAuthn ceremonies hand out.
 * Credential state (`CREDENTIAL_TABLES`): spending one is what lets an
 * assertion sign in, renew a session, enrol a passkey or step up.
 *
 * A ceremony **reads** its challenge (`findLive`), verifies the response
 * outside the account lock, and **spends** it (`consume`) inside the locked
 * transaction together with what the ceremony writes. `consume` is one
 * conditional UPDATE and answers true only if THIS call spent the row: two
 * verifies arriving with the same challenge both read it as live, and one of
 * them finds nothing left to spend. A lock wait that runs out
 * (`AccountBusyError`) rolls back with the spend, so the challenge is still
 * live for the retry that error invites.
 */

import { and, eq, gt, isNull, lt } from 'drizzle-orm';

import { webauthnChallenges } from '../entities/webauthn-challenges';
import type {
    NewWebAuthnChallenge,
    WebAuthnChallenge,
    WebAuthnChallengeKind,
} from '../entities/webauthn-challenges';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

export class WebAuthnChallengesRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<WebAuthnChallengesRepository> = {
        create: { exempt: 'minting a nonce admits nothing: only its spend does, and that runs under the account lock (consume)' },
        consume: { account: accountId => accountId },
        repointStamps: { account: userId => userId },
        deleteExpired: { exempt: 'drops rows past their expiry, which no ceremony can spend: a sweep over every account, nothing live' },
    };

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
     * The challenge, if it is still live, of this kind, and minted for this
     * owner — null for an `'authentication'` challenge, which names nobody
     * (D3). Read on the primary: it was minted moments ago. Spends nothing.
     */
    async findLive(
        challengeHash: string,
        kind: WebAuthnChallengeKind,
        owner: number | null,
    ): Promise<WebAuthnChallenge | null>
    {
        const result = await this.db
            .select()
            .from(webauthnChallenges)
            .where(and(liveChallenge(challengeHash, kind), ownedBy(owner)))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Spend a challenge for the account whose lock this transaction holds — if
     * it is still live, of this kind, and minted for that account (or, for
     * `'authentication'`, for nobody).
     *
     * The whole refusal — unknown, expired, already spent, wrong kind, another
     * account's — is this one statement's WHERE clause, so nothing can read a
     * challenge as usable in one step and spend it in another.
     *
     * @returns true when this call spent the row
     */
    async consume(
        accountId: number,
        challengeHash: string,
        kind: WebAuthnChallengeKind,
    ): Promise<boolean>
    {
        const result = await this.db
            .update(webauthnChallenges)
            .set({ consumedAt: new Date() })
            .where(and(liveChallenge(challengeHash, kind), ownedBy(kind === 'authentication' ? null : accountId)))
            .returning({ id: webauthnChallenges.id });

        return result.length > 0;
    }

    /**
     * Point the live challenges a ceremony started on the device key
     * `fromKeyId` at the key that replaced it in a verified replacement — the
     * same device under a new key (`lib/deferred-stamp.ts`). An application
     * profile's stamp is left alone. Write primary.
     */
    async repointStamps(userId: number, fromKeyId: string, toKeyId: string): Promise<void>
    {
        await this.db
            .update(webauthnChallenges)
            .set({ startedByKeyId: toKeyId })
            .where(and(
                eq(webauthnChallenges.userId, userId),
                eq(webauthnChallenges.startedByKeyId, fromKeyId),
                isNull(webauthnChallenges.startedByProfile),
                isNull(webauthnChallenges.consumedAt),
            ));
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

function liveChallenge(challengeHash: string, kind: WebAuthnChallengeKind)
{
    return and(
        eq(webauthnChallenges.challengeHash, challengeHash),
        eq(webauthnChallenges.kind, kind),
        isNull(webauthnChallenges.consumedAt),
        gt(webauthnChallenges.expiresAt, new Date()),
    );
}

function ownedBy(owner: number | null)
{
    return owner === null ? isNull(webauthnChallenges.userId) : eq(webauthnChallenges.userId, owner);
}

// Default instance export
export const webauthnChallengesRepository = new WebAuthnChallengesRepository();
