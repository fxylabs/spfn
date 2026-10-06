import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { route } from '../../route/route-builder';
import { defineRouter } from '../../route/router';
import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import { collectContractDocument, ContractCollectionError } from '../collect';
import { stableStringify } from '../stable-json';
import type { EventContract } from '../../event/types';

const getUser = route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .contract({
        since: '1.2.0',
        auth: 'clientProofV1',
        requiresSession: true,
        response: Type.Object({ id: Type.String(), email: Type.Optional(Type.String()) }),
    })
    .handler(async () => ({ id: '1' }));

const uncontracted = route.get('/health').handler(async () => ({ ok: true }));

describe('collecting a contract from a router', () =>
{
    it('takes only the routes that carry a contract', () =>
    {
        const document = collectContractDocument(defineRouter({ getUser, uncontracted }));

        expect(document.operations.map(operation => operation.name)).toEqual(['getUser']);
    });

    it('records the wire shape of a contracted route', () =>
    {
        const [operation] = collectContractDocument(defineRouter({ getUser })).operations;

        expect(operation).toMatchObject({
            name: 'getUser',
            method: 'GET',
            path: '/users/:id',
            since: '1.2.0',
            auth: 'clientProofV1',
            requiresSession: true,
        });
        expect(operation.request.params).toEqual({
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
        });
        expect(operation.response).toEqual({
            type: 'object',
            properties: { id: { type: 'string' }, email: { type: 'string' } },
            required: ['id'],
        });
    });

    it('records removedIn, which outlives the route it names', () =>
    {
        const gone = route.get('/legacy')
            .contract({ since: '1.0.0', deprecatedIn: '1.4.0', removedIn: '2.0.0', response: Type.Null() })
            .handler(async () => null);

        const [operation] = collectContractDocument(defineRouter({ gone })).operations;

        expect(operation.deprecatedIn).toBe('1.4.0');
        expect(operation.removedIn).toBe('2.0.0');
    });

    it('omits deprecatedIn and removedIn when the route states neither', () =>
    {
        const [operation] = collectContractDocument(defineRouter({ getUser })).operations;

        expect(operation).not.toHaveProperty('deprecatedIn');
        expect(operation).not.toHaveProperty('removedIn');
    });

    it('defaults auth to none and requiresSession to false', () =>
    {
        const minimal = route.get('/ping')
            .contract({ since: '1.0.0', response: Type.Null() })
            .handler(async () => null);

        const [operation] = collectContractDocument(defineRouter({ minimal })).operations;

        expect(operation.auth).toBe('none');
        expect(operation.requiresSession).toBe(false);
    });

    it('records interceptor fields, which a direct client sends itself', () =>
    {
        const login = route.post('/_auth/login')
            .input({ body: Type.Object({ email: Type.String() }) })
            .interceptor({ body: Type.Object({ publicKey: Type.String() }) })
            .contract({ since: '1.0.0', response: Type.Object({ userId: Type.String() }) })
            .handler(async () => ({ userId: '1' }));

        const [operation] = collectContractDocument(defineRouter({ login })).operations;

        expect(operation.interceptor.body).toEqual({
            type: 'object',
            properties: { publicKey: { type: 'string' } },
            required: ['publicKey'],
        });
    });

    it('sorts operations by name so the file does not churn', () =>
    {
        const a = route.get('/a').contract({ since: '1.0.0', response: Type.Null() }).handler(async () => null);
        const z = route.get('/z').contract({ since: '1.0.0', response: Type.Null() }).handler(async () => null);

        const document = collectContractDocument(defineRouter({ zebra: z, apple: a }));

        expect(document.operations.map(operation => operation.name)).toEqual(['apple', 'zebra']);
    });

    it('reaches routes in nested and package routers', () =>
    {
        const nested = route.get('/admin/users')
            .contract({ since: '1.0.0', response: Type.Null() })
            .handler(async () => null);
        const packaged = route.get('/_auth/me')
            .contract({ since: '1.0.0', response: Type.Null() })
            .handler(async () => null);

        const router = defineRouter({ getUser, admin: defineRouter({ nested }) })
            .packages([defineRouter({ packaged })]);

        expect(collectContractDocument(router).operations.map(operation => operation.name))
            .toEqual(['getUser', 'nested', 'packaged']);
    });

    it('refuses two contracted routes with the same name', () =>
    {
        const duplicate = route.get('/other')
            .contract({ since: '1.0.0', response: Type.Null() })
            .handler(async () => null);

        const router = defineRouter({ getUser })
            .packages([defineRouter({ getUser: duplicate })]);

        expect(() => collectContractDocument(router)).toThrow(ContractCollectionError);
    });

    it('refuses a contract with no since version', () =>
    {
        const bad = route.get('/bad')
            .contract({ since: '', response: Type.Null() })
            .handler(async () => null);

        expect(() => collectContractDocument(defineRouter({ bad }))).toThrow(/since/);
    });

    it('refuses a contracted route that takes multipart form data', () =>
    {
        const upload = route.post('/avatar')
            .input({ formData: Type.Object({ file: Type.Any() }) })
            .contract({ since: '1.0.0', response: Type.Null() })
            .handler(async () => null);

        expect(() => collectContractDocument(defineRouter({ upload }))).toThrow(ContractCollectionError);
        expect(() => collectContractDocument(defineRouter({ upload }))).toThrow(/formData/);
    });

    it('refuses multipart declared on the interceptor rather than the input', () =>
    {
        const upload = route.post('/avatar')
            .interceptor({ formData: Type.Object({ file: Type.Any() }) })
            .contract({ since: '1.0.0', response: Type.Null() })
            .handler(async () => null);

        expect(() => collectContractDocument(defineRouter({ upload }))).toThrow(/interceptor\.formData/);
    });

    it('leaves an uncontracted multipart route alone', () =>
    {
        const upload = route.post('/avatar')
            .input({ formData: Type.Object({ file: Type.Any() }) })
            .handler(async () => null);

        expect(collectContractDocument(defineRouter({ getUser, upload })).operations.map(o => o.name))
            .toEqual(['getUser']);
    });
});

