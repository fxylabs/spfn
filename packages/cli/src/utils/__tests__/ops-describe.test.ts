/**
 * renderCommandUsage tests
 *
 * The renderer reads JSON Schema as it arrives in the manifest, so the
 * fixtures here are plain JSON — the same shape TypeBox serializes to.
 */

import { describe, expect, it } from 'vitest';

import { renderCommandUsage } from '../ops/describe.js';
import type { OpsCommandDescriptor } from '../ops/client.js';

function command(input: OpsCommandDescriptor['input'] = {}): OpsCommandDescriptor
{
    return {
        name: 'listSignups',
        method: 'GET',
        path: '/_ops/signups',
        input,
    };
}

describe('renderCommandUsage', () =>
{
    it('says so when a command takes no input', () =>
    {
        const usage = renderCommandUsage(command());

        expect(usage).toContain('listSignups  GET /_ops/signups');
        expect(usage).toContain('Takes no input.');
        expect(usage).toContain('spfn ops call listSignups');
    });

    it('renders capability module summary, effect, and scopes', () =>
    {
        const usage = renderCommandUsage({
            ...command(),
            name: 'ledger.verify',
            path: '/_ops/ledger/verify',
            module: 'ledger',
            summary: 'Verify ledger invariants',
            effect: 'read',
            scopes: ['ledger:read'],
        });

        expect(usage).toContain('Verify ledger invariants');
        expect(usage).toContain('Effect: read');
        expect(usage).toContain('Scopes: ledger:read');
    });

    it('20 — renders an app command\'s effect without a Scopes line', () =>
    {
        const usage = renderCommandUsage({ ...command(), summary: 'List signups', effect: 'write' });

        expect(usage).toBe([
            'listSignups  GET /_ops/signups',
            '',
            '  List signups',
            '',
            '  Effect: write',
            '',
            '  Takes no input.',
            '',
            '  Invoke: spfn ops call listSignups',
        ].join('\n'));
        expect(usage).not.toContain('Scopes:');
    });

    it('20 — renders a module command exactly as before', () =>
    {
        const usage = renderCommandUsage({
            ...command(),
            name: 'ledger.verify',
            path: '/_ops/ledger/verify',
            module: 'ledger',
            summary: 'Verify ledger invariants',
            effect: 'read',
            scopes: ['ledger:read'],
        });

        expect(usage).toBe([
            'ledger.verify  GET /_ops/ledger/verify',
            '',
            '  Verify ledger invariants',
            '',
            '  Effect: read',
            '  Scopes: ledger:read',
            '',
            '  Takes no input.',
            '',
            '  Invoke: spfn ops call ledger.verify',
        ].join('\n'));
    });

    it('marks required and optional fields and names the flag they arrive on', () =>
    {
        const usage = renderCommandUsage(command({
            query: {
                type: 'object',
                properties: {
                    limit: { type: 'number' },
                    status: { type: 'string' },
                },
                required: ['status'],
            },
        }));

        expect(usage).toContain('query parameters (--query)');
        expect(usage).toMatch(/limit\s+number\s+optional/);
        expect(usage).toMatch(/status\s+string\s+required/);
    });

    it('states the constraints the schema declares', () =>
    {
        const usage = renderCommandUsage(command({
            query: {
                type: 'object',
                properties: {
                    limit: { type: 'number', minimum: 1, maximum: 100, default: 10 },
                    state: { type: 'string', enum: ['pending', 'approved'] },
                    since: { type: 'string', format: 'date-time', description: 'ISO timestamp' },
                },
            },
        }));

        expect(usage).toContain('1–100');
        expect(usage).toContain('default 10');
        expect(usage).toContain('one of: pending, approved');
        expect(usage).toContain('date-time');
        expect(usage).toContain('ISO timestamp');
    });

    it('reads an optional TypeBox field as a union without null noise', () =>
    {
        const usage = renderCommandUsage(command({
            query: {
                type: 'object',
                properties: {
                    limit: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                    tags: { type: 'array', items: { type: 'string' } },
                },
            },
        }));

        expect(usage).toMatch(/limit\s+number\s+optional/);
        expect(usage).toMatch(/tags\s+string\[\]\s+optional/);
    });

    it('flattens a nested object into dotted field names', () =>
    {
        const usage = renderCommandUsage({
            name: 'updateSignup',
            method: 'POST',
            path: '/_ops/signups/:id',
            input: {
                params: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                },
                body: {
                    type: 'object',
                    properties: {
                        contact: {
                            type: 'object',
                            properties: { email: { type: 'string' } },
                            required: ['email'],
                        },
                    },
                },
            },
        });

        expect(usage).toContain('path parameters (--param)');
        expect(usage).toContain('body fields (--data)');
        expect(usage).toMatch(/contact\.email\s+string\s+required/);
    });

    it('builds an invocation example from the first field of each section', () =>
    {
        const usage = renderCommandUsage({
            name: 'updateSignup',
            method: 'POST',
            path: '/_ops/signups/:id',
            input: {
                params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                body: { type: 'object', properties: { note: { type: 'string' } } },
            },
        });

        expect(usage).toContain('--param id=<value>');
        expect(usage).toContain('--data \'{"note": ...}\'');
    });
});
