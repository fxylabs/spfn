/**
 * Middleware application count — how many times one registration runs per request
 *
 * ✅ 테스트 범위:
 * - defineRouter().use() + defineServerConfig().routes() (스캐폴드 기본 구성)
 * - defineServerConfig().middlewares() 단독 구성
 * - 두 레벨 공존, 같은 미들웨어의 양쪽 등록, 익명 미들웨어
 * - .skip() 과 패키지 라우터 스코프
 * - 라우터 레벨 미들웨어의 skips (#165): 상속 체인에서의 제거, 존재 규칙, .packages() 거부
 * - 팩토리 호출 결과 (#168): 이름으로 제거되고, 이름으로 합쳐지지 않는다
 *
 * 🔗 관련 파일:
 * - src/server/config-builder.ts
 * - src/route/register-routes.ts
 *
 * Issue #107: router-level middleware ran twice per request, so middleware holding
 * one-shot state (a nonce replay ledger) rejected its own request on the second run.
 *
 * spfn/spfn#165: a middleware declaring `skips` in a router's `.use()` was ignored,
 * so the inherited `auth` still ran in front of the router's own authenticator.
 *
 * spfn/spfn#168: a factory call returned a bare handler — no name to skip, no
 * `skips` — and a named call must never be merged with another by name.
 */

import { describe, it, expect } from 'vitest';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { route, defineRouter, defineMiddleware, defineMiddlewareFactory, registerRoutes, resolveRouteMiddlewares } from '@spfn/core/route';
import type { NamedMiddleware } from '@spfn/core/route';
import { defineServerConfig } from '../config-builder';
import { createServer } from '../create-server';
import { resolveEndpointMiddlewares } from '../helpers';

// ============================================================================
// Helpers
// ============================================================================

interface Counter
{
    middleware: NamedMiddleware<string>;
    count: () => number;
}

/**
 * A named middleware that counts its own executions — the smallest stand-in for
 * middleware holding one-shot state.
 */
function countingMiddleware(name: string): Counter
{
    let count = 0;

    const middleware = defineMiddleware(name, async (_c, next) =>
    {
        count += 1;
        await next();
    });

    return { middleware, count: () => count };
}

function anonymousCounter(): { middleware: NamedMiddleware<string>; count: () => number }
{
    let count = 0;

    const handler: MiddlewareHandler = async (_c, next) =>
    {
        count += 1;
        await next();
    };

    // No name — what a plain Hono handler pushed through a named-middleware slot looks like.
    return {
        middleware: { name: '', handler, _name: '' },
        count: () => count,
    };
}

const ping = route.get('/ping').handler(async () => ({ ok: true }));

const baseConfig = () => defineServerConfig()
    .middleware({ logger: false, cors: false, errorHandler: false })
    .healthCheck({ enabled: false });

// ============================================================================
// Tests
// ============================================================================

