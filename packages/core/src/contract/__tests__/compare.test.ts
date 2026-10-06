/**
 * The case table, one test per cell.
 *
 * The design fixed the expected result for every (change kind × side) cell
 * before any of this was written; these tests are that table transcribed, and
 * a cell the table does not have is deliberately not tested here.
 */

import { describe, it, expect } from 'vitest';
import { Type, type TSchema } from '@sinclair/typebox';
import { compareDocuments, compareOperation } from '../compare';
import type { ContractDocument, ContractEvent, ContractEvents, ContractOperation, JsonSchema } from '../types';

function schema(value: TSchema): JsonSchema
{
    return JSON.parse(JSON.stringify(value)) as JsonSchema;
}

interface OperationOverrides
{
    method?: ContractOperation['method'];
    path?: string;
    body?: TSchema;
    response?: TSchema;
}

function operation(overrides: OperationOverrides = {}): ContractOperation
{
    return {
        name: 'getUser',
        method: overrides.method ?? 'GET',
        path: overrides.path ?? '/users/:id',
        since: '1.0.0',
        auth: 'none',
        requiresSession: false,
        request: overrides.body ? { body: schema(overrides.body) } : {},
        interceptor: {},
        response: schema(overrides.response ?? Type.Object({ id: Type.String() })),
    };
}

function document(operations: ContractOperation[]): ContractDocument
{
    return { documentVersion: 1, compatibilityPolicy: 'perOperation', operations };
}

function kinds(before: ContractOperation, after: ContractOperation): string[]
{
    return compareOperation(before, after).map(violation => violation.kind);
}

describe('operation-level changes', () =>
{
    it('passes when an operation is added', () =>
    {
        const before = document([operation()]);
        const after = document([operation(), { ...operation(), name: 'listUsers', path: '/users' }]);

        const result = compareDocuments(before, after);

        expect(result.violations).toEqual([]);
        expect(result.removedOperations).toEqual([]);
    });

    it('reports a removed operation without deciding it', () =>
    {
        const before = document([operation()]);
        const after = document([]);

        const result = compareDocuments(before, after);

        expect(result.violations).toEqual([]);
        expect(result.removedOperations).toEqual(['getUser']);
    });

    it('refuses a changed path', () =>
    {
        expect(kinds(operation(), operation({ path: '/v2/users/:id' })))
            .toEqual(['operation.path-changed']);
    });

    it('refuses a changed method', () =>
    {
        expect(kinds(operation(), operation({ method: 'POST' })))
            .toEqual(['operation.method-changed']);
    });
});

describe('request fields — safe when the server grows more tolerant', () =>
{
    const base = Type.Object({ id: Type.String() });

    it('passes an added optional field', () =>
    {
        const after = Type.Object({ id: Type.String(), note: Type.Optional(Type.String()) });

        expect(kinds(operation({ body: base }), operation({ body: after }))).toEqual([]);
    });

    it('refuses an added required field', () =>
    {
        const after = Type.Object({ id: Type.String(), note: Type.String() });

        expect(kinds(operation({ body: base }), operation({ body: after })))
            .toEqual(['request.required-field-added']);
    });

    it('passes a removed field', () =>
    {
        const before = Type.Object({ id: Type.String(), note: Type.String() });

        expect(kinds(operation({ body: before }), operation({ body: base }))).toEqual([]);
    });

    it('passes required → optional', () =>
    {
        const after = Type.Object({ id: Type.Optional(Type.String()) });

        expect(kinds(operation({ body: base }), operation({ body: after }))).toEqual([]);
    });

    it('refuses optional → required', () =>
    {
        const before = Type.Object({ id: Type.Optional(Type.String()) });

        expect(kinds(operation({ body: before }), operation({ body: base })))
            .toEqual(['request.field-became-required']);
    });

    it('refuses a changed type', () =>
    {
        const after = Type.Object({ id: Type.Number() });

        expect(kinds(operation({ body: base }), operation({ body: after })))
            .toEqual(['request.type-changed']);
    });

    it('passes a whole section added with only optional fields', () =>
    {
        const after = Type.Object({ note: Type.Optional(Type.String()) });

        expect(kinds(operation(), operation({ body: after }))).toEqual([]);
    });

    it('refuses a whole section added with a required field', () =>
    {
        expect(kinds(operation(), operation({ body: base })))
            .toEqual(['request.required-field-added']);
    });

    it('passes a required field nested inside a newly added optional object', () =>
    {
        const after = Type.Object({
            id: Type.String(),
            options: Type.Optional(Type.Object({ mode: Type.String() })),
        });

        expect(kinds(operation({ body: base }), operation({ body: after }))).toEqual([]);
    });
});

