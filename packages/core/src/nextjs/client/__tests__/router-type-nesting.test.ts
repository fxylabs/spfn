/**
 * `RouterOutput` / `RouterInput` 중첩 라우터 타입 회귀 테스트
 *
 * ✅ 테스트 범위:
 * - 평면 라우터의 output/input 타입이 그대로 유지되는지
 * - 중첩 라우터(1단계·3단계·4단계) 안의 라우트가 자기 이름으로 해석되는지
 * - 트리 어디에도 없는 이름은 타입 에러가 나는지
 * - 서로 다른 가지에서 같은 이름을 선언하면 이름 자체가 빠지는지
 * - 빈 라우터 / 빈 중첩 라우터가 트리 전체를 망가뜨리지 않는지
 * - `.packages()` 라우트는 평면 이름 공간에 들어오지 않는지
 * - `Router<any>`가 "모든 이름이 존재"로 퍼지지 않는지
 *
 * 🔗 관련 파일:
 * - src/nextjs/client/types.ts (ExtractRoutes, RouterOutput, RouterInput)
 * - src/route/register-routes.ts (registerRoutes — 중첩 라우터를 평면 이름으로 등록)
 * - src/contract/collect.ts (동일한 순회와 이름 중복 거부)
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineRouter, route } from '../../../route';
import type { RouteDef, Router } from '../../../route';
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
        type Nope = RouterOutput<typeof flatRouter, 'nope'>;

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
        type Group = RouterOutput<typeof nestedRouter, 'users'>;

        // @ts-expect-error - 'listPosts' is declared in no branch of this tree
        type Missing = RouterOutput<typeof deepRouter, 'listPosts'>;

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
        type Ambiguous = RouterOutput<typeof duplicateRouter, 'getUser'>;

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
        type None = RouterOutput<typeof emptyRouter, 'getRoot'>;

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
        type Hidden = RouterOutput<typeof appRouter, 'listPosts'>;

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
        type Anything = RouterOutput<Router<any>, 'getUser'>;

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
        type Typo = RouterOutput<App, 'getUsers'>;

        expect(true).toBe(true);
    });

    it('terminates on a router type that refers to itself', () =>
    {
        interface SelfRouter extends Router<{ getRoot: typeof getRoot; self: SelfRouter }> {}

        // A cycle declares its names again at every depth, so each of them is ambiguous by
        // the same rule as two branches. What this guards is that the walk stops at the
        // nesting budget instead of failing with an instantiation-depth error.
        // @ts-expect-error - 'getRoot' is declared at every depth of the cycle
        type Cycled = RouterOutput<SelfRouter, 'getRoot'>;

        expect(true).toBe(true);
    });
});
