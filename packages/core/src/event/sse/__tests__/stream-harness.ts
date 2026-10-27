/**
 * SSE stream harness for handler tests
 *
 * Drives `createSSEHandler` through a Hono app the way `token-auth.test.ts`
 * does — a token issued for a subject, then `GET /events/stream` — and reads
 * the response body into parsed frames in the background, so a test can await
 * one frame and then assert what arrived before it.
 *
 * Absence is asserted with a sentinel: frames of one connection are written in
 * enqueue order, so once a later frame has arrived an earlier one never will.
 */

import { Hono } from 'hono';
import { vi } from 'vitest';
import { createSSEHandler } from '../handler';
import { SSETokenManager } from '../token-manager';
import type { SSETokenManagerConfig } from '../token-manager';
import type { SSEHandlerConfig } from '../types';
import type { EventRouterDef } from '../../router';
import type { EventDef } from '../../types';

export interface Frame
{
    event: string;
    data: any;
    id?: string;
}

export interface OpenStream
{
    status: number;
    body: any;
    frames: Frame[];

    /** Resolve with the `nth` frame named `event` (1-based), or reject after 2s. */
    frame: (event: string, nth?: number) => Promise<Frame>;

    /** Frames named `event` received so far. */
    named: (event: string) => Frame[];

    /** Whether the server ended the body (always `true` for a refusal). */
    ended: () => boolean;

    /** Disconnect as a client would (aborts the request). */
    close: () => Promise<void>;
}

export interface ConnectOptions
{
    query?: string;
    headers?: Record<string, string>;

    /** Abort the request through this controller (a client leaving before the stream opens). */
    controller?: AbortController;

    /** The device key the token is minted with; absent → an untagged token. */
    keyId?: string;
}

const openStreams: OpenStream[] = [];

/** Close every stream a test opened (call from `afterEach`). */
export async function closeAllStreams(): Promise<void>
{
    await Promise.all(openStreams.splice(0).map(stream => stream.close()));
}

/**
 * A Hono app serving one SSE handler. `auth: false` mounts it without a token
 * manager, so connections have no subject; `manager` configures the one it mounts.
 */
export function createStreamApp(
    router: EventRouterDef<any>,
    config: SSEHandlerConfig = {},
    auth = true,
    manager: SSETokenManagerConfig = {},
)
{
    const app = new Hono();
    const tokenManager = auth ? new SSETokenManager({ ttl: 5000, ...manager }) : undefined;
    const handler = createSSEHandler(router, { ...config, auth: { enabled: auth, ...config.auth } }, tokenManager);
    app.get('/events/stream', handler);

    const connect = async (subject: string | undefined, options: ConnectOptions = {}): Promise<OpenStream> =>
    {
        const token = subject && tokenManager ? await tokenManager.issue(subject, { keyId: options.keyId }) : undefined;
        const query = `${options.query ?? 'events=a'}${token ? `&token=${token}` : ''}`;

        return openStream(app, `/events/stream?${query}`, options.headers, options.controller);
    };

    return { app, handler, connect, tokenManager };
}

/**
 * Open `path` on any Hono app (a bare one, or `createServer`'s) and read its frames.
 */
export async function openStream(
    app: Hono,
    path: string,
    headers: Record<string, string> = {},
    controller = new AbortController(),
): Promise<OpenStream>
{
    const res = await app.request(new Request(`http://localhost${path}`, { signal: controller.signal, headers }));
    const frames: Frame[] = [];
    const listeners = new Set<() => void>();
    const isStream = res.status === 200;
    let ended = !isStream;

    if (isStream)
    {
        void pump(res.body!.getReader(), frames, listeners).then(() =>
        {
            ended = true;
        });
    }

    const named = (event: string) => frames.filter(f => f.event === event);
    const stream: OpenStream = {
        status: res.status,
        body: isStream ? undefined : await res.json().catch(() => null),
        frames,
        named,
        ended: () => ended,
        frame: (event, nth = 1) => waitForFrame(() => named(event)[nth - 1], listeners, event),
        close: async () =>
        {
            controller.abort();
            await res.body?.cancel().catch(() => undefined);
            await new Promise(resolve => setImmediate(resolve));
        },
    };
    openStreams.push(stream);

    return stream;
}

async function pump(reader: ReadableStreamDefaultReader<Uint8Array>, frames: Frame[], listeners: Set<() => void>)
{
    const decoder = new TextDecoder();
    let buffer = '';

    while (true)
    {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done)
        {
            return;
        }

        buffer += decoder.decode(value, { stream: true });

        let end = buffer.indexOf('\n\n');
        while (end >= 0)
        {
            frames.push(parseFrame(buffer.slice(0, end)));
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
        }

        listeners.forEach(listener => listener());
    }
}

function parseFrame(block: string): Frame
{
    const fields: Record<string, string[]> = {};

    for (const line of block.split('\n'))
    {
        const colon = line.indexOf(':');
        const key = line.slice(0, colon);
        (fields[key] ??= []).push(line.slice(colon + 1).trimStart());
    }

    return { event: fields.event?.[0] ?? 'message', data: JSON.parse(fields.data.join('\n')), id: fields.id?.[0] };
}

function waitForFrame(find: () => Frame | undefined, listeners: Set<() => void>, event: string): Promise<Frame>
{
    return new Promise((resolve, reject) =>
    {
        const check = () =>
        {
            const found = find();
            if (found)
            {
                listeners.delete(check);
                clearTimeout(timer);
                resolve(found);
            }
        };
        const timer = setTimeout(() =>
        {
            listeners.delete(check);
            reject(new Error(`No "${event}" frame within 2s`));
        }, 2000);

        listeners.add(check);
        check();
    });
}

/** Resolve once `condition` holds, polling each macrotask; reject after 2s. */
export async function until(condition: () => boolean): Promise<void>
{
    const deadline = Date.now() + 2000;

    while (!condition())
    {
        if (Date.now() > deadline)
        {
            throw new Error('Condition not met within 2s');
        }

        await new Promise(resolve => setImmediate(resolve));
    }
}

/**
 * Count the live subscriptions an event's `subscribe` handed out, and any
 * unsubscribe function called twice.
 */
export function countSubscriptions(event: EventDef<any>)
{
    const original = event.subscribe;
    const counts = { live: 0, doubleUnsubscribes: 0 };

    vi.spyOn(event, 'subscribe').mockImplementation((handler) =>
    {
        const unsubscribe = original(handler);
        let done = false;
        counts.live++;

        return () =>
        {
            if (done)
            {
                counts.doubleUnsubscribes++;

                return;
            }

            done = true;
            counts.live--;
            unsubscribe();
        };
    });

    return counts;
}
