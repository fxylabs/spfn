/**
 * @spfn/auth - Device Registration Announcement
 *
 * One helper, called from the two places a `user_public_keys` row is created:
 * `registerPublicKeyService`, which seven of the eight registration paths go
 * through, and `acceptInvitation`, which stores its key directly because the row
 * is written before the user row it belongs to has committed.
 *
 * Both call this rather than emitting for themselves, so the payload is built
 * once and the after-commit rule holds in one place instead of two.
 */

import { onAfterCommit } from '@spfn/core/db';

import type { UserPublicKey } from '../entities/user-public-keys';
import { authDeviceRegisteredEvent, type DeviceRegistrationChannel } from '../events';
import { mfaEnrolledForUser } from './mfa.service';

/**
 * How much of the fingerprint the event carries.
 *
 * Longer than the eight `listKeys` returns, because a notice is read on its own:
 * the prefix has to be enough to find the matching entry in a device list, not
 * just to tell two entries of one list apart. The full value stays on the
 * server — it is what a native sign-in signs as its nonce.
 */
export const DEVICE_EVENT_FINGERPRINT_PREFIX_LENGTH = 12;

/**
 * Announce a newly registered device key, after the transaction that wrote it.
 *
 * `onAfterCommit` and never a bare emit: every registration route runs under
 * `Transactional()`, so an inline emit would announce a device that a rollback
 * then erased — `completePasswordResetService` throws after writing its key row
 * when it loses the claim race, and a device-code poll can roll back the same
 * way. Outside a transaction the callback runs immediately, and a subscriber
 * that throws is logged rather than failing the registration.
 *
 * @param row - The key row as it was written
 * @param channel - Which door the device came through
 * @param mfaEnrolled - Read here rather than by the subscriber, so the notice
 *     can say whether this account has a second factor yet (#95)
 */
export async function emitDeviceRegistered(
    row: UserPublicKey,
    channel: DeviceRegistrationChannel,
): Promise<void>
{
    // Read before the callback is queued, not inside it. The queue fires
    // without awaiting, so an async callback would deliver a tick later than
    // every consumer expects — and the value is the same either way, since the
    // read runs in the transaction that wrote the key row.
    const mfaEnrolled = await mfaEnrolledForUser(row.userId);

    onAfterCommit(() => authDeviceRegisteredEvent.emit({
        userId: String(row.userId),
        keyId: row.keyId,
        algorithm: row.algorithm,
        fingerprintPrefix: row.fingerprint.slice(0, DEVICE_EVENT_FINGERPRINT_PREFIX_LENGTH),
        deviceName: row.deviceName ?? undefined,
        platform: row.platform ?? undefined,
        ip: row.registeredIp ?? undefined,
        userAgent: row.registeredUserAgent ?? undefined,
        createdAtMillis: row.createdAt.getTime(),
        channel,
        mfaEnrolled,
    }));
}
