/**
 * SSE permission — `canRead` translated into #135's `canSubscribe` / `filter`,
 * and `grant` / `revoke` on the state, through the SSE handler.
 *
 * | #   | situation                                                     | expected                                                      |
 * |-----|---------------------------------------------------------------|---------------------------------------------------------------|
 * | P1  | keyed, connect `?events=state.runtime.changed&workspaceId=w1`, `canRead` true | allowed; `canRead` received `{ subject, principal, key: { workspaceId: 'w1' } }` |
 * | P2  | `canRead` false                                               | denied (in `connected.deniedEvents`); a shared change emitted after delivers no data frame |
 * | P3  | key field absent from the connect query                       | denied, no throw, `canRead` not called                        |
 * | P4  | keyless without `canRead`                                     | allowed when a subject exists                                 |
 * | P4' | stream without auth, keyed shared state, `emit`               | nothing delivered                                             |
 * | P4''| stream without auth, keyless state, `emit`                    | nothing delivered                                             |
 * | P5  | `runtime.revoke({ subject: 's' })`                            | `s` gets `subscription.revoked`; a following signal delivers nothing to `s` |
 * | P5' | same                                                          | `t` unaffected                                                |
 * | P6  | `runtime.grant({ subject: 's', key: { workspaceId: 'w1' } })` after P5 | `subscription.granted` then one frame with the current value |
 * | P6' | `s` on `w1` (denied) and `w2` (denied); `grant({ subject: 's', key: w1 })`; then `emit({ workspaceId: 'w2' })` | the `w2` tab receives nothing, no `subscription.granted`; the `w1` tab receives `subscription.granted` and the current-value frame |
 * | P6''| keyed `grant({ subject })` without a key                      | refused naming the state; a type error                        |
 * | P7  | keyless `consent.grant({ subject: 's' })`                     | same, no key                                                  |
 * | P7' | keyless `grant({ subject: 's' })` while `t` is connected      | `t` untouched                                                 |
 * | P8  | `principal` from `resolvePrincipal`                           | reaches `canRead` on the SSE path                             |
 * | P9  | `revoke({ subject: 's', key: w1 })`, tabs on `w1` and `w2` both allowed | only the `w1` tab gets `subscription.revoked`; `w2` still receives frames |
 * | P10 | `revoke({ subject: 's' })` (no key), same tabs                | both tabs revoked                                             |
 * | P11 | `grant({ subject: 's', key: {} })`, `s`'s `w2` tab denied by `canRead` | rejects; `w2` gets no `subscription.granted`; a later `w2` emit delivers nothing |
 * | P12 | two key fields; `grant` with `{}`, with one field, and with an extra field | `{}` and one field reject (as does `revoke` with them); the extra field is dropped and only the matching tab opens |
 * | P12'| open key schema, `revoke({ subject: 's', key: { workspaceId: 'w1', role: 'owner' } })` | `role` dropped, the match is on `workspaceId` only: the `w1` tab gets `subscription.revoked`; a later emit delivers nothing |
 * | P13 | strict key schema (`additionalProperties: false`), `revoke` with the same extra field | resolves; the `w1` tab gets `subscription.revoked`; a later emit delivers nothing |
 * | P13'| same, `grant` on a tab `canRead` denied                       | resolves; `subscription.granted` arrives                      |
 * | P14 | strict key schema, `grant` / `revoke` with a key missing `workspaceId` | rejects naming `/workspaceId` as missing, not an unexpected property |
 * | P15 | hand-built key schema: `workspaceId` marked `Optional` but listed in `required`; `revoke({ subject: 's', key: {} })`, tabs on `w1` and `w2` | rejects naming the key; neither tab revoked |
 * | P16 | strict key schema, `grant` / `revoke` with `{ workspaceId: 1 }` | rejects naming `/workspaceId Expected string` |
 */

import { Type } from '@sinclair/typebox';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { defineEvent } from '../../event/event';
import { defineEventRouter } from '../../event/router';
import { closeAllStreams, createStreamApp } from '../../event/sse/__tests__/stream-harness';
import type { SSEHandlerConfig } from '../../event/sse/types';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { afterInitial, Consent, consentState, ISO, runtimeState } from './state-harness';

const CONSENT = 'state.consent.changed';
const RUNTIME = 'state.runtime.changed';
const GRANTED = 'subscription.granted';
const REVOKED = 'subscription.revoked';

