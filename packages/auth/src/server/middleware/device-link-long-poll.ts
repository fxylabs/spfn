/**
 * @spfn/auth - Device-link long polls
 *
 * The waiting halves of `POST /_auth/device/link/status` (the issuer) and
 * `POST /_auth/device/link/poll` (the new device) with `waitMillis`, run as route
 * middleware between the rate limit and the judgement — ahead of
 * `Transactional()` where the route has one — for the reasons
 * `device-auth-long-poll.ts` gives: nothing is held while waiting, and the
 * judgement that follows runs exactly as a request without `waitMillis` does.
 *
 * The body is read through `c.req.json()`, the cached read the route's own
 * parsing uses, and not validated here: a body that is not the shape this needs
 * skips the wait, and the handler's validation refuses it as it always would.
 */

import type { Context, MiddlewareHandler } from 'hono';

import { getOptionalAuth } from '../helpers/context';
import { waitForDeviceLinkAnswerService, waitForDeviceLinkStatusService } from '../services/device-link.service';

/** Context key the handlers read to take the time already waited off `intervalMillis`. */
export const DEVICE_LINK_WAITED_MILLIS = 'deviceLinkWaitedMillis';

/** Hold the issuer's status request while its link waits on the other device. */
export function deviceLinkStatusLongPoll(): MiddlewareHandler
{
    return longPoll(async (c, body, waitMillis, signal) =>
    {
        const auth = getOptionalAuth(c);

        if (typeof body.linkId !== 'string' || !auth)
        {
            return 0;
        }

        return waitForDeviceLinkStatusService({
            linkId: body.linkId,
            issuer: { userId: Number(auth.userId), keyId: auth.keyId },
            waitMillis,
            signal,
        });
    });
}

/** Hold the new device's poll while its link waits on the issuer's pick. */
export function deviceLinkPollLongPoll(): MiddlewareHandler
{
    return longPoll(async (_c, body, waitMillis, signal) =>
    {
        if (typeof body.deviceCode !== 'string')
        {
            return 0;
        }

        return waitForDeviceLinkAnswerService({ deviceCode: body.deviceCode, waitMillis, signal });
    });
}

type Wait = (c: Context, body: Record<string, unknown>, waitMillis: number, signal: AbortSignal) => Promise<number>;

function longPoll(wait: Wait): MiddlewareHandler
{
    return async (c, next) =>
    {
        const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        const { waitMillis } = body;

        if (!Number.isInteger(waitMillis) || (waitMillis as number) <= 0)
        {
            return next();
        }

        const signal = c.req.raw.signal;
        const waitedMillis = await wait(c, body, waitMillis as number, signal);

        // The caller hung up. Nobody will read this answer, so the link is not
        // judged: an approval judged now would spend the link and register a key
        // for a device that never learns it got in.
        if (signal.aborted)
        {
            return c.body(null, 204);
        }

        c.set(DEVICE_LINK_WAITED_MILLIS, waitedMillis);

        return next();
    };
}
