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
import { initializeSpfn } from '../init/index.js';
import { logger } from '../../utils/logger.js';
import { DRIZZLE_TYPEBOX_REFUSAL, type YarnDlx } from '../../utils/package-manager.js';
import { NPM_ERESOLVE_DRIZZLE_TYPEBOX } from '../../utils/__tests__/fixtures/npm-eresolve.js';

const originalCwd = process.cwd();
let repository: string;
/** What the yarn the fake answers for says to `yarn dlx --help`. */
let yarnDlx: YarnDlx;

/** What execa resolves `yarn dlx --help` with (`reject: false`) for each kind of yarn. */
const YARN_DLX_HELP: Record<YarnDlx, object> = {
    'dlx': { exitCode: 0, stdout: '$ yarn dlx <command> ...' },
    'no-dlx': { exitCode: 1, stdout: 'yarn run v1.22.22' },
    'no-yarn': { code: 'ENOENT', exitCode: undefined, stdout: '' },
};

/**
 * Stands in for every process create starts: yarn answers whether it has
 * `dlx` as `yarnDlx` says; create-next-app writes the app's
 * package.json; an install puts each package `cwd` declares under
 * `cwd/node_modules`, and at the workspace root those of each member too.
 */
function fakeProcess(command: string, args: string[], { cwd }: { cwd: string }): object | void
{
    if (command === 'yarn' && args.join(' ') === 'dlx --help')
    {
        return YARN_DLX_HELP[yarnDlx];
    }

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
    yarnDlx = 'no-dlx';

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

        expect(mocks.execa).toHaveBeenCalledWith('npm', ['install'], { cwd: app });
        expect(mocks.execa.mock.calls.filter(([command]) => command === 'pnpm')).toEqual([]);
    });

    it('installs with npm, the manager it was given, when the workspace lists the app', async () =>
    {
        const app = await createFrom(join(repository, 'packages'));

        expect(mocks.execa).toHaveBeenCalledWith('npm', ['install'], { cwd: app });
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

/** What execa rejects with when npm exits 1 having written `stderr`. */
function npmFailure(stderr: string): Error
{
    return Object.assign(new Error(`Command failed with exit code 1: npm install\n${stderr}`), { exitCode: 1, stdout: '', stderr });
}

describe('an npm install that npm refuses over drizzle-typebox (npm 10.9.9 output, fixtures/npm-eresolve.ts)', () =>
{
    it('spfn init prints npm\'s lines and the explanation, then exits non-zero', async () =>
    {
        const app = join(repository, 'scratch/app');
        mkdirSync(app, { recursive: true });
        writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'next': '16', 'drizzle-typebox': '^0.3.3' } }));
        process.chdir(app);
        mocks.execa.mockRejectedValueOnce(npmFailure(NPM_ERESOLVE_DRIZZLE_TYPEBOX));
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await expect(initializeSpfn({ pm: 'npm', mode: 'bare', yes: true })).rejects.toThrow('process.exit(1)');

        expect(mocks.spinner.fail).toHaveBeenCalledWith('Failed to install dependencies');
        expect(error).toHaveBeenCalledWith(expect.stringContaining('npm error peer drizzle-orm@">=0.36.0" from drizzle-typebox@0.3.3'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining(DRIZZLE_TYPEBOX_REFUSAL));
        exit.mockRestore();
        error.mockRestore();
    });

    it('spfn create\'s @svgr/webpack install warns as before and prints npm\'s lines and the explanation', async () =>
    {
        mocks.execa.mockImplementation((command: string, args: string[], options: { cwd: string }) =>
            (args.includes('@svgr/webpack') ? Promise.reject(npmFailure(NPM_ERESOLVE_DRIZZLE_TYPEBOX)) : fakeProcess(command, args, options)));
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await createFrom(join(repository, 'scratch'));

        expect(mocks.spinner.warn).toHaveBeenCalledWith('Failed to setup SVGR (you can run `spfn setup icons` later)');
        expect(error).toHaveBeenCalledWith(expect.stringContaining(DRIZZLE_TYPEBOX_REFUSAL));
        error.mockRestore();
    });
});

