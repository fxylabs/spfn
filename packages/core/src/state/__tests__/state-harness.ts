/**
 * State test harness
 *
 * HTTP rows drive the derived routes through `createServer`, as
 * `server/__tests__/sse-event-contract.test.ts` does; a test middleware turns
 * the `x-user` header into the `auth` context the app's auth middleware would
 * set. SSE rows drive the derived events through the handler harness of #135.
 *
 * States are built fresh per case: a state belongs to one router.
 */

import { Type } from '@sinclair/typebox';
import type { MiddlewareHandler } from 'hono';
import { vi } from 'vitest';
import type { Frame, OpenStream } from '../../event/sse/__tests__/stream-harness';
import { defineRouter } from '../../route/router';
import { defineServerConfig } from '../../server/config-builder';
import { createServer } from '../../server/create-server';
import { defineState } from '../state-builder';
import type { StateRouter } from '../state-router';

export const Consent = Type.Union([Type.Literal('pending'), Type.Literal('agreed')]);
export const ConsentData = Type.Object({ marketing: Type.Boolean() });
export const ConsentInput = Type.Object({ termsVersion: Type.String(), marketing: Type.Boolean() });
export const Runtime = Type.Union([Type.Literal('provisioning'), Type.Literal('ready')]);
export const Role = Type.Union([Type.Literal('owner'), Type.Literal('admin'), Type.Literal('member')]);
export const WorkspaceKey = Type.Object({ workspaceId: Type.String() });

/** Sets `auth` from `x-user` (and `x-role`), as an app's global auth middleware would. */
export const testAuth: MiddlewareHandler = async (c, next) =>
{
    const userId = c.req.header('x-user');

    if (userId)
    {
        c.set('auth', { userId, role: c.req.header('x-role') });
    }

    await next();
};

/** A server mounting `states.router` through `.packages()`, the documented way. */
export function serve(states: StateRouter<any>)
{
    return createServer(defineServerConfig()
        .infrastructure({ database: false, redis: false })
        .use([testAuth])
        .routes(defineRouter({}).packages([states.router]))
        .build());
}

/** `fetch` against the app as subject `user` (none when `undefined`). */
export function request(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, user: string | undefined)
{
    const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ ...(user ? { 'x-user': user } : {}), ...extra });

    return {
        get: (path: string) => app.request(path, { headers: headers() }),
        put: (path: string, body: unknown) => app.request(path, {
            method: 'PUT',
            headers: headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        }),
    };
}

/** A keyless consent state with data; `read` and `write` are spies. */
export function consentState(value: 'pending' | 'agreed' = 'agreed')
{
    const read = vi.fn(async ({ subject }: { subject: string }) => ({ value, data: { marketing: subject === 's' } }));
    const write = vi.fn(async (_ctx: { subject: string; input: { termsVersion: string; marketing: boolean } }) =>
    {
    });
    const state = defineState('consent')
        .value(Consent)
        .data(ConsentData)
        .read(read)
        .write(ConsentInput, write);

    return { state, read, write };
}

/** A keyed state shared by every reader of the key; `allow` decides `canRead`. */
export function runtimeState(allow: (ctx: { subject: string; principal: unknown; key: { workspaceId: string } }) => boolean = () => true)
{
    const canRead = vi.fn(allow);
    const read = vi.fn(async ({ key }: { key: { workspaceId: string } }) => ({ value: key.workspaceId === 'w1' ? 'ready' as const : 'provisioning' as const }));
    const state = defineState('runtime')
        .key(WorkspaceKey, { shared: true })
        .value(Runtime)
        .canRead(canRead)
        .read(read);

    return { state, read, canRead };
}

/** A keyed per-subject state. */
export function memberState()
{
    const canRead = vi.fn(() => true);
    const read = vi.fn(async ({ subject }: { subject: string; key: { workspaceId: string } }) => ({ value: subject === 's' ? 'owner' as const : 'member' as const }));
    const state = defineState('member')
        .key(WorkspaceKey)
        .value(Role)
        .canRead(canRead)
        .read(read);

    return { state, read, canRead };
}

/**
 * Wait for `connected` and the one initial frame of each state it names, then
 * drop those initial frames from `stream.frames`: a row about what a signal,
 * a write or a grant sends counts only the frames after the connect.
 * `sse-initial.test.ts` covers the initial frames themselves.
 */
export async function afterInitial(stream: OpenStream): Promise<Frame>
{
    const connected = await stream.frame('connected');
    const initial = await Promise.all((connected.data.initial as string[]).map(event => stream.frame(event)));
    initial.forEach(frame => stream.frames.splice(stream.frames.indexOf(frame), 1));

    return connected;
}

export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
