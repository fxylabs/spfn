/**
 * SSE token store — hashed at rest (S-I1)
 *
 * The one-time token is a bearer secret. The store must persist only sha256(token)
 * (key and value), so a store dump can't hand out usable tokens. Verification still
 * works because the presented token is hashed the same way on lookup.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { SSETokenManager, CacheTokenStore } from '../token-manager';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

class FakeCache
{
    store = new Map<string, string>();

    async set(key: string, value: string): Promise<void>
    {
        this.store.set(key, value);
    }

    async getdel(key: string): Promise<string | null>
    {
        const v = this.store.get(key) ?? null;
        this.store.delete(key);

        return v;
    }
}

describe('CacheTokenStore — token hashed at rest', () =>
{
    it('persists sha256(token), never the raw token, in the key or value', async () =>
    {
        const cache = new FakeCache();
        const manager = new SSETokenManager({ ttl: 5000, store: new CacheTokenStore(cache) });

        const token = await manager.issue('user-123');

        const keys = [...cache.store.keys()];
        expect(keys).toHaveLength(1);

        // The raw token must not appear anywhere at rest…
        expect(keys[0]).not.toContain(token);
        expect(cache.store.get(keys[0])).not.toContain(token);
        // …only the prefixed hash is the key.
        expect(keys[0]).toBe(`sse:token:${sha256(token)}`);
        // Subject is retained (needed to authorize the connection).
        expect(cache.store.get(keys[0])).toContain('user-123');

        manager.destroy();
    });

    it('verifies via the hash and stays one-time-use', async () =>
    {
        const cache = new FakeCache();
        const manager = new SSETokenManager({ ttl: 5000, store: new CacheTokenStore(cache) });

        const token = await manager.issue('user-123');

        expect(await manager.verify(token)).toBe('user-123');
        expect(await manager.verify(token)).toBeNull(); // already consumed

        manager.destroy();
    });
});
