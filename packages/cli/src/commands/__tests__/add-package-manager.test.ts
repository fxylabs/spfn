import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execa: vi.fn(),
    spinner: {
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn(),
        fail: vi.fn(),
    },
}));

vi.mock('execa', () => ({ execa: mocks.execa }));
vi.mock('ora', () => ({ default: () => mocks.spinner }));

import { addCommand } from '../add.js';
import { DRIZZLE_TYPEBOX_REFUSAL, getInstallArgs } from '../../utils/package-manager.js';
import { NPM_ERESOLVE_DRIZZLE_TYPEBOX, NPM_ERESOLVE_OTHER } from '../../utils/__tests__/fixtures/npm-eresolve.js';

const originalCwd = process.cwd();
let repository: string;

beforeEach(() =>
{
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // An npm app inside a pnpm repository whose workspace does not list it.
    repository = mkdtempSync(join(tmpdir(), 'spfn-add-pm-'));
    writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(repository, 'pnpm-lock.yaml'), '');
    mkdirSync(join(repository, 'scratch/app'), { recursive: true });
    writeFileSync(join(repository, 'scratch/app/package.json'), '{"name":"app"}');
    writeFileSync(join(repository, 'scratch/app/package-lock.json'), '{}');

    // The install leaves the package where the app finds it.
    mocks.execa.mockImplementation((_command: string, args: string[]) =>
    {
        const packageDir = join(process.cwd(), 'node_modules', args.at(-1)!);

        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, 'package.json'), '{}');
    });
});

/**
 * Runs `spfn add @spfn/i18n` in the npm app with npm failing as execa reports
 * it (`stderr` npm's own output), and returns what the command printed; fails
 * the row unless it exited 1.
 */
async function addFailingWith(stderr: string): Promise<string>
{
    process.chdir(join(repository, 'scratch/app'));
    mocks.execa.mockRejectedValueOnce(Object.assign(
        new Error(`Command failed with exit code 1: npm install @spfn/i18n\n${stderr}`),
        { exitCode: 1, stdout: '', stderr },
    ));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
    {
        throw new Error(`process.exit(${code})`);
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(addCommand.parseAsync(['@spfn/i18n'], { from: 'user' })).rejects.toThrow('process.exit(1)');

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to install package');

    return error.mock.calls.flat().join('\n');
}

afterEach(() =>
{
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(repository, { recursive: true, force: true });
});

describe('spfn add in an npm app', () =>
{
    it('installs with the npm arguments init installs with', async () =>
    {
        process.chdir(join(repository, 'scratch/app'));

        await addCommand.parseAsync(['@spfn/i18n'], { from: 'user' });

        expect(mocks.execa).toHaveBeenCalledWith('npm', [...getInstallArgs('npm'), '@spfn/i18n'], { cwd: process.cwd() });
        expect(mocks.spinner.succeed).toHaveBeenCalledWith('Package installed');
    });

    it('prints npm\'s own ERESOLVE lines and the drizzle-typebox explanation, then exits non-zero', async () =>
    {
        // The fixture is npm 10.9.9's real output; see fixtures/npm-eresolve.ts.
        const error = await addFailingWith(NPM_ERESOLVE_DRIZZLE_TYPEBOX);

        expect(error).toContain('peer drizzle-orm@">=0.36.0" from drizzle-typebox@0.3.3');
        expect(error).toContain(DRIZZLE_TYPEBOX_REFUSAL);
    });

    it('reports an ERESOLVE that names another package as npm wrote it, without the drizzle-typebox line', async () =>
    {
        const error = await addFailingWith(NPM_ERESOLVE_OTHER);

        expect(error).toContain('peer react@"^19.2.1" from react-dom@19.2.1');
        expect(error).not.toContain('drizzle-typebox');
    });

    it('prints nothing about drizzle-typebox when npm succeeds in an app that lists it', async () =>
    {
        process.chdir(join(repository, 'scratch/app'));
        writeFileSync('package.json', '{"name":"app","dependencies":{"drizzle-typebox":"1.0.0-beta.14"}}');
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await addCommand.parseAsync(['@spfn/i18n'], { from: 'user' });

        expect(error).not.toHaveBeenCalled();
        expect(mocks.spinner.succeed).toHaveBeenCalledWith('Package installed');
    });
});