describe('middleware application count', () =>
{
    it('runs router-level .use() middleware exactly once per request', async () =>
    {
        const auth = countingMiddleware('auth');

        const app = await createServer(
            baseConfig()
                .routes(defineRouter({ ping }).use([auth.middleware]))
                .build(),
        );

        const res = await app.request('/ping');

        expect(res.status).toBe(200);
        expect(auth.count()).toBe(1);
    });

    it('runs config-level .middlewares() middleware exactly once per request', async () =>
    {
        const auth = countingMiddleware('auth');

        const app = await createServer(
            baseConfig()
                .routes(defineRouter({ ping }))
                .middlewares([auth.middleware])
                .build(),
        );

        const res = await app.request('/ping');

        expect(res.status).toBe(200);
        expect(auth.count()).toBe(1);
    });

    it('runs a config-level and a router-level middleware once each, config first', async () =>
    {
        const order: string[] = [];

        const configMw = defineMiddleware('configLevel', async (_c, next) =>
        {
            order.push('configLevel');
            await next();
        });

        const routerMw = defineMiddleware('routerLevel', async (_c, next) =>
        {
            order.push('routerLevel');
            await next();
        });

        const app = await createServer(
            baseConfig()
                .middlewares([configMw])
                .routes(defineRouter({ ping }).use([routerMw]))
                .build(),
        );

        const res = await app.request('/ping');

        expect(res.status).toBe(200);
        expect(order).toEqual(['configLevel', 'routerLevel']);
    });

    it('runs a middleware registered at BOTH levels once in total', async () =>
    {
        // Declared semantics: a named middleware runs at most once per route. The two
        // registrations name one middleware reached by two paths, not two middlewares.
        const auth = countingMiddleware('auth');

        const app = await createServer(
            baseConfig()
                .middlewares([auth.middleware])
                .routes(defineRouter({ ping }).use([auth.middleware]))
                .build(),
        );

        const res = await app.request('/ping');

        expect(res.status).toBe(200);
        expect(auth.count()).toBe(1);
    });

    it('keeps unnamed middlewares distinct instead of collapsing them by empty name', async () =>
    {
        const first = anonymousCounter();
        const second = anonymousCounter();

        const app = await createServer(
            baseConfig()
                .middlewares([first.middleware, second.middleware])
                .routes(defineRouter({ ping }))
                .build(),
        );

        const res = await app.request('/ping');

        expect(res.status).toBe(200);
        expect(first.count()).toBe(1);
        expect(second.count()).toBe(1);
    });

    it('still honours .skip() against a router-level middleware', async () =>
    {
        const auth = countingMiddleware('auth');

        const publicRoute = route.get('/public')
            .skip(['auth'])
            .handler(async () => ({ ok: true }));

        const app = await createServer(
            baseConfig()
                .routes(defineRouter({ ping, publicRoute }).use([auth.middleware]))
                .build(),
        );

        expect((await app.request('/public')).status).toBe(200);
        expect(auth.count()).toBe(0);

        expect((await app.request('/ping')).status).toBe(200);
        expect(auth.count()).toBe(1);
    });

    it('applies each router\'s .use() to its own routes, once', async () =>
    {
        const appMw = countingMiddleware('appLevel');
        const pkgMw = countingMiddleware('pkgLevel');

        const pkgPing = route.get('/pkg/ping').handler(async () => ({ ok: true }));
        const pkgRouter = defineRouter({ pkgPing }).use([pkgMw.middleware]);

        const app = await createServer(
            baseConfig()
                .routes(defineRouter({ ping }).packages([pkgRouter]).use([appMw.middleware]))
                .build(),
        );

        // App route: the app router's middleware only.
        expect((await app.request('/ping')).status).toBe(200);
        expect(appMw.count()).toBe(1);
        expect(pkgMw.count()).toBe(0);

        // Package route: the app router's middleware (it covers package routes too)
        // plus the package router's own — each once.
        expect((await app.request('/pkg/ping')).status).toBe(200);
        expect(appMw.count()).toBe(2);
        expect(pkgMw.count()).toBe(1);
    });

    it('leaves router-level middleware out of config.middlewares', async () =>
    {
        const auth = countingMiddleware('auth');

        const config = baseConfig()
            .routes(defineRouter({ ping }).use([auth.middleware]))
            .build();

        expect(config.middlewares).toBeUndefined();
    });
});

