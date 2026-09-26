/**
 * Device Links Repository
 *
 * Data access for device link. Extends BaseRepository for transaction context
 * detection and read/write splitting.
 *
 * Built the way `device-authorizations.repository.ts` is, for its reasons: every
 * state change is a conditional UPDATE naming the state it moves from and
 * carrying the TTL as the database's `now()`, and returns the row only when this
 * call was the one that moved it. Two devices redeeming one code, or two polls
 * collecting one approval, produce one winner.
 *
 * One condition more than device-code login has: the issuing key. A link belongs
 * to the key that signed its issue request, and it is worth nothing once that key
 * is revoked or has run out — a signed-out session must not be able to let a new
 * device into the account. The transitions that move a link toward a registered
 * key (redeem, confirm, consume) carry that condition in the same statement, and
 * lock the key row while they judge it, so a revocation committing at the same
 * moment is either seen or waited for — never read around.
 *
 * Every read here gates authorization — who may see a link, whether a key may be
 * parked or registered — so every read goes to the primary.
 *
 * Every transition wakes the long polls parked on the link, after commit.
 */

import { deviceLinks, userPublicKeys } from '../entities';
import type { DeviceLink, DeviceLinkStatus, NewDeviceLink } from '../entities';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, gt, or, isNull, inArray, exists, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { announceDeviceLinkMoved } from '../lib/device-link-waiters';

/** A link as read, with whether its issuing key can still sign. */
export type DeviceLinkRecord = DeviceLink & { issuerKeyLive: boolean };

/** The key material and labels a redeeming device parks, with the codes drawn for it. */
export interface DeviceLinkRedemption
{
    deviceCodeHash: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: DeviceLink['algorithm'];
    deviceName?: string;
    platform?: DeviceLink['platform'];
    matchNumber: number;
    choices: number[];
}

/** The states a link is still in play in: an issuer can abandon it, and a revocation must reach it. */
const LIVE_STATUSES: DeviceLinkStatus[] = ['issued', 'redeemed', 'approved'];

/** The TTL, judged by the clock that stores it — see `device-authorizations.repository.ts`. */
const notExpired = () => gt(deviceLinks.expiresAt, sql`now()`);

export class DeviceLinksRepository extends BaseRepository
{
    /**
     * Insert an issued link, unless its user code is already taken.
     *
     * `onConflictDoNothing` for the reason `DeviceAuthorizationsRepository.create`
     * gives: a raised unique violation would abort the issue route's transaction
     * and leave no way to retry with a fresh code.
     *
     * @returns the inserted row, or null if the code collided
     */
    async create(data: NewDeviceLink): Promise<DeviceLink | null>
    {
        const result = await this.db
            .insert(deviceLinks)
            .values(data)
            .onConflictDoNothing()
            .returning();

        return result[0] ?? null;
    }

    /**
     * Find a link by the issuer's handle, in any state.
     *
     * Unfiltered, as `DeviceAuthorizationsRepository.findByUserCode` is: which
     * refusal a caller is owed is the service's decision.
     */
    async findByLinkId(linkId: string): Promise<DeviceLinkRecord | null>
    {
        return this.findOne(eq(deviceLinks.linkId, linkId));
    }

    /** Find a link by its normalized user code, in any state. */
    async findByUserCode(userCode: string): Promise<DeviceLinkRecord | null>
    {
        return this.findOne(eq(deviceLinks.userCode, userCode));
    }

    /** Find a link by the hash of the device code its redeemer holds, in any state. */
    async findByDeviceCodeHash(deviceCodeHash: string): Promise<DeviceLinkRecord | null>
    {
        return this.findOne(eq(deviceLinks.deviceCodeHash, deviceCodeHash));
    }

    /**
     * Park a device's key on an issued link and move it to `redeemed`.
     *
     * From `issued` only, so of two devices redeeming one code exactly one wins;
     * the other matches nothing and is answered as if the code were unknown.
     *
     * @returns the updated row, or null if it was no longer issued, expired, or its issuer signed out
     */
    async redeem(id: number, redemption: DeviceLinkRedemption): Promise<DeviceLink | null>
    {
        return this.transition(
            { ...redemption, status: 'redeemed', redeemedAt: new Date() },
            and(eq(deviceLinks.id, id), eq(deviceLinks.status, 'issued'), notExpired(), this.issuerKeyLive(true)),
        );
    }

    /**
     * The issuer picked the right number: move the link to `approved`, from
     * `redeemed` only.
     *
     * The key is not registered here, for the reason device-code approval gives:
     * the redeeming device may never come back for it.
     *
     * @returns the updated row, or null if it was no longer redeemed, expired, or its issuer signed out
     */
    async approve(id: number): Promise<DeviceLink | null>
    {
        return this.transition(
            { status: 'approved', approvedAt: new Date() },
            and(eq(deviceLinks.id, id), eq(deviceLinks.status, 'redeemed'), notExpired(), this.issuerKeyLive(true)),
        );
    }