describe('the contract version the router declares', () =>
{
    it('reaches the document, so the server knows what it serves', () =>
    {
        const document = collectContractDocument(defineRouter({ getUser }).contractVersion('1.2.0'));

        expect(document.contractVersion).toBe('1.2.0');
    });

    it('is absent when the router declares none', () =>
    {
        expect(collectContractDocument(defineRouter({ getUser }))).not.toHaveProperty('contractVersion');
    });

    it('survives .packages() and .use(), which rebuild the router', () =>
    {
        const router = defineRouter({ getUser })
            .contractVersion('1.2.0')
            .packages([defineRouter({ uncontracted })])
            .use([]);

        expect(collectContractDocument(router).contractVersion).toBe('1.2.0');
    });

    it('can be declared after the chain as well as before it', () =>
    {
        const router = defineRouter({ getUser })
            .packages([defineRouter({ uncontracted })])
            .contractVersion('1.2.0');

        expect(collectContractDocument(router).contractVersion).toBe('1.2.0');
    });

    it('refuses a version the release order could not compare', () =>
    {
        // The snapshot filename is named from this value and releases are
        // ordered by it, so the failure belongs next to the typo.
        expect(() => defineRouter({ getUser }).contractVersion('1.2')).toThrow(/major\.minor\.patch/);
        expect(() => defineRouter({ getUser }).contractVersion('latest')).toThrow(/major\.minor\.patch/);
    });

    it('accepts a pre-release', () =>
    {
        const document = collectContractDocument(defineRouter({ getUser }).contractVersion('2.0.0-beta.1'));

        expect(document.contractVersion).toBe('2.0.0-beta.1');
    });

    it('states the policy an app contract is judged under', () =>
    {
        // The same bundle format carries @spfn/auth's all-or-nothing contract,
        // so a consumer must not have to guess which rules it is holding.
        expect(collectContractDocument(defineRouter({ getUser })).compatibilityPolicy).toBe('perOperation');
    });
});

