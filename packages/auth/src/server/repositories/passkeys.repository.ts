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
import { BaseRepository } from '@spfn/core/db';
import { and, desc, eq, isNull } from 'drizzle-orm';

export class PasskeysRepository extends BaseRepository
{
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
     * Record a successful assertion.
     * Write primary.
     */
    async recordUse(id: number, counter: number): Promise<void>
    {
        await this.db
            .update(passkeys)
            .set({ counter, lastUsedAt: new Date() })
            .where(eq(passkeys.id, id));
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

// Default instance export
export const passkeysRepository = new PasskeysRepository();
