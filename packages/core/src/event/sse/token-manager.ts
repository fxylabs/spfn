/**
 * SSE Token Manager
 *
 * Auth-agnostic token issuance and verification for SSE connections.
 * Issues one-time-use tokens with TTL for Token Exchange pattern.
 *
 * @example
 * ```typescript
 * const manager = new SSETokenManager({ ttl: 30000 });
 *
 * // Issue token for authenticated user
 * const token = await manager.issue('user-123');
 *
 * // Verify and consume token (one-time use)
 * const subject = await manager.verify(token); // 'user-123'
 * const again = await manager.verify(token);   // null (already consumed)
 *
 * // A token tagged with the device key it was minted for is refused at
 * // consume once `verifyKey` says that key is gone
 * const tagged = await manager.issue('user-123', { keyId: 'key-1' });
 * const data = await manager.consume(tagged); // { subject, keyId, expiresAt } | null
 *
 * // Cleanup on shutdown
 * manager.destroy();
 * ```
 */

import { randomBytes, createHash } from 'crypto';
import { logger } from '@spfn/core/logger';

const tokenLogger = logger.child('@spfn/core:sse');

/**
 * Hash a token for storage. The raw token is a bearer secret — storing it at rest
 * (e.g. as a Redis key/value) means a store dump hands out live tokens. We persist
 * only sha256(token) and look up by the same hash; the raw token exists only in
 * transit and in the issue() return value.
 */
function hashToken(token: string): string
{
    return createHash('sha256').update(token).digest('hex');
}

/**
 * What `CacheTokenStore` needs of a cache client (ioredis `Redis | Cluster`
 * offers both). `getdel` is the atomic take — Redis `GETDEL` (6.2+; every
 * Valkey) — and is required: a read followed by a delete lets two concurrent
 * consumes both read the token.
 */
type TokenCacheClient = {
    set(key: string, value: string, ...args: any[]): Promise<any>;
    getdel(key: string): Promise<string | null>;
};

// ============================================================================
// Types
// ============================================================================

/**
 * Stored SSE token data
 */
export interface SSEToken
{
    subject: string;
    expiresAt: number;

    /** The device key the token was minted with; absent → an untagged token. */
    keyId?: string;

    /**
     * Who holds `keyId`, as the issuer recorded it beside the tag — the
     * authenticated principal's id. Independent of `subject`, which an app may
     * shape freely (`getSubject`).
     */
    keyHolder?: string;
}

/**
 * Whether the device key a token was minted with still holds; `false` or a
 * throw refuses the token. `keyHolder` is who the issuer recorded as holding
 * the key (absent when it recorded none), so a verifier judges the person as
 * well as the key without parsing `subject` — `@spfn/auth` admits the key
 * holder on that key, account status included.
 */
export type SSEKeyVerifier = (
    keyId: string,
    subject: string,
    keyHolder: string | undefined,
) => boolean | Promise<boolean>;

/**
 * Token storage interface
 *
 * Implement this for custom storage backends (e.g., Redis for multi-instance).
 */
export interface SSETokenStore
{
    /** Store a token */
    set(token: string, data: SSEToken): Promise<void>;

    /**
     * Take a token out (one-time use). Atomic: of concurrent consumes of one
     * token, exactly one answers it — never a read and a separate delete.
     */
    consume(token: string): Promise<SSEToken | null>;

    /** Remove expired tokens */
    cleanup(): Promise<void>;
}

/**
 * SSETokenManager configuration
 */
export interface SSETokenManagerConfig
{
    /**
     * Token time-to-live in milliseconds
     * @default 30000
     */
    ttl?: number;

    /**
     * Custom token store (default: in-memory Map)
     */
    store?: SSETokenStore;

    /**
     * Cleanup interval in milliseconds
     * @default 60000
     */
    cleanupInterval?: number;

    /**
     * Re-check, when a token is consumed, the device key it was minted with —
     * a token minted before its key was revoked is then refused at open.
     * Runs only for a token that carries a `keyId`; `false` or a throw
     * refuses it. The token is consumed first, so a refused one is never
     * retried. `@spfn/auth`'s one-time token manager supplies it.
     */
    verifyKey?: SSEKeyVerifier;
}

// ============================================================================
// InMemoryTokenStore
// ============================================================================

class InMemoryTokenStore implements SSETokenStore
{
    private tokens = new Map<string, SSEToken>();

    async set(token: string, data: SSEToken): Promise<void>
    {
        this.tokens.set(hashToken(token), data);
    }

    /** The read and the delete are one synchronous step — no `await` between them — so it is atomic. */
    async consume(token: string): Promise<SSEToken | null>
    {
        const key = hashToken(token);
        const data = this.tokens.get(key);
        if (!data)
        {
            return null;
        }

        this.tokens.delete(key);

        return data;
    }

    async cleanup(): Promise<void>
    {
        const now = Date.now();

        for (const [key, data] of this.tokens)
        {
            if (data.expiresAt <= now)
            {
                this.tokens.delete(key);
            }
        }
    }
}

// ============================================================================
// CacheTokenStore (Redis/Valkey)
// ============================================================================

