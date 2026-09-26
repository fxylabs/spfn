/**
 * Device Authorizations Repository
 *
 * Data access for device-code login. Extends BaseRepository for transaction
 * context detection and read/write splitting.
 *
 * Every state change here is a conditional UPDATE naming the exact state it is
 * allowed to move from, returning the row only when THIS call was the one that
 * moved it. That is what makes the operations safe to race: two polls on one
 * approved record, or a deny arriving while an approve is in flight, produce one
 * winner and one refusal instead of both callers acting on a row they each read
 * as still theirs to move. Read-then-write would lose that.
 *
 * Each of those transitions also carries the TTL, as `now()` evaluated by the
 * database. The service reads a record before it acts on it, and a record can
 * pass its expiry in the gap between that read and this UPDATE — an approved one
 * most of all, since the poll that spends it is the one call that registers a
 * key. Judging the clock only in the read would let that key be registered after
 * the code was dead.
 *
 * The three transitions that answer a record — approve, deny, and the global
 * revocation's sweep — also wake any long poll parked on it, after commit. That
 * is done here rather than in each caller because the sweep has four callers
 * across the revocation paths, and a caller that forgot would leave a waiting
 * device on its slower recheck instead of telling it no.
 */

import { deviceAuthorizations } from '../entities/device-authorizations';
import type { DeviceAuthorization, NewDeviceAuthorization } from '../entities/device-authorizations';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, gt, inArray, sql } from 'drizzle-orm';
import { announceDeviceAuthAnswered } from '../lib/device-auth-waiters';

/**
 * The TTL condition every transition carries.
 *
 * `now()` rather than a timestamp this process computed: the row is judged by
 * the same clock that stores it, so an app server whose clock has drifted cannot
 * extend or shorten a code's life.
 */
const notExpired = () => gt(deviceAuthorizations.expiresAt, sql`now()`);

export class DeviceAuthorizationsRepository extends BaseRepository
{
    /**
     * Insert a pending authorization, unless one of its codes is already taken.
     *
     * `onConflictDoNothing` rather than letting the unique index raise: the start
     * route runs inside a transaction, and a raised unique violation aborts it,
     * so the retry that a generated-code collision calls for could not run — every
     * statement after it would fail with "current transaction is aborted" instead.
     * An empty result is the collision signal, and the caller draws a fresh code.
     *
     * Write primary.
     *
     * @returns the inserted row, or null if either code collided
     */
    async create(data: NewDeviceAuthorization): Promise<DeviceAuthorization | null>
    {
        const result = await this.db
            .insert(deviceAuthorizations)
            .values(data)
            .onConflictDoNothing()
            .returning();

        return result[0] ?? null;
    }

