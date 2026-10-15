/**
 * Declaration — what `defineState` and `defineStateRouter` accept and derive.
 *
 * | #   | input                                                         | expected                                                        |
 * |-----|---------------------------------------------------------------|-----------------------------------------------------------------|
 * | D1  | router with a state lacking `.read`                           | `defineStateRouter` throws naming the state; type-level: not assignable |
 * | D2  | state lacking `.value`                                        | throws naming the state                                         |
 * | D3  | keyed state without `.canRead`                                | throws, sentence says any subject could read any key            |
 * | D4  | keyless state without `.canRead`                              | accepted                                                        |
 * | D5  | `.write` without `.canWrite`                                  | `canWrite` resolves to `canRead` (W6 proves behaviour)          |
 * | D6  | `.read` / `.value` / `.key` / `.contract` / `.canRead` twice  | throws at the second call, each                                 |
 * | D7  | two states with id `consent`                                  | throws naming the id                                            |
 * | D8  | `.key(Type.String())`                                         | throws: key must be an object schema                            |
 * | D9  | `.use([mw])` and `.skip(['x'])`                               | both derived routes carry them                                  |
 * | D10 | default path                                                  | GET /state/consent, PUT /state/consent only with `.write`, GET /state; `{ path: '/shell' }` moves all three |
 * | D11 | derived event                                                 | key `state.consent.changed`; payload fields at, value, data when declared, key when keyed, subject unless shared |
 * | D12 | state without `.contract`                                     | neither route nor the event carries a contract                  |
 * | D13 | `.contract` and `.write(…, { since: '1.4.0' })`               | read 1.3.0, write 1.4.0, event 1.3.0; response `{ at, value, data }` |
 * | D14 | id `Consent` / `1x` / `my-state`                              | throws: id rule                                                 |
 * | D15 | `.write(…, { since })` without `.contract`                    | throws, nothing to fall back from                               |
 * | D16 | `changed.emit` payload types                                  | keyless `{ subject }`, keyed `{ workspaceId, subject }`, shared `{ workspaceId }`; a missing field refused at runtime |
 * | D17 | builder immutability                                          | `a` still has no read after `a.read(fn)`                        |
 * | D18 | `.use([mw])` (and `.skip(['x'])`) without `canRead`           | `defineStateRouter` throws, naming the state and `canRead`; a keyed state keeps its own refusal |
 * | D19 | `.use([mw]).canRead(() => true)`                              | accepted; the per-state route runs the middleware (403); the snapshot still serves the state |
 * | D20 | `base.changed.emit` where only `final = base.write(…)` is routed | throws naming the state                                      |
 * | C2  | `.changedBy([e])` where `e`'s schema lacks `workspaceId`      | refused at router build naming the event and the field          |
 * | C4  | `.changedBy` called twice                                     | throws at the second call                                       |
 *
 * Also refused at `.key()` (defect anticipation): a reserved key field name
 * (`events`, `token`) and a non-string key field. And typed for the client
 * half: `InferStateValue`, `InferStateKey`, `InferStateInput`.
 */

import { Type } from '@sinclair/typebox';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineEvent } from '../../event/event';
import type { EventDef } from '../../event/types';
import { defineMiddleware } from '../../route/define-middleware';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import type { InferStateInput, InferStateKey, InferStateValue } from '../state-router';
import type { RoutableState } from '../types';
import { Consent, ConsentData, ConsentInput, consentState, memberState, request, Runtime, runtimeState, serve, WorkspaceKey } from './state-harness';

const read = async () => ({ value: 'agreed' as const });

