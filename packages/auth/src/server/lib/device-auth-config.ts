/**
 * Device-code Login Configuration
 *
 * Singleton config for device-code login, mirroring `lib/deletion-config.ts`: a
 * mutable module-level value, set once during `createAuthLifecycle()` and read at
 * request time.
 *
 * Both knobs are answers the server hands to a client that cannot ask again — the
 * waiting device is told its expiry and its poll interval in the `start` response
 * and then just obeys them — so they have to be resolved before any request is
 * served, not read from an environment variable at each use.
 */

export interface AuthDeviceAuthConfig
{
    /** How long a device code stays usable, in milliseconds. */
    ttlMs: number;

    /** How long the waiting device should wait between polls, in milliseconds. */
    intervalMs: number;

    /** The longest a poll that asks to wait (`waitMillis`) is held open, in milliseconds. */
    maxWaitMs: number;
}

/**
 * Ten minutes. Long enough to walk to the other device and type the code, short
 * enough that a code glimpsed over a shoulder is worthless soon after.
 */
export const DEFAULT_DEVICE_AUTH_TTL_MS = 10 * 60 * 1000;

/** Five seconds. The interval the server asks for; the rate limit is what enforces it. */
export const DEFAULT_DEVICE_AUTH_INTERVAL_MS = 5 * 1000;

/**
 * Twenty seconds. Load balancers commonly close a request that has sent nothing
 * for 30 seconds (Google Cloud's backend service default among them), and a long
 * poll cut off there reaches the device as a network error rather than as a
 * pending answer. Twenty leaves room under that for the request's own work.
 */
export const DEFAULT_DEVICE_AUTH_MAX_WAIT_MS = 20 * 1000;

let config: AuthDeviceAuthConfig = {
    ttlMs: DEFAULT_DEVICE_AUTH_TTL_MS,
    intervalMs: DEFAULT_DEVICE_AUTH_INTERVAL_MS,
    maxWaitMs: DEFAULT_DEVICE_AUTH_MAX_WAIT_MS,
};

/**
 * Set the resolved device-auth config. Called synchronously from
 * `createAuthLifecycle()` for the same reason `configureDeletion` is: it must
 * take effect before any handler that reads `getDeviceAuthConfig()` can run.
 *
 * Every knob is a whole millisecond count, and one that is not is refused here
 * rather than served. `intervalMs` is the reason the check exists: it leaves as
 * `intervalMillis` in the start and poll answers, which `DeviceAuthPollResponseSchema`
 * declares an integer and the mobile contract exports as one, so a fractional
 * value configured here would reach a generated client as a number its decoder
 * refuses — at the one moment the flow depends on that client asking again.
 */
export function configureDeviceAuth(options?: Partial<AuthDeviceAuthConfig>): void
{
    const ttlMs = options?.ttlMs ?? DEFAULT_DEVICE_AUTH_TTL_MS;
    const intervalMs = options?.intervalMs ?? DEFAULT_DEVICE_AUTH_INTERVAL_MS;
    const maxWaitMs = options?.maxWaitMs ?? DEFAULT_DEVICE_AUTH_MAX_WAIT_MS;

    assertWholeMillis('ttlMs', ttlMs);
    assertWholeMillis('intervalMs', intervalMs);
    assertWholeMillis('maxWaitMs', maxWaitMs);

    config = { ttlMs, intervalMs, maxWaitMs };
}

function assertWholeMillis(name: string, value: number): void
{
    if (!Number.isInteger(value) || value <= 0)
    {
        throw new Error(
            `deviceAuth.${name} must be a positive whole number of milliseconds, received ${value}.`,
        );
    }
}

/**
 * Read the current device-auth config. Safe to call any time — defaults apply
 * even if `createAuthLifecycle()` was never given a `deviceAuth` block.
 */
export function getDeviceAuthConfig(): AuthDeviceAuthConfig
{
    return config;
}
