/**
 * @spfn/monitor - monitorRouter under a router-level skipper (spfn/spfn#165)
 *
 * Every monitor route authenticates itself: `.use([authenticate,
 * requireRole('superadmin')])`. So the router states no `packageName`, and a
 * skipper above it removes only the inherited `auth` — each route runs its own
 * in its place. If a route ever lost its own `authenticate`, it would rely on
 * the inherited one, and the router would have to state `packageName`.
 */

import { describe, it, expect } from 'vitest';
import { defineMiddleware, defineRouter, resolveRouteMiddlewares } from '@spfn/core/route';
import { authenticate } from '@spfn/auth/server';
import { monitorRouter } from '../../server/routes';

const SERVER = [{ name: 'auth', handler: authenticate.handler }];
const skipper = defineMiddleware('skipper', async (_c, next) => next(), { skips: ['auth'] });

describe('monitorRouter under a router-level skipper', () =>
{
    it('states no package name: its routes do not rely on the inherited auth', () =>
    {
        expect(monitorRouter._packageName).toBeNull();
    });

    it('registers as a plain entry under a skipper, and every route still runs its own auth', () =>
    {
        const routes = resolveRouteMiddlewares(defineRouter({ monitor: monitorRouter }).use([skipper]), SERVER);

        expect(routes).toHaveLength(Object.keys(monitorRouter.routes).length);
        for (const route of routes)
        {
            expect(route.middlewares.map(mw => `${mw.source}:${mw.name}`)).toEqual([
                'router:skipper',
                'route:auth',
                'route:role',
            ]);
        }
    });
});
