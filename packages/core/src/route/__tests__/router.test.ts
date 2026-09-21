/**
 * What a router carries across its chainable methods
 *
 * `.packages()`, `.use()` and `.contractVersion()` each rebuild the router, and
 * anything one of them forgets to carry over is silently lost. That matters most
 * for `_publishesRouteMap`: lost, an ops router would start looking like a
 * package that publishes a route map, and `spfn codegen run` would refuse an app
 * route sharing a name with an ops command again.
 */

import { describe, it, expect } from 'vitest';
import { defineMiddleware } from '../define-middleware';
import { route } from '../route-builder';
import { defineRouter, defineUnmappedRouter } from '../router';

const getRoot = route.get('/').handler(async () => ({}));
const noop = defineMiddleware('noop', async (_c, next) => next());

describe('defineRouter', () =>
{
    it('publishes a route map', () =>
    {
        expect(defineRouter({ getRoot })._publishesRouteMap).toBe(true);
    });

    it('carries that through every chainable method', () =>
    {
        const router = defineRouter({ getRoot })
            .packages([defineRouter({})])
            .use([noop])
            .contractVersion('1.0.0');

        expect(router._publishesRouteMap).toBe(true);
        expect(router._contractVersion).toBe('1.0.0');
        expect(router._packageRouters).toHaveLength(1);
        expect(router._globalMiddlewares).toEqual([noop]);
        expect(router.routes).toEqual({ getRoot });
    });
});

describe('defineUnmappedRouter', () =>
{
    it('publishes no route map', () =>
    {
        expect(defineUnmappedRouter({ getRoot })._publishesRouteMap).toBe(false);
    });

    it('still publishes none after being chained', () =>
    {
        const router = defineUnmappedRouter({ getRoot })
            .use([noop])
            .contractVersion('1.0.0')
            .packages([defineRouter({})]);

        expect(router._publishesRouteMap).toBe(false);
        expect(router._contractVersion).toBe('1.0.0');
        expect(router._globalMiddlewares).toEqual([noop]);
    });

    it('does not make the routers mounted on it unmapped too', () =>
    {
        const published = defineRouter({ getRoot });

        expect(defineUnmappedRouter({ published })._publishesRouteMap).toBe(false);
        expect(published._publishesRouteMap).toBe(true);
    });
});
