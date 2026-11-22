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
 * The payload types exist only at compile time, so two more rows read them
 * with the type checker (#420): every event `server/events/index.ts` exports
 * must have a payload type exported beside it — the type of its `_payload` —
 * and `server.ts` must export that same type. And every event or payload type
 * the README's Events section names must be an export of `server.ts`, so the
 * README cannot document a name an app cannot import.
 *
 * | Row                | goes unnoticed without it                                          |
 * |--------------------|--------------------------------------------------------------------|
 * | defined → exported | an event an app cannot import, though the package emits it (#361)  |
 * | payload types      | an event exported without its payload type: nothing fails to build |
 * | README names       | the README documenting an event or type the entry does not export  |
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, it, expect } from 'vitest';

import * as server from '@/server';

/** Events defined but deliberately not exported from `@spfn/auth/server`, with why. */
const NOT_PUBLIC: Record<string, string> = {};

const SOURCE_ROOT = resolve(__dirname, '../..');
const PACKAGE_ROOT = resolve(SOURCE_ROOT, '..');
const SERVER_ENTRY = join(SOURCE_ROOT, 'server.ts');
const EVENTS_MODULE = join(SOURCE_ROOT, 'server/events/index.ts');

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

interface TypeSurface
{
    /** Each event the events module exports → the payload types it exports for it */
    payloadTypes: Map<string, ts.Symbol[]>;
    /** What `server.ts` exports, each resolved to the declaration it re-exports */
    serverExports: Map<string, ts.Symbol>;
}

function resolvedExports(checker: ts.TypeChecker, file: ts.SourceFile): Map<string, ts.Symbol>
{
    return new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(file)!).map(symbol =>
        [symbol.name, symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol]));
}

/** The events module's events and payload types, and `server.ts`'s exports, as the type checker sees them. */
function readTypeSurface(): TypeSurface
{
    const config = ts.getParsedCommandLineOfConfigFile(
        join(PACKAGE_ROOT, 'tsconfig.json'),
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    const program = ts.createProgram([SERVER_ENTRY], { ...config!.options, noEmit: true });
    const checker = program.getTypeChecker();
    const moduleExports = [...resolvedExports(checker, program.getSourceFile(EVENTS_MODULE)!).values()];
    const typeAliases = moduleExports.filter(symbol => symbol.flags & ts.SymbolFlags.TypeAlias);
    const payloadOf = (symbol: ts.Symbol): ts.Type | undefined =>
    {
        const payload = checker.getTypeOfSymbol(symbol).getProperty('_payload');

        return payload && checker.getTypeOfSymbol(payload);
    };

    return {
        payloadTypes: new Map(moduleExports
            .filter(symbol => symbol.flags & ts.SymbolFlags.Variable && payloadOf(symbol) !== undefined)
            .map(event => [event.name, typeAliases.filter(alias => checker.getDeclaredTypeOfSymbol(alias) === payloadOf(event))])),
        serverExports: resolvedExports(checker, program.getSourceFile(SERVER_ENTRY)!),
    };
}

/** The event and payload type names the README's Events section mentions. */
function readmeEventNames(): string[]
{
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
    const start = readme.indexOf('\n## Events\n');
    const section = readme.slice(start, readme.indexOf('\n## ', start + 1));

    return [...new Set(section.match(/\b[A-Za-z]\w*(?:Event|Payload)\b/g) ?? [])];
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

    describe('with the type checker (#420)', () =>
    {
        let surface: TypeSurface;

        beforeAll(() =>
        {
            surface = readTypeSurface();
        });

        it('exports each event of the events module with its payload type, from the module and from server.ts', () =>
        {
            const exported = new Set(surface.serverExports.values());
            const missing = [...surface.payloadTypes].flatMap(([event, types]) =>
            {
                if (types.length === 0)
                {
                    return [`${event}: no payload type exported from server/events`];
                }

                return types.some(type => exported.has(type)) ? [] : [`${event}: ${types.map(type => type.name).join(' | ')} not exported from server.ts`];
            });

            expect(surface.payloadTypes.size).toBeGreaterThan(0);
            expect(missing).toEqual([]);
        });

        it('exports from server.ts every event and payload type the README\'s Events section names', () =>
        {
            const named = readmeEventNames();

            expect(named.length).toBeGreaterThan(0);
            expect(named.filter(name => !surface.serverExports.has(name))).toEqual([]);
        });
    });
});
