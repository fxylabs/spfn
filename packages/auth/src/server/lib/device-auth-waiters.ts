/**
 * @spfn/auth - Device-code answer notifications
 *
 * What lets a device-code long poll return the moment its record is answered
 * instead of at its next recheck. An approve, a deny or a global revocation
 * wakes every poll parked under the ids it moved.
 *
 * The mechanism — in-process, woken after commit, a speed-up the poll's own
 * recheck (`WAIT_RECHECK_MS` in the service) backs up — is `answer-waiters.ts`,
 * shared with device link. This module is device-code login's own set of it.
 */

import { createAnswerWaiters } from './answer-waiters';

const waiters = createAnswerWaiters();

/** Wake every poll parked on these records once the current transaction commits. */
export function announceDeviceAuthAnswered(ids: number[]): void
{
    waiters.announce(ids);
}

/** Park until the record is answered, `timeoutMs` passes, or the caller hangs up. Never rejects. */
export function waitForDeviceAuthAnswer(id: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
{
    return waiters.wait(id, timeoutMs, signal);
}

/** How many polls are inside a wait on one record right now. */
export function waitingOnDeviceAuth(id: number): number
{
    return waiters.waiting(id);
}

/** Count a poll into a wait on `id`, for as long as `wait` runs. */
export function holdDeviceAuthWait<T>(id: number, wait: () => Promise<T>): Promise<T>
{
    return waiters.hold(id, wait);
}

/** Records with a poll parked on them, plus records with a wait in progress. For tests. */
export function parkedDeviceAuthCount(): number
{
    return waiters.parkedCount();
}
