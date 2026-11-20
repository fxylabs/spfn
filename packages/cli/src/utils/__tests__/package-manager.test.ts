import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Passes through; records which files detection reads.
vi.mock('fs', async importOriginal =>
{
    const fs = await importOriginal<typeof import('fs')>();

    return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

import { readFileSync } from 'fs';

import {
    detectPackageManager,
    findUnresolvedPackages,
    findWorkspace,
    getAddArgs,
    getOneOffCommandLine,
    getRunScriptArgs,
    pnpmNonMemberReason,
    probeYarnDlx,
    type YarnDlx,
} from '../package-manager.js';

describe('getRunScriptArgs', () =>
{
    it('separates the script arguments with `--` on npm, which would otherwise read them as its own config', () =>
    {
        expect(getRunScriptArgs('npm', 'spfn:next', ['--port', '3790']))
            .toEqual(['run', 'spfn:next', '--', '--port', '3790']);
    });

    it('passes the arguments straight through on pnpm', () =>
    {
        expect(getRunScriptArgs('pnpm', 'spfn:next', ['--port', '3790']))
            .toEqual(['run', 'spfn:next', '--port', '3790']);
    });

    it('passes the arguments straight through on yarn', () =>
    {
        expect(getRunScriptArgs('yarn', 'spfn:next', ['--port', '3790']))
            .toEqual(['run', 'spfn:next', '--port', '3790']);
    });

    it('passes the arguments straight through on bun', () =>
    {
        expect(getRunScriptArgs('bun', 'spfn:next', ['--port', '3790']))
            .toEqual(['run', 'spfn:next', '--port', '3790']);
    });

    it('never emits a literal `--` on pnpm, which forwards it to the script and makes next read `--port` as a directory', () =>
    {
        expect(getRunScriptArgs('pnpm', 'spfn:next', ['--port', '3790']))
            .not.toContain('--');
    });
});

let repository: string | undefined;

afterEach(() =>
{
    if (repository)
    {
        rmSync(repository, { recursive: true, force: true });
        repository = undefined;
    }
});

/**
 * A temporary repository holding `files` (path → content).
 */
function makeRepository(files: Record<string, string>): string
{
    repository = mkdtempSync(join(tmpdir(), 'spfn-pm-'));

    for (const [path, content] of Object.entries(files))
    {
        mkdirSync(dirname(join(repository, path)), { recursive: true });
        writeFileSync(join(repository, path), content);
    }

    return repository;
}

describe('getAddArgs', () =>
{
    it('adds with npm\'s install verb and no flag that would hide a peer conflict', () =>
    {
        expect(getAddArgs('npm', ['@spfn/i18n'])).toEqual(['install', '@spfn/i18n']);
        expect(getAddArgs('npm', ['@svgr/webpack'], { dev: true })).toEqual(['install', '--save-dev', '@svgr/webpack']);
    });

    it('add with each manager\'s own verb and dev flag', () =>
    {
        expect(getAddArgs('pnpm', ['tsx'], { dev: true })).toEqual(['add', '-D', 'tsx']);
        expect(getAddArgs('yarn', ['tsx'])).toEqual(['add', 'tsx']);
        expect(getAddArgs('bun', ['tsx'], { dev: true })).toEqual(['add', '--dev', 'tsx']);
    });
});

describe('detectPackageManager', () =>
{
    it('takes the app\'s own package-lock.json over an ancestor\'s pnpm-lock.yaml', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
            'pnpm-lock.yaml': '',
            'apps/web/package.json': '{}',
            'apps/web/package-lock.json': '{}',
        });

        expect(detectPackageManager(join(root, 'apps/web'))).toBe('npm');
    });

    it('takes an ancestor\'s lockfile for a member of its pnpm workspace', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
            'pnpm-lock.yaml': '',
            'apps/web/package.json': '{}',
        });

        expect(detectPackageManager(join(root, 'apps/web'))).toBe('pnpm');
    });

    it('takes an ancestor\'s lockfile for a member of its package.json workspaces, array and object forms', () =>
    {
        const arrayRoot = makeRepository({
            'package.json': JSON.stringify({ workspaces: ['packages/**'] }),
            'yarn.lock': '',
            'packages/group/web/package.json': '{}',
        });
        expect(detectPackageManager(join(arrayRoot, 'packages/group/web'))).toBe('yarn');
        rmSync(arrayRoot, { recursive: true, force: true });

        const objectRoot = makeRepository({
            'package.json': JSON.stringify({ workspaces: { packages: ['./apps/*'] } }),
            'yarn.lock': '',
            'apps/web/package.json': '{}',
        });
        expect(detectPackageManager(join(objectRoot, 'apps/web'))).toBe('yarn');
    });

    it('ignores the ancestor\'s lockfile for a directory its workspace does not list', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
            'pnpm-lock.yaml': '',
            'scratch/app/package.json': '{}',
        });

        expect(detectPackageManager(join(root, 'scratch/app'))).toBe('npm');
    });

    it('ignores the ancestor\'s lockfile for a directory a negated glob excludes', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - "!apps/legacy"\n',
            'pnpm-lock.yaml': '',
            'apps/legacy/package.json': '{}',
        });

        expect(detectPackageManager(join(root, 'apps/legacy'))).toBe('npm');
    });

    it('answers from the app\'s own lockfile when an unrelated ancestor package.json is not strict JSON', () =>
    {
        const root = makeRepository({
            'package.json': '{ "name": "scratch", }',
            'projects/app/package.json': '{}',
            'projects/app/pnpm-lock.yaml': '',
        });

        expect(detectPackageManager(join(root, 'projects/app'))).toBe('pnpm');
    });

    it('reads no ancestor\'s files when the app has its own lockfile', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
            'pnpm-lock.yaml': '',
            'apps/web/package.json': '{}',
            'apps/web/yarn.lock': '',
        });
        vi.mocked(readFileSync).mockClear();

        expect(detectPackageManager(join(root, 'apps/web'))).toBe('yarn');
        expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    });

    it('reads a workspace root package.json that starts with a BOM, as npm, pnpm and yarn do', () =>
    {
        const root = makeRepository({
            'package.json': '\uFEFF{"private":true,"workspaces":["packages/*"]}',
            'yarn.lock': '',
            'packages/web/package.json': '{}',
        });

        expect(detectPackageManager(join(root, 'packages/web'))).toBe('yarn');
    });

    it('takes an ancestor declaration it cannot read, or not of the documented shape, as declaring no workspace', () =>
    {
        // apps/ and other/ declare nothing readable, so the root above answers.
        const root = makeRepository({
            'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
            'yarn.lock': '',
            'apps/package.json': JSON.stringify({ workspaces: { packages: 'web' } }),
            'apps/yarn.lock': '',
            'apps/web/package.json': '{}',
            'other/pnpm-workspace.yaml': 'packages: [unclosed\n',
            'other/pnpm-lock.yaml': '',
            'other/app/package.json': '{}',
        });

        expect(detectPackageManager(join(root, 'apps/web'))).toBe('yarn');
        expect(detectPackageManager(join(root, 'other/app'))).toBe('npm');
    });

    it('asks the manager whose lockfile is at the root: yarn.lock reads package.json workspaces, not pnpm-workspace.yaml', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
            'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
            'yarn.lock': '',
            'apps/web/package.json': '{}',
            'packages/lib/package.json': '{}',
        });

        expect(detectPackageManager(join(root, 'apps/web'))).toBe('yarn');
        expect(detectPackageManager(join(root, 'packages/lib'))).toBe('npm');
    });

    it('takes bun\'s text lockfile, bun.lock, as bun\'s', () =>
    {
        const root = makeRepository({
            'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
            'bun.lock': '{}',
            'apps/web/package.json': '{}',
            'own/package.json': '{}',
            'own/bun.lock': '{}',
        });

        expect(detectPackageManager(join(root, 'apps/web'))).toBe('bun');
        expect(detectPackageManager(join(root, 'own'))).toBe('bun');
    });

    it('takes a root with no lockfile as pnpm\'s when it has a pnpm-workspace.yaml, npm\'s otherwise', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
            'package.json': JSON.stringify({ workspaces: ['tools/*'] }),
            'apps/web/package.json': '{}',
            'tools/cli/package.json': '{}',
        });

        expect(findWorkspace(join(root, 'apps/web'))).toEqual({ root, packageManager: 'pnpm' });
        expect(findWorkspace(join(root, 'tools/cli'))).toBeNull();
    });

    it('answers from the nearest declaration: an inner pnpm-workspace.yaml that does not list the app outranks an outer one that does', () =>
    {
        const root = makeRepository({
            'pnpm-workspace.yaml': 'packages:\n  - "**"\n',
            'pnpm-lock.yaml': '',
            'inner/pnpm-workspace.yaml': 'packages:\n  - other/*\n',
        });

        expect(findWorkspace(join(root, 'inner/apps/x'))).toBeNull();
        expect(detectPackageManager(join(root, 'inner/apps/x'))).toBe('npm');
    });
});