describe('resolveEndpointMiddlewares', () =>
{
    it('guards server-registered endpoints with both levels of middleware', () =>
    {
        const configMw = countingMiddleware('configLevel').middleware;
        const routerMw = countingMiddleware('routerLevel').middleware;
        const pkgMw = countingMiddleware('pkgLevel').middleware;

        const pkgPing = route.get('/pkg/ping').handler(async () => ({ ok: true }));
        const pkgRouter = defineRouter({ pkgPing }).use([pkgMw]);

        const config = defineServerConfig()
            .middlewares([configMw])
            .routes(defineRouter({ ping }).packages([pkgRouter]).use([routerMw]))
            .build();

        expect(resolveEndpointMiddlewares(config).map(mw => mw.name))
            .toEqual(['configLevel', 'routerLevel', 'pkgLevel']);
    });

    it('names a middleware registered at both levels once', () =>
    {
        const auth = countingMiddleware('auth').middleware;

        const config = defineServerConfig()
            .middlewares([auth])
            .routes(defineRouter({ ping }).use([auth]))
            .build();

        expect(resolveEndpointMiddlewares(config).map(mw => mw.name)).toEqual(['auth']);
    });
});

// ============================================================================
// Router-level skips (spfn/spfn#165)
// ============================================================================

/**
 * Named middlewares that write their name to one shared log as they run, so a
 * request shows the chain it ran, in order.
 */
function chainRecorder()
{
    const log: string[] = [];

    const middleware = (name: string, skips?: string[]) => defineMiddleware(name, async (_c, next) =>
    {
        log.push(name);
        await next();
    }, skips ? { skips } : undefined);

    /** The chain one request to `path` ran; the route must answer. */
    const ran = async (app: Hono, path: string) =>
    {
        log.length = 0;
        expect((await app.request(path)).status).toBe(200);

        return [...log];
    };

    return { middleware, ran };
}

const get = (path: string) => route.get(path).handler(async () => ({ ok: true }));

/** A route that counts how often its handler is reached. */
function counting(path: string)
{
    let count = 0;

    return {
        route: route.get(path).handler(async () =>
        {
            count += 1;

            return { ok: true };
        }),
        count: () => count,
    };
}