describe('declaration', () =>
{
    it('D1 a state lacking .read is refused by name, and is not assignable to the router parameter', () =>
    {
        const noRead = defineState('consent').value(Consent);

        expect(() => defineStateRouter({ consent: noRead as unknown as RoutableState }))
            .toThrow(/state "consent" declares no \.read\(\)/);
        expectTypeOf({ consent: noRead }).not.toMatchTypeOf<Record<string, RoutableState>>();
        expectTypeOf({ consent: noRead.read(read) }).toMatchTypeOf<Record<string, RoutableState>>();
    });

    it('D2 a state lacking .value is refused by name', () =>
    {
        const noValue = defineState('consent').read(read);

        expect(() => defineStateRouter({ consent: noValue as unknown as RoutableState }))
            .toThrow(/state "consent" declares no \.value\(\)/);
        expectTypeOf({ consent: noValue }).not.toMatchTypeOf<Record<string, RoutableState>>();
    });

    it('D3 a keyed state without .canRead is refused: any subject could read any key', () =>
    {
        const runtime = defineState('runtime').key(WorkspaceKey).value(Runtime).read(async () => ({ value: 'ready' as const }));

        expect(() => defineStateRouter({ runtime }))
            .toThrow('keyed state "runtime" declares no .canRead(). The key comes from the request, so without it any subject could read any key.');
    });

    it('D4 a keyless state without .canRead is accepted', () =>
    {
        const consent = defineState('consent').value(Consent).read(read);

        expect(defineStateRouter({ consent }).router.routes.getConsentState).toBeDefined();
    });

    it('D5 .write without .canWrite leaves canWrite to canRead', () =>
    {
        const canRead = () => false;
        const consent = defineState('consent').value(Consent).canRead(canRead).read(read).write(ConsentInput, () =>
        {
        });

        expect(consent._definition.canWrite).toBeUndefined();
        expect(consent._definition.canRead).toBe(canRead);
    });

    it('D6 .read / .value / .key / .contract / .canRead / .canWrite / .data / .write declared twice throw at the second call', () =>
    {
        const base = defineState('consent');
        const contract = { since: '1.0.0' };

        expect(() => base.read(read).read(read)).toThrow('State "consent" already declares .read().');
        expect(() => base.value(Consent).value(Consent)).toThrow('State "consent" already declares .value().');
        expect(() => base.key(WorkspaceKey).key(WorkspaceKey)).toThrow('State "consent" already declares .key().');
        expect(() => base.contract(contract).contract(contract)).toThrow('State "consent" already declares .contract().');
        expect(() => base.canRead(() => true).canRead(() => true)).toThrow('State "consent" already declares .canRead().');
        expect(() => base.canWrite(() => true).canWrite(() => true)).toThrow('State "consent" already declares .canWrite().');
        expect(() => base.data(ConsentData).data(ConsentData)).toThrow('State "consent" already declares .data().');
        expect(() => base.write(ConsentInput, () =>
        {
        }).write(ConsentInput, () =>
        {
        })).toThrow('State "consent" already declares .write().');
    });

    it('D7 two states with the id consent are refused, naming the id', () =>
    {
        expect(() => defineStateRouter({ a: consentState().state, b: consentState().state }))
            .toThrow('defineStateRouter: two states have the id "consent".');
    });

    it('D8 .key(Type.String()) is refused: a key is an object schema', () =>
    {
        expect(() => defineState('runtime').key(Type.String() as never))
            .toThrow('State "runtime" .key() takes an object schema, got String.');
    });

    it('D8 (reserved) a key field named events or token is refused, naming the reserved names', () =>
    {
        expect(() => defineState('runtime').key(Type.Object({ events: Type.String() })))
            .toThrow('State "runtime" key field "events" is reserved. The SSE stream reads "events" and "token" from the connect query');
        expect(() => defineState('runtime').key(Type.Object({ token: Type.String() })))
            .toThrow('key field "token" is reserved');
    });

    it('D8 (string) a non-string or optional key field is refused: the filter compares strings', () =>
    {
        expect(() => defineState('runtime').key(Type.Object({ workspaceId: Type.Number() })))
            .toThrow('State "runtime" key field "workspaceId" is not a required string.');
        expect(() => defineState('runtime').key(Type.Object({ workspaceId: Type.Optional(Type.String()) })))
            .toThrow('key field "workspaceId" is not a required string');
    });

    it('D9 .use([mw]) and .skip([\'x\']) reach both derived routes', () =>
    {
        const mw: MiddlewareHandler = async (_c, next) => next();
        const consent = consentState().state.use([mw]).skip(['x']).canRead(() => true);
        const { routes } = defineStateRouter({ consent }).router;

        expect(routes.getConsentState.middlewares).toEqual([mw]);
        expect(routes.getConsentState.skipMiddlewares).toEqual(['x']);
        expect(routes.putConsentState.middlewares).toEqual([mw]);
        expect(routes.putConsentState.skipMiddlewares).toEqual(['x']);
    });

    it('D10 default path /state; PUT only with .write; { path: \'/shell\' } moves all three', () =>
    {
        const { routes } = defineStateRouter({ consent: consentState().state, member: memberState().state }).router;

        expect([routes.getConsentState.method, routes.getConsentState.path]).toEqual(['GET', '/state/consent']);
        expect([routes.putConsentState.method, routes.putConsentState.path]).toEqual(['PUT', '/state/consent']);
        expect([routes.getStates.method, routes.getStates.path]).toEqual(['GET', '/state']);
        expect(routes).not.toHaveProperty('putMemberState');
        expect(Object.keys(routes)).toEqual(['getConsentState', 'putConsentState', 'getMemberState', 'getStates']);

        const moved = defineStateRouter({ consent: consentState().state }, { path: '/shell' }).router.routes;

        expect([moved.getConsentState.path, moved.putConsentState.path, moved.getStates.path])
            .toEqual(['/shell/consent', '/shell/consent', '/shell']);
    });

    it('D11 the derived event is state.<id>.changed; payload fields follow data, key and shared', () =>
    {
        const { events } = defineStateRouter({
            consent: consentState().state,
            runtime: runtimeState().state,
            member: memberState().state,
        });
        const fields = (name: keyof typeof events) => Object.keys(events[name].schema!.properties);

        expect(Object.keys(events)).toEqual(['state.consent.changed', 'state.runtime.changed', 'state.member.changed']);
        expect(events['state.consent.changed'].name).toBe('state.consent.changed');
        expect(fields('state.consent.changed')).toEqual(['at', 'value', 'data', 'subject']);
        expect(fields('state.runtime.changed')).toEqual(['at', 'value', 'key']);
        expect(fields('state.member.changed')).toEqual(['at', 'value', 'key', 'subject']);
    });

    it('D12 without .contract neither route nor the event carries a contract', () =>
    {
        const states = defineStateRouter({ consent: consentState().state });

        expect(states.router.routes.getConsentState.contract).toBeUndefined();
        expect(states.router.routes.putConsentState.contract).toBeUndefined();
        expect(states.events['state.consent.changed']._contract).toBeUndefined();
    });

    it('D13 .contract with .write(…, { since: \'1.4.0\' }): read 1.3.0, write 1.4.0, event 1.3.0; response { at, value, data }', () =>
    {
        const consent = defineState('consent')
            .value(Consent)
            .data(ConsentData)
            .contract({ since: '1.3.0', auth: 'clientProofV1', requiresSession: true })
            .read(async () => ({ value: 'agreed' as const, data: { marketing: false } }))
            .write(ConsentInput, () =>
            {
            }, { since: '1.4.0' });
        const states = defineStateRouter({ consent });
        const readContract = states.router.routes.getConsentState.contract!;
        const writeContract = states.router.routes.putConsentState.contract!;

        expect(readContract).toMatchObject({ since: '1.3.0', auth: 'clientProofV1', requiresSession: true });
        expect(writeContract).toMatchObject({ since: '1.4.0', auth: 'clientProofV1', requiresSession: true });
        expect(states.events['state.consent.changed']._contract).toEqual({ since: '1.3.0' });
        expect(Object.keys(readContract.response.properties)).toEqual(['at', 'value', 'data']);
        expect(readContract.response.required).toEqual(['at', 'value', 'data']);
        expect(writeContract.response).toEqual(readContract.response);
    });

    it('D14 ids Consent, 1x and my-state are refused by the id rule', () =>
    {
        for (const id of ['Consent', '1x', 'my-state'])
        {
            expect(() => defineState(id)).toThrow(`defineState("${id}"): a state id must match /^[a-z][a-zA-Z0-9]*$/.`);
        }
    });

    it('D15 .write(…, { since }) on a state without .contract is refused: nothing to fall back from', () =>
    {
        const consent = defineState('consent').value(Consent).read(read).write(ConsentInput, () =>
        {
        }, { since: '1.4.0' });

        expect(() => defineStateRouter({ consent })).toThrow(/declares no \.contract\(\), so there is nothing to fall back from/);
    });

    it('D16 changed.emit takes exactly what names the value; a missing field is refused at runtime', async () =>
    {
        const consent = consentState().state;
        const member = memberState().state;
        const runtime = runtimeState().state;
        defineStateRouter({ consent, member, runtime });

        type Param<E extends { emit: (...args: any[]) => unknown }> = Parameters<E['emit']>[0];

        expectTypeOf<Param<typeof consent.changed>>().toEqualTypeOf<{ subject: string }>();
        expectTypeOf<Param<typeof member.changed>>().toEqualTypeOf<{ workspaceId: string; subject: string }>();
        expectTypeOf<Param<typeof runtime.changed>>().toEqualTypeOf<{ workspaceId: string }>();
        expectTypeOf<{ workspaceId: string }>().not.toMatchTypeOf<Param<typeof consent.changed>>();
        expectTypeOf<{ workspaceId: string }>().not.toMatchTypeOf<Param<typeof member.changed>>();
        expectTypeOf<{ subject: string }>().not.toMatchTypeOf<Param<typeof runtime.changed>>();

        await expect(consent.changed.emit({} as never)).rejects.toThrow('consent.changed.emit() refused its payload: /subject');
        await expect(member.changed.emit({ subject: 's' } as never)).rejects.toThrow('member.changed.emit() refused its payload: /workspaceId');
        await expect(runtime.changed.emit({} as never)).rejects.toThrow('runtime.changed.emit() refused its payload: /workspaceId');
    });

    it('D17 the builder is immutable: a still has no read after a.read(fn)', () =>
    {
        const a = defineState('x').value(Consent);
        const b = a.read(read);

        expect(a._definition.read).toBeUndefined();
        expect(b._definition.read).toBe(read);
        expectTypeOf(a).not.toMatchTypeOf<RoutableState>();
        expectTypeOf(b).toMatchTypeOf<RoutableState>();
    });

    it('a state already in another router is refused: its change signal would be read twice', () =>
    {
        const consent = consentState().state;
        defineStateRouter({ consent });

        expect(() => defineStateRouter({ consent }, { path: '/shell' }))
            .toThrow('defineStateRouter: state "consent" is already in another state router (path /state, this one /shell).');
    });

    it('D18 .use() or .skip() without .canRead is refused, naming the state and canRead', () =>
    {
        const mw: MiddlewareHandler = async (_c, next) => next();
        const used = defineState('runtime').value(Runtime).use([mw]).read(async () => ({ value: 'ready' as const }));
        const skipped = defineState('consent').value(Consent).skip(['x']).read(async () => ({ value: 'agreed' as const }));
        const keyed = defineState('member').key(WorkspaceKey).value(Runtime).use([mw]).read(async () => ({ value: 'ready' as const }));

        expect(() => defineStateRouter({ used })).toThrow(/state "runtime" declares \.use\(\) or \.skip\(\) but no \.canRead\(\)/);
        expect(() => defineStateRouter({ used })).toThrow('declares .canRead(() => true) to say so');
        expect(() => defineStateRouter({ skipped })).toThrow(/state "consent" declares \.use\(\) or \.skip\(\) but no \.canRead\(\)/);
        expect(() => defineStateRouter({ keyed })).toThrow('keyed state "member" declares no .canRead()');
    });

    it('D19 .use([mw]).canRead(() => true) is accepted: the per-state route runs the middleware, the snapshot serves the state', async () =>
    {
        const opsOnly = defineMiddleware('opsScope', async (c, next) =>
        {
            if ((c.get('auth') as { role?: string } | undefined)?.role !== 'ops')
            {
                return c.json({ error: 'forbidden' }, 403);
            }

            return next();
        });
        const runtime = defineState('runtime').value(Runtime).use([opsOnly]).canRead(() => true).read(async () => ({ value: 'ready' as const }));
        const app = await serve(defineStateRouter({ runtime }));

        expect((await request(app, 's').get('/state/runtime')).status).toBe(403);
        expect((await (await request(app, 's').get('/state')).json()).states).toEqual({ runtime: { value: 'ready' } });
    });

    it('D20 changed.emit on an intermediate builder no router grouped throws, naming the state', async () =>
    {
        const base = defineState('consent').value(Consent).read(read);
        const final = base.write(ConsentInput, async () =>
        {
        });
        defineStateRouter({ consent: final });

        await expect(base.changed.emit({ subject: 's' })).rejects.toThrow('State "consent" is in no defineStateRouter, so consent.changed.emit() reaches nothing.');
        await expect(final.changed.emit({ subject: 's' })).resolves.toBeUndefined();
    });

    it('C2 a .changedBy() event whose payload schema lacks a key field is refused, naming the event and the field', () =>
    {
        const memberJoined = defineEvent('member.joined', Type.Object({ subject: Type.String() }));
        const optional = defineEvent('member.left', Type.Object({ subject: Type.String(), workspaceId: Type.Optional(Type.String()) }));
        const member = (event: EventDef<any>) => defineState('member').key(WorkspaceKey).value(Runtime)
            .canRead(() => true).read(async () => ({ value: 'ready' as const })).changedBy([event]);

        expect(() => defineStateRouter({ member: member(memberJoined) }))
            .toThrow('state "member" lists event "member.joined" in .changedBy(), but its payload schema has no required field "workspaceId"');
        expect(() => defineStateRouter({ member: member(optional) }))
            .toThrow('lists event "member.left" in .changedBy(), but its payload schema has no required field "workspaceId"');
    });

    it('C4 .changedBy declared twice throws at the second call', () =>
    {
        const event = defineEvent('consent.recorded', Type.Object({ subject: Type.String() }));
        const once = defineState('consent').value(Consent).changedBy([event]);

        expect(() => once.changedBy([event])).toThrow('State "consent" already declares .changedBy().');
    });

    it('read, write and canRead contexts are typed from the declaration', () =>
    {
        defineState('member')
            .key(WorkspaceKey)
            .value(Consent)
            .canRead((ctx) =>
            {
                expectTypeOf(ctx).toEqualTypeOf<{ subject: string; principal: unknown; key: { workspaceId: string } }>();

                return true;
            })
            .read((ctx) =>
            {
                expectTypeOf(ctx).toEqualTypeOf<{ subject: string; principal: unknown; key: { workspaceId: string } }>();

                return { value: 'agreed' };
            });
        defineState('runtime')
            .key(WorkspaceKey, { shared: true })
            .value(Runtime)
            .read((ctx) =>
            {
                expectTypeOf(ctx).toEqualTypeOf<{ principal: unknown; key: { workspaceId: string } }>();
                expectTypeOf(ctx).not.toHaveProperty('subject');

                return { value: 'ready' };
            })
            .write(Type.Object({ action: Type.Literal('restart') }), (ctx) =>
            {
                expectTypeOf(ctx.input).toEqualTypeOf<{ action: 'restart' }>();
            });
    });

    it('InferStateValue / InferStateKey / InferStateInput type each state of a router', () =>
    {
        const states = defineStateRouter({ consent: consentState().state, member: memberState().state });

        type States = typeof states;

        expectTypeOf<InferStateValue<States, 'consent'>>().toEqualTypeOf<'pending' | 'agreed'>();
        expectTypeOf<InferStateValue<States, 'member'>>().toEqualTypeOf<'owner' | 'admin' | 'member'>();
        expectTypeOf<'owner'>().not.toMatchTypeOf<InferStateValue<States, 'consent'>>();
        expectTypeOf<InferStateKey<States, 'member'>>().toEqualTypeOf<{ workspaceId: string }>();
        expectTypeOf<InferStateKey<States, 'consent'>>().toEqualTypeOf<undefined>();
        expectTypeOf<InferStateInput<States, 'consent'>>().toEqualTypeOf<{ termsVersion: string; marketing: boolean }>();
        expectTypeOf<InferStateInput<States, 'member'>>().toBeNever();
        expectTypeOf(states.router.routes).toHaveProperty('putConsentState');
        expectTypeOf(states.router.routes).not.toHaveProperty('putMemberState');
        expectTypeOf(states.events).toHaveProperty('state.member.changed');
    });
});