function streamApp(states: ReturnType<typeof defineStateRouter<any>>, config: SSEHandlerConfig = {})
{
    const app = createStreamApp(defineEventRouter(states.events), config);

    return async (subject: string, query: string) =>
    {
        const stream = await app.connect(subject, { query });
        const connected = await afterInitial(stream);

        return { stream, connected: connected.data };
    };
}

/**
 * A stream serving the state events beside an app event `ping`: a ping emitted
 * last and received proves every frame emitted before it was already decided.
 */
function pingedStreamApp(states: ReturnType<typeof defineStateRouter<any>>, auth = true)
{
    const ping = defineEvent('test.ping', Type.Object({ n: Type.Number() }));
    const app = createStreamApp(defineEventRouter({ ...states.events, ping }), {}, auth);
    const connect = async (subject: string | undefined, query: string) =>
    {
        const stream = await app.connect(subject, { query: query.replace(/events=([^&]*)/, 'events=$1,ping') });
        await afterInitial(stream);

        return stream;
    };

    return { connect, ping };
}

afterEach(async () =>
{
    await closeAllStreams();
});

/** A shared runtime state whose key schema refuses any field it does not declare. */
function strictRuntime(canRead: () => boolean)
{
    return defineState('runtime')
        .key(Type.Object({ workspaceId: Type.String() }, { additionalProperties: false }), { shared: true })
        .value(Consent)
        .canRead(canRead)
        .read(async () => ({ value: 'agreed' as const }));
}

/** A membership row: a legal key by type (not a fresh literal), one field more than `.key()` names. */
const membership = { workspaceId: 'w1', role: 'owner' };

