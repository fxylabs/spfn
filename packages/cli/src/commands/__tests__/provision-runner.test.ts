/**
 * The runner `spfn provision` writes to .spfn/provision.mjs (PR #314 review round 2, B3).
 *
 * It used to import server.config itself and pass `.default` on, so a file that
 * exported no default provisioned on defaults with `provisionInfrastructure(undefined)`.
 * It now loads the file with `loadServerConfigFile`, the loader `startServer`
 * uses. These rows run the generated text with node against fixture apps; each
 * one stops before `provisionInfrastructure`, so no database is touched.
 *
 * Issue #349: the runner refuses a second copy of @spfn/core the config brings
 * in (without its mark it provisions beside the copy, unnoticed), and
 * `spfn provision` starts it with the CLI's module hook (R3: without it, the
 * runner silently loads a type-less app's server.config as CommonJS again).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';

import { provisionCommand, renderProvisionRunner } from '../provision';
import { devLoaderImport } from '../../utils/dev-loader';

// `spfn provision` itself, for the arguments it starts the runner with (R3).
vi.mock('execa', () => ({ execa: vi.fn(async () => ({ exitCode: 0 })) }));

// Inside the package, so the runner's bare `@spfn/core/*` imports resolve
// through this package's node_modules, as they do from an app.
const PACKAGE_DIR = join(import.meta.dirname, '..', '..', '..');

let app: string;

beforeEach(() =>
{
    app = mkdtempSync(join(PACKAGE_DIR, '.provision-fixture-'));
    writeFileSync(join(app, 'provision.mjs'), renderProvisionRunner());
});

afterEach(() =>
{
    rmSync(app, { recursive: true, force: true });
});

function writeCompiledConfig(body: string): void
{
    mkdirSync(join(app, '.spfn', 'server'), { recursive: true });
    writeFileSync(join(app, '.spfn', 'server', 'server.config.mjs'), body);
}

/** The runner's exit code and stderr. */
function runProvision(): { status: number; stderr: string }
{
    try
    {
        execFileSync(process.execPath, ['provision.mjs'], { cwd: app, stdio: 'pipe', timeout: 30_000 });

        return { status: 0, stderr: '' };
    }
    catch (error)
    {
        const failed = error as { status: number; stderr: Buffer };

        return { status: failed.status, stderr: failed.stderr.toString() };
    }
}

describe('spfn provision runner', () =>
{
    it.each([
        ['only named exports', 'export const port = 4330;', 'only named exports (port)'],
        ['a number as its default', 'export default 42;', 'a number as its default (42)'],
        ['a promise as its default', 'export default Promise.resolve({});', 'a promise as its default'],
    ])('refuses a server.config that exports %s, naming the file', (_name, body, found) =>
    {
        writeCompiledConfig(body);

        const { status, stderr } = runProvision();

        expect(status).not.toBe(0);
        expect(stderr).toContain('.spfn/server/server.config.mjs must export its configuration as a plain object');
        expect(stderr).toContain(found);
    });

    it('says what it looked for when there is no server.config', () =>
    {
        const { status, stderr } = runProvision();

        expect(status).toBe(1);
        expect(stderr).toContain('server.config not found');
        expect(stderr).toContain('.spfn/server/server.config.mjs');
    });

    it('refuses a second copy of @spfn/core that server.config brings in', () =>
    {
        const secondInstall = join(app, 'node_modules', 'second-core', 'dist', 'logger');

        mkdirSync(secondInstall, { recursive: true });
        writeFileSync(join(app, 'node_modules', 'second-core', 'package.json'), JSON.stringify({ type: 'module' }));
        copyFileSync(join(PACKAGE_DIR, 'node_modules', '@spfn', 'core', 'dist', 'logger', 'index.js'), join(secondInstall, 'index.js'));
        writeCompiledConfig('import \'../../node_modules/second-core/dist/logger/index.js\';\nexport default {};');

        const { status, stderr } = runProvision();

        expect(status).not.toBe(0);
        expect(stderr).toContain('Refusing a second copy of @spfn/core in this process: @spfn/core/logger was loaded from two installs');
    });

    it('K1 blanks the credentials of a URL in what stops it', () =>
    {
        writeCompiledConfig("throw new Error('connection failed for postgres://u:FAKE@h/d');");

        const { status, stderr } = runProvision();

        expect(status).toBe(1);
        expect(stderr).toContain('connection failed for postgres://<redacted>@h/d');
        expect(stderr).not.toContain('FAKE');
    });
});

describe('spfn provision', () =>
{
    it('R3 starts its runner under tsx with the CLI\'s module hook', async () =>
    {
        const cwd = process.cwd();

        process.chdir(app);

        try
        {
            await provisionCommand.parseAsync([], { from: 'user' });
        }
        finally
        {
            process.chdir(cwd);
        }

        const args = vi.mocked(execa).mock.calls[0][1] as string[];

        expect(args).toContain('tsx');
        expect(args[args.indexOf('--import') + 1]).toBe(devLoaderImport(app));
    });
});
