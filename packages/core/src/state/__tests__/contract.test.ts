/**
 * Contract — one `.contract()` publishes the read operation, the write
 * operation and the SSE event in `contracts/current.json`.
 *
 * | #  | situation                                                      | expected                                                         |
 * |----|----------------------------------------------------------------|------------------------------------------------------------------|
 * | K1 | `collectContractDocument(appRouter.packages([states.router]), eventRouter)` | operations `getConsentState` (response `{ at, value, data }`, `since`, `auth`, `requiresSession`), `putConsentState` (request body = input schema), event `state.consent.changed` in `events.items` |
 * | K2 | a `value` literal removed, documents compared with `compareDocuments` | `response.type-changed` on the read operation and `event.payload.type-changed` on the event |
 * | K3 | state without `.contract`                                      | none of the three appears                                        |
 */

import { Type, type TSchema } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { collectContractDocument } from '../../contract/collect';
import { compareDocuments } from '../../contract/compare';
import { defineEventRouter } from '../../event/router';
import { defineRouter } from '../../route/router';
import { route } from '../../route/route-builder';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { Consent, ConsentData, ConsentInput, WorkspaceKey } from './state-harness';

const json = (schema: TSchema) => JSON.parse(JSON.stringify(schema));

/** The contract document of an app mounting one contracted consent state (and a keyed runtime). */
function documentFor(value: TSchema, contracted = true)
{
    const base = defineState('consent').value(value).data(ConsentData);
    const consent = (contracted ? base.contract({ since: '1.3.0', auth: 'clientProofV1', requiresSession: true }) : base)
        .read(async () => ({ value: 'agreed' as never, data: { marketing: false } }))
        .write(ConsentInput, async () =>
        {
        });
    const runtime = defineState('runtime').key(WorkspaceKey, { shared: true }).value(Type.String())
        .canRead(() => true)
        .read(async () => ({ value: 'ready' }));
    const states = defineStateRouter({ consent, runtime: contracted ? runtime.contract({ since: '1.3.0' }) : runtime });
    const health = route.get('/health').contract({ since: '1.0.0', response: Type.Null() }).handler(async () => null);
    const appRouter = defineRouter({ health }).packages([states.router]);
    const eventRouter = defineEventRouter({ ...states.events }).contract({ auth: 'tokenExchange' });

    return collectContractDocument(appRouter, eventRouter);
}

describe('contract', () =>
{
    it('K1 the read and write operations and the event are in the document', () =>
    {
        const document = documentFor(Consent);
        const operation = (name: string) => document.operations.find(op => op.name === name)!;

        expect(document.operations.map(op => op.name)).toEqual(['getConsentState', 'getRuntimeState', 'health', 'putConsentState']);
        expect(operation('getConsentState')).toMatchObject({
            method: 'GET',
            path: '/state/consent',
            since: '1.3.0',
            auth: 'clientProofV1',
            requiresSession: true,
            response: json(Type.Object({ at: Type.String(), value: Consent, data: ConsentData })),
        });
        expect(operation('putConsentState')).toMatchObject({ method: 'PUT', request: { body: json(ConsentInput) } });
        expect(operation('getRuntimeState').request).toEqual({ query: json(WorkspaceKey) });
        expect(document.events!.items.map(item => item.name)).toEqual(['state.consent.changed', 'state.runtime.changed']);
        expect(document.events!.items[0]).toMatchObject({ since: '1.3.0' });
        expect(Object.keys(document.events!.items[0].payload.properties as object)).toEqual(['at', 'value', 'data', 'subject']);
    });

    it('K2 a removed value literal is response.type-changed on the read operation and event.payload.type-changed on the event', () =>
    {
        const before = documentFor(Consent);
        const after = documentFor(Type.Union([Type.Literal('agreed')]));

        const kinds = compareDocuments(before, after).violations.map(v => `${v.kind} ${v.operation ?? v.event}`);

        expect(kinds).toContain('response.type-changed getConsentState');
        expect(kinds).toContain('event.payload.type-changed state.consent.changed');
    });

    it('K3 a state without .contract appears nowhere', () =>
    {
        const document = documentFor(Consent, false);

        expect(document.operations.map(op => op.name)).toEqual(['health']);
        expect(document.events).toBeUndefined();
    });
});
