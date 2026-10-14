/**
 * defineSurface unit tests
 *
 * One `describe` per row of the design's case table (#127): the `/_ops`
 * surface built on it behaves as before, a second surface on its own
 * namespace serves its own manifest, and the refusals hold for any namespace.
 */

import { Type } from '@sinclair/typebox';
import { Hono, type Context, type MiddlewareHandler, type Next } from 'hono';
import { describe, expect, it } from 'vitest';

import { defineMiddleware } from '../../route/define-middleware';
import { registerRoutes } from '../../route/register-routes';
import { route, type RouteDef } from '../../route/route-builder';
import { defineRouter, type Router } from '../../route/router';
import { createOpsRouter } from '../../ops/create-ops-router';
import { OpsRouterError } from '../../ops/error';
import { defineOpsModule } from '../../ops/module';
import { opsRoute } from '../../ops/ops-route';
import { defineSurface } from '../define-surface';
import { SurfaceError } from '../error';
import type { SurfaceCommand, SurfaceManifest } from '../manifest';
import { defineSurfaceModule } from '../module';
import { manifestNameOf } from '../namespace';

/** Admits a request carrying `Authorization: Bearer ok`, refuses anything else. */
function bearerAuth(name: string)
{
    return defineMiddleware(name, async (c, next) =>
    {
        if (c.req.header('Authorization') !== 'Bearer ok')
        {
            return c.json({ error: 'unauthorized' }, 401);
        }

        return await next();
    }, { skips: ['auth'] });
}

const appAuth = bearerAuth('signedTokenAuth');
const opsAuth = bearerAuth('opsTokenAuth');
const AUTHORIZED = { headers: { Authorization: 'Bearer ok' } };

const ownGuard = defineMiddleware('ownGuard', async (_c, next) =>
{
    await next();
});

function mount(...routers: Router<any>[]): Hono
{
    const app = new Hono();
    registerRoutes(app, defineRouter({
        ping: route.get('/ping').handler(async () => ({})),
    }).packages(routers));

    return app;
}

function pagesModule(namespace: string)
{
    return {
        id: 'pages',
        source: '@example/pages',
        contractVersion: '1.0.0',
        summary: 'Page maintenance',
        commands: {
            reindex: {
                summary: 'Rebuild the page index',
                effect: 'write' as const,
                scopes: ['pages:write'],
                route: route.post(`${namespace}/pages/reindex`).handler(async () => ({ ok: true })),
            },
        },
    };
}

/** A pass-through guard under `name` that counts the requests it lets through. */
function countingGuard(name: string, counts: Record<string, number>)
{
    return defineMiddleware(name, async (_c, next) =>
    {
        counts[name] = (counts[name] ?? 0) + 1;
        await next();
    });
}

function middlewaresOf(router: Router<any>, name: string): unknown[]
{
    return (router.routes[name] as RouteDef<any>).middlewares ?? [];
}

describe('1 — /_ops via createOpsRouter, no authorize, no modules', () =>
{
    it('serves /_ops/_manifest behind auth and gives every route [auth, ...inherited, ...own]', async () =>
    {
        const opsRouter = createOpsRouter({
            listSignups: opsRoute.get('/signups').use([ownGuard]).handler(async () => ({ items: [] })),
            admin: defineRouter({
                getStats: opsRoute.get('/stats').handler(async () => ({})),
            }).use([ownGuard]),
        }, { auth: opsAuth });

        expect(Object.keys(opsRouter.routes)[0]).toBe('getOpsManifest');
        expect(middlewaresOf(opsRouter, 'getOpsManifest')).toEqual([opsAuth]);
        expect(middlewaresOf(opsRouter, 'listSignups')).toEqual([opsAuth, ownGuard]);
        expect(middlewaresOf(opsRouter.routes.admin as Router<any>, 'getStats')).toEqual([opsAuth, ownGuard]);

        const app = mount(opsRouter);
        expect((await app.request('/_ops/_manifest')).status).toBe(401);
        expect((await app.request('/_ops/_manifest', AUTHORIZED)).status).toBe(200);
    });

    it('throws the one error class under both names', () =>
    {
        expect(OpsRouterError).toBe(SurfaceError);
        expect(() => createOpsRouter({ stray: route.get('/x').handler(async () => ({})) }, { auth: opsAuth }))
            .toThrow(SurfaceError);
        expect(new OpsRouterError('x').name).toBe('SurfaceError');
    });
});

