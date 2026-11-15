/**
 * What a production server actually reads as its configuration.
 *
 * `spfn build` compiles src/server/ with tsup, and tsup names the output from
 * the app's package.json: `.mjs` normally, `.js` when the app declares
 * `"type": "module"`. The lookup used to list only `.mjs`, so an app with that
 * declaration started with an empty configuration — no middlewares, no routes,
 * no infrastructure switches — and said so only at debug level. These tests fix
 * both extensions in place and assert the report that would have made it
 * visible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadAndMergeConfig, startServer } from '../start-server';
import { serverLogger } from '../logger';

const { serve } = vi.hoisted(() => ({ serve: vi.fn() }));

vi.mock('@hono/node-server', () => ({ serve }));

let fixture: string;

function writeCompiledConfig(fileName: string, body: string): void
{
    const outDir = join(fixture, '.spfn', 'server');

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, fileName), body);
}

const ALIASED_SOURCE = "import { defineServerConfig } from '@/server/nowhere';\nexport default defineServerConfig().build();\n";

function writeAuthoredConfig(body: string = ALIASED_SOURCE): void
{
    const srcDir = join(fixture, 'src', 'server');

    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'server.config.ts'), body);
}

beforeEach(() =>
{
    fixture = mkdtempSync(join(tmpdir(), 'spfn-config-'));
});

afterEach(() =>
{
    rmSync(fixture, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('compiled server config lookup', () =>
{
    it('loads the config tsup emits for an app declaring "type": "module"', async () =>
    {
        writeCompiledConfig(
            'server.config.js',
            'export default { port: 4321, infrastructure: { database: false } };',
        );

        const config = await loadAndMergeConfig(undefined, fixture);

        expect(config.port).toBe(4321);
        expect(config.infrastructure?.database).toBe(false);
    });

    it('loads the config tsup emits for an app without that declaration', async () =>
    {
        writeCompiledConfig(
            'server.config.mjs',
            'export default { port: 4322, infrastructure: { redis: false } };',
        );

        const config = await loadAndMergeConfig(undefined, fixture);

        expect(config.port).toBe(4322);
        expect(config.infrastructure?.redis).toBe(false);
    });

    it('prefers .mjs when a stale build left both behind', async () =>
    {
        writeCompiledConfig('server.config.mjs', 'export default { port: 4323 };');
        writeCompiledConfig('server.config.js', 'export default { port: 9999 };');

        const config = await loadAndMergeConfig(undefined, fixture);

        expect(config.port).toBe(4323);
    });

    it('lets an explicit argument win over the file', async () =>
    {
        writeCompiledConfig('server.config.mjs', 'export default { port: 4324, debug: true };');

        const config = await loadAndMergeConfig({ port: 5555 }, fixture);

        expect(config.port).toBe(5555);
        expect(config.debug).toBe(true);
    });
});

describe('a config file that exists but fails to load', () =>
{
    // Without this, a typo in a policy value (configureAuth throwing at the
    // top of server.config) booted a server with no routes and no lifecycle
    // that answered every request with a 404 and passed its health check.
    it('rejects with the import error when the file\'s top-level code throws', async () =>
    {
        writeCompiledConfig('server.config.mjs', "throw new Error('oauthEmailMatch: Reject');");

        const loading = loadAndMergeConfig(undefined, fixture);

        await expect(loading).rejects.toThrow('.spfn/server/server.config.mjs exists but failed to load');
        await expect(loading).rejects.toMatchObject({ cause: { message: 'oauthEmailMatch: Reject' } });
    });

    it('does not fall through to a lower-priority file', async () =>
    {
        writeCompiledConfig('server.config.mjs', 'export default {');
        writeCompiledConfig('server.config.js', 'export default { port: 4327 };');

        await expect(loadAndMergeConfig(undefined, fixture)).rejects.toThrow('server.config.mjs');
    });

    it('makes startServer reject before anything listens', async () =>
    {
        writeCompiledConfig('server.config.mjs', "throw new Error('refused at configuration');");
        vi.spyOn(process, 'cwd').mockReturnValue(fixture);

        await expect(startServer()).rejects.toThrow('failed to load');
        expect(serve).not.toHaveBeenCalled();
    });

    it('tells an app whose only config is the unbuilt source to build', async () =>
    {
        writeAuthoredConfig();

        await expect(loadAndMergeConfig(undefined, fixture)).rejects.toThrow('run "spfn build"');
    });

    it('prints the cause alone when the unbuilt source fails for another reason', async () =>
    {
        writeAuthoredConfig("throw new Error('oauthEmailMatch: Reject');\nexport default {};\n");

        const loading = loadAndMergeConfig(undefined, fixture);

        await expect(loading).rejects.toThrow('src/server/server.config.ts exists but failed to load: oauthEmailMatch: Reject');
        await expect(loading).rejects.not.toThrow('spfn build');
    });

    it('keeps the defaults when no config file exists', async () =>
    {
        const config = await loadAndMergeConfig(undefined, fixture);

        expect(config.port).toBeTypeOf('number');
        expect(config.middlewares).toBeUndefined();
        expect(config.routes).toBeUndefined();
    });
});

describe('reporting an address that moved to spfn.config.js', () =>
{
    it('warns once when a config still carries .port() or .host()', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        writeCompiledConfig(
            'server.config.mjs',
            "export default { port: 4326, host: '0.0.0.0' };",
        );

        const config = await loadAndMergeConfig(undefined, fixture);

        // Still honoured — deprecated means one more release, not removed.
        expect(config.port).toBe(4326);
        expect(config.host).toBe('0.0.0.0');

        const deprecations = warningsAbout(warn, 'deprecated');

        expect(deprecations).toHaveLength(1);
        expect(deprecations[0]).toContain('.port() and .host()');
        expect(deprecations[0]).toContain('spfn.config.js');
    });

    it('says nothing to an app that carries no address at all', async () =>
    {
        const warn = vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);

        writeCompiledConfig('server.config.mjs', 'export default { debug: true };');

        await loadAndMergeConfig(undefined, fixture);

        expect(warningsAbout(warn, 'deprecated')).toHaveLength(0);
    });
});

/**
 * Structural, not `ReturnType<typeof vi.spyOn>`: that type carries a construct
 * signature the logger's overloaded `warn` does not satisfy, so every call site
 * failed to type-check. All this needs is the recorded arguments.
 */
