/**
 * findRouteEntry — a route map looked up by method and the path the backend routes
 *
 * A package reads its own routes' declarations this way rather than from the
 * application's generated copy (`ctx.route`). What it compares is the path the
 * backend will route, so a spelling the backend resolves to the same handler
 * finds the same entry, and one it does not route finds none.
 */

import { describe, it, expect } from 'vitest';

import { findRouteEntry } from '../interceptors/helpers';
import type { RouteMapEntry } from '../interceptors/types';

const MAP: Record<string, RouteMapEntry> = {
    decide: { method: 'POST', path: '/_auth/oauth2/authorize', csrf: 'required' },
    describe: { method: 'GET', path: '/_auth/oauth2/authorize' },
    disconnect: { method: 'DELETE', path: '/_auth/oauth2/grants/:id', csrf: 'required' },
};

describe('findRouteEntry', () =>
{
    it.each([
        ['as declared', 'POST', '/_auth/oauth2/authorize', MAP.decide],
        ['by method', 'GET', '/_auth/oauth2/authorize', MAP.describe],
        ['a template parameter', 'DELETE', '/_auth/oauth2/grants/42', MAP.disconnect],
        ['an encoded character', 'POST', '/_auth/oauth2/%61uthorize', MAP.decide],
        ['a dot segment', 'POST', '/_auth/x/../oauth2/authorize', MAP.decide],
        ['an encoded dot segment', 'POST', '/_auth/oauth2/x/%2e%2e/authorize', MAP.decide],
        ['an encoded parameter', 'DELETE', '/_auth/oauth2/grants/%34%32', MAP.disconnect],
    ])('%s → the entry the backend routes it to', (_label, method, path, entry) =>
    {
        expect(findRouteEntry(MAP, method, path)).toBe(entry);
    });

    it.each([
        ['another method', 'PUT', '/_auth/oauth2/authorize'],
        ['a trailing slash the backend does not route', 'POST', '/_auth/oauth2/authorize/'],
        ['an encoded slash inside a parameter', 'DELETE', '/_auth/oauth2/grants/4%2F2/x'],
        ['another path', 'POST', '/app/authorize'],
    ])('%s → no entry', (_label, method, path) =>
    {
        expect(findRouteEntry(MAP, method, path)).toBeUndefined();
    });
});
