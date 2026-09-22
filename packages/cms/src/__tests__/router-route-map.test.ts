/**
 * @spfn/cms - What the app router tells the route-map generator
 *
 * The app's generated route map carries the routes of every package router the
 * app mounts with `.packages()` and whose `_publishesRouteMap` is true. This
 * package needs to be in there: it calls `api.getLabelCache.call(...)` itself,
 * a name the app's RPC proxy resolves in that one map. The same flag is what
 * makes an app route sharing a CMS route's name a collision the app's build
 * refuses — both would want the one entry that name has.
 *
 * The flag is how the generator is told. It is asserted here rather than in
 * `@spfn/core`, which cannot import this package.
 */

import { describe, it, expect } from 'vitest';
import { cmsAppRouter } from '../server/routes';

describe('cmsAppRouter', () =>
{
    it('publishes its route map, so the app that mounts it can resolve getLabelCache by name', () =>
    {
        expect(cmsAppRouter._publishesRouteMap).toBe(true);
    });

    it('still registers the routes it always did', () =>
    {
        expect(Object.keys(cmsAppRouter.routes)).toContain('getLabelCache');
    });
});