describe('2 — /_ops via createOpsRouter with a scope factory and one module', () =>
{
    it('guards module routes with authorize(scopes) and leaves app routes as they were', () =>
    {
        const scopeGuards: Array<{ scopes: string[]; guard: MiddlewareHandler }> = [];
        const authorize = (...scopes: string[]) =>
        {
            const guard: MiddlewareHandler = async (_c, next) => await next();
            scopeGuards.push({ scopes, guard });

            return guard;
        };
        const moduleOwn = defineMiddleware('moduleOwn', async (_c, next) => await next());

        const opsRouter = createOpsRouter({
            listSignups: opsRoute.get('/signups').use([ownGuard]).handler(async () => ({})),
            admin: defineRouter({
                getStats: opsRoute.get('/stats').handler(async () => ({})),
            }).use([ownGuard]),
        }, {
            auth: opsAuth,
            authorize,
            modules: [defineOpsModule({
                ...pagesModule('/_ops'),
                commands: {
                    reindex: {
                        ...pagesModule('/_ops').commands.reindex,
                        route: opsRoute.post('/pages/reindex').use([moduleOwn]).handler(async () => ({})),
                    },
                },
            })],
        });

        expect(scopeGuards.map(entry => entry.scopes)).toEqual([['pages:write']]);
        expect(middlewaresOf(opsRouter, 'pages.reindex'))
            .toEqual([opsAuth, scopeGuards[0]!.guard, moduleOwn]);
        expect(middlewaresOf(opsRouter, 'listSignups')).toEqual([opsAuth, ownGuard]);
        expect(middlewaresOf(opsRouter.routes.admin as Router<any>, 'getStats')).toEqual([opsAuth, ownGuard]);
        expect(middlewaresOf(opsRouter, 'getOpsManifest')).toEqual([opsAuth]);
    });
});

describe('3 — /_app, authenticated manifest', () =>
{
    it('serves /_app/_manifest 401 without a token and 200 with one; commands sit behind auth', async () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });
        const app = mount(surface.router({
            pageAdd: surface.route.post('/pages')
                .input({ body: Type.Object({ title: Type.String() }) })
                .handler(async () => ({ added: true })),
        }));

        expect(surface.namespace).toBe('/_app');
        expect((await app.request('/_app/_manifest')).status).toBe(401);

        const answer = await app.request('/_app/_manifest', AUTHORIZED);
        expect(answer.status).toBe(200);
        const manifest = await answer.json() as SurfaceManifest;
        expect(manifest.manifestVersion).toBe(1);
        expect(manifest.commands.map(command => [command.name, command.method, command.path]))
            .toEqual([['pageAdd', 'POST', '/_app/pages']]);

        expect((await app.request('/_app/pages', { method: 'POST' })).status).toBe(401);
    });
});

describe('4 — /_app, public manifest', () =>
{
    it('answers the manifest without a token past a global `auth`, and keeps commands behind auth', async () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth, manifest: 'public' });
        const router = surface.router({
            pageAdd: surface.route.post('/pages').handler(async () => ({ added: true })),
        });

        const app = new Hono();
        const globalAuth: MiddlewareHandler = async () =>
        {
            throw new Error('the global auth middleware ran');
        };
        registerRoutes(app, defineRouter({
            ping: route.get('/ping').handler(async () => ({})),
        }).packages([router]), [{ name: 'auth', handler: globalAuth }]);

        expect(middlewaresOf(router, 'getAppManifest')).toEqual([]);
        expect((router.routes.getAppManifest as RouteDef<any>).skipMiddlewares).toEqual(['auth']);

        const manifest = await app.request('/_app/_manifest');
        expect(manifest.status).toBe(200);
        expect((await manifest.json() as SurfaceManifest).commands.map(command => command.name))
            .toEqual(['pageAdd']);

        expect((await app.request('/_app/pages', { method: 'POST' })).status).toBe(401);
        expect((await app.request('/_app/pages', { method: 'POST', ...AUTHORIZED })).status).toBe(200);
    });

    it('refuses a manifest mode it does not know', () =>
    {
        expect(() => defineSurface({ namespace: '/_app', auth: appAuth, manifest: 'open' as never }))
            .toThrow(/'authenticated' or 'public'/);
    });
});

