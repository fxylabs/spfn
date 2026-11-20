/**
 * Every event the package defines is one an app can import (#361).
 *
 * The export list in `server.ts` and the event definitions are written
 * separately, and the README documents events from the definitions.
 * `mfaLockedEvent`, `passkeyEnrolledEvent` and `passkeyRevokedEvent` were
 * documented and fired but not exported, so no app could subscribe to them.
 *
 * The events are found in the source, not listed: every production file under
 * `src` (tests excluded) that calls `defineEvent(`, or the name it imports
 * `defineEvent` as, is imported, and each call must be matched by an event
 * object the file exports. Each of those objects must be exported from
 * `server.ts` as the same object, or be named in `NOT_PUBLIC` with why. An
 * event added later, in any file, is checked the first time this runs; one
 * defined but not exported from its own file fails the count. The calls found
 * must be more than none, so a broken walk cannot empty the list and pass the
 * check unseen.
 *
 * What it does not see: the payload types, which exist only at compile time.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, it, expect } from 'vitest';

import * as server from '@/server';

/** Events defined but deliberately not exported from `@spfn/auth/server`, with why. */
const NOT_PUBLIC: Record<string, string> = {};

const SOURCE_ROOT = resolve(__dirname, '../..');

interface EventSource
{
    file: string;
    defineEventCalls: number;
    events: Array<[exportName: string, event: unknown]>;
}

function isEventDefinition(value: unknown): boolean
{
    return typeof value === 'object'
        && value !== null
        && typeof (value as { name?: unknown }).name === 'string'
        && typeof (value as { subscribe?: unknown }).subscribe === 'function'
        && typeof (value as { emit?: unknown }).emit === 'function';
}

function isProductionSource(file: string): boolean
{
    return /\.tsx?$/.test(file)
        && !/\.d\.ts$/.test(file)
        && !/\.(test|spec)\.tsx?$/.test(file)
        && !file.split('/').includes('__tests__');
}

/** Calls of `defineEvent`, under its own name or any name the file imports it as. */
function countDefineEventCalls(source: string): number
{
    const aliases = [...source.matchAll(/\bdefineEvent\s+as\s+(\w+)/g)].map(([, alias]) => alias);

    return ['defineEvent', ...aliases]
        .reduce((total, name) => total + (source.match(new RegExp(`\\b${name}\\(`, 'g'))?.length ?? 0), 0);
}

async function readEventSource(file: string, defineEventCalls: number): Promise<EventSource>
{
    const module = await import(join(SOURCE_ROOT, file)) as Record<string, unknown>;

    return {
        file,
        defineEventCalls,
        events: Object.entries(module).filter(([, value]) => isEventDefinition(value)),
    };
}

async function findEventSources(): Promise<EventSource[]>
{
    const files = readdirSync(SOURCE_ROOT, { recursive: true, encoding: 'utf8' })
        .filter(isProductionSource)
        .map(file => [file, countDefineEventCalls(readFileSync(join(SOURCE_ROOT, file), 'utf8'))] as const)
        .filter(([, calls]) => calls > 0);

    return Promise.all(files.map(([file, calls]) => readEventSource(file, calls)));
}

describe('public events', () =>
{
    let sources: EventSource[];

    beforeAll(async () =>
    {
        sources = await findEventSources();
    });

    it('finds an exported event object for each defineEvent call in the production source', () =>
    {
        expect(sources.reduce((total, source) => total + source.defineEventCalls, 0)).toBeGreaterThan(0);
        expect(sources.map(source => [source.file, new Set(source.events.map(([, event]) => event)).size]))
            .toEqual(sources.map(source => [source.file, source.defineEventCalls]));
    });

    it('exports every defined event from @spfn/auth/server, or names it in NOT_PUBLIC', () =>
    {
        const exported = new Set<unknown>(Object.values(server));
        const unexported = sources.flatMap(source => source.events
            .filter(([exportName, event]) => !exported.has(event) && !(exportName in NOT_PUBLIC))
            .map(([exportName]) => `${source.file}: ${exportName}`));

        expect(unexported).toEqual([]);
    });
});
