/**
 * Which port and host each process binds.
 *
 * Three layers and no more — environment, spfn.config.js, default — with the
 * default existing in exactly one place. The tables below are the design's own
 * case tables; each row was a way the old four-layer chain could surprise
 * someone, and one of them (a hardcoded value beating the app's own config) is
 * a defect that shipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

import {
    loadAppConfig,
    resolvePorts,
    resolveHost,
    resolveServerAddress,
    PORT_DEFAULTS,
    HOST_DEFAULT,
} from '../index';

const CONFIG_MODULE = join(__dirname, '..', 'config-module.ts');

let fixture: string;

function writeConfig(body: string): void
{
    writeFileSync(join(fixture, 'spfn.config.js'), body);
}

beforeEach(() =>
{
    fixture = mkdtempSync(join(tmpdir(), 'spfn-app-config-'));
});

afterEach(() =>
{
    rmSync(fixture, { recursive: true, force: true });
});

describe('loading spfn.config.js', () =>
{
    it('reads the ports an app declared', async () =>
    {
        writeConfig('export default { ports: { next: 3890, server: 8890 } };');

        const config = await loadAppConfig(fixture);

        expect(config.ports).toEqual({ next: 3890, server: 8890 });
    });

    describe('a CommonJS file compiled from TypeScript', () =>
    {
        beforeEach(() =>
        {
            writeConfig(
                '"use strict";\n'
                + 'Object.defineProperty(exports, "__esModule", { value: true });\n'
                + 'exports.default = { ports: { next: 3890, server: 8890 } };\n',
            );
        });

        it('yields its settings, not the interop wrapper, through Node\'s own import()', () =>
        {
            // vitest's loader unwraps CommonJS itself, so the namespace the built
            // loader meets under Node is read in a Node process of its own.
            const script = `
                const { plainObjectDefault } = await import(${JSON.stringify(pathToFileURL(CONFIG_MODULE).href)});
                const namespace = await import(${JSON.stringify(pathToFileURL(join(fixture, 'spfn.config.js')).href)});
                process.stdout.write(JSON.stringify(plainObjectDefault(namespace, 'spfn.config.js')));
            `;
            const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' });

            expect(JSON.parse(output.toString())).toEqual({ ports: { next: 3890, server: 8890 } });
        });

        it('yields its settings through a loader that has unwrapped it already — one level, no more', async () =>
        {
            const config = await loadAppConfig(fixture);

            expect(config.ports).toEqual({ next: 3890, server: 8890 });
        });
    });

    it('returns an empty config when the app has no file', async () =>
    {
        expect(await loadAppConfig(fixture)).toEqual({});
    });

    it('refuses a file that throws while it loads, naming it', async () =>
    {
        writeConfig("throw new Error('ports: a typo');");

        const loading = loadAppConfig(fixture);

        await expect(loading).rejects.toThrow('spfn.config.js exists but failed to load: ports: a typo');
    });

    it('refuses a file that does not parse, rather than falling back to defaults', async () =>
    {
        writeConfig('export default { this is not javascript');

        await expect(loadAppConfig(fixture)).rejects.toThrow('spfn.config.js exists but failed to load');
    });

    it.each([
        ['only named exports', 'export const ports = { server: 8890 };', 'only named exports (ports)'],
        ['a number as its default', 'export default 42;', 'a number as its default (42)'],
        ['a promise as its default', 'export default Promise.resolve({ ports: { server: 8890 } });', 'a promise'],
    ])('refuses a file that exports %s', async (_name, body, found) =>
    {
        writeConfig(body);

        const loading = loadAppConfig(fixture);

        await expect(loading).rejects.toThrow('spfn.config.js must export its configuration as a plain object');
        await expect(loading).rejects.toThrow(found);
    });

    it('stays quiet when there is simply no file', async () =>
    {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await loadAppConfig(fixture);

        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });
});

describe('port resolution', () =>
{
    const cases: Array<{
        name: string;
        env: NodeJS.ProcessEnv;
        config: Parameters<typeof resolvePorts>[0];
        expected: { next: number; server: number };
    }> = [
        {
            name: 'nothing set — the single default',
            env: {},
            config: {},
            expected: { next: PORT_DEFAULTS.next, server: PORT_DEFAULTS.server },
        },
        {
            name: 'spfn.config.js alone',
            env: {},
            config: { ports: { next: 3890, server: 8890 } },
            expected: { next: 3890, server: 8890 },
        },
        {
            name: 'environment overrides the file',
            env: { NEXT_PORT: '3900', SPFN_PORT: '9000' },
            config: { ports: { next: 3890, server: 8890 } },
            expected: { next: 3900, server: 9000 },
        },
        {
            name: 'environment alone',
            env: { SPFN_PORT: '9000' },
            config: {},
            expected: { next: PORT_DEFAULTS.next, server: 9000 },
        },
        {
            name: 'one port configured, the other left to the default',
            env: {},
            config: { ports: { server: 8890 } },
            expected: { next: PORT_DEFAULTS.next, server: 8890 },
        },
        {
            name: 'an unusable environment value falls through instead of binding NaN',
            env: { SPFN_PORT: 'not-a-port' },
            config: { ports: { server: 8890 } },
            expected: { next: PORT_DEFAULTS.next, server: 8890 },
        },
        {
            name: 'an out-of-range port falls through too',
            env: { SPFN_PORT: '70000' },
            config: {},
            expected: { next: PORT_DEFAULTS.next, server: PORT_DEFAULTS.server },
        },
    ];

    for (const testCase of cases)
    {
        it(testCase.name, () =>
        {
            expect(resolvePorts(testCase.config, testCase.env)).toEqual(testCase.expected);
        });
    }
});

describe('host resolution', () =>
{
    it('defaults to localhost so a dev machine does not publish to its network', () =>
    {
        expect(resolveHost({}, {})).toBe(HOST_DEFAULT);
    });

    it('takes the configured host', () =>
    {
        expect(resolveHost({ host: '0.0.0.0' }, {})).toBe('0.0.0.0');
    });

    it('lets the environment override it, which is how a container binds', () =>
    {
        expect(resolveHost({ host: 'localhost' }, { SPFN_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    });
});

describe('the deprecated .port() / .host() during their last release', () =>
{
    it('is used when spfn.config.js says nothing', () =>
    {
        const address = resolveServerAddress({}, { port: 8890, host: '0.0.0.0' }, {});

        expect(address).toEqual({ port: 8890, host: '0.0.0.0' });
    });

    it('loses to spfn.config.js, which is where the address moved', () =>
    {
        const address = resolveServerAddress(
            { ports: { server: 9100 }, host: '127.0.0.1' },
            { port: 8890, host: '0.0.0.0' },
            {},
        );

        expect(address).toEqual({ port: 9100, host: '127.0.0.1' });
    });

    it('loses to the environment as well', () =>
    {
        const address = resolveServerAddress(
            {},
            { port: 8890 },
            { SPFN_PORT: '9000' },
        );

        expect(address.port).toBe(9000);
    });

    it('falls back to the single default when nothing is set anywhere', () =>
    {
        expect(resolveServerAddress({}, {}, {})).toEqual({
            port: PORT_DEFAULTS.server,
            host: HOST_DEFAULT,
        });
    });
});
