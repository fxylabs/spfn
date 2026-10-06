/**
 * The removal verdict table.
 *
 * One rule holds the whole thing up: an unreadable file and "nobody calls it"
 * are different answers. Three of these four cases are refusals, and only the
 * last one is a pass.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { callersOf, readUsageRecords } from '../usage';

const ROOT = resolve(process.cwd(), '.test-tmp-contract-usage');
const USAGE = join(ROOT, 'usage');

function writeUsage(name: string, content: string): void
{
    mkdirSync(USAGE, { recursive: true });
    writeFileSync(join(USAGE, name), content, 'utf-8');
}

describe('reading usage files', () =>
{
    beforeEach(() => rmSync(ROOT, { recursive: true, force: true }));
    afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

    it('refuses to decide when the directory does not exist', () =>
    {
        const result = readUsageRecords(USAGE);

        expect(result.decidable).toBe(false);
        expect(result.decidable === false && result.reason).toContain('does not exist');
    });

    it('refuses to decide when the directory holds no usage file', () =>
    {
        mkdirSync(USAGE, { recursive: true });

        const result = readUsageRecords(USAGE);

        expect(result.decidable).toBe(false);
        expect(result.decidable === false && result.reason).toContain('no usage file');
    });

    it('refuses to decide when a file cannot be parsed, and names it', () =>
    {
        writeUsage('ios-2.4.1.json', '{ not json');

        const result = readUsageRecords(USAGE);

        expect(result.decidable).toBe(false);
        expect(result.decidable === false && result.reason).toContain('ios-2.4.1.json');
    });

    it('refuses to decide when a file is the wrong shape, and names it', () =>
    {
        writeUsage('ios-2.4.1.json', JSON.stringify({ platform: 'ios', operations: ['getUser'] }));

        const result = readUsageRecords(USAGE);

        expect(result.decidable).toBe(false);
        expect(result.decidable === false && result.reason).toContain('appVersion');
    });

    it('U1 refuses a file whose events is not an array, naming the field', () =>
    {
        writeUsage('ios-2.4.1.json', JSON.stringify({
            platform: 'ios',
            appVersion: '2.4.1',
            operations: [],
            events: 'sessionActivity',
        }));

        const result = readUsageRecords(USAGE);

        expect(result.decidable).toBe(false);
        expect(result.decidable === false && result.reason).toContain('"events"');
    });

    it('U2 reads a file without events as subscribing to none', () =>
    {
        writeUsage('ios-2.4.1.json', JSON.stringify({ platform: 'ios', appVersion: '2.4.1', operations: [] }));

        const result = readUsageRecords(USAGE);

        expect(result.decidable === true && result.records[0].events).toEqual([]);
    });

    it('decides once every file is read', () =>
    {
        writeUsage('ios-2.4.1.json', JSON.stringify({ platform: 'ios', appVersion: '2.4.1', operations: ['getUser'] }));
        writeUsage('android-3.0.0.json', JSON.stringify({ platform: 'android', appVersion: '3.0.0', operations: [] }));

        const result = readUsageRecords(USAGE);

        expect(result.decidable).toBe(true);
        expect(result.decidable === true && result.records).toHaveLength(2);
    });

    it('one unreadable file makes the whole answer undecidable', () =>
    {
        writeUsage('ios-2.4.1.json', JSON.stringify({ platform: 'ios', appVersion: '2.4.1', operations: [] }));
        writeUsage('android-3.0.0.json', 'nope');

        expect(readUsageRecords(USAGE).decidable).toBe(false);
    });
});

describe('who still calls an operation', () =>
{
    const records = [
        { platform: 'ios', appVersion: '2.4.1', operations: ['getUser'], file: 'a' },
        { platform: 'android', appVersion: '3.0.0', operations: ['listUsers'], file: 'b' },
    ];

    it('finds nobody when nobody calls it', () =>
    {
        expect(callersOf('deleteUser', records)).toEqual([]);
    });

    it('names the platform and version that still call it', () =>
    {
        expect(callersOf('getUser', records).map(record => `${record.platform} ${record.appVersion}`))
            .toEqual(['ios 2.4.1']);
    });
});
