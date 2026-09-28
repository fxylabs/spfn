/**
 * @spfn/notification - Push Device Service
 *
 * The token store behind push. The package has no auth dependency: the app
 * calls these from its own authenticated routes and passes its user id as
 * `ownerId`.
 */

import { getDatabase } from '@spfn/core/db';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
    pushDevices,
    type PushDevice,
    type PushPlatform,
    type PushInvalidationReason,
} from '../entities';

export interface RegisterPushDeviceParams
{
    ownerId: string;
    token: string;
    platform: PushPlatform;
    /**
     * App-side device key. Pass it when the app has one, so a rotated token
     * replaces the old one instead of leaving two active tokens on one device.
     */
    deviceId?: string;
    locale?: string;
}

/**
 * Which of an owner's active devices a push goes to. The default is all of
 * them; the consumer narrows it. Serializable, so a scheduled push can carry
 * it and resolve devices when it runs.
 */
export type PushDeviceSelector = 'all' | {
    platforms?: PushPlatform[];
    deviceIds?: string[];
    /**
     * Only the N most recently seen devices (`latest: 1` = the device the
     * owner used last)
     */
    latest?: number;
};

/**
 * Register (or refresh) a device's token for an owner.
 *
 * - A token already registered moves to this owner: a shared device that
 *   signs in as someone else must stop receiving the previous owner's pushes.
 * - An invalidated token is reactivated.
 * - With `deviceId`, any other active token on that device is retired
 *   (`replaced`), whoever owned it.
 */
export async function registerPushDevice(params: RegisterPushDeviceParams): Promise<PushDevice>
{
    return getDatabase('write').transaction(async (tx) =>
    {
        if (params.deviceId !== undefined)
        {
            // Two registrations for one device (startup and token refresh) run
            // one after the other; otherwise neither sees the other's row and
            // the second hits the one-active-token-per-device index.
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`spfn_push_device:${params.deviceId}`}))`);

            await tx.update(pushDevices)
                .set({ invalidatedAt: new Date(), invalidatedReason: 'replaced' })
                .where(and(
                    eq(pushDevices.deviceId, params.deviceId),
                    ne(pushDevices.token, params.token),
                    isNull(pushDevices.invalidatedAt),
                ));
        }

        const values = {
            ownerId: params.ownerId,
            token: params.token,
            platform: params.platform,
            deviceId: params.deviceId ?? null,
            locale: params.locale ?? null,
            lastSeenAt: new Date(),
            invalidatedAt: null,
            invalidatedReason: null,
        };

        const [device] = await tx.insert(pushDevices)
            .values(values)
            .onConflictDoUpdate({ target: pushDevices.token, set: values })
            .returning();

        return device;
    });
}

/**
 * Stop sending to a token (sign-out, notifications turned off). An unknown or
 * already inactive token is a no-op. The row stays, so history keeps its link.
 */
export async function unregisterPushDevice(token: string): Promise<void>
{
    await invalidatePushToken(token, 'unregistered');
}

/**
 * Mark a token dead. Called by the send path when FCM reports it.
 */
export async function invalidatePushToken(token: string, reason: PushInvalidationReason): Promise<void>
{
    await getDatabase('write')
        .update(pushDevices)
        .set({ invalidatedAt: new Date(), invalidatedReason: reason })
        .where(and(eq(pushDevices.token, token), isNull(pushDevices.invalidatedAt)));
}

/**
 * An owner's active devices, most recently seen first, narrowed by the
 * selector.
 */
export async function listPushDevices(
    ownerId: string,
    selector: PushDeviceSelector = 'all',
): Promise<PushDevice[]>
{
    const narrow = selector === 'all' ? {} : selector;
    const conditions = [eq(pushDevices.ownerId, ownerId), isNull(pushDevices.invalidatedAt)];

    if (narrow.platforms)
    {
        conditions.push(inArray(pushDevices.platform, narrow.platforms));
    }

    if (narrow.deviceIds)
    {
        conditions.push(inArray(pushDevices.deviceId, narrow.deviceIds));
    }

    const query = getDatabase('write')
        .select()
        .from(pushDevices)
        .where(and(...conditions))
        .orderBy(desc(pushDevices.lastSeenAt), desc(pushDevices.id));

    return narrow.latest === undefined ? query : query.limit(narrow.latest);
}

/**
 * The device row for a token, if one is registered
 */
export async function findPushDeviceByToken(token: string): Promise<PushDevice | null>
{
    const [device] = await getDatabase('write')
        .select()
        .from(pushDevices)
        .where(sql`${pushDevices.token} = ${token}`)
        .limit(1);

    return device ?? null;
}
