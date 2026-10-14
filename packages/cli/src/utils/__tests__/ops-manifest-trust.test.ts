/**
 * What the CLI accepts from an app's manifest.
 *
 * The manifest is the application's own description of itself, and the CLI
 * turns it into a request carrying an ops token — so it is the one input on
 * this surface that is not the operator's. These tests pin what happens to a
 * manifest that is malformed, hostile, or simply newer than this CLI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { destructiveConfirmationRequired } from '../../commands/ops/index.js';
import { trustedManifest, type SurfaceWarning } from '../../surface/manifest-trust.js';
import { fetchOpsManifest, joinUrl, printOpsWarning, type OpsCommandDescriptor } from '../ops/client.js';
import { plain, renderCommandUsage } from '../ops/describe.js';

const ESC = String.fromCharCode(27);

function manifestAnswer(commands: unknown[], modules?: unknown): void
{
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({
            manifestVersion: 1,
            ...(modules !== undefined ? { modules } : {}),
            commands,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    ));
}

beforeEach(() =>
{
    vi.spyOn(console, 'error').mockImplementation(() => 
    {});
});

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('joinUrl', () =>
{
    it('keeps the app URL base path, which `new URL(path, base)` would drop', () =>
    {
        expect(joinUrl('https://example.com/api', '/_ops/signups'))
            .toBe('https://example.com/api/_ops/signups');
        expect(new URL('/_ops/signups', 'https://example.com/api').href)
            .toBe('https://example.com/_ops/signups');
    });

    it('does not double a trailing slash', () =>
    {
        expect(joinUrl('https://example.com/', '/_ops/x')).toBe('https://example.com/_ops/x');
    });
});

describe('fetchOpsManifest', () =>
{
    const good = { name: 'listSignups', method: 'GET', path: '/_ops/signups', input: {} };

    it('keeps a well-formed command', async () =>
    {
        manifestAnswer([good]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.commands).toEqual([good]);
    });

    it.each([
        ['an absolute URL', { ...good, path: 'https://evil.example/steal' }],
        ['a path outside the ops namespace', { ...good, path: '/internal/admin' }],
        ['a path climbing out of it', { ...good, path: '/_ops/../../internal/admin' }],
        ['a method the CLI cannot send', { ...good, method: 'TRACE' }],
        ['a missing method', { name: 'x', path: '/_ops/x', input: {} }],
        ['a missing name', { method: 'GET', path: '/_ops/x', input: {} }],
    ])('drops a command declaring %s', async (_label, command) =>
    {
        manifestAnswer([command, good]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.commands).toEqual([good]);
    });

    it('says so rather than dropping a command silently', async () =>
    {
        manifestAnswer([{ ...good, path: '/internal/admin' }]);
        await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/Ignoring an ops command/);
    });

    it('gives a command with no input section an empty one, so rendering cannot crash', async () =>
    {
        manifestAnswer([{ name: 'x', method: 'GET', path: '/_ops/x' }]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.commands[0]!.input).toEqual({});
        expect(() => renderCommandUsage(manifest.commands[0]!)).not.toThrow();
    });

    it('keeps valid additive module metadata', async () =>
    {
        const module = {
            id: 'ledger',
            source: '@spfn/ledger',
            contractVersion: '1.0.0',
            summary: 'Ledger diagnostics',
        };
        const command = {
            ...good,
            name: 'ledger.verify',
            path: '/_ops/ledger/verify',
            module: 'ledger',
            summary: 'Verify invariants',
            effect: 'read',
            scopes: ['ledger:read'],
        };

        manifestAnswer([command], [module]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.modules).toEqual([module]);
        expect(manifest.commands).toEqual([command]);
    });

    it('drops malformed module metadata without losing an otherwise safe command', async () =>
    {
        const command = {
            ...good,
            name: 'ledger.verify',
            path: '/_ops/ledger/verify',
            module: 'ledger',
            summary: 'Verify invariants',
            effect: 'erase-everything',
            scopes: ['ledger:read'],
        };

        manifestAnswer([command], [{
            id: 'ledger',
            source: '@spfn/ledger',
            contractVersion: '1.0.0',
            summary: 'Ledger diagnostics',
        }]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.commands).toEqual([{
            name: 'ledger.verify',
            method: 'GET',
            path: '/_ops/ledger/verify',
            input: {},
            metadataRejected: true,
        }]);
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/Ignoring module metadata/);
    });

    it('marks a command whose refused metadata claimed a limit this CLI enforces alone', async () =>
    {
        // The server caps none of these, so a legitimate app can produce a
        // command the CLI refuses to describe. Dropping `effect` silently would
        // hand the operator a destructive command with no confirmation gate.
        manifestAnswer([{
            ...good,
            name: 'ledger.wipe',
            method: 'POST',
            path: '/_ops/ledger/wipe',
            module: 'ledger',
            summary: 'x'.repeat(600),
            effect: 'destructive',
            scopes: ['ledger:write'],
        }], [{
            id: 'ledger',
            source: '@spfn/ledger',
            contractVersion: '1.0.0',
            summary: 'Ledger diagnostics',
        }]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.commands[0]!.effect).toBeUndefined();
        expect(manifest.commands[0]!.metadataRejected).toBe(true);
    });

    it('sanitizes the command name in its own warning, as every other rendered string is', async () =>
    {
        manifestAnswer([{
            ...good,
            name: `ledger.${ESC}[2Jverify`,
            path: '/_ops/ledger/verify',
            module: 'ledger',
            summary: 'Verify invariants',
            effect: 'read',
            scopes: [],
        }], [{
            id: 'ledger',
            source: '@spfn/ledger',
            contractVersion: '1.0.0',
            summary: 'Ledger diagnostics',
        }]);
        await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).not.toContain(ESC);
    });

    it('drops duplicate or malformed modules and detaches their command metadata', async () =>
    {
        const module = {
            id: 'ledger',
            source: '@spfn/ledger',
            contractVersion: '1.0.0',
            summary: 'Ledger diagnostics',
        };
        const command = {
            ...good,
            name: 'ledger.verify',
            path: '/_ops/ledger/verify',
            module: 'missing',
            summary: 'Verify invariants',
            effect: 'read',
            scopes: ['ledger:read'],
        };

        manifestAnswer([command], [module, module, { id: '../bad' }]);
        const manifest = await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(manifest.modules).toEqual([module]);
        expect(manifest.commands[0]!.module).toBeUndefined();
        expect(manifest.commands[0]!.metadataRejected).toBe(true);
        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/duplicated/);
    });
});

describe('rendering a manifest the app wrote', () =>
{
    it('replaces control characters so the app cannot redraw the terminal', () =>
    {
        expect(plain(`${ESC}[2J${ESC}[1;1Hspfn $ `)).toBe('?[2J?[1;1Hspfn $ ');
    });

    it('carries no escape sequence through to the usage block', () =>
    {
        const command = {
            name: `list${ESC}[2J`,
            method: 'GET',
            path: `/_ops/x${ESC}[1;1H`,
            input: {
                query: {
                    type: 'object',
                    properties: { limit: { type: 'number', description: `${ESC}[31mred` } },
                    required: [],
                },
            },
        } as unknown as OpsCommandDescriptor;

        expect(renderCommandUsage(command)).not.toContain(ESC);
    });

    it('stops following a schema deep enough to exhaust the stack', () =>
    {
        let schema: unknown = { type: 'string' };
        for (let i = 0; i < 20000; i++)
        {
            schema = { type: 'object', properties: { n: schema }, required: ['n'] };
        }

        const command = {
            name: 'deep', method: 'GET', path: '/_ops/deep', input: { body: schema },
        } as unknown as OpsCommandDescriptor;

        expect(() => renderCommandUsage(command)).not.toThrow();
    });
});

describe('an app command\'s own effect and summary (#128)', () =>
{
    const appCommand = { name: 'pageAdd', method: 'POST', path: '/_app/pages', input: {} };

    interface Warned
    {
        message: string;
        warning: SurfaceWarning;
    }

    function trusted(command: Record<string, unknown>): { kept: OpsCommandDescriptor; warnings: Warned[] }
    {
        const warnings: Warned[] = [];
        const manifest = trustedManifest({ manifestVersion: 1, commands: [command] }, {
            namespace: '/_app',
            prefix: '/_app/',
            warn: (message, warning) => warnings.push({ message, warning }),
        });

        return { kept: manifest.commands[0]!, warnings };
    }

    it('15 — carries a valid effect and summary without a warning or a confirmation', () =>
    {
        const { kept, warnings } = trusted({ ...appCommand, effect: 'write', summary: 'Add' });

        expect(kept).toEqual({ ...appCommand, summary: 'Add', effect: 'write' });
        expect(kept.metadataRejected).toBeUndefined();
        expect(warnings).toEqual([]);
        expect(destructiveConfirmationRequired(kept, undefined)).toBe(false);
    });

    it('16 — carries destructive, which then asks for --yes', () =>
    {
        const { kept, warnings } = trusted({ ...appCommand, effect: 'destructive' });

        expect(kept.effect).toBe('destructive');
        expect(warnings).toEqual([]);
        expect(destructiveConfirmationRequired(kept, undefined)).toBe(true);
        expect(destructiveConfirmationRequired(kept, true)).toBe(false);
    });

    it('17 — rejects an unknown effect with the command-metadata warning and asks for --yes', () =>
    {
        const { kept, warnings } = trusted({ ...appCommand, effect: 'nuke' });

        expect(kept).toEqual({ ...appCommand, metadataRejected: true });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.warning).toEqual({
            kind: 'metadata',
            command: 'pageAdd',
            metadata: 'command',
            reason: 'its effect is unknown',
        });
        expect(warnings[0]!.message).toBe('Ignoring command metadata for command "pageAdd": its effect is unknown. '
            + 'Its effect is unknown, so treat it as destructive.');
        expect(destructiveConfirmationRequired(kept, undefined)).toBe(true);
    });

    it.each([
        ['an empty summary', ''],
        ['a 501-character summary', 'x'.repeat(501)],
        ['a summary that is not a string', 7],
    ])('18 — rejects %s whole, a valid effect included', (_label, summary) =>
    {
        const { kept, warnings } = trusted({ ...appCommand, effect: 'read', summary });

        expect(kept).toEqual({ ...appCommand, metadataRejected: true });
        expect(warnings[0]!.warning).toMatchObject({ metadata: 'command', reason: 'its summary is empty or too long' });
        expect(warnings[0]!.message).toMatch(/^Ignoring command metadata for command "pageAdd"/);
        expect(destructiveConfirmationRequired(kept, undefined)).toBe(true);
    });

    it('18 — accepts a summary of exactly 500 characters', () =>
    {
        expect(trusted({ ...appCommand, summary: 'x'.repeat(500) }).kept.metadataRejected).toBeUndefined();
    });

    it('19 — reads scopes without a module as module metadata, as before', () =>
    {
        const { kept, warnings } = trusted({ ...appCommand, effect: 'read', scopes: ['x'] });

        expect(kept.metadataRejected).toBe(true);
        expect(kept.effect).toBeUndefined();
        expect(warnings[0]!.warning).toMatchObject({
            kind: 'metadata',
            metadata: 'module',
            reason: 'it names no usable module',
        });
        expect(warnings[0]!.message).toMatch(/^Ignoring module metadata for command "pageAdd"/);
    });

    it('keeps a command announcing no metadata exactly as before', () =>
    {
        const { kept, warnings } = trusted(appCommand);

        expect(kept).toEqual(appCommand);
        expect(Object.keys(kept)).toEqual(['name', 'method', 'path', 'input']);
        expect(warnings).toEqual([]);
        expect(destructiveConfirmationRequired(kept, undefined)).toBe(false);
    });

    it('prints a rejected app command\'s warning in spfn ops\' words, naming it command metadata', async () =>
    {
        manifestAnswer([{ name: 'wipe', method: 'POST', path: '/_ops/wipe', input: {}, effect: 'nuke' }]);
        await fetchOpsManifest('https://api.example.com', 'spfn_ops_x');

        expect(vi.mocked(console.error).mock.calls.flat().join('\n'))
            .toContain('Ignoring command metadata for ops command "wipe": its effect is unknown. Calling it will require --yes.');
    });

    it('prints the module noun for a metadata warning missing the optional field', () =>
    {
        printOpsWarning('ignored', { kind: 'metadata', command: 'wipe', reason: 'its effect is unknown' });

        expect(vi.mocked(console.error).mock.calls.flat().join('\n'))
            .toContain('Ignoring module metadata for ops command "wipe": its effect is unknown. Calling it will require --yes.');
    });
});
