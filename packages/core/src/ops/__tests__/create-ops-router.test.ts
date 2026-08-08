/**
 * createOpsRouter unit tests
 *
 * The ops surface's definition-time guarantees: prefix enforcement, reserved
 * names, mandatory auth injection, and manifest correctness.
 */

import { Type } from '@sinclair/typebox';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { defineMiddleware } from '../../route/define-middleware';
import { registerRoutes } from '../../route/register-routes';
import { route, type RouteDef } from '../../route/route-builder';
import { defineRouter } from '../../route/router';
import { createOpsRouter, OPS_MANIFEST_PATH } from '../create-ops-router';
import type { OpsManifest } from '../manifest';
import { opsRoute } from '../ops-route';

const testAuth = defineMiddleware('opsTokenAuth', async (_c, next) =>
{
    await next();
}, { skips: ['auth'] });

function listSignupsRoute()
{
    return opsRoute.get('/signups')
        .input({ query: Type.Object({ limit: Type.Optional(Type.Number()) }) })
        .handler(async () => ({ items: [] }));
}

describe('opsRoute', () =>
{
    it('applies the /_ops namespace so a definition carries only the app\'s part', () =>
    {
        const def = opsRoute.get('/examples/count').handler(async () => ({}));

        expect(def.method).toBe('GET');
        expect(def.path).toBe('/_ops/examples/count');
    });

    it('leaves the path after the namespace to the app, parameters included', () =>
    {
        expect(opsRoute.post('/tenants/:id/reindex').handler(async () => ({})).path)
            .toBe('/_ops/tenants/:id/reindex');
    });

    it('refuses a path that is not appendable', () =>
    {
        expect(() => opsRoute.get('examples')).toThrow(/must start with "\/"/);
        expect(() => opsRoute.get('/')).toThrow(/names no command/);
    });
});

