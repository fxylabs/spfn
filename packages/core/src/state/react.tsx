import { useCallback, useMemo, useSyncExternalStore } from 'react';
// Types come from the client entry, so react.d.ts refers to the one declaration
// of StateClient there instead of carrying a copy of its own.
import type {
    AnyStateRouter,
    StateCatalog,
    StateClient,
    StateEntry,
    StateFrame,
    StateFrameOf,
    StateId,
    StateKeyArgs,
} from '@spfn/core/state/client';
import { parseKey, stableKey, type StateKeyFields } from './client-store';

type StateWrite<TStates extends AnyStateRouter, Id extends StateId<TStates>> =
    (input: StateCatalog<TStates>[Id]['input']) => Promise<StateFrameOf<TStates, Id>>;

/**
 * What `useServerState` returns. `'loading'` until the client holds an entry —
 * and always during a server render. `write` is typed only on a state that
 * declares one, bound to the key the hook was given.
 */
export type ServerState<TStates extends AnyStateRouter, Id extends StateId<TStates>> = {
    status: 'loading' | 'ready' | 'revoked';
    at?: string;
    value?: StateCatalog<TStates>[Id]['value'];
    data?: StateCatalog<TStates>[Id]['data'];
} & ([StateCatalog<TStates>[Id]['input']] extends [never] ? {} : { write: StateWrite<TStates, Id> });

/** The client as the hook drives it: the hook's own signature already checked id, key and input. */
interface LooseClient
{
    subscribe(id: string, ...args: unknown[]): () => void;
    current(id: string, ...key: unknown[]): StateEntry | undefined;
    write(id: string, input: unknown, ...key: unknown[]): Promise<StateFrame>;
}

/** A server render has no store: the first client render takes over from `'loading'`. */
function serverSnapshot(): undefined
{
    return undefined;
}

function keyArgs(keyText: string): [] | [StateKeyFields]
{
    const key = parseKey(keyText);

    return key ? [key] : [];
}

/**
 * The entry as the hook returns it. `write` is always attached at runtime — the
 * type hides it on a state without one, whose client `write` rejects — so the
 * result never waits on the manifest.
 */
function toServerState(entry: StateEntry | undefined, write: (input: unknown) => Promise<StateFrame>): object
{
    if (!entry)
    {
        return { status: 'loading', write };
    }

    const { status, at, value, data } = entry;

    return { status, ...(at === undefined ? {} : { at, value }), ...(data === undefined ? {} : { data }), write };
}

/**
 * Subscribe a component to one state of a state client. The key is compared
 * by its fields, so a new object literal on every render does not resubscribe.
 *
 * @example
 * ```tsx
 * const consent = useServerState(state, 'consent');
 * const runtime = useServerState(state, 'runtime', { workspaceId });
 *
 * if (consent.status === 'ready' && consent.value === 'pending')
 * {
 *     await consent.write({ termsVersion, marketing });
 * }
 * ```
 */
export function useServerState<TStates extends AnyStateRouter, Id extends StateId<TStates>>(
    client: StateClient<TStates>,
    id: Id,
    ...key: StateKeyArgs<TStates, Id>
): ServerState<TStates, Id>
{
    const loose = client as unknown as LooseClient;
    const keyText = stableKey(key[0] as StateKeyFields | undefined);
    const args = useMemo(() => keyArgs(keyText), [keyText]);

    const subscribe = useCallback((onChange: () => void) => loose.subscribe(id, ...args, onChange), [loose, id, args]);
    const getSnapshot = useCallback(() => loose.current(id, ...args), [loose, id, args]);
    const entry = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
    const write = useCallback((input: unknown) => loose.write(id, input, ...args), [loose, id, args]);

    return useMemo(() => toServerState(entry, write), [entry, write]) as ServerState<TStates, Id>;
}
