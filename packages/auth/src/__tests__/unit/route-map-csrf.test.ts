/**
 * @spfn/auth - the shipped route map against the routes it was generated from
 *
 * The CSRF check reads this package's own routes' `.csrf()` declarations from
 * `src/generated/route-map.ts`, the map the package ships — not from the route
 * definitions. That makes the committed map a security input: a route given
 * `.csrf('required')` without `pnpm codegen` afterwards would ship with the
 * check silently off. This file compares every route on the auth router with
 * its committed entry, in both directions, so that drift fails here instead.
 */

import { describe, it, expect } from 'vitest';
import type { RouteDef, Router } from '@spfn/core/route';

import { mainAuthRouter } from '../../server/routes';
import { routeMap } from '../../generated/route-map';

/** A route's method, path and `.csrf()` — a definition built before `.handler()` may lack the first two. */
interface Declaration
{
    method?: string;
    path?: string;
    csrf?: string;
}

function isRouter(entry: RouteDef<any> | Router<any>): entry is Router<any>
{
    return 'routes' in entry && !('handler' in entry);
}

/** Every route on `router`, nested routers included, by the name the map keys it under. */
function declarationsOf(router: Router<any>, into: Record<string, Declaration> = {}): Record<string, Declaration>
{
    for (const [name, entry] of Object.entries(router.routes) as [string, RouteDef<any> | Router<any>][])
    {
        if (isRouter(entry))
        {
            declarationsOf(entry, into);
            continue;
        }

        into[name] = { method: entry.method, path: entry.path, ...(entry.csrf ? { csrf: entry.csrf } : {}) };
    }

    return into;
}

/** The committed map, in the same shape. */
function committedEntries(): Record<string, Declaration>
{
    return Object.fromEntries(Object.entries(routeMap).map(([name, entry]) =>
        [name, { method: entry.method, path: entry.path, ...(entry.csrf ? { csrf: entry.csrf } : {}) }]));
}

describe('the committed route map and the auth router (run `pnpm codegen` when this fails)', () =>
{
    const routes = declarationsOf(mainAuthRouter);
    const committed = committedEntries();

    it('declares at least one CSRF-required route — the comparison below is not vacuous', () =>
    {
        expect(Object.values(routes).filter(route => route.csrf === 'required')).not.toHaveLength(0);
    });

    it.each(Object.keys(routes))('route %s → its committed entry has the same method, path and csrf', (name) =>
    {
        expect(committed[name]).toEqual(routes[name]);
    });

    it.each(Object.keys(committed))('committed entry %s → a route on the router declares the same', (name) =>
    {
        expect(routes[name]).toEqual(committed[name]);
    });
});
