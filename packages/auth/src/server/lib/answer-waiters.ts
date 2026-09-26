/**
 * @spfn/auth - Long-poll answer notifications
 *
 * What lets a long poll return the moment its record moves instead of at its
 * next recheck. A waiting poll parks a resolver here under the record's id, and
 * a transition wakes every resolver parked under the ids it moved.
 *
 * In-process only, and a speed-up rather than a guarantee. A poll parked on one
 * instance is not woken by a transition committed on another, and a wake can be
 * lost to anything that restarts a process — so a poll never trusts this to be
 * the only way it learns an answer. It rechecks the row on its own cadence, and
 * a missed wake costs at most that.
 *
 * The wake is sent after commit, never inline. A waiter woken before the
 * transition commits re-reads the row, still sees the old state, and parks again
 * — nothing wrong happens, but the wake was wasted. A transition that rolls back
 * sends none, which is the only correct answer: nothing was decided.
 *
 * One set per table, because ids are only unique within one: device-code login
 * and device link each create their own with `createAnswerWaiters()`.
 */

import { onAfterCommit } from '@spfn/core/db';

export interface AnswerWaiters
{
    /**
     * Wake every poll parked on these records once the current transaction
     * commits. Outside a transaction `onAfterCommit` runs the callback at once,
     * which is the same moment: there is nothing left to commit.
     */
    announce(ids: number[]): void;

    /**
     * Park until the record is answered, `timeoutMs` passes, or the caller hangs up.
     *
     * Always resolves, never rejects: which of the three happened is not this
     * function's to report. The caller re-reads the row afterwards and the row is
     * the answer — a wake only says "look now".
     */
    wait(id: number, timeoutMs: number, signal?: AbortSignal): Promise<void>;

    /** How many polls are inside a wait on one record right now. */
    waiting(id: number): number;

    /** Count a poll into a wait on `id`, for as long as `wait` runs. */
    hold<T>(id: number, wait: () => Promise<T>): Promise<T>;

    /** Records with a poll parked on them, plus records with a wait in progress. For tests. */
    parkedCount(): number;
}

export function createAnswerWaiters(): AnswerWaiters
{
    const parkedById = new Map<number, Set<() => void>>();

    /**
     * Polls inside a wait on each record, counted from the start of the wait to
     * its end — including the moments between two parks, when the poll is
     * re-reading the row and holds no resolver. A per-record cap reads this, not
     * the parked set, so a poll arriving during a re-read cannot slip past it.
     */
    const waitingById = new Map<number, number>();

    function wake(id: number): void
    {
        const parked = parkedById.get(id);

        if (!parked)
        {
            return;
        }

        parkedById.delete(id);

        for (const resolve of parked)
        {
            resolve();
        }
    }

    /**
     * Drop one resolver, and the record's entry with it once nobody is left — the
     * map must not keep an id for every record that was ever polled.
     */
    function unpark(id: number, parked: Set<() => void>, resolver: () => void): void
    {
        parked.delete(resolver);

        if (parked.size === 0 && parkedById.get(id) === parked)
        {
            parkedById.delete(id);
        }
    }

    function announce(ids: number[]): void
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

    function wait(id: number, timeoutMs: number, signal?: AbortSignal): Promise<void>
    {
        if (signal?.aborted)
        {
            return Promise.resolve();
        }

        return new Promise((resolve) =>
        {
            const parked = parkedById.get(id) ?? new Set<() => void>();

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
            parkedById.set(id, parked);
        });
    }

    function waiting(id: number): number
    {
        return waitingById.get(id) ?? 0;
    }

    async function hold<T>(id: number, run: () => Promise<T>): Promise<T>
    {
        waitingById.set(id, waiting(id) + 1);

        try
        {
            return await run();
        }
        finally
        {
            const left = waiting(id) - 1;

            if (left > 0)
            {
                waitingById.set(id, left);
            }
            else
            {
                waitingById.delete(id);
            }
        }
    }

    return {
        announce,
        wait,
        waiting,
        hold,
        parkedCount: () => parkedById.size + waitingById.size,
    };
}