describe('collecting contracted SSE events', () =>
{
    /** A fresh definition per case: `.contract()` may be called once per event. */
    function activity(name = 'session.activity')
    {
        return defineEvent(name, Type.Object({ sessionId: Type.String(), at: Type.Number() }));
    }

    function contracted(contract: Partial<EventContract> = {}, name?: string)
    {
        return activity(name).contract({ since: '1.0.0', ...contract } as EventContract);
    }

    const appRouter = defineRouter({ getUser });

    it('C1 publishes the contracted events sorted, each named by its router key', () =>
    {
        const eventRouter = defineEventRouter({
            zeta: contracted({}, 'z.wire.never'),
            alpha: contracted({}, 'a.wire.never'),
            internal: activity(),
        }).contract({ auth: 'none' });

        const { events } = collectContractDocument(appRouter, eventRouter);

        expect(events!.items.map(item => item.name)).toEqual(['alpha', 'zeta']);
        expect(events!.items[0]).toEqual({
            name: 'alpha',
            since: '1.0.0',
            payload: {
                type: 'object',
                properties: { sessionId: { type: 'string' }, at: { type: 'number' } },
                required: ['sessionId', 'at'],
            },
        });
    });

    it('C2 writes no events key when the event router contracts nothing', () =>
    {
        const eventRouter = defineEventRouter({ internal: activity() }).contract({ auth: 'none' });

        expect(collectContractDocument(appRouter, eventRouter)).not.toHaveProperty('events');
    });

    it('C3 writes the document it wrote before events existed when no event router is given', () =>
    {
        const before = '{"compatibilityPolicy":"perOperation","contractVersion":"1.2.0","documentVersion":1,'
            + '"operations":[{"auth":"clientProofV1","interceptor":{},"method":"GET","name":"getUser",'
            + '"path":"/users/:id","request":{"params":{"properties":{"id":{"type":"string"}},"required":["id"],'
            + '"type":"object"}},"requiresSession":true,"response":{"properties":{"email":{"type":"string"},'
            + '"id":{"type":"string"}},"required":["id"],"type":"object"},"since":"1.2.0"}]}';

        const document = collectContractDocument(defineRouter({ getUser }).contractVersion('1.2.0'));

        expect(document).not.toHaveProperty('events');
        expect(stableStringify(document)).toBe(before);
    });

    it('C4 refuses contracted events on a router that declares no contract, naming the router', () =>
    {
        const eventRouter = defineEventRouter({ sessionActivity: contracted() });

        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(ContractCollectionError);
        expect(() => collectContractDocument(appRouter, eventRouter))
            .toThrow(/defineEventRouter\(\{ sessionActivity \}\)/);
    });

    it('C5 refuses a contracted event without a payload schema', () =>
    {
        const eventRouter = defineEventRouter({
            sessionEnded: defineEvent('session.ended').contract({ since: '1.0.0' }),
        }).contract({ auth: 'none' });

        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(ContractCollectionError);
        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(/Type\.Object\(\{\}\)/);
    });

    it('C6 refuses a contracted event under a reserved frame name', () =>
    {
        const eventRouter = defineEventRouter({ ping: contracted() }).contract({ auth: 'none' });

        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(ContractCollectionError);
        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(/"ping"/);
    });

    it('C7 refuses a contracted event with no since version', () =>
    {
        const eventRouter = defineEventRouter({ sessionActivity: contracted({ since: '' }) })
            .contract({ auth: 'none' });

        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(ContractCollectionError);
        expect(() => collectContractDocument(appRouter, eventRouter)).toThrow(/since/);
    });

    it('C8 defaults the stream path and derives the token path beside it', () =>
    {
        const eventRouter = defineEventRouter({ sessionActivity: contracted() }).contract({ auth: 'none' });

        const { events } = collectContractDocument(appRouter, eventRouter);

        expect(events).toMatchObject({ streamPath: '/events/stream', tokenPath: '/events/token', auth: 'none' });
    });

    it('C9 derives the token path from a declared stream path', () =>
    {
        const eventRouter = defineEventRouter({ sessionActivity: contracted() })
            .contract({ auth: 'tokenExchange', streamPath: '/sse' });

        const { events } = collectContractDocument(appRouter, eventRouter);

        expect(events).toMatchObject({ streamPath: '/sse', tokenPath: '/token', auth: 'tokenExchange' });
    });

    it('C10 refuses a relative stream path where it is declared', () =>
    {
        const eventRouter = defineEventRouter({ sessionActivity: activity() });

        expect(() => eventRouter.contract({ auth: 'none', streamPath: 'sse' })).toThrow(/streamPath: "sse"/);
    });

    it('C11 records deprecatedIn and removedIn only when the event states them', () =>
    {
        const eventRouter = defineEventRouter({
            legacy: contracted({ deprecatedIn: '1.4.0', removedIn: '2.0.0' }),
            current: contracted(),
        }).contract({ auth: 'none' });

        const [current, legacy] = collectContractDocument(appRouter, eventRouter).events!.items;

        expect(legacy).toMatchObject({ deprecatedIn: '1.4.0', removedIn: '2.0.0' });
        expect(current).not.toHaveProperty('deprecatedIn');
        expect(current).not.toHaveProperty('removedIn');
    });

    it('refuses a second .contract() on the same event instead of keeping the first', () =>
    {
        const event = contracted();

        expect(() => event.contract({ since: '2.0.0' })).toThrow(/already declares/);
        expect(event._contract).toEqual({ since: '1.0.0' });
    });
});
