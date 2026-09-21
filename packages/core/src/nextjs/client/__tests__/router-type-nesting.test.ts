/**
 * `RouterOutput` / `RouterInput` / `Client` 중첩 라우터 타입 회귀 테스트
 *
 * ✅ 테스트 범위:
 * - 평면 라우터의 output/input 타입과 클라이언트 표면이 그대로 유지되는지
 * - 중첩 라우터(1단계·3단계·4단계) 안의 라우트가 자기 이름으로 해석되는지
 * - 트리 어디에도 없는 이름은 타입 에러가 나는지
 * - 서로 다른 가지에서 같은 이름을 선언하면 이름 자체가 빠지는지
 * - 빈 라우터 / 빈 중첩 라우터가 트리 전체를 망가뜨리지 않는지
 * - `.packages()` 라우트는 평면 이름 공간에 들어오지 않는지
 * - `Router<any>`가 "모든 이름이 존재"로 퍼지지 않는지
 * - `Client`가 그룹 키가 아니라 라우트 이름을 노출하는지, 프록시가 그 이름을 보내는지
 *
 * 🔗 관련 파일:
 * - src/nextjs/client/types.ts (ExtractRoutes, RouterOutput, RouterInput)
 * - src/nextjs/client/builder.ts (Client, RouteClient)
 * - src/nextjs/client/core.ts (createApi — buildProxy가 보내는 평면 라우트 이름)
 * - src/route/register-routes.ts (registerRoutes — 중첩 라우터를 평면 이름으로 등록)
 * - src/contract/collect.ts (동일한 순회와 이름 중복 거부)
 */

import { describe, it, expect, expectTypeOf, afterEach, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineRouter, route } from '../../../route';
import type { RouteDef, Router } from '../../../route';
import { createApi } from '../core';
import type { Client, RouteClient } from '../builder';
import type { RouterInput, RouterOutput } from '../types';

interface User
{
    id: string;
    name: string;
}

const getUser = route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (): Promise<User> => ({ id: '1', name: 'Ada' }));

const createUser = route.post('/users')
    .input({ body: Type.Object({ name: Type.String() }) })
    .handler(async (): Promise<User> => ({ id: '1', name: 'Ada' }));

const listPosts = route.get('/posts')
    .input({ query: Type.Object({ page: Type.Number() }) })
    .handler(async (): Promise<{ total: number }> => ({ total: 0 }));

const getRoot = route.get('/')
    .handler(async (): Promise<{ ok: true }> => ({ ok: true }));

const ping = route.get('/ping')
    .handler(async (): Promise<'pong'> => 'pong');

describe('RouterOutput / RouterInput — flat router', () =>
{
    const flatRouter = defineRouter({ getUser, createUser });

    it('resolves output and input by route name', () =>
    {
        expectTypeOf<RouterOutput<typeof flatRouter, 'getUser'>>().toEqualTypeOf<User>();
        expectTypeOf<RouterInput<typeof flatRouter, 'getUser'>['params']>().toEqualTypeOf<{ id: string }>();
        expectTypeOf<RouterInput<typeof flatRouter, 'createUser'>['body']>().toEqualTypeOf<{ name: string }>();

        expect(Object.keys(flatRouter.routes)).toEqual(['getUser', 'createUser']);
    });

    it('rejects a name the router does not declare', () =>
    {
        // @ts-expect-error - 'nope' is not a route on flatRouter
        expectTypeOf<RouterOutput<typeof flatRouter, 'nope'>>();

        expect(true).toBe(true);
    });
});