describe('findUnresolvedPackages', () =>
{
    const savedNodePath = process.env.NODE_PATH;

    afterEach(() =>
    {
        process.env.NODE_PATH = savedNodePath;
    });

    function app(dependencies: Record<string, string>, extra: Record<string, unknown> = {}): string
    {
        return JSON.stringify({ name: 'app', dependencies, ...extra });
    }

    it('reports a package that resolves only through the CLI process\'s NODE_PATH as missing', () =>
    {
        const root = makeRepository({
            'app/package.json': app({ 'only-on-node-path': '1' }),
            'store/only-on-node-path/package.json': '{"name":"only-on-node-path"}',
        });
        process.env.NODE_PATH = join(root, 'store');

        expect(findUnresolvedPackages(join(root, 'app'))).toEqual(['only-on-node-path']);
    });

    it('checks every dependency and devDependency, not optional or peer ones', () =>
    {
        const root = makeRepository({
            'app/package.json': app({ 'present': '1', 'absent': '1' }, {
                devDependencies: { 'absent-dev': '1' },
                optionalDependencies: { 'absent-optional': '1' },
                peerDependencies: { 'absent-peer': '1' },
            }),
            'app/node_modules/present/package.json': '{}',
        });

        expect(findUnresolvedPackages(join(root, 'app'))).toEqual(['absent', 'absent-dev']);
    });

    it('finds a package hoisted to an ancestor\'s node_modules, as a workspace install leaves it', () =>
    {
        const root = makeRepository({
            'apps/web/package.json': app({ hoisted: '1' }),
            'node_modules/hoisted/package.json': '{}',
        });

        expect(findUnresolvedPackages(join(root, 'apps/web'))).toEqual([]);
    });

    it('finds a package by its package.json: with no entry point, or with exports that do not list it', () =>
    {
        const root = makeRepository({
            'app/package.json': app({ 'types-only': '1', 'exports-only': '1', 'no-manifest': '1' }),
            'app/node_modules/types-only/package.json': '{"name":"types-only","types":"index.d.ts"}',
            'app/node_modules/exports-only/package.json': '{"name":"exports-only","exports":{".":{"import":"./index.mjs"}}}',
            'app/node_modules/no-manifest/index.js': '',
        });

        expect(findUnresolvedPackages(join(root, 'app'))).toEqual(['no-manifest']);
    });

    /**
     * Stands in for yarn's runtime: marks the process as PnP and lets
     * `require.resolve` find the packages in `.yarn/store` beside it, which
     * Node's plain lookup from the app never does.
     */
    const FAKE_PNP_RUNTIME = `
        process.versions.pnp = '3';
        process.env.NODE_PATH = require('path').join(__dirname, '.yarn/store');
        require('module')._initPaths();
    `;

    function pnpRepository(appPath: string, workspaces: string[]): string
    {
        return makeRepository({
            'package.json': JSON.stringify({ name: 'repository', workspaces }),
            'yarn.lock': '',
            '.pnp.cjs': FAKE_PNP_RUNTIME,
            '.yarn/store/repository-only/package.json': '{}',
            [`${appPath}/package.json`]: app({ 'own-install': '1', 'repository-only': '1' }),
            [`${appPath}/node_modules/own-install/package.json`]: '{}',
        });
    }

    it('resolves a member of a PnP workspace through its root\'s .pnp.cjs', () =>
    {
        const root = pnpRepository('apps/web', ['apps/*']);

        expect(findUnresolvedPackages(join(root, 'apps/web'))).toEqual([]);
    });

    it('ignores the .pnp.cjs of a PnP repository that does not list the app: the repository\'s packages are not the app\'s', () =>
    {
        const root = pnpRepository('tools/app', ['apps/*']);

        expect(findUnresolvedPackages(join(root, 'tools/app'))).toEqual(['repository-only']);
    });

    it('resolves an app through its own .pnp.cjs, the project it is', () =>
    {
        const root = makeRepository({
            'app/package.json': app({ 'pnp-only': '1' }),
            'app/.pnp.cjs': FAKE_PNP_RUNTIME,
            'app/.yarn/store/pnp-only/package.json': '{}',
        });

        expect(findUnresolvedPackages(join(root, 'app'))).toEqual([]);
    });
});

