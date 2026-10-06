import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    compareVersions,
    listSnapshots,
    newestSnapshot,
    readSnapshot,
    releasedDir,
    writeCurrentDocument,
    writeSnapshot,
} from '../snapshot';
import { stableDigest, stableStringifyPretty } from '../stable-json';
import type { ContractDocument } from '../types';

const ROOT = resolve(process.cwd(), '.test-tmp-contract-snapshot');

const document: ContractDocument = {
    documentVersion: 1,
    compatibilityPolicy: 'perOperation',
    operations: [{
        name: 'getUser',
        method: 'GET',
        path: '/users/:id',
        since: '1.0.0',
        auth: 'none',
        requiresSession: false,
        request: {},
        interceptor: {},
        response: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }],
};

/** The same document at a stated version — the release name comes from here. */
function at(version: string): ContractDocument
{
    return { ...document, contractVersion: version };
}

describe('version ordering', () =>
{
    it('orders numerically, not as text', () =>
    {
        expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    });

    it('places a pre-release before the release it leads to', () =>
    {
        expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBeLessThan(0);
        expect(compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBeLessThan(0);
    });

    it('refuses a version that is not major.minor.patch', () =>
    {
        expect(() => compareVersions('1.2', '1.2.0')).toThrow(/major\.minor\.patch/);
    });
});

describe('released snapshots', () =>
{
    beforeEach(() => rmSync(ROOT, { recursive: true, force: true }));
    afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

    it('has no baseline before the first release', () =>
    {
        expect(listSnapshots(ROOT)).toEqual([]);
        expect(newestSnapshot(ROOT)).toBeUndefined();
    });

    it('writes a snapshot that reads back', () =>
    {
        const file = writeSnapshot(ROOT, at('1.2.0'));
        const snapshot = readSnapshot(file);

        expect(snapshot.version).toBe('1.2.0');
        expect(snapshot.document).toEqual(at('1.2.0'));
    });

    it('S1 round-trips a document with an events section, digest verified', () =>
    {
        const withEvents: ContractDocument = {
            ...at('1.2.0'),
            events: {
                streamPath: '/events/stream',
                tokenPath: '/events/token',
                auth: 'tokenExchange',
                items: [{
                    name: 'sessionActivity',
                    since: '1.2.0',
                    deprecatedIn: '1.3.0',
                    payload: { type: 'object', properties: { at: { type: 'number' } }, required: ['at'] },
                }],
            },
        };

        const snapshot = readSnapshot(writeSnapshot(ROOT, withEvents));

        expect(snapshot.document).toEqual(withEvents);
        expect(snapshot.sha256).toBe(stableDigest(withEvents));
    });

    it('names the release from the document, not from a second argument', () =>
    {
        const file = writeSnapshot(ROOT, at('1.2.0'));

        expect(file.endsWith('1.2.0.json')).toBe(true);
    });

    it('refuses a release when the router declared no version', () =>
    {
        expect(() => writeSnapshot(ROOT, document)).toThrow(/declares no version/);
    });

    it('picks the newest release as the baseline', () =>
    {
        writeSnapshot(ROOT, at('1.9.0'));
        writeSnapshot(ROOT, at('1.10.0'));

        expect(newestSnapshot(ROOT)?.version).toBe('1.10.0');
    });

    it('refuses to rewrite a released version', () =>
    {
        writeSnapshot(ROOT, at('1.2.0'));

        expect(() => writeSnapshot(ROOT, at('1.2.0'))).toThrow(/never rewritten/);
    });

    it('refuses a snapshot filled in behind the newest one', () =>
    {
        writeSnapshot(ROOT, at('1.2.0'));

        expect(() => writeSnapshot(ROOT, at('1.1.0'))).toThrow(/not newer than/);
    });

    it('refuses a snapshot that was edited after release', () =>
    {
        const file = writeSnapshot(ROOT, at('1.2.0'));
        const snapshot = JSON.parse(readFileSync(file, 'utf-8'));

        snapshot.document.operations[0].path = '/edited';
        writeFileSync(file, stableStringifyPretty(snapshot), 'utf-8');

        expect(() => readSnapshot(file)).toThrow(/edited after release/);
    });

    it('refuses a file that is not a snapshot', () =>
    {
        mkdirSync(releasedDir(ROOT), { recursive: true });
        const file = join(releasedDir(ROOT), '1.2.0.json');
        writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf-8');

        expect(() => readSnapshot(file)).toThrow(/not a contract snapshot/);
    });
});

describe('current.json', () =>
{
    beforeEach(() => rmSync(ROOT, { recursive: true, force: true }));
    afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

    it('writes once and then reports no change for the same document', () =>
    {
        expect(writeCurrentDocument(ROOT, document)).toBe(true);
        expect(writeCurrentDocument(ROOT, document)).toBe(false);
    });

    it('does not depend on key order in the router', () =>
    {
        writeCurrentDocument(ROOT, document);
        const first = readFileSync(join(ROOT, 'current.json'), 'utf-8');

        const reordered: ContractDocument = {
            operations: document.operations.map(operation => ({
                response: operation.response,
                interceptor: operation.interceptor,
                request: operation.request,
                requiresSession: operation.requiresSession,
                auth: operation.auth,
                since: operation.since,
                path: operation.path,
                method: operation.method,
                name: operation.name,
            })),
            compatibilityPolicy: 'perOperation',
            documentVersion: 1,
        };

        rmSync(ROOT, { recursive: true, force: true });
        writeCurrentDocument(ROOT, reordered);

        expect(readFileSync(join(ROOT, 'current.json'), 'utf-8')).toBe(first);
    });
});
