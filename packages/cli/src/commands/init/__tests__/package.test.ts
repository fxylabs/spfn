import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../utils/logger.js';
import { setupPackageJson } from '../steps/package.js';
import { NODE_ENGINE_RANGE } from '../steps/node-engine.js';
import type { PackageJson } from '../steps/validate.js';

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
vi.mock('../../../utils/version.js', () => ({ getSpfnTag: () => 'beta' }));

let testDirectory: string | undefined;

/**
 * What a working install leaves behind: every package the app declares, under
 * `cwd/node_modules`, except those in `skipped`.
 */
async function fakeInstall(cwd: string, skipped: string[] = []): Promise<void>
{
    const { dependencies, devDependencies } = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as PackageJson;
    const names = [...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})];

    for (const name of names.filter(name => !skipped.includes(name)))
    {
        await mkdir(join(cwd, 'node_modules', name), { recursive: true });
        await writeFile(join(cwd, 'node_modules', name, 'package.json'), JSON.stringify({ name }));
    }
}

beforeEach(() =>
{
    mocks.execa.mockImplementation((_pm: string, _args: string[], { cwd }: { cwd: string }) => fakeInstall(cwd));
});

afterEach(async () =>
{
    vi.clearAllMocks();
    if (testDirectory)
    {
        await rm(testDirectory, { recursive: true, force: true });
        testDirectory = undefined;
    }
});