describe('pnpmNonMemberReason', () =>
{
    it('names the workspace that does not list the app', () =>
    {
        const root = makeRepository({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });

        expect(pnpmNonMemberReason(join(root, 'apps/web')))
            .toContain(`is not in the packages of ${join(root, 'pnpm-workspace.yaml')}`);
    });

    it('gives no reason for the app\'s own settings-only pnpm-workspace.yaml, as create-next-app writes one', () =>
    {
        const root = makeRepository({ 'app/pnpm-workspace.yaml': 'onlyBuiltDependencies:\n  - sharp\n' });

        expect(pnpmNonMemberReason(join(root, 'app'))).toBeNull();
    });
});

describe('getOneOffCommandLine', () =>
{
    it.each(['npm', 'pnpm', 'bun'] as const)('runs the package with npx --yes for %s, without asking yarn', async pm =>
    {
        const probe = vi.fn(async (): Promise<YarnDlx> => 'dlx');

        expect(await getOneOffCommandLine(pm, '/app', 'shadcn@latest', ['init'], probe))
            .toEqual({ command: 'npx', args: ['--yes', 'shadcn@latest', 'init'] });
        expect(probe).not.toHaveBeenCalled();
    });

    it('runs the package with yarn dlx when the yarn in the directory has dlx', async () =>
    {
        const probe = vi.fn(async (): Promise<YarnDlx> => 'dlx');

        expect(await getOneOffCommandLine('yarn', '/app', 'shadcn@latest', ['init'], probe))
            .toEqual({ command: 'yarn', args: ['dlx', 'shadcn@latest', 'init'] });
        expect(probe).toHaveBeenCalledWith('/app');
    });

    it('runs the package with npx --yes when the yarn in the directory has no dlx (yarn 1)', async () =>
    {
        expect(await getOneOffCommandLine('yarn', '/app', 'shadcn@latest', ['init'], async () => 'no-dlx'))
            .toEqual({ command: 'npx', args: ['--yes', 'shadcn@latest', 'init'] });
    });

    it('rejects when there is no yarn: an app that installs with yarn cannot be made', async () =>
    {
        await expect(getOneOffCommandLine('yarn', '/app', 'shadcn@latest', ['init'], async () => 'no-yarn'))
            .rejects.toThrow('yarn was not found; install it or choose another --pm');
    });
});