function warningsAbout(
    warn: { mock: { calls: unknown[][] } },
    fragment: string,
): string[]
{
    return warn.mock.calls
        .map(call => String(call[0]))
        .filter(message => message.includes(fragment));
}

describe('a config file that loads but exports no plain object', () =>
{
    it.each([
        ['only named exports', 'export const port = 4330;', 'only named exports (port)'],
        ['a number as its default', 'export default 42;', 'a number as its default (42)'],
        ['a promise as its default', 'export default Promise.resolve({ port: 4331 });', 'a promise as its default'],
    ])('refuses a file that exports %s, naming the file and what it found', async (_name, body, found) =>
    {
        writeCompiledConfig('server.config.mjs', body);

        const loading = loadAndMergeConfig(undefined, fixture);

        await expect(loading).rejects.toThrow('.spfn/server/server.config.mjs must export its configuration as a plain object');
        await expect(loading).rejects.toThrow(found);
    });

    it('names a builder that was never built', async () =>
    {
        writeCompiledConfig('server.config.mjs', 'class ServerConfigBuilder {}\nexport default new ServerConfigBuilder();');

        await expect(loadAndMergeConfig(undefined, fixture)).rejects.toThrow('an instance of ServerConfigBuilder');
    });

    it('makes startServer reject before anything listens', async () =>
    {
        writeCompiledConfig('server.config.mjs', 'export default 42;');
        vi.spyOn(process, 'cwd').mockReturnValue(fixture);

        await expect(startServer()).rejects.toThrow('plain object');
        expect(serve).not.toHaveBeenCalled();
    });

    it('accepts an object with a null prototype', async () =>
    {
        writeCompiledConfig('server.config.mjs', 'export default Object.assign(Object.create(null), { port: 4332 });');

        expect((await loadAndMergeConfig(undefined, fixture)).port).toBe(4332);
    });
});
