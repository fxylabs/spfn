/**
 * How the email-match setting resolves (fxylabs/spfn#156).
 *
 * Rows S1-S3 of the #156 design §6-1. Rows E1-E11 and N1-N2 are in
 * integration/oauth-email-match.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { startServer } from '@spfn/core/server';

import { configureAuth, getOAuthEmailMatch, type OAuthEmailMatch } from '@/server/lib/config';

describe('OAuth email-match setting', () =>
{
    afterEach(() =>
    {
        configureAuth({ oauthEmailMatch: undefined });
    });

    it('S1: with nothing set, a matching email attaches as in 0.3.0-beta.50', () =>
    {
        expect(getOAuthEmailMatch()).toBe('attach');
    });

    it('S2: reject and separate are read as set, on every call', () =>
    {
        configureAuth({ oauthEmailMatch: 'reject' });
        expect(getOAuthEmailMatch()).toBe('reject');

        configureAuth({ oauthEmailMatch: 'separate' });
        expect(getOAuthEmailMatch()).toBe('separate');

        configureAuth({ oauthEmailMatch: 'attach' });
        expect(getOAuthEmailMatch()).toBe('attach');
    });

    it('S3 (T5): a value the type does not allow is refused at configuration, naming the allowed values', () =>
    {
        configureAuth({ oauthEmailMatch: 'reject' });

        expect(() => configureAuth({ oauthEmailMatch: 'Reject' as OAuthEmailMatch }))
            .toThrow("configureAuth: oauthEmailMatch does not accept 'Reject'. Allowed: 'attach', 'reject', 'separate'.");
        expect(() => configureAuth({ oauthEmailMatch: 'merge' as OAuthEmailMatch })).toThrow('oauthEmailMatch');
        expect(getOAuthEmailMatch()).toBe('reject');
    });
});

/**
 * S4 (review of PR #314, F1): the refusal in S3 only matters if it stops the
 * server. The config is the compiled form `spfn build` emits, loaded by
 * `@spfn/core` the way production loads it; it imports the built package, so
 * this row needs `pnpm build` first. Without it, a typo in the policy value
 * booted a server with none of the app's routes or lifecycle.
 */
describe('a server.config whose configureAuth refuses a value', () =>
{
    const fixture = mkdtempSync(join(tmpdir(), 'spfn-auth-config-'));
    const builtServerEntry = resolve(__dirname, '../../../dist/server.js');

    afterEach(() =>
    {
        vi.restoreAllMocks();
        rmSync(fixture, { recursive: true, force: true });
    });

    it('S4: refuses the boot with that error, and nothing listens', async () =>
    {
        mkdirSync(join(fixture, '.spfn', 'server'), { recursive: true });
        writeFileSync(
            join(fixture, '.spfn', 'server', 'server.config.mjs'),
            `import { configureAuth } from ${JSON.stringify(builtServerEntry)};\n`
            + "configureAuth({ oauthEmailMatch: 'Reject' });\n"
            + 'export default {};\n',
        );
        vi.spyOn(process, 'cwd').mockReturnValue(fixture);
        const port = 47000 + Math.floor(Math.random() * 1000);

        const boot = startServer({ host: '127.0.0.1', port });

        await expect(boot).rejects.toThrow('.spfn/server/server.config.mjs exists but failed to load');
        await expect(boot).rejects.toMatchObject({
            cause: { message: expect.stringContaining("oauthEmailMatch does not accept 'Reject'") },
        });
        await expect(connects('127.0.0.1', port)).resolves.toBe(false);
    });
});

function connects(host: string, port: number): Promise<boolean>
{
    return new Promise(settle =>
    {
        const socket = createConnection({ host, port });

        socket.once('connect', () =>
        {
            socket.destroy();
            settle(true);
        });
        socket.once('error', () => settle(false));
    });
}
