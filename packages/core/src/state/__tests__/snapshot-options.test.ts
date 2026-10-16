/**
 * Snapshot route options (#136) — `defineStateRouter(states, { use, skip, contract })`
 * reach `GET <path>` only. The server gates every request behind a named
 * middleware `requirements` that answers 403 unless `x-onboarded` is present.
 *
 * | #   | situation                                                       | expected                                                         |
 * |-----|-----------------------------------------------------------------|------------------------------------------------------------------|
 * | S1  | no option                                                       | `getStates` def has no middleware, no `skipMiddlewares`, no `contract` — as before this change |
 * | S2  | states `.skip(['requirements']).canRead(() => true)`, router without `skip` | `GET /state/consent` 200; `GET /state` 403            |
 * | S3  | same states, router `skip: ['requirements']`                    | `GET /state` 200 with both states; `GET /state/consent` still 200 |
 * | S4  | router `skip: '*'`                                              | `GET /state` 200 without the header                              |
 * | S5  | router `use: [mw]`, `mw` records the path it ran on             | runs on `GET /state`; not on `GET /state/consent` or `PUT /state/consent` |
 * | S6  | state `.use([mw2])`, router without `use`                       | `mw2` runs on the per-state routes, not on `GET /state`          |
 * | S7  | router `contract: { since: '1.0.0', auth }`                     | `getStates` carries it with the derived response schema; per-state defs unchanged |
 * | S8  | router `use: [mw]`, a keyless state lacking `canRead`           | `defineStateRouter` throws, naming the state and `.canRead()`    |
 * | S8b | router `use: [mw]`, first state guarded, second (`terms`) not   | throws, naming `"terms"` and `.canRead()` — every state is checked |
 * | S9  | router `skip: ['x']`, the same state                            | throws likewise                                                  |
 * | S10 | router `contract` only, a state lacking `canRead`               | no throw                                                         |
 * | S11 | router `use`, every state declaring `canRead`                   | no throw; routes derived                                         |
 * | S12 | router `use: []`, a state lacking `canRead`                     | no throw — an empty `use` is not a middleware; `getStates` has no middleware |
 */

import { Type } from '@sinclair/typebox';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineMiddleware } from '../../route/define-middleware';
import { defineRouter } from '../../route/router';
import type { RouteDef } from '../../route/route-builder';
import { defineServerConfig } from '../../server/config-builder';
import { createServer } from '../../server/create-server';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import type { StateRouter, StateRouterOptions } from '../state-router';
import { Consent, ConsentData, ConsentInput, Runtime, testAuth } from './state-harness';

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

/** "Finish your onboarding": every request without `x-onboarded` is refused. */
const requirements = defineMiddleware('requirements', async (c, next) =>
{
    if (!c.req.header('x-onboarded'))
    {
        return c.json({ message: 'finish your onboarding' }, 403);
    }

    return next();
});

/** A server whose every route runs `requirements` unless it skips it. */
function serve(states: StateRouter<any>)
{
    return createServer(defineServerConfig()
        .infrastructure({ database: false, redis: false })
        .use([testAuth])
        .middlewares([requirements])
        .routes(defineRouter({}).packages([states.router]))
        .build());
}

function send(app: Awaited<ReturnType<typeof serve>>, method: 'GET' | 'PUT', path: string, onboarded = false)
{
    return app.request(path, {
        method,
        headers: { 'x-user': 's', 'content-type': 'application/json', ...(onboarded ? { 'x-onboarded': '1' } : {}) },
        ...(method === 'PUT' ? { body: JSON.stringify({ termsVersion: '2026-10', marketing: true }) } : {}),
    });
}

/** A middleware recording `METHOD path` of every request it runs on. */
function recorder(): { mw: MiddlewareHandler; ran: string[] }
{
    const ran: string[] = [];
    const mw: MiddlewareHandler = async (c, next) =>
    {
        ran.push(`${c.req.method} ${c.req.path}`);
        await next();
    };

    return { mw, ran };
}

/** Consent (with a write) and runtime, both skipping `requirements` on their own routes. */
function onboardingStates(options: StateRouterOptions = {})
{
    const consent = defineState('consent')
        .value(Consent)
        .data(ConsentData)
        .skip(['requirements'])
        .canRead(() => true)
        .read(async () => ({ value: 'pending' as const, data: { marketing: false } }))
        .write(ConsentInput, async () =>
        {
        });
    const runtime = defineState('runtime')
        .value(Runtime)
        .skip(['requirements'])
        .canRead(() => true)
        .read(async () => ({ value: 'ready' as const }));

    return defineStateRouter({ consent, runtime }, options);
}

/** A keyless state declaring no `canRead`. */
function unguardedConsent()
{
    return defineState('consent').value(Consent).read(async () => ({ value: 'pending' as const }));
}

function routeDef(states: StateRouter<any>, name: string): RouteDef<any, any, any>
{
    return (states.router.routes as Record<string, RouteDef<any, any, any>>)[name];
}