describe('router-level skips (#165)', () =>
{
    it('R1: the issue\'s tree — machine routes run their authenticator in place of auth, every other route keeps auth', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const auth = middleware('auth');
        const machineAuth = middleware('machineAuth', ['auth']);
        const machineLimit = middleware('machineLimit');

        const machine = defineRouter({ machineA: get('/machine/a'), machineB: get('/machine/b') })
            .use([machineAuth, machineLimit]);
        const pkg = defineRouter({ pkgSession: get('/pkg/session') });
        const app = await createServer(
            baseConfig()
                .routes(defineRouter({ machine, person: get('/person') }).packages([pkg]).use([auth]))
                .build(),
        );

        expect(await ran(app, '/machine/a')).toEqual(['machineAuth', 'machineLimit']);
        expect(await ran(app, '/machine/b')).toEqual(['machineAuth', 'machineLimit']);
        expect(await ran(app, '/person')).toEqual(['auth']);
        expect(await ran(app, '/pkg/session')).toEqual(['auth']);
    });

    it('R2: a skipper never removes a sibling in the same .use()', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const app = await createServer(
            baseConfig()
                .routes(defineRouter({ ping }).use([middleware('auth'), middleware('machineAuth', ['auth'])]))
                .build(),
        );

        expect(await ran(app, '/ping')).toEqual(['auth', 'machineAuth']);
    });

    it('R3: the removal reaches every route below the skipper, however deep', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const deep = defineRouter({ deepRoute: get('/m/sub/deep') });
        const sub = defineRouter({ subRoute: get('/m/sub'), deep });
        const machine = defineRouter({ sub }).use([middleware('machineAuth', ['auth'])]);
        const app = await createServer(
            baseConfig().routes(defineRouter({ machine }).use([middleware('auth')])).build(),
        );

        expect(await ran(app, '/m/sub')).toEqual(['machineAuth']);
        expect(await ran(app, '/m/sub/deep')).toEqual(['machineAuth']);
    });

    it('R4: an inner router that .use()s the removed middleware again runs it, after the skipper', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const auth = middleware('auth');
        const both = defineRouter({ bothRoute: get('/m/both') }).use([auth]);
        const machine = defineRouter({ both }).use([middleware('machineAuth', ['auth'])]);
        const app = await createServer(baseConfig().routes(defineRouter({ machine }).use([auth])).build());

        expect(await ran(app, '/m/both')).toEqual(['machineAuth', 'auth']);
    });

    it('R5: a route that .use()s the removed middleware again runs it, after the skipper', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const auth = middleware('auth');
        const machine = defineRouter({ both: route.get('/m/both').use([auth]).handler(async () => ({ ok: true })) })
            .use([middleware('machineAuth', ['auth'])]);
        const app = await createServer(baseConfig().routes(defineRouter({ machine }).use([auth])).build());

        expect(await ran(app, '/m/both')).toEqual(['machineAuth', 'auth']);
    });

    it('R6: a route that skips the skipper gets the inherited auth back', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const machine = defineRouter({ person: route.get('/m/person').skip(['machineAuth']).handler(async () => ({ ok: true })) })
            .use([middleware('machineAuth', ['auth'])]);
        const app = await createServer(baseConfig().routes(defineRouter({ machine }).use([middleware('auth')])).build());

        expect(await ran(app, '/m/person')).toEqual(['auth']);
    });

    it('R7: .skip(\'*\') drops everything inherited, the skipper and what it skipped alike', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const open = route.get('/m/open').skip('*').use([middleware('own')]).handler(async () => ({ ok: true }));
        const machine = defineRouter({ open }).use([middleware('machineAuth', ['auth'])]);
        const app = await createServer(baseConfig().routes(defineRouter({ machine }).use([middleware('auth')])).build());

        expect(await ran(app, '/m/open')).toEqual(['own']);
    });

    it('R8: a top-router skipper removes the server-level middleware it names', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const app = await createServer(
            baseConfig()
                .middlewares([middleware('auth')])
                .routes(defineRouter({ ping }).use([middleware('machineAuth', ['auth'])]))
                .build(),
        );

        expect(await ran(app, '/ping')).toEqual(['machineAuth']);
    });

    it('R9/R10: the same skipper at two levels runs once, outermost, and its inner declaration still skips', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const skipper = middleware('skipper', ['middle']);
        const inner = defineRouter({ innerRoute: get('/inner') }).use([skipper]);
        const mid = defineRouter({ inner }).use([middleware('middle')]);
        const app = await createServer(baseConfig().routes(defineRouter({ mid }).use([skipper])).build());

        expect(await ran(app, '/inner')).toEqual(['skipper']);
    });

    it('R11: the chain keeps its order — server, outer router, inner router, route', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const leaf = route.get('/leaf').use([middleware('own')]).handler(async () => ({ ok: true }));
        const mid = defineRouter({ leaf }).use([middleware('machineAuth', ['auth']), middleware('midLevel')]);
        const app = await createServer(
            baseConfig()
                .middlewares([middleware('auth'), middleware('serverLevel')])
                .routes(defineRouter({ mid }).use([middleware('topLevel')]))
                .build(),
        );

        expect(await ran(app, '/leaf')).toEqual(['serverLevel', 'topLevel', 'machineAuth', 'midLevel', 'own']);
    });

    /**
     * The tree holds the two shapes main registers oddly and the resolver must
     * keep as they were: a package mounting a package (`.packages()` copies the
     * inner one up, so its route registers twice and the first chain answers),
     * and a route with no path (skipped with a warning, registered nowhere).
     */
    it('R13: every route runs exactly the chain the resolver reports for it', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const auth = middleware('auth');
        const machineAuth = middleware('machineAuth', ['auth']);
        const machine = defineRouter({
            plain: get('/m/plain'),
            reAdded: route.get('/m/re-added').use([auth]).handler(async () => ({ ok: true })),
            person: route.get('/m/person').skip(['machineAuth']).handler(async () => ({ ok: true })),
            open: route.get('/m/open').skip('*').handler(async () => ({ ok: true })),
            nested: defineRouter({ nestedRoute: get('/m/nested') }).use([auth, middleware('nestedLevel')]),
        }).use([machineAuth, middleware('machineLevel')]);
        const optional = route.get('/optional').use([middleware('optionalAuth', ['auth'])]).handler(async () => ({ ok: true }));
        const innerPkg = defineRouter({ innerPkgRoute: get('/pkg/inner') }).use([middleware('innerPkgLevel')]);
        const pkg = defineRouter({ pkgRoute: get('/pkg') }).packages([innerPkg]).use([middleware('pkgLevel')]);
        const pathless = route.get('').handler(async () => ({ ok: true }));
        const tree = defineRouter({ machine, optional, pathless, person: get('/person') }).packages([pkg]).use([auth]);
        const serverList = [middleware('serverLevel')];

        const app = new Hono();
        const registered = registerRoutes(app, tree, serverList);
        const resolved = resolveRouteMiddlewares(tree, serverList);

        expect(registered.map(r => r.path)).toEqual(
            ['/m/plain', '/m/re-added', '/m/person', '/m/open', '/m/nested', '/optional', '/person', '/pkg', '/pkg/inner', '/pkg/inner'],
        );
        expect(resolved.map(r => r.path)).toEqual(registered.map(r => r.path));

        const answering = new Map<string, string[]>();
        for (const [index, entry] of resolved.entries())
        {
            const names = entry.middlewares.map(mw => mw.name);
            expect(registered[index]!.middlewares, entry.path).toEqual(names);
            answering.set(entry.path, answering.get(entry.path) ?? names);
            expect(await ran(app, entry.path), entry.path).toEqual(answering.get(entry.path));
        }

        expect(answering.get('/pkg/inner')).toEqual(['serverLevel', 'auth', 'pkgLevel', 'innerPkgLevel']);
        expect(resolved.filter(r => r.path === '/pkg/inner')[1]!.middlewares.map(mw => mw.name)).toEqual(['serverLevel', 'auth', 'innerPkgLevel']);
    });

    it('R14: refuses a skipper on a router that mounts .packages(), or on any router enclosing the mount', async () =>
    {
        const { middleware } = chainRecorder();
        const machineAuth = middleware('machineAuth', ['auth']);
        const pkg = defineRouter({ pkgRoute: get('/pkg') });
        const boot = (routes: ReturnType<typeof defineRouter>) =>
            createServer(baseConfig().middlewares([middleware('auth')]).routes(routes).build());

        await expect(boot(defineRouter({ ping }).packages([pkg]).use([machineAuth]))).rejects.toThrow(
            'Router "(top-level)" .use()s "machineAuth", a middleware declaring skips: [\'auth\'], '
            + 'and the package router "packages[0]" (mounted with .packages()) sits below it. Package routes have no authenticator of their own, '
            + 'so "machineAuth" would remove the auth they inherit from every one of them. '
            + 'Put "machineAuth" on a nested router that holds no package router, or on the routes themselves.',
        );

        const enclosing = defineRouter({ machine: defineRouter({ inner: defineRouter({ ping }).packages([pkg]) }).use([machineAuth]) });
        await expect(boot(enclosing)).rejects.toThrow(
            'Router "machine" .use()s "machineAuth", a middleware declaring skips: [\'auth\'], '
            + 'and the package router "machine.inner.packages[0]" (mounted with .packages()) sits below it.',
        );
    });

    /**
     * rv389 P1/P2: what makes a router a package's is the package saying so,
     * not how the app mounted it. A marked router entered as a plain key
     * (`defineRouter({ auth: authRouter })`) is the shape auth's own JSDoc showed.
     */
    it('R16: refuses a skipper above a router its package marked, wherever it is mounted', async () =>
    {
        const { middleware } = chainRecorder();
        const optionalAuth = middleware('optionalAuth', ['auth']);
        const pkg = defineRouter({ pkgSession: get('/pkg/session') }, { packageName: '@acme/pkg' });
        const server = [middleware('auth')];
        const refusal = (label: string, skipperRouter: string) =>
            `Router "${skipperRouter}" .use()s "optionalAuth", a middleware declaring skips: ['auth'], `
            + `and the package router "${label}" (defined by @acme/pkg) sits below it.`;

        expect(() => resolveRouteMiddlewares(defineRouter({ pkg }).use([optionalAuth]), server))
            .toThrow(refusal('pkg', '(top-level)'));
        expect(() => resolveRouteMiddlewares(defineRouter({ outer: defineRouter({ deep: defineRouter({ pkg }) }) }).use([optionalAuth]), server))
            .toThrow(refusal('outer.deep.pkg', '(top-level)'));
        expect(() => resolveRouteMiddlewares(defineRouter({ ok: defineRouter({ pkg }), opt: defineRouter({ pkg }).use([optionalAuth]) }), server))
            .toThrow(refusal('opt.pkg', 'opt'));
        expect(() => resolveRouteMiddlewares(defineRouter({ pkg: pkg.use([middleware('pkgLevel')]) }).use([optionalAuth]), server))
            .toThrow(refusal('pkg', '(top-level)'));
    });

    it('R17: a marked router mounted as a plain entry under a skipper never boots, so no anonymous request reaches its route', async () =>
    {
        const { middleware } = chainRecorder();
        const pkgRoute = counting('/pkg/session');
        const pkg = defineRouter({ pkgSession: pkgRoute.route }, { packageName: '@acme/pkg' });
        const app = new Hono();

        expect(() => registerRoutes(app, defineRouter({ pkg }).use([middleware('optionalAuth', ['auth'])]), [middleware('auth')]))
            .toThrow('(defined by @acme/pkg)');
        expect((await app.request('/pkg/session')).status).toBe(404);
        expect(pkgRoute.count()).toBe(0);
    });

    /**
     * i165f2: a skipper in the package router's own `.use()` removes the
     * inherited `auth` from every package route just as one above it does, and
     * an app's `.use()` on the package router is indistinguishable from the
     * package's own — so "at or above", not "strictly above".
     */
    it('R19: refuses a skipper in a package router\'s own .use(), through .packages() and as a plain entry, attaching nothing', async () =>
    {
        const { middleware } = chainRecorder();
        const pkgRoute = counting('/pkg/session');
        const pkg = defineRouter({ pkgSession: pkgRoute.route }, { packageName: '@acme/pkg' }).use([middleware('optionalAuth', ['auth'])]);
        const refusal = (label: string) =>
            `Package router "${label}" (defined by @acme/pkg) .use()s "optionalAuth", a middleware declaring skips: ['auth']. `
            + 'Package routes have no authenticator of their own, so "optionalAuth" would remove the auth they inherit from every one of them. '
            + 'Put "optionalAuth" on the routes that need it, or on a nested router inside the package router that holds no package router.';

        for (const [label, tree] of [['packages[0]', defineRouter({ ping }).packages([pkg])], ['pkg', defineRouter({ ping, pkg })]] as const)
        {
            const app = new Hono();

            expect(() => registerRoutes(app, tree, [middleware('auth')])).toThrow(refusal(label));
            expect((await app.request('/pkg/session')).status).toBe(404);
            expect((await app.request('/ping')).status).toBe(404);
        }
        expect(pkgRoute.count()).toBe(0);
    });

    it('R20: refuses a skipper in the own .use() of an unmarked router mounted with .packages(), and admits one on a nested router inside a package router', () =>
    {
        const { middleware } = chainRecorder();
        const optionalAuth = middleware('optionalAuth', ['auth']);
        const server = [middleware('auth')];

        expect(() => resolveRouteMiddlewares(defineRouter({ ping }).packages([defineRouter({ pkgRoute: get('/pkg') }).use([optionalAuth])]), server))
            .toThrow('Package router "packages[0]" (mounted with .packages()) .use()s "optionalAuth"');

        const pkg = defineRouter({ session: get('/pkg/session'), feed: defineRouter({ feedRoute: get('/pkg/feed') }).use([optionalAuth]) }, { packageName: '@acme/pkg' });
        expect(resolveRouteMiddlewares(defineRouter({ ping }).packages([pkg]), server).map(r => [r.path, r.middlewares.map(mw => mw.name)])).toEqual([
            ['/ping', ['auth']],
            ['/pkg/session', ['auth']],
            ['/pkg/feed', ['optionalAuth']],
        ]);
    });

    it('R18: a marked router under no skipper keeps the inherited auth on every route', () =>
    {
        const { middleware } = chainRecorder();
        const pkg = defineRouter({ pkgSession: get('/pkg/session') }, { packageName: '@acme/pkg' });
        const chain = resolveRouteMiddlewares(defineRouter({ pkg, feed: route.get('/feed').use([middleware('optionalAuth', ['auth'])]).handler(async () => ({ ok: true })) }), [middleware('auth')]);

        expect(chain.map(r => [r.path, r.middlewares.map(mw => mw.name)])).toEqual([
            ['/pkg/session', ['auth']],
            ['/feed', ['optionalAuth']],
        ]);
    });

    it('R15: a route-level skipper still removes the inherited middleware it names', async () =>
    {
        const { middleware, ran } = chainRecorder();
        const feed = route.get('/feed').use([middleware('optionalAuth', ['auth'])]).handler(async () => ({ ok: true }));
        const app = await createServer(baseConfig().routes(defineRouter({ feed }).use([middleware('auth')])).build());

        expect(await ran(app, '/feed')).toEqual(['optionalAuth']);
    });

    it('R12: the SSE/WS token endpoint keeps the top router\'s auth beside a top-router skipper', () =>
    {
        const { middleware } = chainRecorder();
        const config = defineServerConfig()
            .middlewares([middleware('auth')])
            .routes(defineRouter({ ping }).use([middleware('optionalAuth', ['auth'])]))
            .build();

        expect(resolveEndpointMiddlewares(config).map(mw => mw.name)).toEqual(['auth', 'optionalAuth']);
    });
});

