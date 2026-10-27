/**
 * Process-wide close of the SSE streams one device key opened
 *
 * Every `createSSEHandler` registers its connection registry here, so a key
 * revocation reaches every handler of the process (two routers, tests) — the
 * local half of `closeSSEConnectionsByKey`. The cross-pod half lives in the
 * cache transport, which calls `applyKeyClose` for a close another pod
 * published; this module imports nothing from it, so the two never cycle.
 */

import { logger } from '@spfn/core/logger';
import type { ConnectionRegistry } from './connection-registry';

const keyCloseLogger = logger.child('@spfn/core:sse');

/** What this module needs of a registry. */
type KeyClosable = Pick<ConnectionRegistry, 'closeByKey'>;

const REGISTRIES_KEY = Symbol.for('@spfn/core:sse-key-close-registries');

// globalThis, like the event transport: one set per process across the CJS/ESM dual package.
const registries: Set<KeyClosable> = ((globalThis as any)[REGISTRIES_KEY] ??= new Set<KeyClosable>());

/** Let `applyKeyClose` reach one handler's connections. */
export function registerKeyCloseRegistry(registry: KeyClosable): void
{
    registries.add(registry);
}

/**
 * Close, on this process, every open SSE stream whose token was minted with
 * `keyId`, and stop its pending connects from opening. Answers how many open
 * streams it closed. Logs the count and reason only — never the key id.
 */
export function applyKeyClose(keyId: string): number
{
    let closed = 0;
    registries.forEach(registry =>
    {
        closed += registry.closeByKey(keyId);
    });

    if (closed > 0)
    {
        keyCloseLogger.info('SSE connections closed', { count: closed, reason: 'key revoked' });
    }
    else
    {
        keyCloseLogger.debug('SSE key close reached no open connection', { reason: 'key revoked' });
    }

    return closed;
}
