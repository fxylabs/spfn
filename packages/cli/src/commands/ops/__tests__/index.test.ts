import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpsCommandDescriptor } from '../../../utils/ops/client.js';
import { destructiveConfirmationRequired, opsCommand } from '../index.js';

function command(effect?: OpsCommandDescriptor['effect']): OpsCommandDescriptor
{
    return {
        name: 'reconcile.key.forget',
        method: 'DELETE',
        path: '/_ops/reconcile/key/:key',
        ...(effect ? { effect } : {}),
        input: {},
    };
}

describe('destructiveConfirmationRequired', () =>
{
    it('requires --yes only for commands explicitly described as destructive', () =>
    {
        expect(destructiveConfirmationRequired(command('destructive'), undefined)).toBe(true);
        expect(destructiveConfirmationRequired(command('destructive'), true)).toBe(false);
        expect(destructiveConfirmationRequired(command('write'), undefined)).toBe(false);
        expect(destructiveConfirmationRequired(command(), undefined)).toBe(false);
    });

    it('requires --yes when the effect is unknown because its metadata was refused', () =>
    {
        // The alternative is reading a missing `effect` as harmless, which
        // opens the gate for precisely the commands the CLI could not verify.
        const refused = { ...command(), metadataRejected: true };

        expect(destructiveConfirmationRequired(refused, undefined)).toBe(true);
        expect(destructiveConfirmationRequired(refused, true)).toBe(false);
    });
});

describe('spfn ops list', () =>
{
    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    function answering(commands: unknown[]): void
    {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
            JSON.stringify({ manifestVersion: 1, commands }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
    }

    async function listed(...flags: string[]): Promise<string>
    {
        const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await opsCommand.parseAsync(
            ['list', '--app', 'https://api.example.com', '--token', 'spfn_ops_x', ...flags],
            { from: 'user' },
        );

        return printed.mock.calls.flat().join('\n');
    }

    it('21 — shows an app command\'s effect and summary on its line', async () =>
    {
        answering([{
            name: 'pageAdd', method: 'POST', path: '/_ops/pages', summary: 'Add a page', effect: 'write', input: {},
        }]);

        const output = await listed();

        expect(output).toMatch(/pageAdd.*POST \/_ops\/pages.*input: -  effect: write/);
        expect(output).toContain('    Add a page');
    });

    it('prints --json for a manifest without effects as it always has', async () =>
    {
        const command = { name: 'listSignups', method: 'GET', path: '/_ops/signups', input: {} };
        answering([command]);

        expect(await listed('--json')).toBe(JSON.stringify([command], null, 2));
    });
});
