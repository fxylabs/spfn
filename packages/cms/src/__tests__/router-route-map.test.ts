/**
 * @spfn/cms - What the app router tells the route-map generator
 *
 * The generator refuses an app route whose name a mounted package router also
 * registers, because the app spreads that package's published route map over
 * its own and the package entry wins the name. This package publishes no such
 * map — its `.spfnrc.ts` runs the router generator only, and nothing here is
 * exported as one — so an app route sharing a name with a CMS route loses
 * nothing to it.
 *
 * The flag is how the generator is told. It is asserted here rather than in
 * `@spfn/core`, which cannot import this package.
 */

import { describe, it, expect } from 'vitest';
import { cmsAppRouter } from '../server/routes';

describe('cmsAppRouter', () =>
{
    it('publishes no route map, so an app route may share a name with it', () =>
    {
        expect(cmsAppRouter._publishesRouteMap).toBe(false);
    });

    it('still registers the routes it always did', () =>
    {
        expect(Object.keys(cmsAppRouter.routes)).toContain('getLabelCache');
    });
});