// ============================================================================
// Factory calls (#168)
// ============================================================================

/**
 * A server-level `auth` refusing a request without `Authorization`, and a
 * `scope` factory refusing one whose `X-Scopes` lacks its argument. Every run
 * is logged, so a request shows the chain it ran.
 */
function guards(scopeSkips?: string[])
{
    const log: string[] = [];

    const auth = defineMiddleware('auth', async (c, next) =>
    {
        log.push('auth');

        return c.req.header('Authorization') ? await next() : c.json({ refused: 'auth' }, 401);
    });

    const scope = defineMiddlewareFactory('scope', (needed: string) => async (c, next) =>
    {
        log.push(`scope:${needed}`);
        const granted = (c.req.header('X-Scopes') ?? '').split(',');

        return granted.includes(needed) ? await next() : c.json({ refused: needed }, 403);
    }, scopeSkips ? { skips: scopeSkips } : undefined);

    /** Register `router` under the server-level `auth`; answer status and chain per request. */
    const serve = (router: ReturnType<typeof defineRouter>) =>
    {
        const app = new Hono();
        registerRoutes(app, router, [auth]);

        return async (path: string, headers: Record<string, string> = {}) =>
        {
            log.length = 0;
            const { status } = await app.request(path, { headers: { Authorization: 'Bearer t', ...headers } });

            return { status, ran: [...log] };
        };
    };

    return { log, auth, scope, serve };
}