describe('RouterOutput / RouterInput — nested routers', () =>
{
    const nestedRouter = defineRouter({
        getRoot,
        users: defineRouter({ getUser, createUser }),
    });

    const deepRouter = defineRouter({
        getRoot,
        api: defineRouter({
            v1: defineRouter({
                users: defineRouter({ getUser }),
            }),
        }),
    });

    const deeperRouter = defineRouter({
        a: defineRouter({
            b: defineRouter({
                c: defineRouter({
                    d: defineRouter({ ping }),
                }),
            }),
        }),
    });

    it('resolves a route declared one level down by its own name', () =>
    {
        expectTypeOf<RouterOutput<typeof nestedRouter, 'getUser'>>().toEqualTypeOf<User>();
        expectTypeOf<RouterInput<typeof nestedRouter, 'getUser'>['params']>().toEqualTypeOf<{ id: string }>();
        expectTypeOf<RouterOutput<typeof nestedRouter, 'getRoot'>>().toEqualTypeOf<{ ok: true }>();
    });

    it('gives a nested route the same type it has when declared flat', () =>
    {
        const flatRouter = defineRouter({ getUser });

        expectTypeOf<RouterOutput<typeof nestedRouter, 'getUser'>>()
            .toEqualTypeOf<RouterOutput<typeof flatRouter, 'getUser'>>();
        expectTypeOf<RouterInput<typeof nestedRouter, 'getUser'>>()
            .toEqualTypeOf<RouterInput<typeof flatRouter, 'getUser'>>();
    });

    it('flattens three and four levels into one namespace', () =>
    {
        expectTypeOf<RouterOutput<typeof deepRouter, 'getUser'>>().toEqualTypeOf<User>();
        expectTypeOf<RouterOutput<typeof deeperRouter, 'ping'>>().toEqualTypeOf<'pong'>();
    });

    it('keeps the group key out of the namespace and rejects an undeclared name', () =>
    {
        // @ts-expect-error - 'users' is a group, not a route
        expectTypeOf<RouterOutput<typeof nestedRouter, 'users'>>();

        // @ts-expect-error - 'listPosts' is declared in no branch of this tree
        expectTypeOf<RouterOutput<typeof deepRouter, 'listPosts'>>();

        expect(true).toBe(true);
    });

    it('carries no optional or readonly modifier out of the source record', () =>
    {
        // A route key that arrived optional must not hand `RouteDef | undefined` to the
        // inference — `InferRouteInput` would return a different type for it.
        expectTypeOf<RouterOutput<{ getUser?: typeof getUser }, 'getUser'>>().toEqualTypeOf<User>();
        expectTypeOf<RouterOutput<{ readonly getUser: typeof getUser }, 'getUser'>>().toEqualTypeOf<User>();
        expectTypeOf<RouterInput<{ getUser?: typeof getUser }, 'getUser'>['params']>()
            .toEqualTypeOf<{ id: string }>();
    });
});

describe('RouterOutput / RouterInput — ambiguous names', () =>
{
    const duplicateRouter = defineRouter({
        users: defineRouter({ getUser }),
        admins: defineRouter({ getUser: createUser }),
    });

    it('leaves a name declared in two branches out of the namespace', () =>
    {
        // @ts-expect-error - 'getUser' is declared in two branches, so it names no single route
        expectTypeOf<RouterOutput<typeof duplicateRouter, 'getUser'>>();

        expect(true).toBe(true);
    });

    it('counts two places by where they are, not by the type held there', () =>
    {
        // One slot whose value is a union of two routes is still one route, and its output
        // is the union — the same answer a flat router gave before nesting was flattened.
        const either = null as unknown as typeof getUser | typeof listPosts;
        const unionRouter = defineRouter({ either, getRoot });

        expectTypeOf<RouterOutput<typeof unionRouter, 'either'>>()
            .toEqualTypeOf<User | { total: number }>();
    });

    it('does not let a loose route record erase the names beside it', () =>
    {
        // `Record<string, RouteDef>` contributes the name `string`, which swallows every
        // literal name in the union of names. The tree still resolves through it rather
        // than collapsing to no names at all.
        const loose = null as unknown as Router<{
            getRoot: typeof getRoot;
            group: Router<Record<string, RouteDef<any, any, { ok: boolean }>>>;
        }>;

        expectTypeOf<RouterOutput<typeof loose, 'getRoot'>>().toEqualTypeOf<{ ok: boolean }>();
    });

    it('still resolves the unambiguous names around it', () =>
    {
        const mixed = defineRouter({
            getRoot,
            users: defineRouter({ getUser }),
            admins: defineRouter({ getUser: createUser }),
        });

        expectTypeOf<RouterOutput<typeof mixed, 'getRoot'>>().toEqualTypeOf<{ ok: true }>();
    });
});

