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
import { getAddArgs, getInstallArgs } from '../../utils/package-manager.js';

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

        expect(mocks.execa).toHaveBeenCalledWith('npm', [...getInstallArgs('npm'), '@spfn/i18n']);
        expect(mocks.spinner.succeed).toHaveBeenCalledWith('Package installed');
    });

    it('refuses before npm runs when the app still lists drizzle-typebox, saying how to fix it', async () =>
    {
        process.chdir(join(repository, 'scratch/app'));
        writeFileSync('package.json', '{"name":"app","dependencies":{"drizzle-typebox":"^0.3.3"}}');
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(addCommand.parseAsync(['@spfn/i18n'], { from: 'user' })).rejects.toThrow('process.exit(1)');

        expect(mocks.execa).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(expect.stringContaining(
            'Remove drizzle-typebox from package.json, or import drizzle-orm/typebox-legacy instead.',
        ));
        exit.mockRestore();
    });

    it('installs with pnpm, which does not refuse it, an app that lists drizzle-typebox', async () =>
    {
        process.chdir(join(repository, 'scratch/app'));
        rmSync('package-lock.json');
        writeFileSync('pnpm-lock.yaml', '');
        writeFileSync('package.json', '{"name":"app","dependencies":{"drizzle-typebox":"^0.3.3"}}');

        await addCommand.parseAsync(['@spfn/i18n'], { from: 'user' });

        expect(mocks.execa).toHaveBeenCalledWith('pnpm', getAddArgs('pnpm', ['@spfn/i18n']));
    });
});
