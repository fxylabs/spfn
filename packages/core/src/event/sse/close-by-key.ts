/**
 * `closeSSEConnectionsByKey` — the public close, local and cross-pod
 *
 * Imports both halves: `key-close` (this process) and the cache transport
 * (every other pod). Neither imports this module, so `check:circular` stays clean.
 */

import { publishKeyClose, resolveEventPubSubCache } from '../cache-transport';
import { applyKeyClose } from './key-close';

/**
 * Close every SSE stream opened with a token minted for device key `keyId`,
 * on this pod and — when a cache (`CACHE_URL`) is configured — on every other
 * pod, through the event transport's control channel. A connect of that key
 * still in admission never opens. Untagged streams (no key) are never closed.
 *
 * Resolves once the local close is done and the publish settled; a failed
 * publish is warned and swallowed, never thrown. `@spfn/auth` calls it after
 * a key revocation commits. A close this pod cannot publish while the
 * transport's breaker is open, or whose publish fails, is re-sent when the
 * breaker cooldown ends and whenever the next publish succeeds; while it is
 * pending, the key's streams on other pods stay open. A held close is lost
 * only when the Redis outage outlasts this pod (its shutdown disposes held
 * closes) or when more than 1000 closes are held (the oldest are dropped);
 * those streams then stay open until they disconnect, and their next token
 * mint is refused.
 *
 * @example
 * ```typescript
 * import { closeSSEConnectionsByKey } from '@spfn/core/event/sse';
 * import { onAfterCommit } from '@spfn/core/db';
 *
 * onAfterCommit(() => closeSSEConnectionsByKey(revoked.keyId));
 * ```
 */
export async function closeSSEConnectionsByKey(keyId: string): Promise<void>
{
    applyKeyClose(keyId);

    const cache = await resolveEventPubSubCache();
    if (cache)
    {
        await publishKeyClose(cache, keyId);
    }
}