    /**
     * Refuse a redeemed link — the issuer said no, or picked the wrong number.
     *
     * No issuing-key condition: refusing is always safe, and a signed-out issuer's
     * link is refused anyway.
     *
     * @returns the updated row, or null if it was no longer redeemed, or expired
     */
    async deny(id: number): Promise<DeviceLink | null>
    {
        return this.transition(
            { status: 'denied' },
            and(eq(deviceLinks.id, id), eq(deviceLinks.status, 'redeemed'), notExpired()),
        );
    }

    /**
     * The issuer closed the link before anyone was let in: `issued` or `redeemed`
     * to `expired`.
     *
     * @returns the updated row, or null if it had moved past redeemed, or expired
     */
    async cancel(id: number): Promise<DeviceLink | null>
    {
        return this.transition(
            { status: 'expired' },
            and(eq(deviceLinks.id, id), inArray(deviceLinks.status, ['issued', 'redeemed']), notExpired()),
        );
    }

    /**
     * Spend an approved link, addressed by the device code hash the caller
     * presented — the one-shot `DeviceAuthorizationsRepository.consumeApproved`
     * is, with the issuing key judged in the same statement.
     *
     * @returns the spent row, or null if it was not approved (any more), expired, or its issuer signed out
     */
    async consumeApproved(deviceCodeHash: string): Promise<DeviceLink | null>
    {
        return this.transition(
            { status: 'consumed', consumedAt: new Date() },
            and(
                eq(deviceLinks.deviceCodeHash, deviceCodeHash),
                eq(deviceLinks.status, 'approved'),
                notExpired(),
                this.issuerKeyLive(true),
            ),
        );
    }

    /**
     * Expire the live link a key issued, so a fresh issue leaves one link per key.
     *
     * @returns the rows this call expired
     */
    async expireLiveByIssuerKey(issuerKeyId: string): Promise<DeviceLink[]>
    {
        return this.expireLive(eq(deviceLinks.issuerKeyId, issuerKeyId));
    }

    /**
     * Expire every link an account still has in play — the device-link half of a
     * global revocation, beside `DeviceAuthorizationsRepository.denyAllActiveByUserId`.
     *
     * A revoke-all that spares the calling device spares its key too, so the
     * issuing-key condition alone would leave that device's link able to let a
     * new device in seconds after the owner signed everything else out.
     *
     * @returns the rows this call expired
     */
    async expireAllLiveByUserId(userId: number): Promise<DeviceLink[]>
    {
        return this.expireLive(eq(deviceLinks.issuerUserId, userId));
    }

    private async expireLive(owner: SQL): Promise<DeviceLink[]>
    {
        const expired = await this.db
            .update(deviceLinks)
            .set({ status: 'expired' })
            .where(and(owner, inArray(deviceLinks.status, LIVE_STATUSES)))
            .returning();

        announceDeviceLinkMoved(expired.map(link => link.id));

        return expired;
    }

    /** Apply one conditional UPDATE, wake the waiters of the row it moved, and hand the row back. */
    private async transition(values: Partial<NewDeviceLink>, where: SQL | undefined): Promise<DeviceLink | null>
    {
        const result = await this.db
            .update(deviceLinks)
            .set(values)
            .where(where)
            .returning();

        const moved = result[0] ?? null;

        if (moved)
        {
            announceDeviceLinkMoved([moved.id]);
        }

        return moved;
    }

    /** One link with its issuing key's standing. */
    private async findOne(where: SQL): Promise<DeviceLinkRecord | null>
    {
        // primary read: every caller decides from this who may see or answer a
        // link and whether a key may be parked or registered, and a replica one
        // commit behind would show a cancelled link or a revoked key as good.
        const result = await this.db
            .select({ ...getTableColumns(deviceLinks), issuerKeyLive: this.issuerKeyLive(false) })
            .from(deviceLinks)
            .where(where)
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Whether the link's issuing key is still registered to its issuer, active
     * and unexpired — the test `authenticate` applies to the same row.
     *
     * @param lock take a share lock on the key row, so a transition waits for a
     *   revocation in flight instead of judging the version before it
     */
    private issuerKeyLive(lock: boolean): SQL<boolean>
    {
        const key = this.db
            .select({ one: sql`1` })
            .from(userPublicKeys)
            .where(
                and(
                    eq(userPublicKeys.keyId, deviceLinks.issuerKeyId),
                    eq(userPublicKeys.userId, deviceLinks.issuerUserId),
                    eq(userPublicKeys.isActive, true),
                    or(isNull(userPublicKeys.expiresAt), gt(userPublicKeys.expiresAt, sql`now()`)),
                ),
            );

        return sql<boolean>`${exists(lock ? key.for('share') : key)}`;
    }
}

// Default instance export
export const deviceLinksRepository = new DeviceLinksRepository();
