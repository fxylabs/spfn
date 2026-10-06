/**
 * The boot check between an event router's contract and `.events()`.
 *
 * The contract is generated from the event router alone, so the server is the
 * one place the declared stream path and auth mode meet what is actually
 * served. One test per row of the boot table.
 */

import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import type { EventRouterContract } from '../../event/router';
import { defineServerConfig } from '../config-builder';
import { createServer } from '../create-server';

type EventsOptions = Parameters<ReturnType<typeof defineServerConfig>['events']>[1];

/** A fresh router per case: an event's `.contract()` may be called once. */
function eventRouter(contract?: EventRouterContract)
{
    const router = defineEventRouter({
        sessionActivity: defineEvent('session.activity', Type.Object({ at: Type.Number() }))
            .contract({ since: '1.0.0' }),
    });

    return contract ? router.contract(contract) : router;
}

function serve(contract: EventRouterContract | undefined, options?: EventsOptions)
{
    return createServer(defineServerConfig()
        .infrastructure({ database: false, redis: false })
        .events(eventRouter(contract), options)
        .build());
}

describe('the event router contract checked against .events() at boot', () =>
{
    it('B1 starts as today when the router declares no contract', async () =>
    {
        await expect(serve(undefined, { path: '/sse', auth: { enabled: true } })).resolves.toBeDefined();
        await expect(createServer(defineServerConfig()
            .infrastructure({ database: false, redis: false })
            .build())).resolves.toBeDefined();
    });

    it('B2 starts when auth none meets no auth on the default path', async () =>
    {
        await expect(serve({ auth: 'none' })).resolves.toBeDefined();
    });

    it('B3 starts when tokenExchange meets enabled auth, and serves the token path', async () =>
    {
        const app = await serve({ auth: 'tokenExchange' }, { auth: { enabled: true } });

        expect((await app.request('/events/token', { method: 'POST' })).status).toBe(401);
    });

    it('B4 refuses a contract stream path the server does not register, naming both', async () =>
    {
        await expect(serve({ auth: 'tokenExchange', streamPath: '/sse' }, {
            path: '/events/stream',
            auth: { enabled: true },
        })).rejects.toThrow(
            'SSE event router contract declares streamPath /sse but .events() registers /events/stream; '
            + 'the contract would describe a path the server does not serve',
        );
    });

    it('B5 refuses a contract auth mode the server does not serve, naming both', async () =>
    {
        await expect(serve({ auth: 'none' }, { auth: { enabled: true } }))
            .rejects.toThrow(/declares auth none but \.events\(\) serves auth tokenExchange/);
    });
});