describe('response fields — safe when the server grows more certain', () =>
{
    const base = Type.Object({ id: Type.String(), name: Type.String() });

    it('passes an added field', () =>
    {
        const after = Type.Object({ id: Type.String(), name: Type.String(), email: Type.String() });

        expect(kinds(operation({ response: base }), operation({ response: after }))).toEqual([]);
    });

    it('refuses a removed field', () =>
    {
        const after = Type.Object({ id: Type.String() });

        expect(kinds(operation({ response: base }), operation({ response: after })))
            .toEqual(['response.field-removed']);
    });

    it('refuses required → optional', () =>
    {
        const after = Type.Object({ id: Type.String(), name: Type.Optional(Type.String()) });

        expect(kinds(operation({ response: base }), operation({ response: after })))
            .toEqual(['response.field-became-optional']);
    });

    it('passes optional → required', () =>
    {
        const before = Type.Object({ id: Type.String(), name: Type.Optional(Type.String()) });

        expect(kinds(operation({ response: before }), operation({ response: base }))).toEqual([]);
    });

    it('refuses a changed type', () =>
    {
        const after = Type.Object({ id: Type.Number(), name: Type.String() });

        expect(kinds(operation({ response: base }), operation({ response: after })))
            .toEqual(['response.type-changed']);
    });

    it('refuses a field removed from inside an array element', () =>
    {
        const before = Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })) });
        const after = Type.Object({ items: Type.Array(Type.Object({ id: Type.String() })) });

        expect(kinds(operation({ response: before }), operation({ response: after })))
            .toEqual(['response.field-removed']);
    });

    it('names where the break is', () =>
    {
        const after = Type.Object({ id: Type.String() });
        const [violation] = compareOperation(operation({ response: base }), operation({ response: after }));

        expect(violation.location).toBe('response.name');
        expect(violation.operation).toBe('getUser');
    });
});

describe('both sides at once', () =>
{
    it('reports the request and the response break separately', () =>
    {
        const before = operation({
            body: Type.Object({ id: Type.String() }),
            response: Type.Object({ id: Type.String(), name: Type.String() }),
        });
        const after = operation({
            body: Type.Object({ id: Type.String(), note: Type.String() }),
            response: Type.Object({ id: Type.String() }),
        });

        expect(kinds(before, after).sort()).toEqual(['request.required-field-added', 'response.field-removed']);
    });
});