describe('probeYarnDlx', () =>
{
    const originalPath = process.env.PATH;
    let bin: string;

    /** Puts on PATH a `yarn` that prints `stdout` and `stderr` and exits with `code`. */
    function fakeYarn(stdout: string, code: number, stderr = ''): void
    {
        bin = mkdtempSync(join(tmpdir(), 'spfn-yarn-'));
        writeFileSync(join(bin, 'yarn'), `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nprintf '%s\\n' '${stderr}' >&2\nexit ${code}\n`);
        chmodSync(join(bin, 'yarn'), 0o755);
        process.env.PATH = bin;
    }

    afterEach(() =>
    {
        process.env.PATH = originalPath;
        rmSync(bin, { recursive: true, force: true });
    });

    it('says dlx for yarn 2+, which prints the usage of dlx and exits 0', async () =>
    {
        fakeYarn('Run a package in a temporary environment\n\u001b[1m$ \u001b[22myarn dlx <command> ...', 0);

        expect(await probeYarnDlx(tmpdir())).toBe('dlx');
    });

    it('says no-dlx for yarn 1, whose `yarn dlx` looks for a dlx script and fails (yarn 1.22.22 output)', async () =>
    {
        fakeYarn('yarn run v1.22.22\ninfo Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.', 1, 'error Command "dlx" not found.');

        expect(await probeYarnDlx(tmpdir())).toBe('no-dlx');
    });

    it('says no-dlx for yarn 1 running a project\'s own `dlx` script that exits 0', async () =>
    {
        fakeYarn('yarn run v1.22.22\n$ echo dlx', 0);

        expect(await probeYarnDlx(tmpdir())).toBe('no-dlx');
    });

    it('says no-yarn when there is no yarn at all', async () =>
    {
        bin = mkdtempSync(join(tmpdir(), 'spfn-yarn-'));
        process.env.PATH = bin;

        expect(await probeYarnDlx(tmpdir())).toBe('no-yarn');
    });

    it('rejects with yarn\'s output for a failure that is not yarn 1, such as a corepack refusal', async () =>
    {
        fakeYarn('', 1, 'Usage Error: This project is configured to use pnpm');

        await expect(probeYarnDlx(tmpdir())).rejects.toThrow(/did not say whether this yarn has dlx \(exit code 1\)[^]*Usage Error: This project is configured to use pnpm/);
    });

    it('rejects when yarn prints the usage of dlx but exits non-zero', async () =>
    {
        fakeYarn('$ yarn dlx <command> ...', 1);

        await expect(probeYarnDlx(tmpdir())).rejects.toThrow('did not say whether this yarn has dlx (exit code 1)');
    });

    it('rejects when yarn exits 0 without the usage of dlx', async () =>
    {
        fakeYarn('1.22.22', 0);

        await expect(probeYarnDlx(tmpdir())).rejects.toThrow('did not say whether this yarn has dlx (exit code 0)');
    });
});
