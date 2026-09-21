/**
 * @spfn/notification - What the tracking router tells the route-map generator
 *
 * The generator refuses an app route whose name a mounted package router also
 * registers, because the app spreads that package's published route map over
 * its own and the package entry wins the name. This package publishes no such
 * map — no `.spfnrc.ts`, and nothing named as one in its exports — and these
 * endpoints are reached by the URL baked into a sent email, never by name. An
 * app route sharing one of their names loses nothing to them.
 *
 * The flag is how the generator is told. It is asserted here rather than in
 * `@spfn/core`, which cannot import this package.
 */

import { describe, it, expect } from 'vitest';
import { trackingRouter } from '../routes';

describe('trackingRouter', () =>
{
    it('publishes no route map, so an app route may share a name with it', () =>
    {
        expect(trackingRouter._publishesRouteMap).toBe(false);
    });

    it('still registers the routes it always did', () =>
    {
        expect(Object.keys(trackingRouter.routes)).toEqual(['trackOpen', 'trackClick']);
    });
});
