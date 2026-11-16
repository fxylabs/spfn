/**
 * A one-time token in the cache store is spent once (au1-B7).
 *
 * | #   | state                                                   | action                                   | expected                                              |
 * |-----|---------------------------------------------------------|------------------------------------------|-------------------------------------------------------|
 * | T4a | a cache client with `get` and `del` but no `getdel`     | `new CacheTokenStore(client)`            | refused at construction, the message names `getdel`   |
 * | T4b | a real Redis behind `CacheTokenStore`, one issued token | two concurrent SSE connects with it      | exactly one opens (200); the other is refused (401)   |
 *
 * T4b reads `TEST_CACHE_URL`, defaulting to the plain Redis CI runs on `:6479`.
 */

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Redis } from 'ioredis';

import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import { CacheTokenStore } from '../token-manager';
import { closeAllStreams, createStreamApp, openStream } from './stream-harness';

/** A cache client that can only read and then delete: two consumes can both read before either deletes. */
class ReadThenDeleteCache
{
    store = new Map<string, string>();

    async set(key: string, value: string): Promise<void>
    {
        this.store.set(key, value);
    }

    async get(key: string): Promise<string | null>
    {
        return this.store.get(key) ?? null;
    }

    async del(...keys: string[]): Promise<number>
    {
        return keys.filter(key => this.store.delete(key)).length;
    }
}

const redis = new Redis(process.env.TEST_CACHE_URL ?? 'redis://localhost:6479', { lazyConnect: true });

afterEach(async () =>
{
    await closeAllStreams();
});

afterAll(async () =>
{
    redis.disconnect();
});

describe('a one-time token in the cache store is spent once', () =>
{
    it('T4a a cache client without getdel is refused when the store is constructed', () =>
    {
        expect(() => new CacheTokenStore(new ReadThenDeleteCache() as never)).toThrow(/getdel/);
    });

    it('T4b two concurrent connects with one token through a real Redis: exactly one opens', async () =>
    {
        const e = defineEvent('test.consume.once', Type.Object({ n: Type.Number() }));
        const { app, tokenManager } = createStreamApp(defineEventRouter({ e }), {}, true, {
            store: new CacheTokenStore(redis),
        });
        const token = await tokenManager!.issue('u');
        const path = `/events/stream?events=e&token=${token}`;

        const statuses = (await Promise.all([openStream(app, path), openStream(app, path)])).map(stream => stream.status);

        expect(statuses.sort()).toEqual([200, 401]);
    });
});
