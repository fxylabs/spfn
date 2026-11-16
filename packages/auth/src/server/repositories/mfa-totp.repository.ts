/**
 * MFA TOTP Repository
 *
 * Data access for the one enrolment row an account may have. Extends
 * BaseRepository for transaction-context detection and read/write splitting.
 *
 * `secret_enc` is a ciphertext and is only ever moved through this layer as an
 * opaque string — nothing here decrypts, and nothing here logs a row.
 */

import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import { mfaTotp } from '../entities/mfa-totp';
import type { MfaTotp } from '../entities/mfa-totp';
import { stampColumns, type DeferredStamp } from '../lib/deferred-stamp';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

export class MfaTotpRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<MfaTotpRepository> = {
        startEnrolment: { account: userId => userId },
        repointStamp: { account: userId => userId },
        confirm: { account: userId => userId },
        recordUsedStep: { account: userId => userId },
        updateSecret: { account: userId => userId },
        deleteByUserId: { account: userId => userId },
        deleteUnconfirmedOf: { account: userId => userId },
    };

    /**
     * The account's enrolment row, confirmed or not. Primary: a code is checked
     * against what this returns, and a replica behind the last spend or confirm
     * would answer a state that is gone.
     */
    async findByUserId(userId: number): Promise<MfaTotp | null>
    {
        const result = await this.db
            .select()
            .from(mfaTotp)
            .where(eq(mfaTotp.userId, userId))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Start an enrolment, replacing an unconfirmed one.
     *
     * Upsert rather than insert: calling `enroll` twice is the ordinary case —
     * a user closes the app before scanning — and the second call must hand out
     * a fresh secret rather than a 409.
     *
     * A **confirmed** row is refused by the service before this is reached, so
     * this can never overwrite a working second factor.
     *
     * The row carries the stamp of the start (`lib/deferred-stamp.ts`): the
     * credential that started it and the account's key generation then.
     *
     * A fresh start is a fresh row id: the id names the enrolment — the secret
     * — a code was verified against, and `confirm` and `recordUsedStep` write
     * only to the enrolment they were handed. Rewriting the ciphertext under
     * another key (`updateSecret`) keeps it, as it keeps the secret.
     */
    async startEnrolment(userId: number, secretEnc: string, stamp: DeferredStamp): Promise<MfaTotp>
    {
        const started = { secretEnc, ...stampColumns(stamp) };
        const result = await this.db
            .insert(mfaTotp)
            .values({ userId, ...started })
            .onConflictDoUpdate({
                target: mfaTotp.userId,
                set: { ...started, id: sql`DEFAULT`, confirmedAt: null, lastUsedStep: null },
            })
            .returning();

        return result[0];
    }

    /**
     * Point an unconfirmed enrolment started on the device key `fromKeyId` at
     * the key that replaced it in a verified replacement — the same device
     * under a new key. An application profile's stamp is not a device key's,
     * whatever key id its verifier reported, and is left alone. Write primary.
     */
    async repointStamp(userId: number, fromKeyId: string, toKeyId: string): Promise<void>
    {
        await this.db
            .update(mfaTotp)
            .set({ startedByKeyId: toKeyId })
            .where(and(
                eq(mfaTotp.userId, userId),
                eq(mfaTotp.startedByKeyId, fromKeyId),
                isNull(mfaTotp.startedByProfile),
                isNull(mfaTotp.confirmedAt),
            ));
    }

    /**
     * Mark the enrolment confirmed and record the step its first code spent —
     * only while it is still the enrolment the code was verified against
     * (`enrolmentId`) and still unconfirmed, so of two confirms with one code
     * exactly one confirms it, and issues the recovery codes; and a code for a
     * secret an `enroll` since then replaced confirms nothing. Write primary.
     *
     * @returns true when this call confirmed it
     */
    async confirm(userId: number, enrolmentId: number, step: number): Promise<boolean>
    {
        const result = await this.db
            .update(mfaTotp)
            .set({ confirmedAt: new Date(), lastUsedStep: step })
            .where(and(eq(mfaTotp.id, enrolmentId), eq(mfaTotp.userId, userId), isNull(mfaTotp.confirmedAt)))
            .returning({ userId: mfaTotp.userId });

        return result.length > 0;
    }

    /**
     * Record the newest step this account has spent, so it cannot be replayed —
     * only while the enrolment is the one the code was verified against
     * (`enrolmentId`), confirmed, and the step is newer than the last one
     * spent: the check the code passed, restated under the account lock, so
     * two requests with one code produce one winner, and a code of a secret
     * replaced in between spends nothing on the new one.
     *
     * @returns true when this call spent the step
     */
    async recordUsedStep(userId: number, enrolmentId: number, step: number): Promise<boolean>
    {
        const result = await this.db
            .update(mfaTotp)
            .set({ lastUsedStep: step })
            .where(and(
                eq(mfaTotp.id, enrolmentId),
                eq(mfaTotp.userId, userId),
                isNotNull(mfaTotp.confirmedAt),
                or(isNull(mfaTotp.lastUsedStep), lt(mfaTotp.lastUsedStep, step)),
            ))
            .returning({ userId: mfaTotp.userId });

        return result.length > 0;
    }

    /**
     * Rewrite the ciphertext in place, after a read on a retired key — only
     * while the row still holds the ciphertext that was read: an enrolment
     * started over in between holds a new secret, which this must not put back.
     */
    async updateSecret(userId: number, readSecretEnc: string, secretEnc: string): Promise<void>
    {
        await this.db
            .update(mfaTotp)
            .set({ secretEnc })
            .where(and(eq(mfaTotp.userId, userId), eq(mfaTotp.secretEnc, readSecretEnc)));
    }

    /** Drop the account's enrolment. Write primary. */
    async deleteByUserId(userId: number): Promise<void>
    {
        await this.db.delete(mfaTotp).where(eq(mfaTotp.userId, userId));
    }

    /**
     * Up to `limit` accounts holding an enrolment nobody confirmed since before
     * the cutoff. The rest wait for the next sweep run.
     */
    async findAccountsUnconfirmedBefore(cutoff: Date, limit: number): Promise<number[]>
    {
        const rows = await this.db
            .select({ userId: mfaTotp.userId })
            .from(mfaTotp)
            .where(and(isNull(mfaTotp.confirmedAt), lt(mfaTotp.createdAt, cutoff)))
            .orderBy(mfaTotp.userId)
            .limit(limit);

        return rows.map(row => row.userId);
    }

    /**
     * Drop one account's enrolment if nobody confirmed it since before the
     * cutoff. The sweep job's statement, under that account's lock.
     *
     * @returns number of rows deleted
     */
    async deleteUnconfirmedOf(userId: number, cutoff: Date): Promise<number>
    {
        const result = await this.db
            .delete(mfaTotp)
            .where(and(eq(mfaTotp.userId, userId), isNull(mfaTotp.confirmedAt), lt(mfaTotp.createdAt, cutoff)))
            .returning();

        return result.length;
    }
}

// Default instance export
export const mfaTotpRepository = new MfaTotpRepository();