describe('5 — /_app with a per-command authorize', () =>
{
    it('hands the guard each command and places it after auth; undefined adds nothing', () =>
    {
        const guard = defineMiddleware('pageGuard', async (_c, next) => await next());
        const seen: SurfaceCommand[] = [];
        const surface = defineSurface({
            namespace: '/_app',
            auth: appAuth,
            authorize: command =>
            {
                seen.push(command);

                return command.name === 'pageAdd' ? guard : undefined;
            },
        });

        const router = surface.router({
            pageAdd: surface.route.post('/pages').use([ownGuard]).handler(async () => ({})),
            pageList: surface.route.get('/pages').use([ownGuard]).handler(async () => ({})),
        });

        expect(seen.map(command => [command.name, command.method, command.path])).toEqual([
            ['pageAdd', 'POST', '/_app/pages'],
            ['pageList', 'GET', '/_app/pages'],
        ]);
        expect(middlewaresOf(router, 'pageAdd')).toEqual([appAuth, guard, ownGuard]);
        expect(middlewaresOf(router, 'pageList')).toEqual([appAuth, ownGuard]);
    });

    it('guards a nested router\'s route between auth and the router\'s own middlewares', () =>
    {
        const guard = defineMiddleware('pageGuard', async (_c, next) => await next());
        const surface = defineSurface({ namespace: '/_app', auth: appAuth, authorize: () => guard });

        const router = surface.router({
            pages: defineRouter({
                pageList: surface.route.get('/pages').handler(async () => ({})),
            }).use([ownGuard]),
        });

        expect(middlewaresOf(router.routes.pages as Router<any>, 'pageList')).toEqual([appAuth, guard, ownGuard]);
    });

    it('refuses a guard named like the command\'s own middleware, which registration would drop', () =>
    {
        const guardNamed = (name: string) => defineMiddleware(name, async (_c, next) => await next());
        const surface = defineSurface({ namespace: '/_app', auth: appAuth, authorize: () => guardNamed('g') });

        const build = () => surface.router({
            dropAll: surface.route.post('/pages/drop').use([guardNamed('g')]).handler(async () => ({})),
        });

        expect(build).toThrow(SurfaceError);
        expect(build).toThrow(/command "dropAll" declares a middleware named "g".*own guard would never run/);
    });

    it('refuses a guard named like a nested router\'s .use() middleware', () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth, authorize: () => ownGuard });

        expect(() => surface.router({
            pages: defineRouter({
                pageList: surface.route.get('/pages').handler(async () => ({})),
            }).use([ownGuard]),
        })).toThrow(/command "pageList" declares a middleware named "ownGuard"/);
    });

    it('refuses a guard named like the surface\'s auth middleware', () =>
    {
        const surface = defineSurface({
            namespace: '/_app',
            auth: appAuth,
            authorize: () => defineMiddleware('signedTokenAuth', async (_c, next) => await next()),
        });

        const build = () => surface.router({
            pageAdd: surface.route.post('/pages').handler(async () => ({})),
        });

        expect(build).toThrow(SurfaceError);
        expect(build).toThrow(/shares the name "signedTokenAuth".*auth middleware/);
    });

    it('runs both guards when their names differ', async () =>
    {
        const counts: Record<string, number> = {};
        const surface = defineSurface({
            namespace: '/_app',
            auth: appAuth,
            authorize: () => countingGuard('pageGuard', counts),
        });
        const own = countingGuard('ownGuard', counts);
        const router = surface.router({
            pageAdd: surface.route.post('/pages').use([own]).handler(async () => ({ added: true })),
        });

        const [, guard] = middlewaresOf(router, 'pageAdd');
        expect(middlewaresOf(router, 'pageAdd')).toEqual([appAuth, guard, own]);

        const answer = await mount(router).request('/_app/pages', { method: 'POST', ...AUTHORIZED });
        expect(answer.status).toBe(200);
        expect(counts).toEqual({ pageGuard: 1, ownGuard: 1 });
    });

    it('does not refuse an own middleware when authorize gives that command no guard', () =>
    {
        const surface = defineSurface({
            namespace: '/_app',
            auth: appAuth,
            authorize: command => (command.name === 'pageAdd' ? ownGuard : undefined),
        });

        const router = surface.router({
            pageList: surface.route.get('/pages').use([ownGuard]).handler(async () => ({})),
        });

        expect(middlewaresOf(router, 'pageList')).toEqual([appAuth, ownGuard]);
    });
});

