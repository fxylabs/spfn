/**
 * @spfn/auth - Device-code long poll
 *
 * The waiting half of `POST /_auth/device/poll` with `waitMillis`, run as route
 * middleware between the rate limit and `Transactional()`.
 *
 * Here and not in the handler because of what `Transactional()` is. It holds a
 * pooled connection for as long as the handler runs, so a wait inside it would
 * pin one connection per waiting device. And it is also where a database error
 * becomes the answer a client can read — a unique violation a 409, a lost
 * connection a 503 and a reconnect — so the judgement must stay inside it. A wait
 * placed before it keeps both: nothing held while waiting, and the judgement that
 * follows runs exactly as a poll without `waitMillis` does.
 *
 * The body is read here only to find what to wait on, through `c.req.json()` —
 * the same cached read the route layer's own parsing uses, so the body is read
 * and parsed once whoever asks first. It is not validated here: a body that is
 * not the shape this needs skips the wait, and the handler's own validation
 * refuses it with the error it always gave.
 */

import type { MiddlewareHandler } from 'hono';

import { waitForDeviceAuthAnswerService } from '../services/device-auth.service';

/** Context key the handler reads to take the time already waited off `intervalMillis`. */
export const DEVICE_AUTH_WAITED_MILLIS = 'deviceAuthWaitedMillis';

export function deviceAuthLongPoll(): MiddlewareHandler
{
    return async (c, next) =>
    {
        const target = waitTarget(await c.req.json().catch(() => null));

        if (!target)
        {
            return next();
        }

        const signal = c.req.raw.signal;
        const waitedMillis = await waitForDeviceAuthAnswerService({ ...target, signal });

        // The device hung up. Nobody will read this answer, so the record is not
        // judged: an approval judged now would spend the code and register a key
        // for a device that never learns it got in, and whose next poll is told
        // the code does not exist. Left alone, the approval waits for that poll.
        if (signal.aborted)
        {
            return c.body(null, 204);
        }

        c.set(DEVICE_AUTH_WAITED_MILLIS, waitedMillis);

        return next();
    };
}

/** `deviceCode` and a positive whole `waitMillis`, or null for "do not wait". */
function waitTarget(body: unknown): { deviceCode: string; waitMillis: number } | null
{
    const { deviceCode, waitMillis } = (body ?? {}) as Record<string, unknown>;

    if (typeof deviceCode !== 'string' || !Number.isInteger(waitMillis) || (waitMillis as number) <= 0)
    {
        return null;
    }

    return { deviceCode, waitMillis: waitMillis as number };
}