describe('RouterOutput / RouterInput — empty and hidden routes', () =>
{
    const emptyRouter = defineRouter({});

    const withEmptyChild = defineRouter({
        getRoot,
        nothing: defineRouter({}),
        alsoNothing: defineRouter({ deeper: defineRouter({}) }),
    });

    it('types an empty router as a namespace with no routes', () =>
    {
        // @ts-expect-error - an empty router declares no route names at all
        expectTypeOf<RouterOutput<typeof emptyRouter, 'getRoot'>>();

        expect(Object.keys(emptyRouter.routes)).toEqual([]);
    });

    it('keeps the rest of the tree usable next to an empty nested router', () =>
    {
        expectTypeOf<RouterOutput<typeof withEmptyChild, 'getRoot'>>().toEqualTypeOf<{ ok: true }>();
    });

    it('keeps .packages() routes out of the flat namespace', () =>
    {
        const packageRouter = defineRouter({ listPosts });
        const appRouter = defineRouter({
            getRoot,
            users: defineRouter({ getUser }),
        }).packages([packageRouter]);

        expectTypeOf<RouterOutput<typeof appRouter, 'getUser'>>().toEqualTypeOf<User>();

        // @ts-expect-error - a package route is served but deliberately hidden from client types
        expectTypeOf<RouterOutput<typeof appRouter, 'listPosts'>>();

        expect(true).toBe(true);
    });

    it('keeps .use() and .contractVersion() chaining transparent to the types', () =>
    {
        const chained = defineRouter({
            getRoot,
            users: defineRouter({ getUser }),
        }).use([]).contractVersion('1.0.0');

        expectTypeOf<RouterOutput<typeof chained, 'getUser'>>().toEqualTypeOf<User>();
    });
});

describe('RouterOutput / RouterInput — unresolved routes', () =>
{
    it('does not let Router<any> claim that every name exists', () =>
    {
        // @ts-expect-error - Router<any> knows no route names, so a name cannot be checked against it
        expectTypeOf<RouterOutput<Router<any>, 'getUser'>>();

        expect(true).toBe(true);
    });

    it('resolves a router reached through an intermediate generic', () =>
    {
        const appRouter = defineRouter({
            getRoot,
            users: defineRouter({ getUser }),
        });

        type Unwrap<TRouter extends Router<any>> = TRouter;

        type App = Unwrap<typeof appRouter>;

        expectTypeOf<RouterOutput<App, 'getUser'>>().toEqualTypeOf<User>();

        // @ts-expect-error - the generic is resolved, so a typo is still caught
        expectTypeOf<RouterOutput<App, 'getUsers'>>();

        expect(true).toBe(true);
    });

    it('terminates on a router type that refers to itself', () =>
    {
        interface SelfRouter extends Router<{ getRoot: typeof getRoot; self: SelfRouter }> {}

        // A cycle declares its names again at every depth, so each of them is ambiguous by
        // the same rule as two branches. What this guards is that the walk stops at the
        // nesting budget instead of failing with an instantiation-depth error.
        // @ts-expect-error - 'getRoot' is declared at every depth of the cycle
        expectTypeOf<RouterOutput<SelfRouter, 'getRoot'>>();

        expect(true).toBe(true);
    });
});