describe('5 — the same refusal on /_ops', () =>
{
    it('refuses a module command repeating the scope guard authorize gives it', () =>
    {
        const namedScopeGuard = (..._scopes: string[]) =>
            defineMiddleware('opsScope', async (_c, next) => await next());

        expect(() => createOpsRouter({}, {
            auth: opsAuth,
            authorize: namedScopeGuard,
            modules: [defineOpsModule({
                ...pagesModule('/_ops'),
                commands: {
                    reindex: {
                        ...pagesModule('/_ops').commands.reindex,
                        route: opsRoute.post('/pages/reindex').use([namedScopeGuard('admin')]).handler(async () => ({})),
                    },
                },
            })],
        })).toThrow(/Ops command "pages\.reindex" declares a middleware named "opsScope"/);
    });

    it('refuses a module command whose guard is named like the ops auth middleware', () =>
    {
        const build = () => createOpsRouter({}, {
            auth: opsAuth,
            authorize: () => defineMiddleware('opsTokenAuth', async (_c, next) => await next()),
            modules: [defineOpsModule(pagesModule('/_ops'))],
        });

        expect(build).toThrow(OpsRouterError);
        expect(build).toThrow(/shares the name "opsTokenAuth".*auth middleware/);
    });

    it('does not refuse requireOpsScope\'s real shape — a factory returning an unnamed handler — and runs both checks', async () =>
    {
        const scopeFactory = defineMiddleware('opsScope', (...scopes: string[]) => async (c: Context, next: Next) =>
        {
            const granted = new Set((c.req.header('X-Scopes') ?? '').split(','));
            const missing = scopes.filter(scope => !granted.has(scope));

            return missing.length > 0 ? c.json({ need: missing }, 403) : await next();
        });

        const opsRouter = createOpsRouter({}, {
            auth: opsAuth,
            authorize: scopeFactory,
            modules: [defineOpsModule({
                ...pagesModule('/_ops'),
                commands: {
                    reindex: {
                        ...pagesModule('/_ops').commands.reindex,
                        route: opsRoute.post('/pages/reindex').use([scopeFactory('admin')]).handler(async () => ({ ran: true })),
                    },
                },
            })],
        });

        const res = await mount(opsRouter).request('/_ops/pages/reindex', {
            method: 'POST',
            headers: { Authorization: 'Bearer ok', 'X-Scopes': 'pages:write' },
        });

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ need: ['admin'] });
    });
});

