/**
 * RouteBuilder metadata tests
 *
 * `.effect()` and `.summary()` are read by a command surface only, so the
 * builder's one job is to carry them to the RouteDef through every chained
 * call — each of which clones the builder.
 */

import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { route } from '../route-builder';

describe('14 — .effect() and .summary() on a plain route', () =>
{
    it('carries both onto the RouteDef through later chained calls', () =>
    {
        const def = route.get('/pages')
            .effect('read')
            .summary('s')
            .input({ query: Type.Object({ limit: Type.Optional(Type.Number()) }) })
            .use([])
            .skip(['auth'])
            .handler(async () => ({}));

        expect(def.effect).toBe('read');
        expect(def.summary).toBe('s');
        expect(def.input?.query).toBeDefined();
    });

    it('lets a later call replace an earlier one', () =>
    {
        const def = route.post('/pages').effect('read').effect('write').handler(async () => ({}));

        expect(def.effect).toBe('write');
    });

    it('carries an explicit empty summary, so the surface reading it can refuse it', () =>
    {
        const def = route.post('/pages').summary('kept').summary('').effect('write').handler(async () => ({}));

        expect(def.summary).toBe('');
    });

    it('adds no effect or summary key to a route that declares neither', () =>
    {
        const def = route.get('/pages').handler(async () => ({}));

        expect(def).not.toHaveProperty('effect');
        expect(def).not.toHaveProperty('summary');
    });
});