describe('factory calls (#168)', () =>
{
    it('F1: a route\'s .skip([name]) removes a router-level call of the factory', async () =>
    {
        const { scope, serve } = guards();
        const request = serve(defineRouter({
            open: route.get('/open').skip(['scope']).handler(async () => ({ ok: true })),
            closed: get('/closed'),
        }).use([scope('admin')]));

        expect(await request('/open')).toEqual({ status: 200, ran: ['auth'] });
        expect(await request('/closed')).toEqual({ status: 403, ran: ['auth', 'scope:admin'] });
    });

    it('F2: a router-level call and a stricter route-level call of the same factory both run', async () =>
    {
        const { scope, serve } = guards();
        const request = serve(defineRouter({
            read: get('/read'),
            write: route.get('/write').use([scope('write')]).handler(async () => ({ ok: true })),
        }).use([scope('read')]));

        expect(await request('/write', { 'X-Scopes': 'read' })).toEqual({ status: 403, ran: ['auth', 'scope:read', 'scope:write'] });
        expect(await request('/write', { 'X-Scopes': 'read,write' })).toEqual({ status: 200, ran: ['auth', 'scope:read', 'scope:write'] });
        expect(await request('/read', { 'X-Scopes': 'read' })).toEqual({ status: 200, ran: ['auth', 'scope:read'] });
    });

    it('F3: one call\'s result referenced at router and route level runs once', async () =>
    {
        const { scope, serve } = guards();
        const admin = scope('admin');
        const request = serve(defineRouter({
            both: route.get('/both').use([admin]).handler(async () => ({ ok: true })),
        }).use([admin]));

        expect(await request('/both', { 'X-Scopes': 'admin' })).toEqual({ status: 200, ran: ['auth', 'scope:admin'] });
    });

    it('F4: a factory\'s skips apply to each call — the route skips the inherited auth, and a router call above a package router is refused', async () =>
    {
        const { scope, serve } = guards(['auth']);
        const request = serve(defineRouter({
            door: route.get('/door').use([scope('north')]).handler(async () => ({ ok: true })),
            ping,
        }));

        expect(await request('/door', { Authorization: '', 'X-Scopes': 'north' })).toEqual({ status: 200, ran: ['scope:north'] });
        expect(await request('/ping', { Authorization: '' })).toEqual({ status: 401, ran: ['auth'] });

        const pkg = defineRouter({ pkgSession: get('/pkg/session') });
        expect(() => serve(defineRouter({ ping }).packages([pkg]).use([scope('north')]))).toThrow(
            'Router "(top-level)" .use()s "scope", a middleware declaring skips: [\'auth\'], '
            + 'and the package router "packages[0]" (mounted with .packages()) sits below it.',
        );
    });

    it('F5: defineMiddleware takes a one-parameter function for the handler, not for a factory', async () =>
    {
        const { serve } = guards();
        const teapot = defineMiddleware('teapot', async (c: Context) => c.json({ from: 'teapot' }, 418));
        const request = serve(defineRouter({ pot: route.get('/pot').use([teapot]).handler(async () => ({ ok: true })) }));

        expect(await request('/pot')).toEqual({ status: 418, ran: ['auth'] });
    });

    it('F7: two calls of a factory that return one shared handler both run; one call at two levels runs once', async () =>
    {
        const { log, serve } = guards();
        const shared: MiddlewareHandler = async (_c, next) =>
        {
            log.push('shared');
            await next();
        };
        const cached = defineMiddlewareFactory('cached', () => shared);
        const once = cached();
        const request = serve(defineRouter({
            twice: route.get('/twice').use([cached()]).handler(async () => ({ ok: true })),
            once: route.get('/once').use([once]).handler(async () => ({ ok: true })),
        }).use([cached(), once]));

        expect(await request('/twice')).toEqual({ status: 200, ran: ['auth', 'shared', 'shared', 'shared'] });
        expect(await request('/once')).toEqual({ status: 200, ran: ['auth', 'shared', 'shared'] });
    });
});