describe('6 — /_app and /_ops mounted together', () =>
{
    it('answers both manifests under distinct route names, each listing only its own commands', async () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });
        const appSurface = surface.router({
            pageAdd: surface.route.post('/pages').handler(async () => ({})),
        });
        const opsSurface = createOpsRouter({
            listSignups: opsRoute.get('/signups').handler(async () => ({})),
        }, { auth: opsAuth });

        expect(Object.keys(appSurface.routes)[0]).toBe('getAppManifest');
        expect(Object.keys(opsSurface.routes)[0]).toBe('getOpsManifest');

        const app = mount(appSurface, opsSurface);
        const appManifest = await (await app.request('/_app/_manifest', AUTHORIZED)).json() as SurfaceManifest;
        const opsManifest = await (await app.request('/_ops/_manifest', AUTHORIZED)).json() as SurfaceManifest;

        expect(appManifest.commands.map(command => command.path)).toEqual(['/_app/pages']);
        expect(opsManifest.commands.map(command => command.path)).toEqual(['/_ops/signups']);
    });
});

describe('6 — surfaces sharing a namespace or a manifest name', () =>
{
    it('refuses two surfaces on one namespace in one .packages(), naming it', () =>
    {
        const a = defineSurface({ namespace: '/_app', auth: appAuth });
        const b = defineSurface({ namespace: '/_app', auth: bearerAuth('otherAuth') });

        expect(() => defineRouter({}).packages([
            a.router({ cmdA: a.route.get('/a').handler(async () => ({})) }),
            b.router({ cmdB: b.route.get('/b').handler(async () => ({})) }),
        ])).toThrow(/two command surfaces on "\/_app"/);
    });

    it('refuses two createOpsRouter results in one .packages()', () =>
    {
        const first = createOpsRouter({ a: opsRoute.get('/a').handler(async () => ({})) }, { auth: opsAuth });
        const second = createOpsRouter({ b: opsRoute.get('/b').handler(async () => ({})) }, { auth: opsAuth });

        expect(() => defineRouter({}).packages([first, second])).toThrow(/two command surfaces on "\/_ops"/);
        expect(() => defineRouter({}).packages([first]).packages([second])).toThrow(/"\/_ops"/);
    });

    it('marks the router with its namespace without making it enumerable', () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });
        const router = surface.router({});

        expect(router._surfaceNamespace).toBe('/_app');
        expect(Object.keys(router)).not.toContain('_surfaceNamespace');
    });

    it('derives a distinct manifest name for every namespace, keeping /_ops and /_app readable', () =>
    {
        const namespaces = ['/_app', '/app', '/_ops', '/ops', '/Ops', '/a/b', '/a_b', '/a-b', '/a__b', '/_A'];
        const names = namespaces.map(manifestNameOf);

        expect(new Set(names).size).toBe(namespaces.length);
        expect(manifestNameOf('/_ops')).toBe('getOpsManifest');
        expect(manifestNameOf('/_app')).toBe('getAppManifest');
        expect(manifestNameOf('/app')).toBe('getappManifest');
    });

    it('registers /_app and /app side by side under two manifest names', async () =>
    {
        const a = defineSurface({ namespace: '/_app', auth: appAuth });
        const b = defineSurface({ namespace: '/app', auth: appAuth });
        const app = new Hono();

        const registered = registerRoutes(app, defineRouter({
            ping: route.get('/ping').handler(async () => ({})),
        }).packages([
            a.router({ x: a.route.get('/x').handler(async () => ({})) }),
            b.router({ y: b.route.get('/y').handler(async () => ({})) }),
        ]));

        expect(registered.map(entry => entry.name)).toEqual(['ping', 'getAppManifest', 'x', 'getappManifest', 'y']);
        expect((await app.request('/_app/_manifest', AUTHORIZED)).status).toBe(200);
        expect((await app.request('/app/_manifest', AUTHORIZED)).status).toBe(200);
    });
});

describe('7 — /_app mounting a module written for /_ops', () =>
{
    it('refuses it, naming the namespace it is mounted on', () =>
    {
        const surface = defineSurface({
            namespace: '/_app',
            auth: appAuth,
            authorize: () => undefined,
            modules: [defineOpsModule(pagesModule('/_ops'))],
        });

        expect(() => surface.router({})).toThrow(SurfaceError);
        expect(() => surface.router({})).toThrow(/outside "\/_app\/pages\/".*mounted on "\/_app"/);
    });
});

