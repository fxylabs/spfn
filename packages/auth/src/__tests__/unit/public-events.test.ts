/**
 * Every event the package defines is one an app can import (#361).
 *
 * The export list in `server.ts` and the definitions in `server/events` are
 * written separately, and the README documents events from the definitions.
 * `mfaLockedEvent`, `passkeyEnrolledEvent` and `passkeyRevokedEvent` were
 * documented and fired but not exported, so no app could subscribe to them.
 *
 * The events are read off the module at runtime, not listed: every export of
 * `server/events` that is an event definition is exported from `server.ts` as
 * the same object, or is named in `NOT_PUBLIC` with why. An event added later
 * is checked the first time this runs. The definitions found are counted
 * against the `defineEvent(` calls in the source, so a change to what an event
 * object looks like cannot empty the list and pass the check unseen.
 *
 * What it does not see: the payload types, which exist only at compile time.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import * as events from '@/server/events';
import * as server from '@/server';

/** Events defined but deliberately not exported from `@spfn/auth/server`, with why. */
const NOT_PUBLIC: Record<string, string> = {};

function isEventDefinition(value: unknown): boolean
{
    return typeof value === 'object'
        && value !== null
        && typeof (value as { name?: unknown }).name === 'string'
        && typeof (value as { subscribe?: unknown }).subscribe === 'function'
        && typeof (value as { emit?: unknown }).emit === 'function';
}

const definedEvents = Object.entries(events)
    .filter(([, value]) => isEventDefinition(value))
    .map(([exportName]) => exportName);

describe('public events', () =>
{
    it('finds one event for each defineEvent call in server/events', () =>
    {
        const source = readFileSync(resolve(__dirname, '../../server/events/index.ts'), 'utf8');

        expect(definedEvents).toHaveLength(source.match(/\bdefineEvent\(/g)!.length);
    });

    it('exports every defined event from @spfn/auth/server, or names it in NOT_PUBLIC', () =>
    {
        const unexported = definedEvents.filter(exportName =>
            (server as Record<string, unknown>)[exportName] !== (events as Record<string, unknown>)[exportName]
            && !(exportName in NOT_PUBLIC));

        expect(unexported).toEqual([]);
    });
});
