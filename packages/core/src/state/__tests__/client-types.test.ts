/**
 * State client types — what `typeof states` lets an app write. Every
 * assertion is an `expectTypeOf` expression on types alone (`client` is only
 * declared): vitest runs them, and `pnpm type-check` fails when a positive
 * stops compiling or a negative starts to.
 *
 * | #  | assertion                                                                                       |
 * |----|-------------------------------------------------------------------------------------------------|
 * | T1 | `client.subscribe('runtime', { workspaceId: 'w1' }, cb)` compiles; with `{ teamId }` does not; without a key does not |
 * | T2 | `client.subscribe('consent', cb)` compiles; with a key does not                                 |
 * | T3 | `client.write('consent', { termsVersion, marketing })` compiles; `client.write('member', …)` does not; a keyed write without its key does not |
 * | T4 | `useServerState(client, 'nope')` does not compile                                               |
 * | T5 | the value type of `useServerState(client, 'consent').value` is `'pending' \| 'agreed' \| undefined` |
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { StateClient, StateEntry, StateId, StateListener } from '../client';
import type { useServerState } from '../react';
import type { FixtureStates } from './client-harness';

declare const client: StateClient<FixtureStates>;

type Id = StateId<FixtureStates>;

type SubscribeArgs<I extends Id> = Parameters<typeof client.subscribe<I>>;

type WriteArgs<I extends 'consent' | 'runtime'> = Parameters<typeof client.write<I>>;

type HookArgs = Parameters<typeof useServerState<FixtureStates, Id>>;

type HookResult<I extends Id> = ReturnType<typeof useServerState<FixtureStates, I>>;

describe('state client types', () =>
{
    it('T1 a keyed subscribe takes exactly its key', () =>
    {
        expectTypeOf<['runtime', { workspaceId: string }, StateListener]>().toMatchTypeOf<SubscribeArgs<'runtime'>>();
        expectTypeOf<['runtime', { teamId: string }, StateListener]>().not.toMatchTypeOf<SubscribeArgs<'runtime'>>();
        expectTypeOf<['runtime', StateListener]>().not.toMatchTypeOf<SubscribeArgs<'runtime'>>();
    });

    it('T2 a keyless subscribe takes no key', () =>
    {
        expectTypeOf<['consent', StateListener]>().toMatchTypeOf<SubscribeArgs<'consent'>>();
        expectTypeOf<['consent', { workspaceId: string }, StateListener]>().not.toMatchTypeOf<SubscribeArgs<'consent'>>();
    });

    it('T3 write is typed by the state\'s input, only for states with a write, with the key when keyed', () =>
    {
        expectTypeOf<StateClient<FixtureStates>['write']>().parameter(0).toEqualTypeOf<'consent' | 'runtime'>();
        expectTypeOf<StateClient<FixtureStates>['write']>().parameter(0).not.toEqualTypeOf<Id>();
        expectTypeOf<['consent', { termsVersion: string; marketing: boolean }]>().toMatchTypeOf<WriteArgs<'consent'>>();
        expectTypeOf<['consent', { termsVersion: number; marketing: boolean }]>().not.toMatchTypeOf<WriteArgs<'consent'>>();
        expectTypeOf<['runtime', { action: 'restart' }, { workspaceId: string }]>().toMatchTypeOf<WriteArgs<'runtime'>>();
        expectTypeOf<['runtime', { action: 'restart' }]>().not.toMatchTypeOf<WriteArgs<'runtime'>>();
    });

    it('T4 useServerState refuses an id the router does not have', () =>
    {
        expectTypeOf<'consent'>().toMatchTypeOf<HookArgs[1]>();
        expectTypeOf<'nope'>().not.toMatchTypeOf<HookArgs[1]>();
    });

    it('T5 the hook\'s value is the state\'s value type, or undefined while loading', () =>
    {
        expectTypeOf<HookResult<'consent'>['value']>().toEqualTypeOf<'pending' | 'agreed' | undefined>();
        expectTypeOf<HookResult<'consent'>['data']>().toEqualTypeOf<{ marketing: boolean } | undefined>();
        expectTypeOf<HookResult<'member'>['value']>().toEqualTypeOf<'owner' | 'admin' | 'member' | undefined>();
        expectTypeOf<ReturnType<typeof client.current<'runtime'>>>().toEqualTypeOf<StateEntry<'provisioning' | 'ready', undefined> | undefined>();
    });
});
