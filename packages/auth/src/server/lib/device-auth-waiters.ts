/**
 * @spfn/auth - Device-code answer notifications
 *
 * What lets a long poll return the moment its record is answered instead of at
 * its next recheck. A waiting poll parks a resolver here under the record's id,
 * and an approve, a deny or a global revocation wakes every resolver parked
 * under the ids it moved.
 *
 * In-process only, and a speed-up rather than a guarantee. A poll parked on one
 * instance is not woken by an approval committed on another, and a wake can be
 * lost to anything that restarts a process — so the poll never trusts this to be
 * the only way it learns an answer. It rechecks the row on its own cadence
 * (`WAIT_RECHECK_MS` in the service), and a missed wake costs at most that.
 *
 * The wake is sent after commit, never inline. A waiter woken before the
 * transition commits re-reads the row, still sees `pending`, and parks again —
 * nothing wrong happens, but the wake was wasted. A transition that rolls back
 * sends none, which is the only correct answer: nothing was decided.
 */

import { onAfterCommit } from '@spfn/core/db';

const waiters = new Map<number, Set<() => void>>();

/**
 * Wake every poll parked on these records once the current transaction commits.
 * Outside a transaction `onAfterCommit` runs the callback at once, which is the
 * same moment: there is nothing left to commit.
 */
export function announceDeviceAuthAnswered(ids: number[]): void
{
    if (ids.length === 0)
    {
        return;
    }

    onAfterCommit(() =>
    {
        for (const id of ids)
        {
            wake(id);
        }
    });
}

function wake(id: number): void
{
    const parked = waiters.get(id);

    if (!parked)
    {
        return;
    }

    waiters.delete(id);

    for (const resolve of parked)
    {
        resolve();
    }
}

/**
 * Park until the record is answered, `timeoutMs` passes, or the caller hangs up.
 *
 * Always resolves, never rejects: which of the three happened is not this
 * function's to report. The caller re-reads the row afterwards and the row is
 * the answer — a wake only says "look now".
 */
export function waitForDeviceAuthAnswer(id: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
{
    if (signal?.aborted)
    {
        return Promise.resolve();
    }

    return new Promise((resolve) =>
    {
        const parked = waiters.get(id) ?? new Set<() => void>();

        const done = () =>
        {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            unpark(id, parked, done);
            resolve();
        };

        const timer = setTimeout(done, timeoutMs);

        signal?.addEventListener('abort', done, { once: true });
        parked.add(done);
        waiters.set(id, parked);
    });
}

/**
 * Drop one resolver, and the record's entry with it once nobody is left — the
 * map must not keep an id for every code that was ever polled.
 */
function unpark(id: number, parked: Set<() => void>, resolver: () => void): void
{
    parked.delete(resolver);

    if (parked.size === 0 && waiters.get(id) === parked)
    {
        waiters.delete(id);
    }
}

/**
 * Polls inside a wait on each record, counted from the start of the wait to its
 * end — including the moments between two parks, when the poll is re-reading
 * the row and holds no resolver. The per-record cap reads this, not the parked
 * set, so a poll arriving during a re-read cannot slip past it.
 */
const waiting = new Map<number, number>();

/** How many polls are inside a wait on one record right now. */
export function waitingOnDeviceAuth(id: number): number
{
    return waiting.get(id) ?? 0;
}

/** Count a poll into a wait on `id`, for as long as `wait` runs. */
export async function holdDeviceAuthWait<T>(id: number, wait: () => Promise<T>): Promise<T>
{
    waiting.set(id, waitingOnDeviceAuth(id) + 1);

    try
    {
        return await wait();
    }
    finally
    {
        const left = waitingOnDeviceAuth(id) - 1;

        if (left > 0)
        {
            waiting.set(id, left);
        }
        else
        {
            waiting.delete(id);
        }
    }
}

/** Records with a poll parked on them, plus records with a wait in progress. For tests. */
export function parkedDeviceAuthCount(): number
{
    return waiters.size + waiting.size;
}