/**
 * Redis/Valkey-backed token store for multi-instance deployments.
 *
 * Uses SET EX for automatic TTL expiry and GETDEL for atomic one-time consumption:
 * of two concurrent consumes of one token, exactly one gets it. Needs Redis 6.2+
 * or Valkey; on an older server GETDEL fails, so the consume throws and the
 * token is never accepted. No cleanup needed — Redis handles expiration automatically.
 *
 * @throws Error at construction when the client offers no `getdel` — a store
 *   that could only read and then delete is refused, never raced.
 *
 * @example
 * ```typescript
 * import { getCache } from '@spfn/core/cache';
 *
 * const cache = getCache();
 * if (cache) {
 *     const store = new CacheTokenStore(cache);
 *     const manager = new SSETokenManager({ store });
 * }
 * ```
 */
export class CacheTokenStore implements SSETokenStore
{
    private prefix = 'sse:token:';

    constructor(private cache: TokenCacheClient)
    {
        if (typeof cache?.getdel !== 'function')
        {
            throw new Error(
                'CacheTokenStore needs a cache client with getdel() (Redis GETDEL, 6.2+, or Valkey) ' +
                'to consume a token exactly once; this client has none.',
            );
        }
    }

    async set(token: string, data: SSEToken): Promise<void>
    {
        const ttlSeconds = Math.max(1, Math.ceil((data.expiresAt - Date.now()) / 1000));
        await this.cache.set(
            this.prefix + hashToken(token),
            JSON.stringify(data),
            'EX',
            ttlSeconds,
        );
    }

    async consume(token: string): Promise<SSEToken | null>
    {
        const raw = await this.cache.getdel(this.prefix + hashToken(token));

        return raw ? JSON.parse(raw) as SSEToken : null;
    }

    async cleanup(): Promise<void>
    {
        // No-op: Redis TTL handles expiration automatically
    }
}

// ============================================================================
// SSETokenManager
// ============================================================================

export class SSETokenManager
{
    private store: SSETokenStore;
    private ttl: number;
    private verifyKey: SSEKeyVerifier | undefined;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config?: SSETokenManagerConfig)
    {
        this.ttl = config?.ttl ?? 30000;
        this.store = config?.store ?? new InMemoryTokenStore();
        this.verifyKey = config?.verifyKey;

        const cleanupInterval = config?.cleanupInterval ?? 60000;
        this.cleanupTimer = setInterval(() => void this.store.cleanup(), cleanupInterval);
        this.cleanupTimer.unref();
    }

    /**
     * How long an issued token stays valid, in milliseconds.
     *
     * Exposed so a caller that has to report an expiry to its client computes the same
     * number this manager stamps on the token, instead of assuming the default.
     */
    get ttlMs(): number
    {
        return this.ttl;
    }

    /**
     * Issue a new one-time-use token for the given subject. `keyId` tags it
     * with the device key it is minted for; an empty one leaves it untagged.
     * `keyHolder` records who holds that key, beside the tag, for `verifyKey`;
     * it is kept only on a tagged token.
     */
    async issue(subject: string, options?: { keyId?: string; keyHolder?: string }): Promise<string>
    {
        const token = randomBytes(32).toString('hex');
        const keyId = options?.keyId || undefined;
        const keyHolder = keyId ? options?.keyHolder || undefined : undefined;

        // The store keys by sha256(token); the raw token is never persisted.
        await this.store.set(token, {
            subject,
            expiresAt: Date.now() + this.ttl,
            ...(keyId ? { keyId } : {}),
            ...(keyHolder ? { keyHolder } : {}),
        });

        return token;
    }

    /**
     * Verify and consume a token
     * @returns subject string if valid, null if invalid/expired/already consumed
     */
    async verify(token: string): Promise<string | null>
    {
        return (await this.consume(token))?.subject ?? null;
    }

    /**
     * Consume a token and answer what it was minted with: `null` when it is
     * unknown, expired, already consumed, or its key no longer holds
     * (`verifyKey`). The token is gone either way. `take` + `checkKey`.
     */
    async consume(token: string): Promise<SSEToken | null>
    {
        const data = await this.take(token);

        return data && await this.checkKey(data) ? data : null;
    }

    /**
     * The store half of `consume`: take the token out of the store and answer
     * what it was minted with, `null` when it is unknown, expired or already
     * consumed — its key is not checked yet (`checkKey`). For a caller that
     * has to register the connection before the key check, so a revocation
     * landing during the check reaches it.
     */
    async take(token: string): Promise<SSEToken | null>
    {
        const data = await this.store.consume(token);

        return data && data.expiresAt > Date.now() ? data : null;
    }

    /**
     * The key half of `consume`: `verifyKey` on a tagged token; an untagged
     * one, or no verifier, holds without a call. A throw refuses and is warned
     * without its text — it may carry what the verifier read.
     */
    async checkKey(data: SSEToken): Promise<boolean>
    {
        if (!data.keyId || !this.verifyKey)
        {
            return true;
        }

        try
        {
            return await this.verifyKey(data.keyId, data.subject, data.keyHolder) === true;
        }
        catch
        {
            tokenLogger.warn('SSE token key check threw — token refused');

            return false;
        }
    }

    /**
     * Cleanup timer and resources
     */
    destroy(): void
    {
        if (this.cleanupTimer)
        {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
}