describe('spfn create launches its one-off packages with yarn dlx where yarn has it, else with npx', () =>
{
    /** The command and arguments that started the one-off package `spec`. */
    function oneOffCall(spec: string): [string, string[]]
    {
        return mocks.execa.mock.calls.find(([, args]) => args.includes(spec))!.slice(0, 2) as [string, string[]];
    }

    const runners: [string, YarnDlx, string, string[]][] = [
        ['npm', 'dlx', 'npx', ['--yes']],
        ['pnpm', 'dlx', 'npx', ['--yes']],
        ['bun', 'dlx', 'npx', ['--yes']],
        ['yarn', 'no-dlx', 'npx', ['--yes']],
        ['yarn', 'dlx', 'yarn', ['dlx']],
    ];

    it.each(runners)('runs create-next-app for %s (yarn says %s) with %s %s', async (pm, answer, command, runnerArgs) =>
    {
        yarnDlx = answer;
        await createFrom(join(repository, 'scratch'), ['--pm', pm]);

        const [called, args] = oneOffCall('create-next-app@latest');

        expect(called).toBe(command);
        expect(args.slice(0, runnerArgs.length + 2)).toEqual([...runnerArgs, 'create-next-app@latest', 'app']);
        expect(args).toContain(`--use-${pm}`);
    });

    it.each(runners)('runs shadcn for %s (yarn says %s) with %s %s', async (pm, answer, command, runnerArgs) =>
    {
        yarnDlx = answer;
        await createFrom(join(repository, 'scratch'), ['--pm', pm, '--shadcn']);

        expect(oneOffCall('shadcn@latest')).toEqual([command, [...runnerArgs, 'shadcn@latest', 'init', '--yes', '--defaults']]);
    });

    it('asks yarn in the directory each one-off package will run in', async () =>
    {
        yarnDlx = 'dlx';
        const app = await createFrom(join(repository, 'scratch'), ['--pm', 'yarn', '--shadcn']);
        const probes = mocks.execa.mock.calls.filter(([command, args]) => command === 'yarn' && args[0] === 'dlx' && args[1] === '--help');

        expect(probes.map(([, , options]) => options.cwd)).toEqual([join(repository, 'scratch'), app]);
    });

    it('stops --pm yarn with no yarn before anything is downloaded or written', async () =>
    {
        yarnDlx = 'no-yarn';
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

        await expect(createFrom(join(repository, 'scratch'), ['--pm', 'yarn'])).rejects.toThrow('process.exit(1)');

        expect(error).toHaveBeenCalledWith('yarn was not found; install it or choose another --pm');
        expect(mocks.execa.mock.calls.filter(([command]) => command !== 'yarn')).toEqual([]);
        expect(existsSync(join(repository, 'scratch', 'app'))).toBe(false);
        exit.mockRestore();
        error.mockRestore();
    });

    it('warns and goes on when the yarn in the app does not say whether it has dlx for shadcn', async () =>
    {
        yarnDlx = 'dlx';
        const app = join(repository, 'scratch', 'app');
        mocks.execa.mockImplementation((command: string, args: string[], options: { cwd: string }) =>
            (command === 'yarn' && args[0] === 'dlx' && options.cwd === app ? { exitCode: 1, stdout: '', stderr: 'Usage Error: This project is configured to use pnpm' } : fakeProcess(command, args, options)));

        await createFrom(join(repository, 'scratch'), ['--pm', 'yarn', '--shadcn']);

        expect(mocks.spinner.warn).toHaveBeenCalledWith(expect.stringMatching(/^Failed to initialize shadcn\/ui: `yarn dlx --help` in .* did not say whether this yarn has dlx[^]*Usage Error/));
        expect(mocks.execa.mock.calls.some(([, args]) => args.includes('shadcn@latest'))).toBe(false);
        expect(mocks.execa).toHaveBeenCalledWith('yarn', ['install'], { cwd: app });
    });
});