describe('SSE permission', () =>
{
    it('P1 keyed, key in the connect query, canRead true: allowed; canRead got { subject, principal, key }', async () =>
    {
        const runtime = runtimeState(() => true);
        const connect = streamApp(defineStateRouter({ runtime: runtime.state }));

        const { connected } = await connect('s', `events=${RUNTIME}&workspaceId=w1`);

        expect(connected.subscribedEvents).toEqual([RUNTIME]);
        expect(runtime.canRead).toHaveBeenCalledWith({ subject: 's', principal: undefined, key: { workspaceId: 'w1' } });
    });

    it('P2 canRead false: denied, and a shared change emitted after delivers no data frame', async () =>
    {
        const runtime = runtimeState(() => false);
        const consent = consentState();
        const connect = streamApp(defineStateRouter({ runtime: runtime.state, consent: consent.state }));

        const { stream, connected } = await connect('s', `events=${RUNTIME},${CONSENT}&workspaceId=w1`);
        await runtime.state.changed.emit({ workspaceId: 'w1' });
        await consent.state.changed.emit({ subject: 's' });
        await stream.frame(CONSENT);

        expect(connected.deniedEvents).toEqual([RUNTIME]);
        expect(stream.named(RUNTIME)).toEqual([]);
    });

    it('P3 key field absent from the connect query: denied, no throw, canRead not called', async () =>
    {
        const runtime = runtimeState(() => true);
        const connect = streamApp(defineStateRouter({ runtime: runtime.state }));

        const { connected } = await connect('s', `events=${RUNTIME}`);

        expect(connected.deniedEvents).toEqual([RUNTIME]);
        expect(runtime.canRead).not.toHaveBeenCalled();
    });

    it('P4 keyless without canRead: allowed when a subject exists', async () =>
    {
        const connect = streamApp(defineStateRouter({ consent: consentState().state }));

        const { connected } = await connect('s', `events=${CONSENT}`);

        expect(connected.subscribedEvents).toEqual([CONSENT]);
    });

    it('P4\' a stream without auth never receives a keyed shared frame', async () =>
    {
        const runtime = runtimeState(() => true);
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime: runtime.state }), false);
        const anonymous = await connect(undefined, `events=${RUNTIME}&workspaceId=w1`);

        await runtime.state.changed.emit({ workspaceId: 'w1' });
        await ping.emit({ n: 1 });
        await anonymous.frame('ping');

        expect(anonymous.named(RUNTIME)).toEqual([]);
    });

    it('P4\'\' a stream without auth never receives a keyless frame', async () =>
    {
        const consent = consentState();
        const { connect, ping } = pingedStreamApp(defineStateRouter({ consent: consent.state }), false);
        const anonymous = await connect(undefined, `events=${CONSENT}`);

        await consent.state.changed.emit({ subject: 's' });
        await ping.emit({ n: 1 });
        await anonymous.frame('ping');

        expect(anonymous.named(CONSENT)).toEqual([]);
    });

    it('P5 revoke({ subject: s }): s gets subscription.revoked and a following signal delivers nothing to s', async () =>
    {
        const runtime = runtimeState(() => true);
        const consent = consentState();
        const connect = streamApp(defineStateRouter({ runtime: runtime.state, consent: consent.state }));
        const { stream: s } = await connect('s', `events=${RUNTIME},${CONSENT}&workspaceId=w1`);

        await runtime.state.revoke({ subject: 's' });
        await runtime.state.changed.emit({ workspaceId: 'w1' });
        await consent.state.changed.emit({ subject: 's' });
        await s.frame(CONSENT);

        expect((await s.frame(REVOKED)).data).toEqual({ event: RUNTIME });
        expect(s.named(RUNTIME)).toEqual([]);
    });

    it('P5\' revoke({ subject: s }): t unaffected', async () =>
    {
        const runtime = runtimeState(() => true);
        const connect = streamApp(defineStateRouter({ runtime: runtime.state }));
        const { stream: t } = await connect('t', `events=${RUNTIME}&workspaceId=w1`);

        await runtime.state.revoke({ subject: 's' });
        await runtime.state.changed.emit({ workspaceId: 'w1' });

        expect((await t.frame(RUNTIME)).data.data.value).toBe('ready');
        expect(t.named(REVOKED)).toEqual([]);
    });

    it('P6 grant({ subject: s, key }) after a revoke: subscription.granted, then one frame with the current value', async () =>
    {
        const runtime = runtimeState(() => true);
        const connect = streamApp(defineStateRouter({ runtime: runtime.state }));
        const { stream: s } = await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        await runtime.state.revoke({ subject: 's' });

        await runtime.state.grant({ subject: 's', key: { workspaceId: 'w1' } });
        const frame = await s.frame(RUNTIME);

        expect(s.frames.map(f => f.event)).toEqual(['connected', REVOKED, GRANTED, RUNTIME]);
        expect(frame.data.data).toEqual({ at: expect.stringMatching(ISO), value: 'ready', key: { workspaceId: 'w1' } });
        expect(runtime.read).toHaveBeenCalledWith({ principal: undefined, key: { workspaceId: 'w1' } });
    });

    it('P6\' grant({ subject: s, key: w1 }) opens only the w1 tab: the w2 tab, which canRead denied, gets nothing', async () =>
    {
        const runtime = runtimeState(() => false);
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime: runtime.state }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        const onW2 = await connect('s', `events=${RUNTIME}&workspaceId=w2`);

        await runtime.state.grant({ subject: 's', key: { workspaceId: 'w1' } });
        await runtime.state.changed.emit({ workspaceId: 'w2' });
        await ping.emit({ n: 1 });
        await Promise.all([onW1.frame('ping'), onW2.frame('ping')]);

        expect(onW2.frames.map(f => f.event)).toEqual(['connected', 'ping']);
        expect(onW1.frames.map(f => f.event)).toEqual(['connected', GRANTED, RUNTIME, 'ping']);
        expect(onW1.named(RUNTIME)[0].data.data).toEqual({ at: expect.stringMatching(ISO), value: 'ready', key: { workspaceId: 'w1' } });
    });

    it('P6\'\' a keyed grant without a key is refused naming the state, and is a type error', async () =>
    {
        const runtime = runtimeState(() => false);
        defineStateRouter({ runtime: runtime.state });

        await expect(runtime.state.grant({ subject: 's' } as never)).rejects.toThrow('State "runtime" .grant() was called without a key.');
        expectTypeOf<{ subject: string }>().not.toMatchTypeOf<Parameters<typeof runtime.state.grant>[0]>();
        expectTypeOf<{ subject: string; key: { workspaceId: string } }>().toMatchTypeOf<Parameters<typeof runtime.state.grant>[0]>();
        expect(runtime.read).not.toHaveBeenCalled();
    });

    it('P7 keyless grant({ subject: s }): subscription.granted, then one frame with the current value, no key', async () =>
    {
        const consent = defineState('consent').value(Consent).canRead(() => false).read(async () => ({ value: 'pending' as const }));
        const connect = streamApp(defineStateRouter({ consent }));
        const { stream: s, connected } = await connect('s', `events=${CONSENT}`);
        expect(connected.deniedEvents).toEqual([CONSENT]);

        await consent.grant({ subject: 's' });
        const frame = await s.frame(CONSENT);

        expect(s.frames.map(f => f.event)).toEqual(['connected', GRANTED, CONSENT]);
        expect(frame.data.data).toEqual({ at: expect.stringMatching(ISO), value: 'pending', subject: 's' });
    });

    it('P8 the principal resolvePrincipal returns reaches canRead on the SSE path', async () =>
    {
        const principal = { role: 'admin' };
        const runtime = runtimeState(() => true);
        const connect = streamApp(defineStateRouter({ runtime: runtime.state }), { auth: { resolvePrincipal: () => principal } });

        await connect('s', `events=${RUNTIME}&workspaceId=w1`);

        expect(runtime.canRead.mock.calls[0][0]).toMatchObject({ subject: 's', key: { workspaceId: 'w1' } });
        expect(runtime.canRead.mock.calls[0][0].principal).toBe(principal);
    });

    it('P7\' keyless grant({ subject: s }) leaves t untouched', async () =>
    {
        const consent = defineState('consent').value(Consent).canRead(() => false).read(async () => ({ value: 'pending' as const }));
        const { connect, ping } = pingedStreamApp(defineStateRouter({ consent }));
        const s = await connect('s', `events=${CONSENT}`);
        const t = await connect('t', `events=${CONSENT}`);

        await consent.grant({ subject: 's' });
        await ping.emit({ n: 1 });
        await Promise.all([s.frame('ping'), t.frame('ping')]);

        expect(s.frames.map(f => f.event)).toEqual(['connected', GRANTED, CONSENT, 'ping']);
        expect(t.frames.map(f => f.event)).toEqual(['connected', 'ping']);
    });

    it('P9 revoke({ subject: s, key: w1 }) revokes only the w1 tab; the w2 tab still receives frames', async () =>
    {
        const runtime = runtimeState(() => true);
        const { connect } = pingedStreamApp(defineStateRouter({ runtime: runtime.state }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        const onW2 = await connect('s', `events=${RUNTIME}&workspaceId=w2`);

        await runtime.state.revoke({ subject: 's', key: { workspaceId: 'w1' } });
        await runtime.state.changed.emit({ workspaceId: 'w1' });
        await runtime.state.changed.emit({ workspaceId: 'w2' });
        await onW1.frame(REVOKED);

        expect((await onW2.frame(RUNTIME)).data.data.value).toBe('provisioning');
        expect(onW2.named(REVOKED)).toEqual([]);
        expect(onW1.named(RUNTIME)).toEqual([]);
    });

    it('P10 revoke({ subject: s }) without a key revokes every tab of s', async () =>
    {
        const runtime = runtimeState(() => true);
        const { connect } = pingedStreamApp(defineStateRouter({ runtime: runtime.state }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        const onW2 = await connect('s', `events=${RUNTIME}&workspaceId=w2`);

        await runtime.state.revoke({ subject: 's' });

        expect((await onW1.frame(REVOKED)).data).toEqual({ event: RUNTIME });
        expect((await onW2.frame(REVOKED)).data).toEqual({ event: RUNTIME });
    });

    it('P11 grant with an empty key rejects; the w2 tab, which canRead denied, gets nothing', async () =>
    {
        const runtime = runtimeState(({ key }) => key.workspaceId === 'w1');
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime: runtime.state }));
        const onW2 = await connect('s', `events=${RUNTIME}&workspaceId=w2`);

        await expect(runtime.state.grant({ subject: 's', key: {} as { workspaceId: string } }))
            .rejects.toThrow('State "runtime" .grant() refused its key: /workspaceId');
        await runtime.state.changed.emit({ workspaceId: 'w2' });
        await ping.emit({ n: 1 });
        await onW2.frame('ping');

        expect(onW2.named(GRANTED)).toEqual([]);
        expect(onW2.named(RUNTIME)).toEqual([]);
        expect(runtime.read).toHaveBeenCalledTimes(1);
    });

    it('P12 a partial key rejects; an extra key field is dropped and the grant opens only the matching tab', async () =>
    {
        const board = defineState('board')
            .key(Type.Object({ workspaceId: Type.String(), boardId: Type.String() }), { shared: true })
            .value(Consent)
            .canRead(() => false)
            .read(async () => ({ value: 'agreed' as const }));
        const BOARD = 'state.board.changed';
        const { connect, ping } = pingedStreamApp(defineStateRouter({ board }));
        const onB1 = await connect('s', `events=${BOARD}&workspaceId=w1&boardId=b1`);
        const onB2 = await connect('s', `events=${BOARD}&workspaceId=w1&boardId=b2`);

        for (const key of [{}, { workspaceId: 'w1' }])
        {
            await expect(board.grant({ subject: 's', key: key as never })).rejects.toThrow('State "board" .grant() refused its key');
            await expect(board.revoke({ subject: 's', key: key as never })).rejects.toThrow('State "board" .revoke() refused its key');
        }
        await board.grant({ subject: 's', key: { workspaceId: 'w1', boardId: 'b1', extra: 'x' } as never });
        await ping.emit({ n: 1 });
        await Promise.all([onB1.frame('ping'), onB2.frame('ping')]);

        expect(onB1.frames.map(f => f.event)).toEqual(['connected', GRANTED, BOARD, 'ping']);
        expect(onB1.named(BOARD)[0].data.data.key).toEqual({ workspaceId: 'w1', boardId: 'b1' });
        expect(onB2.frames.map(f => f.event)).toEqual(['connected', 'ping']);
    });

    it('P12\' an open key schema: revoke drops an extra key field and matches on the declared field only', async () =>
    {
        const runtime = runtimeState(() => true);
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime: runtime.state }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);

        await runtime.state.revoke({ subject: 's', key: membership });
        await runtime.state.changed.emit({ workspaceId: 'w1' });
        await ping.emit({ n: 1 });
        await onW1.frame('ping');

        expect(onW1.named(REVOKED)).toHaveLength(1);
        expect(onW1.named(RUNTIME)).toEqual([]);
    });

    it('P13 a strict key schema: revoke with an extra key field resolves and revokes the tab', async () =>
    {
        const runtime = strictRuntime(() => true);
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);

        await expect(runtime.revoke({ subject: 's', key: membership })).resolves.toBeUndefined();
        await runtime.changed.emit({ workspaceId: 'w1' });
        await ping.emit({ n: 1 });
        await onW1.frame('ping');

        expect(onW1.named(REVOKED)).toHaveLength(1);
        expect(onW1.named(RUNTIME)).toEqual([]);
    });

    it('P13\' a strict key schema: grant with an extra key field resolves and opens the denied tab', async () =>
    {
        const runtime = strictRuntime(() => false);
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);

        await expect(runtime.grant({ subject: 's', key: membership })).resolves.toBeUndefined();
        await ping.emit({ n: 1 });
        await onW1.frame('ping');

        expect(onW1.named(GRANTED)).toHaveLength(1);
        expect(onW1.named(RUNTIME)).toHaveLength(1);
    });

    it('P14 a strict key schema: a key missing workspaceId rejects naming the missing field', async () =>
    {
        const runtime = strictRuntime(() => true);
        defineStateRouter({ runtime });
        const missing = { role: 'owner' } as never;

        for (const method of ['grant', 'revoke'] as const)
        {
            const message = await runtime[method]({ subject: 's', key: missing }).then(() => 'resolved', (error: Error) => error.message);

            expect(message).toContain(`State "runtime" .${method}() refused its key: /workspaceId Expected required property`);
            expect(message).not.toContain('Unexpected property');
        }
    });

    it('P15 a key schema listing an Optional field in required: revoke with {} rejects and revokes no tab', async () =>
    {
        const key = Object.assign(Type.Object({ workspaceId: Type.Optional(Type.String()) }), { required: ['workspaceId'] });
        const runtime = defineState('runtime')
            .key(key, { shared: true })
            .value(Consent)
            .canRead(() => true)
            .read(async () => ({ value: 'agreed' as const }));
        const { connect, ping } = pingedStreamApp(defineStateRouter({ runtime }));
        const onW1 = await connect('s', `events=${RUNTIME}&workspaceId=w1`);
        const onW2 = await connect('s', `events=${RUNTIME}&workspaceId=w2`);

        const message = await runtime.revoke({ subject: 's', key: {} as never }).then(() => 'resolved', (error: Error) => error.message);
        await ping.emit({ n: 1 });
        await Promise.all([onW1.frame('ping'), onW2.frame('ping')]);

        expect(message).toContain('State "runtime" .revoke() refused its key');
        expect(onW1.named(REVOKED)).toEqual([]);
        expect(onW2.named(REVOKED)).toEqual([]);
    });

    it('P16 a strict key schema: a non-string key field rejects naming the field', async () =>
    {
        const runtime = strictRuntime(() => true);
        defineStateRouter({ runtime });

        for (const method of ['grant', 'revoke'] as const)
        {
            const message = await runtime[method]({ subject: 's', key: { workspaceId: 1 } as never }).then(() => 'resolved', (error: Error) => error.message);

            expect(message).toContain(`State "runtime" .${method}() refused its key: /workspaceId Expected string`);
        }
    });
});
