// @vitest-environment jsdom
/**
 * `useServerState` — a component subscribed to one state of a state client
 * through `useSyncExternalStore`.
 *
 * | #  | situation                                               | expected                                                       |
 * |----|---------------------------------------------------------|----------------------------------------------------------------|
 * | H1 | mount `useServerState(client, 'consent')`               | status `'loading'`; one `subscribe` on the client; after a frame, re-render with `'ready'` and the value |
 * | H2 | unmount                                                 | unsubscribe called once                                        |
 * | H3 | StrictMode double mount                                 | one live subscription after effects settle                     |
 * | H4 | key object re-created each render with the same fields  | no resubscribe (subscribe count stays 1)                       |
 * | H5 | key changes to another `workspaceId`, never seen before | unsubscribe then subscribe; status back to `'loading'` until the entry exists |
 * | H6 | `write` typed only for a state with a write             | `expectTypeOf` positive and negative; at runtime a function on every state — decided by the type, never by the manifest's arrival — and `member`'s rejects naming it |
 * | H7 | server render (`renderToStaticMarkup`)                  | renders with status `'loading'`, no `EventSource` constructed  |
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { StateClient } from '../client';
import { useServerState, type ServerState } from '../react';
import { at, FakeEventSource, harness, opened, type FixtureStates } from './client-harness';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Client = StateClient<FixtureStates>;

/** Every subscribe and unsubscribe the hook made, in order, and how many are live. */
function track(client: Client): { log: string[]; live: () => number }
{
    const log: string[] = [];
    const subscribe = client.subscribe.bind(client) as (...args: unknown[]) => () => void;

    (client as { subscribe: unknown }).subscribe = (...args: unknown[]) =>
    {
        const label = JSON.stringify(args.slice(0, -1));
        log.push(`subscribe ${label}`);
        const off = subscribe(...args);

        return () =>
        {
            log.push(`unsubscribe ${label}`);
            off();
        };
    };

    return { log, live: () => log.filter(line => line.startsWith('subscribe')).length - log.filter(line => line.startsWith('unsubscribe')).length };
}

const seen: { status: string; value?: unknown; write?: unknown }[] = [];

function Consent({ client }: { client: Client })
{
    const consent = useServerState(client, 'consent');
    seen.push(consent);

    return <span>{consent.status}:{String(consent.value)}</span>;
}

function Runtime({ client, workspaceId }: { client: Client; workspaceId: string; tick?: number })
{
    const runtime = useServerState(client, 'runtime', { workspaceId });
    seen.push(runtime);

    return <span>{runtime.status}:{String(runtime.value)}</span>;
}

function Member({ client }: { client: Client })
{
    seen.push(useServerState(client, 'member', { workspaceId: 'w1' }));

    return null;
}

let container: HTMLElement;
let root: Root;

async function render(node: React.ReactNode): Promise<void>
{
    await act(async () =>
    {
        root.render(node);
    });
}

describe('useServerState', () =>
{
    beforeEach(() =>
    {
        FakeEventSource.install();
        seen.length = 0;
        container = document.createElement('div');
        root = createRoot(container);
    });

    afterEach(() =>
    {
        act(() => root.unmount());
        FakeEventSource.uninstall();
    });

    it('H1 mounts loading with one subscribe; a frame re-renders it ready with the value', async () =>
    {
        const h = harness();
        const { log } = track(h.client);

        await render(<Consent client={h.client} />);

        expect(seen[0].status).toBe('loading');
        expect(log).toEqual(['subscribe ["consent"]']);

        await act(async () =>
        {
            const es = await opened();
            es.emit('state.consent.changed', { at: at(2), value: 'agreed', data: { marketing: true }, subject: 'u1' });
        });

        expect(container.textContent).toBe('ready:agreed');
        expect(seen.at(-1)).toMatchObject({ status: 'ready', at: at(2), value: 'agreed', data: { marketing: true } });
    });

    it('H2 unmount unsubscribes once', async () =>
    {
        const h = harness();
        const { log } = track(h.client);
        await render(<Consent client={h.client} />);

        act(() => root.unmount());
        root = createRoot(container);

        expect(log).toEqual(['subscribe ["consent"]', 'unsubscribe ["consent"]']);
    });

    it('H3 StrictMode double mount leaves one live subscription and one stream', async () =>
    {
        const h = harness();
        const { log, live } = track(h.client);

        await render(<StrictMode><Consent client={h.client} /></StrictMode>);
        await act(async () =>
        {
            await opened();
        });

        expect(log).toEqual(['subscribe ["consent"]', 'unsubscribe ["consent"]', 'subscribe ["consent"]']);
        expect(live()).toBe(1);
        expect(FakeEventSource.live).toHaveLength(1);
    });

    it('H4 a key object re-created on every render with the same fields does not resubscribe', async () =>
    {
        const h = harness();
        const { log } = track(h.client);

        await render(<Runtime client={h.client} workspaceId="w1" tick={1} />);
        await render(<Runtime client={h.client} workspaceId="w1" tick={2} />);
        await render(<Runtime client={h.client} workspaceId="w1" tick={3} />);

        expect(seen.length).toBeGreaterThanOrEqual(3);
        expect(log).toEqual(['subscribe ["runtime",{"workspaceId":"w1"}]']);
    });

    it('H5 another workspaceId unsubscribes then subscribes; loading until its entry exists', async () =>
    {
        const h = harness({ getStates: input => ({ at: at(1), states: { runtime: { value: input.query.workspaceId === 'w1' ? 'ready' : 'provisioning' } } }) });
        const { log } = track(h.client);
        await render(<Runtime client={h.client} workspaceId="w1" />);
        await act(async () =>
        {
            await opened();
        });
        expect(container.textContent).toBe('ready:ready');

        await render(<Runtime client={h.client} workspaceId="w2" />);

        expect(log).toEqual([
            'subscribe ["runtime",{"workspaceId":"w1"}]',
            'unsubscribe ["runtime",{"workspaceId":"w1"}]',
            'subscribe ["runtime",{"workspaceId":"w2"}]',
        ]);
        expect(container.textContent).toBe('loading:undefined');

        await act(async () =>
        {
            await opened();
        });

        expect(container.textContent).toBe('ready:provisioning');
    });

    it('H6 write is typed only on a state that declares one; at runtime member\'s rejects naming it', async () =>
    {
        const h = harness();

        await render(<><Consent client={h.client} /><Member client={h.client} /></>);

        expect(typeof seen[0].write).toBe('function');
        await expect((seen[1].write as (input: unknown) => Promise<unknown>)({ role: 'admin' })).rejects.toThrow('state "member" declares no .write()');
        expectTypeOf<ServerState<FixtureStates, 'consent'>>().toHaveProperty('write');
        expectTypeOf<ServerState<FixtureStates, 'runtime'>['write']>().parameter(0).toEqualTypeOf<{ action: 'restart' }>();
        expectTypeOf<ServerState<FixtureStates, 'member'>>().not.toHaveProperty('write');
    });

    it('H7 a server render is loading and constructs no EventSource', () =>
    {
        const h = harness();
        const { log } = track(h.client);

        const markup = renderToStaticMarkup(<Consent client={h.client} />);

        expect(markup).toBe('<span>loading:undefined</span>');
        expect(log).toEqual([]);
        expect(FakeEventSource.instances).toHaveLength(0);
    });
});
