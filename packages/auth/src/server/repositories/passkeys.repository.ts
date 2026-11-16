/**
 * Passkeys Repository
 *
 * Data access for enrolled WebAuthn credentials. Extends BaseRepository for
 * transaction-context detection and read/write splitting.
 *
 * Two lookups by credential id, deliberately separate. `findLiveByCredentialId`
 * is the login path and must see only credentials that can still sign.
 * `existsByCredentialId` is the enrollment path and must see revoked rows too,
 * because a credential someone cut off stays reserved forever (D5) — one query
 * serving both would have to pick a filter, and each caller needs the other one.
 */

import { passkeys } from '../entities/passkeys';
import type { NewPasskey, Passkey } from '../entities/passkeys';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

export class PasskeysRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<PasskeysRepository> = {
        create: { account: data => data.userId },
        recordUse: { account: passkey => passkey.userId },
        renameByIdAndUserId: { exempt: 'the label alone: display, authorizes nothing, read by no admission; one owner-scoped single-row statement on a live passkey, outside any transaction' },
        revokeByIdAndUserId: { account: (_id, userId) => userId },
        revokeAllLiveByUserId: { account: userId => userId },
        markSecondFactorByIdAndUserId: { account: (_id, userId) => userId },
        clearSecondFactorByUserId: { account: userId => userId },
        deleteAllByUserId: { account: userId => userId },
    };

    /**
     * Enroll a credential.
     * Write primary.
     */
    async create(data: NewPasskey): Promise<Passkey>
    {
        const result = await this.db
            .insert(passkeys)
            .values(data)
            .returning();

        return result[0];
    }

    /**
     * The live credential with this id, whoever owns it.
     *
     * Unfiltered by user on purpose: a discoverable sign-in names no account, so
     * the credential is what identifies the owner.
     *
     * Write primary — the login path reads it inside the transaction that then
     * moves its counter.
     */
    async findLiveByCredentialId(credentialId: string): Promise<Passkey | null>
    {
        const result = await this.db
            .select()
            .from(passkeys)
            .where(and(eq(passkeys.credentialId, credentialId), isNull(passkeys.revokedAt)))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Whether this credential id is taken on any account, live or revoked.
     * Write primary — enrollment decides on it inside its own transaction.
     */
    async existsByCredentialId(credentialId: string): Promise<boolean>
    {
        const result = await this.db
            .select({ id: passkeys.id })
            .from(passkeys)
            .where(eq(passkeys.credentialId, credentialId))
            .limit(1);

        return result.length > 0;
    }

    /**
     * One owner's live credentials, newest first.
     * Write primary — both callers (the exclude list, the last-credential guard)
     * decide something inside a transaction on what they read here.
     */
    async listLiveByUserId(userId: number): Promise<Passkey[]>
    {
        return await this.db
            .select()
            .from(passkeys)
            .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)))
            .orderBy(desc(passkeys.createdAt));
    }

    /**
     * One live credential owned by this user.
     * Owner-scoped, so an id belonging to someone else answers null rather than
     * a row — a management route can only ever say "not yours".
     */
    async findLiveByIdAndUserId(id: number, userId: number): Promise<Passkey | null>
    {
        const result = await this.db
            .select()
            .from(passkeys)
            .where(and(
                eq(passkeys.id, id),
                eq(passkeys.userId, userId),
                isNull(passkeys.revokedAt),
            ))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Record a successful assertion — only on a passkey still live, and still
     * at the counter the assertion was verified against. The assertion was
     * verified against a row read before the account lock: a revocation that
     * landed since must refuse it, and so must another assertion recorded
     * since, or two assertions verified against one counter would both succeed
     * and the counter could move backwards. Write primary.
     *
     * The counter rule, after WebAuthn §6.1.1 and §7.2 step 21: the new
     * counter must be greater than the one verified against. The one exception
     * is the authenticator that implements no counter and reports 0 every time
     * (the spec's "both zero"): it keeps working, with no clone detection —
     * there is no counter to detect one by.
     *
     * @returns false when the passkey is revoked (or not the account's), or its
     *   counter moved or would not advance: a refusal
     */
    async recordUse(passkey: Pick<Passkey, 'id' | 'userId' | 'counter'>, newCounter: number): Promise<boolean>
    {
        if (!counterAdvances(passkey.counter, newCounter))
        {
            return false;
        }

        const result = await this.db
            .update(passkeys)
            .set({ counter: newCounter, lastUsedAt: new Date() })
            .where(and(
                eq(passkeys.id, passkey.id),
                eq(passkeys.userId, passkey.userId),
                isNull(passkeys.revokedAt),
                eq(passkeys.counter, passkey.counter),
            ))
            .returning({ id: passkeys.id });

        return result.length > 0;
    }

    /**
     * Rename, but only a credential this user still owns and has not revoked.
     *
     * @returns the updated row, or null if it is not theirs or already revoked
     */
    async renameByIdAndUserId(id: number, userId: number, label: string): Promise<Passkey | null>
    {
        const result = await this.db
            .update(passkeys)
            .set({ label })
            .where(and(
                eq(passkeys.id, id),
                eq(passkeys.userId, userId),
                isNull(passkeys.revokedAt),
            ))
            .returning();

        return result[0] ?? null;
    }

    /**
     * Retire a credential, but only if THIS call is the one that retired it.
     *
     * Conditional on `revokedAt IS NULL`, so two concurrent revokes produce one
     * winner and one 404 rather than both reporting success on a row only one of
     * them moved.
     *
     * @returns the updated row, or null if it is not theirs or already revoked
     */
    async revokeByIdAndUserId(id: number, userId: number, reason: string): Promise<Passkey | null>
    {
        const result = await this.db
            .update(passkeys)
            .set({ revokedAt: new Date(), revokedReason: reason })
            .where(and(
                eq(passkeys.id, id),
                eq(passkeys.userId, userId),
                isNull(passkeys.revokedAt),
            ))
            .returning();

        return result[0] ?? null;
    }

    /**
     * Retire every live credential of an account, for the same reason.
     * Write primary.
     *
     * @returns the rows it retired
     */
    async revokeAllLiveByUserId(userId: number, reason: string): Promise<Passkey[]>
    {
        return await this.db
            .update(passkeys)
            .set({ revokedAt: new Date(), revokedReason: reason })
            .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)))
            .returning();
    }

    /**
     * Mark or unmark a live credential as the owner's second factor.
     *
     * Owner-scoped and live-only, so somebody else's passkey and an already
     * revoked one are both "no such row" — the same answer every other
     * management statement here gives. A mark is given only to a credential
     * registered with user verification: that is a condition of this
     * statement, so no read before it decides it.
     *
     * @returns the updated row, or null if it is not theirs, already revoked,
     *   or — when marking — registered without user verification
     */
    async markSecondFactorByIdAndUserId(id: number, userId: number, secondFactor: boolean): Promise<Passkey | null>
    {
        const result = await this.db
            .update(passkeys)
            .set({ secondFactor })
            .where(and(
                eq(passkeys.id, id),
                eq(passkeys.userId, userId),
                isNull(passkeys.revokedAt),
                secondFactor ? eq(passkeys.registeredUserVerified, true) : undefined,
            ))
            .returning();

        return result[0] ?? null;
    }

    /**
     * The account's live credentials that satisfy a step-up.
     *
     * Used to check an assertion against the marked ones only: a passkey that
     * signs the owner in is not a second factor until they say it is.
     */
    async listLiveSecondFactorByUserId(userId: number): Promise<Passkey[]>
    {
        return await this.readDb
            .select()
            .from(passkeys)
            .where(and(
                eq(passkeys.userId, userId),
                eq(passkeys.secondFactor, true),
                isNull(passkeys.revokedAt),
            ))
            .orderBy(desc(passkeys.createdAt));
    }

    /**
     * Take the second-factor mark off every one of an account's credentials.
     *
     * What `mfa/disable` does to the passkey half of an enrolment. The
     * credentials themselves are untouched — they still sign the owner in.
     * Write primary.
     */
    async clearSecondFactorByUserId(userId: number): Promise<void>
    {
        await this.db
            .update(passkeys)
            .set({ secondFactor: false })
            .where(eq(passkeys.userId, userId));
    }

    /**
     * Delete every passkey of an account (account destruction).
     * Write primary.
     *
     * @returns number of rows deleted
     */
    async deleteAllByUserId(userId: number): Promise<number>
    {
        const result = await this.db
            .delete(passkeys)
            .where(eq(passkeys.userId, userId))
            .returning();

        return result.length;
    }
}

/** The counter rule `recordUse` states: strictly up, or an authenticator that counts nothing. */
function counterAdvances(verifiedAgainst: number, newCounter: number): boolean
{
    return newCounter > verifiedAgainst || (newCounter === 0 && verifiedAgainst === 0);
}

// Default instance export
export const passkeysRepository = new PasskeysRepository();