describe('Client — flat router', () =>
{
    const flatRouter = defineRouter({ getUser, createUser });

    it('exposes exactly one property per route, unchanged', () =>
    {
        expectTypeOf<Client<typeof flatRouter>>().toEqualTypeOf<{
            getUser: RouteClient<typeof getUser>;
            createUser: RouteClient<typeof createUser>;
        }>();
    });

    it('keeps the call signature of a route client', () =>
    {
        const api = null as unknown as Client<typeof flatRouter>;

        expectTypeOf<Parameters<typeof api.getUser.call>[0]['params']>().toEqualTypeOf<{ id: string }>();
        expectTypeOf<ReturnType<typeof api.getUser.call>>().toEqualTypeOf<Promise<User>>();
        expectTypeOf<Parameters<typeof api.createUser.call>[0]['body']>().toEqualTypeOf<{ name: string }>();
    });

    it('rejects a name the router does not declare', () =>
    {
        // @ts-expect-error - 'nope' is not a route on flatRouter
        expectTypeOf<Client<typeof flatRouter>['nope']>();

        expect(true).toBe(true);
    });
});

describe('Client — nested routers', () =>
{
    const nestedRouter = defineRouter({
        getRoot,
        users: defineRouter({ getUser, createUser }),
    });

    const deepRouter = defineRouter({
        getRoot,
        api: defineRouter({
            v1: defineRouter({
                users: defineRouter({ getUser }),
            }),
        }),
    });

    it('reaches a route declared one level down by its own name', () =>
    {
        const api = null as unknown as Client<typeof nestedRouter>;

        expectTypeOf<Parameters<typeof api.getUser.call>[0]['params']>().toEqualTypeOf<{ id: string }>();
        expectTypeOf<ReturnType<typeof api.getUser.call>>().toEqualTypeOf<Promise<User>>();
        expectTypeOf<ReturnType<typeof api.getRoot.call>>().toEqualTypeOf<Promise<{ ok: true }>>();
    });

    it('gives a nested route the same client it has when declared flat', () =>
    {
        const flatRouter = defineRouter({ getUser });

        expectTypeOf<Client<typeof nestedRouter>['getUser']>()
            .toEqualTypeOf<Client<typeof flatRouter>['getUser']>();
    });

    it('reaches a route declared four levels down by its own name', () =>
    {
        const api = null as unknown as Client<typeof deepRouter>;

        expectTypeOf<ReturnType<typeof api.getUser.call>>().toEqualTypeOf<Promise<User>>();
        expectTypeOf<ReturnType<typeof api.getRoot.call>>().toEqualTypeOf<Promise<{ ok: true }>>();
    });

    it('does not expose the group key, at any depth', () =>
    {
        // The group key is where the routes were written, not a name the server
        // registers — `api.users` was a call builder for a route named 'users' at
        // runtime, which the proxy cannot resolve.
        // @ts-expect-error - 'users' is a group, not a route
        expectTypeOf<Client<typeof nestedRouter>['users']>();

        // @ts-expect-error - 'api' is a group, not a route
        expectTypeOf<Client<typeof deepRouter>['api']>();

        // @ts-expect-error - a route declared in no branch of this tree
        expectTypeOf<Client<typeof deepRouter>['listPosts']>();

        expect(true).toBe(true);
    });

    it('matches the names RouterOutput takes', () =>
    {
        // The two layers must name a route the same way; a route that typed in one
        // and not the other is the defect this pair of commits closes.
        expectTypeOf<keyof Client<typeof deepRouter>>()
            .toEqualTypeOf<'getRoot' | 'getUser'>();
    });
});

