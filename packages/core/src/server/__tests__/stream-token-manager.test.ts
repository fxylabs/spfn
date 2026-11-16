/**
 * A stream endpoint resolves the cache token store only for its default token manager.
 *
 * Through `createServer` with `.events(router, { auth: { enabled: true } })`
 * and a connected cache client that has `get` and `del` but no `getdel`:
 *
 * | #   | `auth.tokenManager`         | expected                                                   |
 * |-----|-----------------------------|------------------------------------------------------------|
 * | F2a | the app's own manager       | boots; the token endpoint mints with the app's manager     |
 * | F2b | unset (the default manager) | refused at boot, the message names `getdel`                |
 */

import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@spfn/core/cache', () => ({
    getCache: vi.fn(() => ({
        get: async () => null,
        set: async () => 'OK',
        del: async () => 0,
    })),
}));

import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import { SSETokenManager } from '../../event/sse/token-manager';
import { defineServerConfig } from '../config-builder';
import { createServer } from '../create-server';

type EventsOptions = Parameters<ReturnType<typeof defineServerConfig>['events']>[1];

function serve(options: EventsOptions)
{
    const router = defineEventRouter({ a: defineEvent('stream-token-manager.a', Type.Object({ n: Type.Number() })) });

    return createServer(defineServerConfig()
        .infrastructure({ database: false, redis: false })
        .events(router, options)
        .build());
}

describe('the cache token store is resolved only for the default token manager', () =>
{
    it('F2a an app\'s own token manager boots beside a cache without getdel', async () =>
    {
        const tokenManager = new SSETokenManager({ ttl: 5000 });
        const issue = vi.spyOn(tokenManager, 'issue');

        const app = await serve({ auth: { enabled: true, tokenManager, getSubject: () => 'subject-1' } });
        const response = await app.request('/events/token', { method: 'POST' });

        expect(response.status).toBe(200);
        expect(issue).toHaveBeenCalledOnce();
    });

    it('F2b the default token manager is refused at boot on a cache without getdel', async () =>
    {
        await expect(serve({ auth: { enabled: true } })).rejects.toThrow(/getdel/);
    });
});