    /**
     * Find a record by its normalized user code, in any state.
     *
     * Deliberately unfiltered: which refusal a caller is owed — expired, already
     * handled, unknown — is the service's decision, and a row filtered out here
     * would be indistinguishable from a code that was never issued.
     *
     * Read replica.
     */
    async findByUserCode(userCode: string): Promise<DeviceAuthorization | null>
    {
        const result = await this.readDb
            .select()
            .from(deviceAuthorizations)
            .where(eq(deviceAuthorizations.userCode, userCode))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Find a record by the hash of a device code, in any state.
     * Unfiltered for the same reason as `findByUserCode`.
     *
     * Read replica.
     */
    async findByDeviceCodeHash(deviceCodeHash: string): Promise<DeviceAuthorization | null>
    {
        const result = await this.readDb
            .select()
            .from(deviceAuthorizations)
            .where(eq(deviceAuthorizations.deviceCodeHash, deviceCodeHash))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * `findByDeviceCodeHash`, read from the primary even outside a transaction.
     *
     * For the long poll's wait, which runs before any transaction opens: it is
     * woken right after an answer commits, and a replica that has not caught up
     * yet would show it the record still pending and send it back to sleep.
     *
     * Write primary.
     */
    async findByDeviceCodeHashOnPrimary(deviceCodeHash: string): Promise<DeviceAuthorization | null>
    {
        const result = await this.db
            .select()
            .from(deviceAuthorizations)
            .where(eq(deviceAuthorizations.deviceCodeHash, deviceCodeHash))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Bind the approving user and move the record to `approved`, but only from
     * `pending`.
     *
     * `userId` comes from the approver's authenticated session — never from a
     * request body — so this is the point where the record gains an owner.
     *
     * @returns the updated row, or null if it was no longer pending, or expired
     */
    async approve(id: number, userId: number): Promise<DeviceAuthorization | null>
    {
        const result = await this.db
            .update(deviceAuthorizations)
            .set({ status: 'approved', userId, approvedAt: new Date() })
            .where(
                and(
                    eq(deviceAuthorizations.id, id),
                    eq(deviceAuthorizations.status, 'pending'),
                    notExpired(),
                ),
            )
            .returning();

        return this.answered(result[0] ?? null);
    }

    /**
     * Move the record to `denied`, but only from `pending`.
     *
     * No user is bound: a refusal should leave no record of who was asked.
     *
     * @returns the updated row, or null if it was no longer pending, or expired
     */
    async deny(id: number): Promise<DeviceAuthorization | null>
    {
        const result = await this.db
            .update(deviceAuthorizations)
            .set({ status: 'denied' })
            .where(
                and(
                    eq(deviceAuthorizations.id, id),
                    eq(deviceAuthorizations.status, 'pending'),
                    notExpired(),
                ),
            )
            .returning();

        return this.answered(result[0] ?? null);
    }

    /**
     * Refuse every authorization a user still has in flight.
     *
     * This is the device-code half of a global revocation. Revoking
     * `user_public_keys` alone leaves an approved-but-uncollected record behind,
     * and the next poll on it registers a brand-new active key — so "sign every
     * device out" would hand one straight back to whoever was still waiting,
     * which is exactly the person a revoke-all is usually aimed at.
     *
     * `denied` rather than a status of its own: a swept record owes its holder
     * the answer a refused one owes, on all four operations — the waiting device
     * is told no and stops polling, and info/approve/deny say the request was
     * already answered. Adding a fourth live status would add a migration and a
     * case-table row to record a distinction nothing acts on.
     *
     * Expired rows are swept too. A global revoke is not the place to reason
     * about which dead rows were about to die anyway.
     *
     * `pending` alongside `approved` even though a pending row carries no
     * `userId` today, so only approved rows can match: the state list says which
     * states this is meant to close, and a later change that binds the user
     * earlier should not silently reopen the hole.
     *
     * @returns the rows this call refused
     */
    async denyAllActiveByUserId(userId: number): Promise<DeviceAuthorization[]>
    {
        const denied = await this.db
            .update(deviceAuthorizations)
            .set({ status: 'denied' })
            .where(
                and(
                    eq(deviceAuthorizations.userId, userId),
                    inArray(deviceAuthorizations.status, ['pending', 'approved']),
                ),
            )
            .returning();

        announceDeviceAuthAnswered(denied.map(record => record.id));

        return denied;
    }

    /**
     * Spend an approved record, but only from `approved`, and address it by the
     * device code hash the caller actually presented.
     *
     * This is the one-shot: the winner of two concurrent polls registers the key,
     * and the loser sees no approved record and is answered as if the code were
     * unknown. Matching on the hash rather than on an id read a moment ago keeps
     * the whole decision in one statement.
     *
     * @returns the spent row, or null if it was not approved (any more), or expired
     */
    async consumeApproved(deviceCodeHash: string): Promise<DeviceAuthorization | null>
    {
        const result = await this.db
            .update(deviceAuthorizations)
            .set({ status: 'consumed', consumedAt: new Date() })
            .where(
                and(
                    eq(deviceAuthorizations.deviceCodeHash, deviceCodeHash),
                    eq(deviceAuthorizations.status, 'approved'),
                    notExpired(),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /** Wake the polls parked on a record this call moved, and hand the row back. */
    private answered(record: DeviceAuthorization | null): DeviceAuthorization | null
    {
        if (record)
        {
            announceDeviceAuthAnswered([record.id]);
        }

        return record;
    }
}

// Default instance export
export const deviceAuthorizationsRepository = new DeviceAuthorizationsRepository();
