/**
 * Device Link Configuration
 *
 * Singleton config for device link, set once during `createAuthLifecycle()` and
 * read at request time, as `device-auth-config.ts` is.
 *
 * One knob of its own. The poll interval and the long-poll cap are device-code
 * login's (`deviceAuth.intervalMs`, `deviceAuth.maxWaitMs`): both flows wait the
 * same way, behind the same proxies, so two settings for one idle timeout would
 * only be two chances to get it wrong.
 */

export interface AuthDeviceLinkConfig
{
    /** How long a link code stays usable, in milliseconds. */
    ttlMs: number;
}

/**
 * Five minutes. Half of device-code login's ten, because the code is on the
 * issuer's own screen and the new device is in the same hand: there is no walk
 * to another room, and a code left showing on a desk is worth less the sooner
 * it dies.
 */
export const DEFAULT_DEVICE_LINK_TTL_MS = 5 * 60 * 1000;

let config: AuthDeviceLinkConfig = {
    ttlMs: DEFAULT_DEVICE_LINK_TTL_MS,
};

/**
 * Set the resolved device-link config. Called synchronously from
 * `createAuthLifecycle()` beside `configureDeviceAuth`, so it takes effect before
 * any handler can run.
 *
 * `ttlMs` leaves as `expiresAtMillis`, an integer in the issue and redeem
 * answers, so a value that is not a positive whole number of milliseconds is
 * refused here rather than served.
 */
export function configureDeviceLink(options?: Partial<AuthDeviceLinkConfig>): void
{
    const ttlMs = options?.ttlMs ?? DEFAULT_DEVICE_LINK_TTL_MS;

    if (!Number.isInteger(ttlMs) || ttlMs <= 0)
    {
        throw new Error(`deviceLink.ttlMs must be a positive whole number of milliseconds, received ${ttlMs}.`);
    }

    config = { ttlMs };
}

/** Read the current device-link config. Defaults apply until `configureDeviceLink` runs. */
export function getDeviceLinkConfig(): AuthDeviceLinkConfig
{
    return config;
}