describe('events — the payload is compared under the response rules', () =>
{
    const base = Type.Object({ userId: Type.String(), status: Type.String() });

    function event(name: string, payload: TSchema = base): ContractEvent
    {
        return { name, since: '1.0.0', payload: schema(payload) };
    }

    function events(items: ContractEvent[], overrides: Partial<ContractEvents> = {}): ContractEvents
    {
        return { streamPath: '/events/stream', tokenPath: '/events/token', auth: 'tokenExchange', items, ...overrides };
    }

    function withEvents(section: ContractEvents | undefined): ContractDocument
    {
        return { ...document([operation()]), ...(section ? { events: section } : {}) };
    }

    function compareEvents(before: ContractEvents | undefined, after: ContractEvents | undefined)
    {
        return compareDocuments(withEvents(before), withEvents(after));
    }

    function payloadKinds(before: TSchema, after: TSchema): string[]
    {
        return compareEvents(events([event('sessionActivity', before)]), events([event('sessionActivity', after)]))
            .violations.map(violation => violation.kind);
    }

    it('E1 passes an added event', () =>
    {
        const result = compareEvents(events([event('a')]), events([event('a'), event('b')]));

        expect(result.violations).toEqual([]);
        expect(result.removedEvents).toEqual([]);
    });

    it('E2 reports a removed event without deciding it', () =>
    {
        const result = compareEvents(events([event('a'), event('b')]), events([event('a')]));

        expect(result.violations).toEqual([]);
        expect(result.removedEvents).toEqual(['b']);
        expect(result.removedOperations).toEqual([]);
    });

    it('E3 refuses a changed stream path', () =>
    {
        const result = compareEvents(events([event('a')]), events([event('a')], { streamPath: '/sse', tokenPath: '/token' }));

        expect(result.violations.map(violation => violation.kind)).toEqual(['events.stream-path-changed']);
    });

    it('E4 refuses a changed auth mode', () =>
    {
        const result = compareEvents(events([event('a')]), events([event('a')], { auth: 'none' }));

        expect(result.violations.map(violation => violation.kind)).toEqual(['events.auth-changed']);
    });

    it('E5 passes an added payload field', () =>
    {
        const after = Type.Object({ userId: Type.String(), status: Type.String(), at: Type.Number() });

        expect(payloadKinds(base, after)).toEqual([]);
    });

    it('E6 refuses a removed payload field, naming the event and the field', () =>
    {
        const result = compareEvents(
            events([event('sessionActivity')]),
            events([event('sessionActivity', Type.Object({ userId: Type.String() }))]),
        );

        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]).toMatchObject({
            kind: 'event.payload.field-removed',
            event: 'sessionActivity',
            location: 'payload.status',
        });
    });

    it('E7 refuses payload required → optional', () =>
    {
        const after = Type.Object({ userId: Type.String(), status: Type.Optional(Type.String()) });

        expect(payloadKinds(base, after)).toEqual(['event.payload.field-became-optional']);
    });

    it('E8 passes payload optional → required', () =>
    {
        const before = Type.Object({ userId: Type.String(), status: Type.Optional(Type.String()) });

        expect(payloadKinds(before, base)).toEqual([]);
    });

    it('E9 refuses a changed payload type', () =>
    {
        const after = Type.Object({ userId: Type.Number(), status: Type.String() });

        expect(payloadKinds(base, after)).toEqual(['event.payload.type-changed']);
    });

    it('E10 refuses a narrowed payload constraint', () =>
    {
        const before = Type.Object({ note: Type.String({ maxLength: 100 }) });
        const after = Type.Object({ note: Type.String({ maxLength: 50 }) });

        expect(payloadKinds(before, after)).toEqual(['event.payload.type-changed']);
    });

    it('E11 passes events appearing where the baseline had no events section', () =>
    {
        const result = compareEvents(undefined, events([event('a'), event('b')]));

        expect(result.violations).toEqual([]);
        expect(result.removedEvents).toEqual([]);
    });

    it('E12 reports every event as removed when the events section disappears', () =>
    {
        const result = compareEvents(events([event('a'), event('b')]), undefined);

        expect(result.violations).toEqual([]);
        expect(result.removedEvents).toEqual(['a', 'b']);
    });

    it('E13 keeps event violations out of the operation violations', () =>
    {
        const result = compareEvents(
            events([event('sessionActivity')]),
            events([event('sessionActivity', Type.Object({ userId: Type.String() }))]),
        );

        expect(result.violations.filter(violation => violation.operation !== undefined)).toEqual([]);
        expect(result.violations.every(violation => violation.kind.startsWith('event.'))).toBe(true);
        expect(result.removedOperations).toEqual([]);
    });
});
