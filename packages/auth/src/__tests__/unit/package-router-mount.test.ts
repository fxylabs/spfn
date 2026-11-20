/**
 * @spfn/auth - authRouter under a router-level skipper (spfn/spfn#165, rv389 P1/P2)
 *
 * Auth's routes carry no authenticator of their own: a signed-in route reads
 * `getAuth(c)` from the app's inherited `auth`. A skipper above `authRouter`
 * would remove that `auth` from every one of them, so registration refuses it
 * however the app mounts the router — under `.packages()` or as a plain entry
 * (`defineRouter({ auth: authRouter })`). What makes it refused is the router
 * saying it is `@spfn/auth`'s, not the way it was mounted.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { defineRouter, registerRoutes, resolveRouteMiddlewares } from '@spfn/core/route';

import { authRouter, authenticate, machineAuth, optionalAuth } from '@/server';

const SERVER = [{ name: 'auth', handler: authenticate.handler }];

/** The chain `GET /_auth/session` runs under this tree. */
function sessionChain(tree: ReturnType<typeof defineRouter>): string[]
{
    return resolveRouteMiddlewares(tree, SERVER)
        .find(r => r.method === 'GET' && r.path === '/_auth/session')!
        .middlewares.map(mw => mw.name);
}

describe('authRouter under a router-level skipper', () =>
{
    it('states it is @spfn/auth\'s', () =>
    {
        expect(authRouter._packageName).toBe('@spfn/auth');
    });

    it.each([
        ['optionalAuth', optionalAuth],
        ['machineAuth', machineAuth],
    ])('P1: refuses %s above authRouter mounted as a plain entry, nested or not', (name, skipper) =>
    {
        const refusal = `.use()s "${name}", a middleware declaring skips: ['auth'], and the package router`;

        expect(() => sessionChain(defineRouter({ auth: authRouter }).use([skipper]))).toThrow(refusal);
        expect(() => sessionChain(defineRouter({ api: defineRouter({ auth: authRouter }) }).use([skipper]))).toThrow(
            `"api.auth" (defined by @spfn/auth) sits below it`,
        );
        expect(() => sessionChain(defineRouter({}).packages([authRouter]).use([skipper]))).toThrow(refusal);
    });

    it.each([
        ['optionalAuth', optionalAuth],
        ['machineAuth', machineAuth],
    ])('P2: under %s nothing registers, so an anonymous GET /_auth/session never reaches the handler', async (_name, skipper) =>
    {
        const app = new Hono();

        expect(() => registerRoutes(app, defineRouter({ auth: authRouter }).use([skipper]), SERVER)).toThrow('(defined by @spfn/auth)');
        expect((await app.request('/_auth/session')).status).toBe(404);
    });

    /**
     * i165f2: the app's `.use()` on `authRouter` itself is part of the app's
     * tree, and removes `auth` from every auth route as one above it does.
     */
    it.each([
        ['optionalAuth', optionalAuth],
        ['machineAuth', machineAuth],
    ])('H1: refuses %s in authRouter\'s own .use(), through .packages() and as a plain entry, registering nothing', async (name, skipper) =>
    {
        const refusal = (label: string) => `Package router "${label}" (defined by @spfn/auth) .use()s "${name}", a middleware declaring skips: ['auth'].`;

        for (const [label, tree] of [
            ['packages[0]', defineRouter({}).packages([authRouter.use([skipper])])],
            ['auth', defineRouter({ auth: authRouter.use([skipper]) })],
        ] as const)
        {
            const app = new Hono();

            expect(() => registerRoutes(app, tree, SERVER)).toThrow(refusal(label));
            expect((await app.request('/_auth/session')).status).toBe(404);
        }
        expect(authRouter._globalMiddlewares).toEqual([]);
    });

    it('keeps auth on GET /_auth/session as a plain entry under no skipper', () =>
    {
        expect(sessionChain(defineRouter({ auth: authRouter }))).toContain('auth');
    });
});
