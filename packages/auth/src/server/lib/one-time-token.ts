/**
 * One-Time Token Manager
 *
 * Singleton wrapper around SSETokenManager for one-time token authentication.
 * Used for direct API access (file uploads, SSE streaming, etc.) bypassing RPC proxy.
 */

import { SSETokenManager } from '@spfn/core/event/sse';
import type { SSETokenStore } from '@spfn/core/event/sse';
import { admitPrincipal } from '../services/admission.service';
import { optionKeys, readOptions } from './stated-options';

/** What `initOneTimeTokenManager` reads: `createAuthLifecycle`'s `oneTimeToken`. */
export interface OneTimeTokenOptions
{
    ttl?: number;
    store?: SSETokenStore;
}

let manager: SSETokenManager | null = null;

/**
 * Initialize the one-time token manager
 *
 * Called during auth lifecycle initialization.
 * Creates a singleton SSETokenManager instance.
 *
 * @param config - Optional configuration
 * @param config.ttl - Token time-to-live in milliseconds (default: 30000)
 * @param config.store - Custom token store (e.g., CacheTokenStore for Redis)
 *
 * A token is minted for a device key (`/_auth/tokens` and the SSE and WS token
 * endpoints tag it with the caller's key) and is refused at consume unless the
 * person it was minted for is admitted on that key now (`admitPrincipal`): a
 * token minted just before a revocation, or a suspension, cannot open a
 * stream after it.
 *
 * `config` is read once, by `readOptions`: a plain object whose every own
 * name is `ttl` or `store` (#477).
 */
export function initOneTimeTokenManager(config?: OneTimeTokenOptions): void
{
    if (manager)
    {
        manager.destroy();
    }

    const read = config === undefined ? {} : readOptions<OneTimeTokenOptions>('oneTimeToken', config, optionKeys<OneTimeTokenOptions>({ ttl: true, store: true }));

    manager = new SSETokenManager({
        ttl: read.ttl,
        store: read.store,
        verifyKey: admitsTokenHolder,
    });
}

/**
 * Whether the person a token was minted for is admitted on the key that
 * minted it — the one admission every door asks, with a `oneTimeToken`
 * credential: the key live, the account active, the second-factor policy.
 * Read on the primary: a key revoked a moment ago may still read active on a
 * replica.
 *
 * The person is the key holder the issuer recorded beside the key tag (core's
 * token endpoints record the `AuthContext` user id, `issueOneTimeTokenService`
 * the caller's), never a parse of the subject, which an app shapes with
 * `getSubject`. A tagged token with no holder recorded is refused.
 */
async function admitsTokenHolder(keyId: string, _subject: string, keyHolder: string | undefined): Promise<boolean>
{
    const userId = Number(keyHolder);

    if (!keyHolder || !Number.isSafeInteger(userId))
    {
        return false;
    }

    const admission = await admitPrincipal({
        userId,
        credential: { kind: 'oneTimeToken', issuedByKeyId: keyId },
        route: null,
        presentedOn: null,
    });

    return 'admitted' in admission;
}

/**
 * Get the one-time token manager instance
 *
 * @throws Error if initOneTimeTokenManager() has not been called
 *
 * @example
 * ```typescript
 * import { getOneTimeTokenManager } from '@spfn/auth/server';
 *
 * // Use as SSE tokenManager
 * .eventsConfig({
 *     auth: {
 *         enabled: true,
 *         tokenManager: getOneTimeTokenManager(),
 *     },
 * })
 * ```
 */
export function getOneTimeTokenManager(): SSETokenManager
{
    if (!manager)
    {
        throw new Error(
            'OneTimeTokenManager not initialized. '
            + 'Ensure createAuthLifecycle() is configured in your server config.',
        );
    }

    return manager;
}
