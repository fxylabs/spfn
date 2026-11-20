/**
 * @spfn/auth - opsOrUser at two levels (spfn/spfn#168)
 *
 * Every `opsOrUser(...)` configuration shares the name 'opsOrUser'. When it
 * was a hand-written named middleware, registration kept the first of a name,
 * so a router's `opsOrUser(read)` dropped a route's `opsOrUser(write)` and a
 * read-only ops token passed the write route. As a factory call it is never
 * merged by name: both checks run.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { defineRouter, registerRoutes, route } from '@spfn/core/route';

import { authenticate, opsOrUser } from '@/server';

const verifyOpsTokenService = vi.hoisted(() => vi.fn());

vi.mock('../../server/services/ops-token.service', async importOriginal => ({
    ...await importOriginal<typeof import('../../server/services/ops-token.service')>(),
    verifyOpsTokenService,
}));

/** A server with `auth` at server level, `opsOrUser(read)` on a router and `opsOrUser(write)` on its write route. */
function serve(): Hono
{
    const app = new Hono();
    const ok = async () => ({ ok: true });

    app.onError((error, c) => c.json({ error: error.message }, (error as { statusCode?: 401 | 403 }).statusCode ?? 500));
    registerRoutes(app, defineRouter({
        read: route.get('/read').handler(ok),
        write: route.get('/write').use([opsOrUser({ opsScopes: ['write'], roles: ['admin'] })]).handler(ok),
    }).use([opsOrUser({ opsScopes: ['read'], roles: ['admin'] })]), [authenticate]);

    return app;
}

/** The status of a request carrying an ops token granted `scopes`. */
async function statusWith(app: Hono, path: string, scopes: string[]): Promise<number>
{
    verifyOpsTokenService.mockResolvedValue({ tokenId: 1, name: 'ops', scopes });

    return (await app.request(path, { headers: { Authorization: 'Bearer spfn_ops_test' } })).status;
}

describe('opsOrUser at two levels', () =>
{
    it('F6: a router\'s opsOrUser(read) and a route\'s opsOrUser(write) both run — a read-only ops token is refused on the write route', async () =>
    {
        const app = serve();

        expect(await statusWith(app, '/write', ['read'])).toBe(403);
        expect(await statusWith(app, '/write', ['read', 'write'])).toBe(200);
        expect(await statusWith(app, '/read', ['read'])).toBe(200);
    });
});