describe('snapshot route options', () =>
{
    it('S1 no option: getStates carries no middleware, skip or contract', () =>
    {
        const def = routeDef(defineStateRouter({ consent: unguardedConsent() }), 'getStates');

        expect(def).toMatchObject({ method: 'GET', path: '/state', input: { query: expect.any(Object) } });
        expect(def.middlewares).toBeUndefined();
        expect(def.skipMiddlewares).toBeUndefined();
        expect(def.contract).toBeUndefined();
        expect(Object.keys(def).sort()).toEqual(
            ['_input', '_interceptor', '_response', 'contract', 'handler', 'input', 'interceptor', 'method', 'middlewares', 'path', 'skipMiddlewares'],
        );
    });

    it('S2 states skip requirements, the router does not: the per-state read passes, the snapshot is refused', async () =>
    {
        const app = await serve(onboardingStates());

        expect((await send(app, 'GET', '/state/consent')).status).toBe(200);
        expect((await send(app, 'GET', '/state')).status).toBe(403);
    });

    it('S3 router skip: [requirements]: the snapshot answers both states; the per-state read still passes', async () =>
    {
        const app = await serve(onboardingStates({ skip: ['requirements'] }));

        const res = await send(app, 'GET', '/state');

        expect(res.status).toBe(200);
        expect((await res.json()).states).toEqual({ consent: { value: 'pending', data: { marketing: false } }, runtime: { value: 'ready' } });
        expect((await send(app, 'GET', '/state/consent')).status).toBe(200);
    });

    it('S4 router skip: * : the snapshot answers without the header', async () =>
    {
        const app = await serve(onboardingStates({ skip: '*' }));

        expect((await send(app, 'GET', '/state')).status).toBe(200);
    });

    it('S5 router use runs on the snapshot only, never on a per-state route', async () =>
    {
        const { mw, ran } = recorder();
        const app = await serve(onboardingStates({ use: [mw], skip: ['requirements'] }));

        expect((await send(app, 'GET', '/state')).status).toBe(200);
        expect((await send(app, 'GET', '/state/consent')).status).toBe(200);
        expect((await send(app, 'PUT', '/state/consent')).status).toBe(200);
        expect(ran).toEqual(['GET /state']);
    });

    it('S6 a state\'s use runs on its per-state routes, not on the snapshot', async () =>
    {
        const { mw, ran } = recorder();
        const consent = defineState('consent')
            .value(Consent)
            .use([mw])
            .canRead(() => true)
            .read(async () => ({ value: 'pending' as const }))
            .write(ConsentInput, async () =>
            {
            });
        const app = await serve(defineStateRouter({ consent }));

        await send(app, 'GET', '/state', true);
        await send(app, 'GET', '/state/consent', true);
        await send(app, 'PUT', '/state/consent', true);

        expect(ran).toEqual(['GET /state/consent', 'PUT /state/consent']);
    });

    it('S7 router contract: getStates carries it with the derived response; per-state defs unchanged', () =>
    {
        const consent = defineState('consent').value(Consent).data(ConsentData).read(async () => ({ value: 'pending' as const, data: { marketing: false } }));
        const runtime = defineState('runtime').value(Runtime).read(async () => ({ value: 'ready' as const }));
        const states = defineStateRouter({ consent, runtime }, { contract: { since: '1.0.0', auth: 'clientProofV1' } });
        const manifestEntry = Type.Object({ key: Type.Array(Type.String()), write: Type.Boolean() });

        expect(json(routeDef(states, 'getStates').contract!)).toEqual({
            since: '1.0.0',
            auth: 'clientProofV1',
            response: json(Type.Object({
                at: Type.String(),
                states: Type.Object({
                    consent: Type.Optional(Type.Object({ value: Consent, data: ConsentData })),
                    runtime: Type.Optional(Type.Object({ value: Runtime })),
                }),
                manifest: Type.Object({ consent: manifestEntry, runtime: manifestEntry }),
            })),
        });
        expect(routeDef(states, 'getConsentState').contract).toBeUndefined();
        expect(routeDef(states, 'getRuntimeState').contract).toBeUndefined();
    });

    it('S8 router use with a state lacking canRead: refused, naming the state and .canRead()', () =>
    {
        const { mw } = recorder();

        expect(() => defineStateRouter({ consent: unguardedConsent() }, { use: [mw] }))
            .toThrow(/state "consent" declares no \.canRead\(\)\. The snapshot's middleware never reaches the SSE stream/);
    });

    it('S8b router use with only a later state lacking canRead: refused, naming that state', () =>
    {
        const { mw } = recorder();
        const consent = defineState('consent').value(Consent).canRead(() => true).read(async () => ({ value: 'pending' as const }));
        const terms = defineState('terms').value(Consent).read(async () => ({ value: 'pending' as const }));

        expect(() => defineStateRouter({ consent, terms }, { use: [mw] }))
            .toThrow(/state "terms" declares no \.canRead\(\)/);
    });

    it('S9 router skip with a state lacking canRead: refused likewise', () =>
    {
        expect(() => defineStateRouter({ consent: unguardedConsent() }, { skip: ['x'] }))
            .toThrow(/state "consent" declares no \.canRead\(\)/);
    });

    it('S10 router contract alone with a state lacking canRead: accepted', () =>
    {
        expect(() => defineStateRouter({ consent: unguardedConsent() }, { contract: { since: '1.0.0' } })).not.toThrow();
    });

    it('S11 router use with every state declaring canRead: accepted, routes derived', () =>
    {
        const { mw } = recorder();
        const states = onboardingStates({ use: [mw] });

        expect(Object.keys(states.router.routes)).toEqual(['getConsentState', 'putConsentState', 'getRuntimeState', 'getStates']);
        expect(routeDef(states, 'getStates').middlewares).toEqual([mw]);
    });

    it('S12 router use: [] with a state lacking canRead: accepted, getStates carries no middleware', () =>
    {
        const states = defineStateRouter({ consent: unguardedConsent() }, { use: [] });

        expect(routeDef(states, 'getStates').middlewares).toBeUndefined();
    });
});
