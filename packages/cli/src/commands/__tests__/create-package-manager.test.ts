import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execa: vi.fn(),
    spinner: {
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn(),
        fail: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('execa', () => ({ execa: mocks.execa }));
vi.mock('ora', () => ({ default: () => mocks.spinner }));
vi.mock('../../utils/version.js', () => ({ getSpfnTag: () => 'beta' }));
vi.mock('../setup.js', () => ({ setupIcons: vi.fn() }));

// The scaffolding steps write templates and have nothing to do with the
// package manager; init's package step, which installs, runs for real.
vi.mock('../init/steps/server-structure.js', () => ({ setupServerStructure: vi.fn() }));
vi.mock('../init/steps/api-proxy.js', () => ({ setupApiProxy: vi.fn() }));
vi.mock('../init/steps/next-config.js', () => ({ setupNextConfig: vi.fn() }));
vi.mock('../init/steps/docker.js', () => ({ setupDockerFiles: vi.fn() }));
vi.mock('../init/steps/deployment-config.js', () => ({ setupDeploymentConfig: vi.fn() }));
vi.mock('../init/steps/config-files.js', () => ({ setupConfigFiles: vi.fn() }));
vi.mock('../init/steps/readme.js', () => ({ setupReadme: vi.fn() }));

import { createCommand } from '../create.js';

const originalCwd = process.cwd();
let repository: string;

/**
 * Stands in for every process create starts: create-next-app writes the app's
 * package.json; an install puts each package `cwd` declares under
 * `cwd/node_modules`, and at the workspace root those of each member too.
 */
function fakeProcess(_command: string, args: string[], { cwd }: { cwd: string }): void
{
    if (args.some(arg => arg.startsWith('create-next-app')))
    {
        mkdirSync(join(cwd, 'app'));
        writeFileSync(join(cwd, 'app', 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: '16' } }));

        return;
    }

    const members = cwd === repository && existsSync(join(repository, 'packages'))
        ? readdirSync(join(repository, 'packages')).map(name => join(repository, 'packages', name))
        : [];

    [cwd, ...members].forEach(installDeclared);
}

/** What a working install leaves in `dir`: every package its package.json declares. */
function installDeclared(dir: string): void
{
    const { dependencies, devDependencies } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    for (const name of [...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})])
    {
        mkdirSync(join(dir, 'node_modules', name), { recursive: true });
        writeFileSync(join(dir, 'node_modules', name, 'package.json'), '{}');
    }
}

beforeEach(() =>
{
    // A pnpm workspace that lists packages/* only.
    repository = mkdtempSync(join(tmpdir(), 'spfn-create-pm-'));
    writeFileSync(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(repository, 'pnpm-lock.yaml'), '');
    writeFileSync(join(repository, 'package.json'), '{}');
    mocks.execa.mockImplementation(fakeProcess);

    // Commander keeps a parse's option values for the next one: `--pm` included.
    Object.keys(createCommand.opts()).forEach(key => createCommand.setOptionValue(key, undefined));
});

afterEach(() =>
{
    process.chdir(originalCwd);
    vi.clearAllMocks();
    rmSync(repository, { recursive: true, force: true });
});

/** `spfn create app` run in `directory` with `pmArgs`; the app's path. */
async function createFrom(directory: string, pmArgs = ['--pm', 'npm']): Promise<string>
{
    mkdirSync(directory, { recursive: true });
    process.chdir(directory);
    await createCommand.parseAsync(['app', ...pmArgs, '--mode', 'bare', '--yes', '--skip-git'], { from: 'user' });

    return join(directory, 'app');
}

/** The arguments create-next-app was started with. */
function createNextAppArgs(): string[]
{
    return mocks.execa.mock.calls.map(([, args]) => args).find(args => args.some((arg: string) => arg.startsWith('create-next-app')));
}

describe('spfn create --pm npm under a pnpm workspace', () =>
{
    it('installs with npm in the app directory when the workspace does not list it', async () =>
    {
        const app = await createFrom(join(repository, 'scratch'));

        expect(mocks.execa).toHaveBeenCalledWith('npm', ['install', '--legacy-peer-deps'], { cwd: app });
        expect(mocks.execa.mock.calls.filter(([command]) => command === 'pnpm')).toEqual([]);
    });

    it('installs with npm, the manager it was given, when the workspace lists the app', async () =>
    {
        const app = await createFrom(join(repository, 'packages'));

        expect(mocks.execa).toHaveBeenCalledWith('npm', ['install', '--legacy-peer-deps'], { cwd: app });
        expect(mocks.execa.mock.calls.filter(([command]) => command === 'pnpm')).toEqual([]);
    });
});

describe('spfn create under a pnpm workspace, the manager detected or pnpm', () =>
{
    it('detects pnpm from the new app\'s path, a member, and installs from the workspace root', async () =>
    {
        // Run from packages/, which the workspace does not list itself: only the
        // app's own path, packages/app, answers pnpm.
        const app = await createFrom(join(repository, 'packages'), []);

        expect(createNextAppArgs()).toContain('--skip-install');
        expect(mocks.execa).toHaveBeenCalledWith('pnpm', ['install'], expect.objectContaining({ cwd: repository }));
        expect(mocks.execa).toHaveBeenCalledWith('pnpm', ['install'], { cwd: app });
        expect(mocks.execa.mock.calls.filter(([command]) => command === 'npm')).toEqual([]);
        expect(mocks.spinner.succeed).toHaveBeenCalledWith('Dependencies installed');
    });

    it('fails at the workspace-root install when it left the app\'s packages unresolvable', async () =>
    {
        mocks.execa.mockImplementation((command: string, args: string[], options: { cwd: string }) =>
            (options.cwd === repository ? undefined : fakeProcess(command, args, options)));
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);

        await expect(createFrom(join(repository, 'packages'), [])).rejects.toThrow('process.exit(1)');

        exit.mockRestore();
        expect(mocks.spinner.fail).toHaveBeenCalledWith(expect.stringMatching(/^pnpm install finished, but these do not resolve from .*app: next$/));
        expect(mocks.execa.mock.calls.filter(([, , options]) => options?.cwd?.endsWith('app'))).toEqual([]);
    });

    it('installs with pnpm in the app directory, not from the root, when the workspace does not list it', async () =>
    {
        const app = await createFrom(join(repository, 'scratch'), ['--pm', 'pnpm']);

        expect(createNextAppArgs()).not.toContain('--skip-install');
        expect(mocks.execa.mock.calls.filter(([, , options]) => options?.cwd === repository)).toEqual([]);
        expect(mocks.execa).toHaveBeenCalledWith('pnpm', ['install'], { cwd: app });
    });
});
