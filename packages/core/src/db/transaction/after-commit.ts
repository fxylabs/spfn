/**
 * Starting an after-commit callback
 *
 * An after-commit callback runs detached: the transaction's caller has its
 * result and the request may have answered before the callback is done. That
 * makes it work the process accepted and has not finished — what a graceful
 * shutdown's drain is for — so each one is tracked by the shutdown manager
 * from the moment it starts until it settles. A callback started while the
 * drain is waiting (its transaction committed during the drain) is tracked
 * too, and the drain waits for it.
 */

import { getShutdownManager } from '../../server/shutdown-manager';

/**
 * Run `callback` on the next microtask, detached from the caller, with its
 * failure handed to `onError`; a graceful shutdown's drain waits for it
 */
export function startAfterCommitCallback(callback: () => unknown, onError: (error: unknown) => void): void
{
    getShutdownManager().trackDetached('after-commit', Promise.resolve().then(callback).catch(onError));
}
