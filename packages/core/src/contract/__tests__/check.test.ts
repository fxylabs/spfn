/**
 * The gate, end to end.
 *
 * Covers the "no previous snapshot" column of the case table and the removal
 * verdicts, which only exist once the pieces are put together.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkContract, formatViolations } from '../check';
import { usageDir, writeSnapshot } from '../snapshot';
import type { ContractDocument, ContractEvents, ContractOperation } from '../types';

const ROOT = resolve(process.cwd(), '.test-tmp-contract-check');

function operation(overrides: Partial<ContractOperation> = {}): ContractOperation
{
    return {
        name: 'getUser',
        method: 'GET',
        path: '/users/:id',
        since: '1.0.0',
        auth: 'none',
        requiresSession: false,
        request: {},
        interceptor: {},
        response: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        ...overrides,
    };
}

function document(operations: ContractOperation[], contractVersion?: string): ContractDocument
{
    return {
        documentVersion: 1,
        ...(contractVersion ? { contractVersion } : {}),
        compatibilityPolicy: 'perOperation',
        operations,
    };
}

function writeUsage(name: string, content: unknown): void
{
    mkdirSync(usageDir(ROOT), { recursive: true });
    writeFileSync(
        join(usageDir(ROOT), name),
        typeof content === 'string' ? content : JSON.stringify(content),
        'utf-8',
    );
}

describe('with nothing released yet', () =>
{
    beforeEach(() => rmSync(ROOT, { recursive: true, force: true }));
    afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

    it('passes every change and says why it compared nothing', () =>
    {
        const result = checkContract(ROOT, document([operation({ path: '/anything' })]));

        expect(result.violations).toEqual([]);
        expect(result.baselineVersion).toBeUndefined();
        expect(result.warnings[0]).toContain('No released contract snapshot');
    });
});

describe('against a released snapshot', () =>
{
    beforeEach(() =>
    {
        rmSync(ROOT, { recursive: true, force: true });
        writeSnapshot(ROOT, document([operation()], '1.0.0'));
    });

    afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

    it('passes an unchanged contract', () =>
    {
        const result = checkContract(ROOT, document([operation()]));

        expect(result.violations).toEqual([]);
        expect(result.baselineVersion).toBe('1.0.0');
    });

    it('refuses a broken response', () =>
    {
        const result = checkContract(ROOT, document([operation({ response: { type: 'object', properties: {} } })]));

        expect(result.violations.map(violation => violation.kind)).toEqual(['response.field-removed']);
    });

    it('refuses a removal it cannot decide', () =>
    {
        const result = checkContract(ROOT, document([]));

        expect(result.violations.map(violation => violation.kind)).toEqual(['usage.undecidable']);
        expect(result.violations[0].detail).toContain('getUser');
    });

    it('refuses a removal a released app still calls, naming it', () =>
    {
        writeUsage('ios-2.4.1.json', { platform: 'ios', appVersion: '2.4.1', operations: ['getUser'] });

        const result = checkContract(ROOT, document([]));

        expect(result.violations.map(violation => violation.kind)).toEqual(['usage.still-called']);
        expect(result.violations[0].detail).toContain('ios 2.4.1');
    });

    it('allows a removal once every released app has stopped calling it', () =>
    {
        writeUsage('ios-2.5.0.json', { platform: 'ios', appVersion: '2.5.0', operations: [] });

        expect(checkContract(ROOT, document([])).violations).toEqual([]);
    });

    it('refuses a removal when one usage file is unreadable, even if the others say nobody calls it', () =>
    {
        writeUsage('ios-2.5.0.json', { platform: 'ios', appVersion: '2.5.0', operations: [] });
        writeUsage('android-3.0.0.json', 'not json');

        expect(checkContract(ROOT, document([])).violations.map(violation => violation.kind))
            .toEqual(['usage.undecidable']);
    });

    it('refuses when the baseline snapshot was hand-edited', () =>
    {
        writeFileSync(
            join(ROOT, 'released', '1.0.0.json'),
            JSON.stringify({ version: '1.0.0', sha256: 'deadbeef', document: document([operation()]) }),
            'utf-8',
        );

        expect(checkContract(ROOT, document([operation()])).violations.map(violation => violation.kind))
            .toEqual(['snapshot.digest-mismatch']);
    });
});

describe('the gate over contracted events', () =>
{
    function events(names: string[], streamPath = '/events/stream'): ContractEvents
    {
        return {
            streamPath,
            tokenPath: streamPath.replace(/\/[^/]+$/, '/token'),
            auth: 'none',
            items: names.map(name => ({ name, since: '1.0.0', payload: { type: 'object', properties: {} } })),
        };
    }

    function withEvents(section: ContractEvents, contractVersion?: string): ContractDocument
    {
        return { ...document([operation()], contractVersion), events: section };
    }

    beforeEach(() => rmSync(ROOT, { recursive: true, force: true }));
    afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

    describe('against a released snapshot with events', () =>
    {
        beforeEach(() => writeSnapshot(ROOT, withEvents(events(['sessionActivity', 'x']), '1.0.0')));

        it('G1 refuses an event removal it cannot decide', () =>
        {
            const result = checkContract(ROOT, withEvents(events(['sessionActivity'])));

            expect(result.violations.map(violation => violation.kind)).toEqual(['usage.undecidable']);
            expect(result.violations[0].detail).toContain('x');
        });

        it('G2 refuses an event removal a released app still subscribes to, naming it', () =>
        {
            writeUsage('ios-2.4.1.json', { platform: 'ios', appVersion: '2.4.1', operations: [], events: ['x'] });

            const result = checkContract(ROOT, withEvents(events(['sessionActivity'])));

            expect(result.violations).toHaveLength(1);
            expect(result.violations[0]).toMatchObject({ kind: 'usage.still-subscribed', event: 'x' });
            expect(result.violations[0].detail).toContain('ios 2.4.1');
        });

        it('G3 allows an event removal once no released app subscribes to it', () =>
        {
            writeUsage('ios-2.4.1.json', { platform: 'ios', appVersion: '2.4.1', operations: [], events: ['sessionActivity'] });
            writeUsage('android-3.0.0.json', { platform: 'android', appVersion: '3.0.0', operations: [] });

            expect(checkContract(ROOT, withEvents(events(['sessionActivity']))).violations).toEqual([]);
        });

        it('G4 refuses an event removal when one usage file is unreadable, naming it', () =>
        {
            writeUsage('ios-2.4.1.json', { platform: 'ios', appVersion: '2.4.1', operations: [], events: [] });
            writeUsage('android-3.0.0.json', 'not json');

            const result = checkContract(ROOT, withEvents(events(['sessionActivity'])));

            expect(result.violations.map(violation => violation.kind)).toEqual(['usage.undecidable']);
            expect(result.violations[0].detail).toContain('android-3.0.0.json');
        });

        it('G5 refuses a stream path changed since the snapshot', () =>
        {
            const result = checkContract(ROOT, withEvents(events(['sessionActivity', 'x'], '/sse')));

            expect(result.violations.map(violation => violation.kind)).toEqual(['events.stream-path-changed']);
        });
    });

    it('G6 passes events with nothing released yet, with the first-contract warning', () =>
    {
        const result = checkContract(ROOT, withEvents(events(['sessionActivity'])));

        expect(result.violations).toEqual([]);
        expect(result.warnings[0]).toContain('No released contract snapshot');
    });

    it('prints an event violation with the event where an operation goes', () =>
    {
        const rendered = formatViolations([
            { kind: 'event.payload.field-removed', event: 'sessionActivity', location: 'payload.at', detail: 'gone' },
        ]);

        expect(rendered).toContain('[event.payload.field-removed] sessionActivity payload.at: gone');
    });
});

describe('the message a failing build prints', () =>
{
    it('names the operation, the place and the reason', () =>
    {
        const rendered = formatViolations([
            { kind: 'response.field-removed', operation: 'getUser', location: 'response.name', detail: 'gone' },
        ]);

        expect(rendered).toContain('response.field-removed');
        expect(rendered).toContain('getUser response.name');
        expect(rendered).toContain('gone');
    });
});
