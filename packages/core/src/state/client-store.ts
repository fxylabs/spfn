/**
 * State Client Store
 *
 * One frozen entry per `(id, key)` and the ordering rule that decides whether
 * an arrival — a snapshot entry, a frame, a read or a write answer — replaces
 * it. An entry is replaced only on an applied change, so `current()` returns
 * the same object until then: `useSyncExternalStore` compares by reference
 * and would re-render forever on a fresh object per call.
 */

import type { StateEntry, StateFrame, StateListener } from './client-types';

/** Key fields, flat strings by construction (`.key()` refuses other fields). */
export type StateKeyFields = Record<string, string>;

/** A key as text with its fields sorted, so equal keys written in any order name one entry. */
export function stableKey(key: StateKeyFields | undefined): string
{
    if (!key)
    {
        return '';
    }

    return JSON.stringify(Object.keys(key).sort().map(field => [field, key[field]]));
}

/** The inverse of `stableKey`. */
export function parseKey(text: string): StateKeyFields | undefined
{
    return text ? Object.fromEntries(JSON.parse(text) as [string, string][]) : undefined;
}

/** Deep equality of JSON values, which is all a frame carries. */
function sameJson(a: unknown, b: unknown): boolean
{
    if (a === b)
    {
        return true;
    }

    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    {
        return false;
    }

    const aKeys = Object.keys(a);
    const bRecord = b as Record<string, unknown>;

    return aKeys.length === Object.keys(b).length
        && aKeys.every(field => field in bRecord && sameJson((a as Record<string, unknown>)[field], bRecord[field]));
}

/**
 * The ordering rule for the value. A newer `at` replaces; an older one is
 * dropped; an equal one is by design the same value (one read stamps one
 * `at`), so it replaces only when it says something different. An entry
 * marked revoked before any value arrived has no `at`: anything replaces it.
 */
function supersedes(current: StateEntry | undefined, arrival: StateFrame): boolean
{
    if (current?.at === undefined || arrival.at > current.at)
    {
        return true;
    }

    if (arrival.at < current.at)
    {
        return false;
    }

    return !sameJson(current.value, arrival.value) || !sameJson(current.data, arrival.data);
}

function entryOf(frame: StateFrame, status: StateStatus): StateEntry
{
    const { at, value, data } = frame;

    return Object.freeze(data === undefined ? { at, value, status } : { at, value, data, status });
}

type StateStatus = StateEntry['status'];

export class StateStore
{
    private readonly entries = new Map<string, StateEntry>();
    private readonly listeners = new Map<string, Set<StateListener>>();

    /**
     * The slots the server stopped serving, with the generation of the
     * connection that said so. Kept apart from the entries: a revoke can
     * arrive before the slot has a value, and an arrival afterwards supplies
     * the value without clearing the mark.
     */
    private readonly revoked = new Map<string, number>();

    /** The store slot of `(id, key)`. */
    static slot(id: string, keyText: string): string
    {
        return `${id}\u0000${keyText}`;
    }

    current(slot: string): StateEntry | undefined
    {
        return this.entries.get(slot);
    }

    /**
     * Apply an arrival: the value under the ordering rule, the status from the
     * revoked mark. Listeners hear only an applied change.
     */
    apply(slot: string, frame: StateFrame): void
    {
        const current = this.entries.get(slot);
        const status: StateStatus = this.revoked.has(slot) ? 'revoked' : 'ready';

        if (supersedes(current, frame))
        {
            this.replace(slot, entryOf(frame, status));
        }
        else if (current!.status !== status)
        {
            // Not superseded, so the current entry has a value: only its status changes.
            this.replace(slot, entryOf(current as StateFrame, status));
        }
    }

    /** Mark `slot` revoked by the connection of `generation`; its value, if any, is kept. */
    revoke(slot: string, generation: number): void
    {
        this.revoked.set(slot, generation);
        const entry = this.entries.get(slot);

        if (entry?.status !== 'revoked')
        {
            this.replace(slot, Object.freeze(entry ? { ...entry, status: 'revoked' as const } : { status: 'revoked' as const }));
        }
    }

    /** The generation of the connection that revoked `slot`, or `undefined` while it is served. */
    revokedBy(slot: string): number | undefined
    {
        return this.revoked.get(slot);
    }

    /** Clear the revoked mark; the next arrival for `slot` is `'ready'`. */
    allow(slot: string): void
    {
        this.revoked.delete(slot);
    }

    listen(slot: string, listener: StateListener): void
    {
        const set = this.listeners.get(slot) ?? new Set();
        set.add(listener);
        this.listeners.set(slot, set);
    }

    unlisten(slot: string, listener?: StateListener): void
    {
        const set = this.listeners.get(slot);

        if (listener)
        {
            set?.delete(listener);
        }

        if (!listener || set?.size === 0)
        {
            this.listeners.delete(slot);
        }
    }

    clearListeners(): void
    {
        this.listeners.clear();
    }

    /** Replace the entry and notify; a throwing listener is logged and does not stop the others. */
    private replace(slot: string, entry: StateEntry): void
    {
        this.entries.set(slot, entry);

        for (const listener of [...this.listeners.get(slot) ?? []])
        {
            notify(slot, listener);
        }
    }
}

function notify(slot: string, listener: StateListener): void
{
    try
    {
        listener();
    }
    catch (error)
    {
        // The state id only: the key is the app's data.
        console.warn(`[state] A listener of state "${slot.split('\u0000')[0]}" threw:`, error);
    }
}