describe('Client — names it refuses', () =>
{
    it('leaves a name declared in two branches out of the client', () =>
    {
        const duplicateRouter = defineRouter({
            getRoot,
            users: defineRouter({ getUser }),
            admins: defineRouter({ getUser: createUser }),
        });

        // @ts-expect-error - 'getUser' is declared in two branches, so it names no single route
        expectTypeOf<Client<typeof duplicateRouter>['getUser']>();

        // The unambiguous names around it are untouched.
        expectTypeOf<Client<typeof duplicateRouter>['getRoot']>()
            .toEqualTypeOf<RouteClient<typeof getRoot>>();
    });

    it('keeps .packages() routes out of the client', () =>
    {
        const packageRouter = defineRouter({ listPosts });
        const appRouter = defineRouter({
            getRoot,
            users: defineRouter({ getUser }),
        }).packages([packageRouter]);

        expectTypeOf<Client<typeof appRouter>['getUser']>()
            .toEqualTypeOf<RouteClient<typeof getUser>>();

        // @ts-expect-error - a package route is served, but called through the package's own client
        expectTypeOf<Client<typeof appRouter>['listPosts']>();

        expect(true).toBe(true);
    });

    it('does not let Router<any> claim that every property exists', () =>
    {
        // @ts-expect-error - Router<any> knows no route names, so the client has none
        expectTypeOf<Client<Router<any>>['getUser']>();

        expect(true).toBe(true);
    });

    it('maps a slot that is neither route nor router to never', () =>
    {
        // A well-typed `defineRouter` cannot hold one — the `Router` constraint refuses
        // it — so the slot is reached the only way it can be, through `Router<any>`.
        // `never` is what the client type said before nesting was flattened, and what it
        // still says: the slot names nothing callable.
        interface OddRouter extends Router<any>
        {
            _routes: { getRoot: typeof getRoot; notARoute: string };
        }

        expectTypeOf<Client<OddRouter>['getRoot']>().toEqualTypeOf<RouteClient<typeof getRoot>>();
        expectTypeOf<Client<OddRouter>['notARoute']>().toEqualTypeOf<never>();
    });
});

describe('createApi — inference and the name on the wire', () =>
{
    const packageRouter = defineRouter({ listPosts });

    const appRouter = defineRouter({
        getRoot,
        users: defineRouter({ getUser, createUser }),
    })
        .use([])
        .packages([packageRouter])
        .contractVersion('1.0.0');

    type AppRouter = typeof appRouter;

    afterEach(() =>
    {
        vi.unstubAllGlobals();
    });

    it('infers a generated AppRouter built with .use() and .packages()', () =>
    {
        const api = createApi<AppRouter>();

        expectTypeOf<Parameters<typeof api.getUser.call>[0]['params']>().toEqualTypeOf<{ id: string }>();
        expectTypeOf<ReturnType<typeof api.getUser.call>>().toEqualTypeOf<Promise<User>>();
        expectTypeOf<ReturnType<typeof api.getRoot.call>>().toEqualTypeOf<Promise<{ ok: true }>>();

        // @ts-expect-error - 'users' is where the routes were written, not a route
        expectTypeOf<Client<AppRouter>['users']>();

        // @ts-expect-error - a package route stays out of the app client
        expectTypeOf<Client<AppRouter>['listPosts']>();
    });

    it('sends a nested route under its own flat name', async () =>
    {
        const urls: string[] = [];

        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { cookie: '' });

        const api = createApi<AppRouter>({
            fetch: (async (url: string) =>
            {
                urls.push(url);

                return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
            }) as unknown as typeof fetch,
        });

        await api.getUser.call({ params: { id: '1' } });
        await api.createUser.call({ body: { name: 'Ada' } });

        // `getUser` is declared inside `users`, and the proxy sends the bare name —
        // which is what `registerRoutes` mounted and what the route map holds.
        expect(urls[0]).toContain('/api/rpc/getUser?input=');
        expect(urls[0]).not.toContain('/api/rpc/users');
        expect(urls[1]).toBe('/api/rpc/createUser');
    });
});