describe('createOpsRouter', () =>
{
    it('refuses to build without an auth middleware', () =>
    {
        expect(() => createOpsRouter({ listSignups: listSignupsRoute() }, { auth: undefined as never }))
            .toThrow(/requires an auth middleware/);
    });

    it('refuses a route built with `route` instead of `opsRoute`', () =>
    {
        const stray = route.get('/signups').handler(async () => ({}));

        expect(() => createOpsRouter({ stray }, { auth: testAuth }))
            .toThrow(/Build ops routes with `opsRoute`/);
    });

    it('refuses a route claiming the manifest path or name', () =>
    {
        const clash = opsRoute.get('/_manifest').handler(async () => ({}));
        expect(() => createOpsRouter({ clash }, { auth: testAuth }))
            .toThrow(/reserved for the manifest/);

        const named = opsRoute.get('/other').handler(async () => ({}));
        expect(() => createOpsRouter({ getOpsManifest: named }, { auth: testAuth }))
            .toThrow(/reserved for the manifest route/);
    });

    it('refuses a nested router claiming the manifest name', () =>
    {
        const nested = defineRouter({
            getStats: opsRoute.get('/stats').handler(async () => ({})),
        });

        expect(() => createOpsRouter({ getOpsManifest: nested }, { auth: testAuth }))
            .toThrow(/reserved for the manifest route/);
    });

    it('refuses two routes sharing a command name across nested routers', () =>
    {
        const first = defineRouter({
            listUsers: opsRoute.get('/admin/users').handler(async () => ({})),
        });
        const second = defineRouter({
            listUsers: opsRoute.get('/support/users').handler(async () => ({})),
        });

        expect(() => createOpsRouter({ first, second }, { auth: testAuth }))
            .toThrow(/Two ops routes are named "listUsers"/);
    });

    it('keeps a nested router\'s own middlewares, behind auth, so a scope guard cannot be lost', () =>
    {
        const requireScope = defineMiddleware('requireOpsScope', async (_c, next) =>
        {
            await next();
        });

        const opsRouter = createOpsRouter({
            admin: defineRouter({
                getStats: opsRoute.get('/stats').handler(async () => ({})),
            }).use([requireScope]),
        }, { auth: testAuth });

        const nested = opsRouter.routes.admin as { routes: Record<string, RouteDef<any>>; _globalMiddlewares: unknown[] };
        expect(nested.routes.getStats.middlewares).toEqual([testAuth, requireScope]);
        expect(nested._globalMiddlewares).toHaveLength(0);
    });

    it('runs auth before a nested router\'s guard, so the guard sees the token', async () =>
    {
        const calls: string[] = [];

        const auth = defineMiddleware('opsTokenAuth', async (c, next) =>
        {
            calls.push('auth');
            (c as any).set('opsToken', { scopes: ['stats:read'] });
            await next();
        }, { skips: ['auth'] });

        const requireScope = defineMiddleware('requireOpsScope', async (c, next) =>
        {
            calls.push((c as any).get('opsToken') ? 'guard sees token' : 'guard sees nothing');
            await next();
        });

        const opsRouter = createOpsRouter({
            admin: defineRouter({
                getStats: opsRoute.get('/stats').handler(async () => ({ ok: true })),
            }).use([requireScope]),
        }, { auth });

        const app = new Hono();
        registerRoutes(app, defineRouter({
            ping: route.get('/ping').handler(async () => ({})),
        }).packages([opsRouter]));

        const response = await app.request('/_ops/stats');

        expect(response.status).toBe(200);
        expect(calls).toEqual(['auth', 'guard sees token']);
    });

    it('registers the manifest first, so no app route can answer its path', async () =>
    {
        const opsRouter = createOpsRouter({
            byName: opsRoute.get('/:name').handler(async () => ({ appRoute: true })),
        }, { auth: testAuth });

        expect(Object.keys(opsRouter.routes)[0]).toBe('getOpsManifest');

        const app = new Hono();
        registerRoutes(app, defineRouter({
            ping: route.get('/ping').handler(async () => ({})),
        }).packages([opsRouter]));

        const manifest = await (await app.request(OPS_MANIFEST_PATH)).json() as OpsManifest;
        expect(manifest.manifestVersion).toBe(1);

        // The pattern route still answers its own URLs.
        const own = await (await app.request('/_ops/anything-else')).json() as { appRoute: boolean };
        expect(own.appRoute).toBe(true);
    });

    it('refuses a nested router mounting package routers', () =>
    {
        const nested = defineRouter({
            getStats: opsRoute.get('/stats').handler(async () => ({})),
        }).packages([defineRouter({
            unchecked: route.get('/anywhere').handler(async () => ({})),
        })]);

        expect(() => createOpsRouter({ nested }, { auth: testAuth }))
            .toThrow(/bypass the prefix check and the auth injection/);
    });

    it('injects the auth middleware into every route, manifest and nested routes included', () =>
    {
        const opsRouter = createOpsRouter({
            listSignups: listSignupsRoute(),
            nested: defineRouter({
                getStats: opsRoute.get('/stats').handler(async () => ({})),
            }),
        }, { auth: testAuth });

        const assertAuthFirst = (routes: Record<string, unknown>): void =>
        {
            for (const [name, entry] of Object.entries(routes))
            {
                if (entry !== null && typeof entry === 'object' && 'routes' in entry)
                {
                    assertAuthFirst((entry as { routes: Record<string, unknown> }).routes);
                    continue;
                }

                const middlewares = (entry as RouteDef<any>).middlewares ?? [];
                expect(middlewares[0], `route "${name}" must carry auth first`).toBe(testAuth);
            }
        };

        assertAuthFirst(opsRouter.routes);
    });

    it('serves a manifest describing every command with JSON-serialized schemas', async () =>
    {
        const opsRouter = createOpsRouter({
            listSignups: listSignupsRoute(),
            nested: defineRouter({
                getStats: opsRoute.get('/stats/:metric')
                    .input({ params: Type.Object({ metric: Type.String() }) })
                    .handler(async () => ({})),
            }),
        }, { auth: testAuth });

        const manifestDef = opsRouter.routes.getOpsManifest as RouteDef<any>;
        expect(manifestDef.path).toBe(OPS_MANIFEST_PATH);

        const manifest = await manifestDef.handler({} as never) as OpsManifest;
        expect(manifest.manifestVersion).toBe(1);
        expect(manifest.commands.map(c => c.name)).toEqual(['getStats', 'listSignups']);

        const listSignups = manifest.commands.find(c => c.name === 'listSignups')!;
        expect(listSignups.method).toBe('GET');
        expect(listSignups.path).toBe('/_ops/signups');
        expect(JSON.parse(JSON.stringify(listSignups.input.query))).toEqual(listSignups.input.query);

        const getStats = manifest.commands.find(c => c.name === 'getStats')!;
        expect(getStats.input.params).toMatchObject({ type: 'object' });

        expect(manifest.commands.some(c => c.path === OPS_MANIFEST_PATH)).toBe(false);
    });
});
