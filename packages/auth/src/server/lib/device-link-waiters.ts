/**
 * @spfn/auth - Device-link answer notifications
 *
 * Device link has two parties waiting on one record: the issuer long-polls
 * `status` until a device redeems its code (and again until that device has
 * collected its login), and the redeeming device long-polls `poll` until the
 * issuer answers. Every transition of a link wakes both, after commit — each
 * re-reads the row and keeps waiting if the move was not the one it waits for.
 *
 * The mechanism is `answer-waiters.ts`, shared with device-code login; this is
 * device link's own set of it, since the two tables number their rows apart.
 */

import { createAnswerWaiters } from './answer-waiters';

const waiters = createAnswerWaiters();

/** Wake every status or poll parked on these links once the current transaction commits. */
export function announceDeviceLinkMoved(ids: number[]): void
{
    waiters.announce(ids);
}

/** Park until the link moves, `timeoutMs` passes, or the caller hangs up. Never rejects. */
export function waitForDeviceLinkMove(id: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
{
    return waiters.wait(id, timeoutMs, signal);
}

/** How many requests — issuer's and device's together — are inside a wait on one link. */
export function waitingOnDeviceLink(id: number): number
{
    return waiters.waiting(id);
}

/** Count a request into a wait on `id`, for as long as `wait` runs. */
export function holdDeviceLinkWait<T>(id: number, wait: () => Promise<T>): Promise<T>
{
    return waiters.hold(id, wait);
}

/** Links with a request parked on them, plus links with a wait in progress. For tests. */
export function parkedDeviceLinkCount(): number
{
    return waiters.parkedCount();
}
