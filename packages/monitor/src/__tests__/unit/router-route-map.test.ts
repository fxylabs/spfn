/**
 * @spfn/monitor - What the router tells the route-map generator
 *
 * The generator refuses an app route whose name a mounted package router also
 * registers, because the app spreads that package's published route map over
 * its own and the package entry wins the name. This package publishes no such
 * map — no `.spfnrc.ts`, and nothing named as one in its exports — so an app
 * route called `getStats` loses nothing to the admin route of the same name,
 * and the build that refused it was refusing a merge that does not exist.
 *
 * The flag is how the generator is told. It is asserted here rather than in
 * `@spfn/core`, which cannot import this package.
 */

import { describe, it, expect } from 'vitest';
import { monitorRouter } from '../../server/routes';

describe('monitorRouter', () =>
{
    it('publishes no route map, so an app route may share a name with it', () =>
    {
        expect(monitorRouter._publishesRouteMap).toBe(false);
    });

    it('still registers the routes it always did', () =>
    {
        expect(Object.keys(monitorRouter.routes)).toContain('getStats');
    });
});