describe('Client — router shapes that could split the two layers', () =>
{
    // The walk follows ten levels of nesting. `Client` reads the same walk `RouterOutput`
    // does, so a route is visible to both or to neither; a route that typed in one place
    // and not the other is the split this pair of commits closes.
    const usersGroup = defineRouter({ getUser });

    const d1 = defineRouter({ ping });
    const d2 = defineRouter({ down: d1 });
    const d3 = defineRouter({ down: d2 });
    const d4 = defineRouter({ down: d3 });
    const d5 = defineRouter({ down: d4 });
    const d6 = defineRouter({ down: d5 });
    const d7 = defineRouter({ down: d6 });
    const d8 = defineRouter({ down: d7 });
    const d9 = defineRouter({ down: d8 });
    const d10 = defineRouter({ down: d9 });
    const d11 = defineRouter({ down: d10 });
    const d12 = defineRouter({ down: d11 });

    it('spends the same nesting budget as RouterOutput', () =>
    {
        const atBudget = null as unknown as Client<typeof d11>;

        expectTypeOf<ReturnType<typeof atBudget.ping.call>>().toEqualTypeOf<Promise<'pong'>>();
        expectTypeOf<RouterOutput<typeof d11, 'ping'>>().toEqualTypeOf<'pong'>();

        // @ts-expect-error - one level past the budget, for the client…
        expectTypeOf<Client<typeof d12>['ping']>();

        // @ts-expect-error - …and for RouterOutput, which must not disagree
        expectTypeOf<RouterOutput<typeof d12, 'ping'>>();
    });

    it('refuses a name reached through one sub-router mounted twice', () =>
    {
        const shared = defineRouter({ getUser });
        const twice = defineRouter({ getRoot, a: shared, b: shared });

        // @ts-expect-error - 'getUser' is reached by two trails, so it names no single route
        expectTypeOf<Client<typeof twice>['getUser']>();

        expectTypeOf<Client<typeof twice>['getRoot']>().toEqualTypeOf<RouteClient<typeof getRoot>>();
    });

    it('carries no optional or readonly modifier into the client', () =>
    {
        // A route key that arrived optional would hand `RouteDef | undefined` to
        // `RouteClient`, and a readonly one would make `api.getUser` readonly for no
        // reason the router expressed. The flat namespace is a fresh mapped type, so
        // neither modifier survives it.
        interface ModifiedRouter extends Router<any>
        {
            _routes: { readonly getUser: typeof getUser; createUser?: typeof createUser };
        }

        expectTypeOf<Client<ModifiedRouter>>().toEqualTypeOf<{
            getUser: RouteClient<typeof getUser>;
            createUser: RouteClient<typeof createUser>;
        }>();
    });

    it('reads a slot that is either a route or a router the way RouterOutput reads it', () =>
    {
        // Degenerate, but it is the shape that could split the two layers: one branch
        // makes the key a route name, the other makes it a group. Both layers take both
        // readings, because both read the same walk — the client does not get an opinion
        // of its own here.
        const slot = null as unknown as typeof getUser | typeof usersGroup;
        const eitherRouter = defineRouter({ getRoot, slot });

        expectTypeOf<keyof Client<typeof eitherRouter>>().toEqualTypeOf<'getRoot' | 'slot' | 'getUser'>();
        expectTypeOf<Client<typeof eitherRouter>['slot']>().toEqualTypeOf<RouteClient<typeof getUser>>();
        expectTypeOf<RouterOutput<typeof eitherRouter, 'slot'>>().toEqualTypeOf<User>();
        expectTypeOf<RouterOutput<typeof eitherRouter, 'getUser'>>().toEqualTypeOf<User>();
    });

    it('keeps a loose route record as loose as RouterOutput leaves it', () =>
    {
        // `Record<string, RouteDef>` declares the name `string`, so both layers accept
        // every name against it — the router said so. What matters is that this is the
        // author's own typing and not something the client mapping invents: `Router<any>`
        // stays empty.
        const loose = null as unknown as Router<Record<string, RouteDef<any, any, { ok: boolean }>>>;

        expectTypeOf<RouterOutput<typeof loose, 'anything'>>().toEqualTypeOf<{ ok: boolean }>();
        expectTypeOf<Client<typeof loose>['anything']>()
            .toEqualTypeOf<RouteClient<RouteDef<any, any, { ok: boolean }>>>();

        // @ts-expect-error - Router<any> said nothing, so the client has nothing
        expectTypeOf<Client<Router<any>>['anything']>();
    });
});