describe('8 — /_app mounting a module written for /_app', () =>
{
    it('mounts it, guarded per command, and lists it in the manifest', async () =>
    {
        const guard = defineMiddleware('pageScope', async (_c, next) => await next());
        const surface = defineSurface({
            namespace: '/_app',
            auth: appAuth,
            authorize: command => (command.scopes?.includes('pages:write') ? guard : undefined),
            modules: [defineSurfaceModule(pagesModule('/_app'), '/_app')],
        });
        const router = surface.router({});

        expect(middlewaresOf(router, 'pages.reindex')).toEqual([appAuth, guard]);

        const manifest = await (await mount(router).request('/_app/_manifest', AUTHORIZED)).json() as SurfaceManifest;
        expect(manifest.modules?.map(module => module.id)).toEqual(['pages']);
        expect(manifest.commands.map(command => command.name)).toEqual(['pages.reindex']);
    });

    it('requires authorize when a module is mounted', () =>
    {
        expect(() => defineSurface({
            namespace: '/_app',
            auth: appAuth,
            modules: [pagesModule('/_app')],
        })).toThrow(/defineSurface requires an authorize function/);
    });
});

describe('9 — namespaces refused at defineSurface', () =>
{
    it.each(['app', '/_app/', '/', '/_a%70p', '/:x', '/_app/../x', '/a.b', ''])('refuses %j', (namespace) =>
    {
        expect(() => defineSurface({ namespace, auth: appAuth })).toThrow(/Surface namespace .* is invalid/);
    });

    it('accepts /_ops, /_app and a nested namespace', () =>
    {
        for (const namespace of ['/_ops', '/_app', '/machine/v1'])
        {
            expect(defineSurface({ namespace, auth: appAuth }).namespace).toBe(namespace);
        }
    });

    it('refuses a surface without auth', () =>
    {
        expect(() => defineSurface({ namespace: '/_app', auth: undefined as never }))
            .toThrow(/defineSurface requires an auth middleware/);
    });
});

describe('10 — /_app given a route outside its namespace', () =>
{
    it('refuses a route built with `route` or `opsRoute`', () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });

        expect(() => surface.router({ stray: route.post('/pages').handler(async () => ({})) }))
            .toThrow(/outside "\/_app\/"/);
        expect(() => surface.router({ stray: opsRoute.post('/pages').handler(async () => ({})) }))
            .toThrow(/outside "\/_app\/"/);
        expect(() => surface.router({ stray: route.post('/_application/x').handler(async () => ({})) }))
            .toThrow(/outside "\/_app\/"/);
    });

    it('applies the namespace in its own route builder and refuses a path it cannot append', () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });

        expect(surface.route.get('/pages/:id').handler(async () => ({})).path).toBe('/_app/pages/:id');
        expect(() => surface.route.get('pages')).toThrow(/must start with "\/"/);
        expect(() => surface.route.get('/')).toThrow(/names no command/);
    });
});

describe('11 — /_app with a command claiming the manifest', () =>
{
    it('refuses the reserved name and the reserved path', () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });

        expect(() => surface.router({ getAppManifest: surface.route.get('/other').handler(async () => ({})) }))
            .toThrow(/"getAppManifest" is reserved for the manifest route/);
        expect(() => surface.router({ clash: surface.route.get('/_manifest').handler(async () => ({})) }))
            .toThrow(/"\/_app\/_manifest", which is reserved for the manifest/);
    });
});

describe('12 — /_app with a nested router mounting package routers', () =>
{
    it('refuses it', () =>
    {
        const surface = defineSurface({ namespace: '/_app', auth: appAuth });
        const nested = defineRouter({
            pageList: surface.route.get('/pages').handler(async () => ({})),
        }).packages([defineRouter({
            unchecked: route.get('/anywhere').handler(async () => ({})),
        })]);

        expect(() => surface.router({ nested })).toThrow(/bypass the prefix check and the auth injection/);
    });
});