describe('setupPackageJson', () =>
{
    it('scaffolds the supported Drizzle 1.0 RC dependency set', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-'));
        const packageJsonPath = join(testDirectory, 'package.json');
        const packageJson: PackageJson = {
            name: 'example-app',
            dependencies: {},
            devDependencies: {},
            scripts: {},
        };

        await setupPackageJson(
            testDirectory,
            packageJsonPath,
            packageJson,
            'pnpm',
            'bare',
        );

        const generated = JSON.parse(
            await readFile(packageJsonPath, 'utf8'),
        ) as PackageJson;
        expect(generated.dependencies?.['drizzle-orm']).toBe('1.0.0-rc.4');
        // drizzle-typebox's peer range admits no drizzle-orm prerelease, so npm
        // refuses an app that declares it (ERESOLVE); nothing imports it.
        expect(generated.dependencies?.['drizzle-typebox']).toBeUndefined();
        expect(generated.devDependencies?.['drizzle-kit']).toBe('1.0.0-rc.4');
        // `spfn build` bundles with the CLI's own tsup; no template configures one.
        expect(generated.devDependencies?.['tsup']).toBeUndefined();
        expect(mocks.execa).toHaveBeenCalledWith('pnpm', ['install'], {
            cwd: testDirectory,
        });
    });

    it('sets the patched Node range in bare mode too', async () =>
    {
        // The range is about the Node runtime itself (CVE-2026-111497), so it is not
        // something only full mode's @spfn/auth brings.
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-bare-node-'));
        const packageJsonPath = join(testDirectory, 'package.json');
        const packageJson: PackageJson = {
            name: 'bare-app',
            dependencies: {},
            devDependencies: {},
            scripts: {},
            engines: { node: '>=18.18.0' },
        };

        await setupPackageJson(
            testDirectory,
            packageJsonPath,
            packageJson,
            'pnpm',
            'bare',
        );

        const generated = JSON.parse(
            await readFile(packageJsonPath, 'utf8'),
        ) as PackageJson;
        expect(generated.engines?.node).toBe(NODE_ENGINE_RANGE);
        expect(generated.dependencies?.['@spfn/auth']).toBeUndefined();
    });

    it('adds the Prototype-to-Production dependency set in full mode', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-full-'));
        const packageJsonPath = join(testDirectory, 'package.json');
        const packageJson: PackageJson = {
            name: 'full-app',
            dependencies: {},
            devDependencies: {},
            scripts: {},
        };

        await setupPackageJson(
            testDirectory,
            packageJsonPath,
            packageJson,
            'pnpm',
            'full',
        );

        const generated = JSON.parse(
            await readFile(packageJsonPath, 'utf8'),
        ) as PackageJson;
        expect(generated.dependencies).toMatchObject({
            '@spfn/core': 'beta',
            '@spfn/auth': 'beta',
            '@spfn/i18n': 'beta',
            '@spfn/notification': 'beta',
        });
        // The ops surface ships inside core and auth, so full mode installs no
        // package for it — and no longer installs the MCP server it replaced.
        expect(generated.dependencies?.['@spfn/mcp']).toBeUndefined();
        expect(generated.engines?.node).toBe(NODE_ENGINE_RANGE);
    });

    it('upgrades an existing Node 18 engine for full mode', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-node18-'));
        const packageJsonPath = join(testDirectory, 'package.json');
        const packageJson: PackageJson = {
            name: 'node-18-app',
            dependencies: {},
            devDependencies: {},
            scripts: {},
            engines: { node: '>=18.18.0' },
        };

        await setupPackageJson(
            testDirectory,
            packageJsonPath,
            packageJson,
            'pnpm',
            'full',
        );

        const generated = JSON.parse(
            await readFile(packageJsonPath, 'utf8'),
        ) as PackageJson;
        expect(generated.engines?.node).toBe(NODE_ENGINE_RANGE);
    });

    it('preserves an existing range that admits only patched Node releases', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-node22-'));
        const packageJsonPath = join(testDirectory, 'package.json');
        const packageJson: PackageJson = {
            name: 'node-22-app',
            dependencies: {},
            devDependencies: {},
            scripts: {},
            engines: { node: '^24.22.1' },
        };

        await setupPackageJson(
            testDirectory,
            packageJsonPath,
            packageJson,
            'pnpm',
            'full',
        );

        const generated = JSON.parse(
            await readFile(packageJsonPath, 'utf8'),
        ) as PackageJson;
        expect(generated.engines?.node).toBe('^24.22.1');
    });

    it('fails naming the declared packages an install that exited 0 left unresolvable', async () =>
    {
        // pnpm in a directory its workspace does not list installs the workspace
        // and exits 0; only looking for the packages tells the two apart.
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-noop-'));
        const packageJsonPath = join(testDirectory, 'package.json');
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        mocks.execa.mockImplementation((_pm: string, _args: string[], { cwd }: { cwd: string }) =>
            fakeInstall(cwd, ['@spfn/core', 'tsx']));

        await expect(setupPackageJson(
            testDirectory,
            packageJsonPath,
            { name: 'noop-app', dependencies: {}, devDependencies: {}, scripts: {} },
            'pnpm',
            'bare',
        )).rejects.toThrow('process.exit(1)');

        exit.mockRestore();
        expect(mocks.spinner.fail).toHaveBeenCalledWith(expect.stringMatching(/do not resolve from .*: @spfn\/core, tsx$/));
        expect(mocks.spinner.succeed).not.toHaveBeenCalledWith('Dependencies installed');
    });

    it('fails naming a dependency the app already declared that the install left unresolvable', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-existing-'));
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        mocks.execa.mockImplementation((_pm: string, _args: string[], { cwd }: { cwd: string }) =>
            fakeInstall(cwd, ['left-pad']));

        await expect(setupPackageJson(
            testDirectory,
            join(testDirectory, 'package.json'),
            { name: 'existing-app', dependencies: { 'left-pad': '^1.3.0' }, devDependencies: {}, scripts: {} },
            'npm',
            'bare',
        )).rejects.toThrow('process.exit(1)');

        exit.mockRestore();
        expect(mocks.spinner.fail).toHaveBeenCalledWith(expect.stringMatching(/do not resolve from .*: left-pad$/));
    });

    it('says why when pnpm installed the workspace above a directory it does not list', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-init-package-nonmember-'));
        await writeFile(join(testDirectory, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
        await writeFile(join(testDirectory, 'pnpm-lock.yaml'), '');
        const appDirectory = join(testDirectory, 'scratch/app');
        await mkdir(appDirectory, { recursive: true });
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`process.exit(${code})`);
        }) as never);
        const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
        mocks.execa.mockResolvedValue(undefined);

        await expect(setupPackageJson(
            appDirectory,
            join(appDirectory, 'package.json'),
            { name: 'app', dependencies: {}, devDependencies: {}, scripts: {} },
            'pnpm',
            'bare',
        )).rejects.toThrow('process.exit(1)');

        exit.mockRestore();
        expect(error).toHaveBeenCalledWith(
            `${appDirectory} is not in the packages of ${join(testDirectory, 'pnpm-workspace.yaml')}, so pnpm installed that workspace instead.`
            + ' Add the directory to its packages, or install with the app\'s own manager (--pm npm).',
        );
        error.mockRestore();
    });
});
