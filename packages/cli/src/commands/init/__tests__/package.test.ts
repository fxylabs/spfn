import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupPackageJson } from '../steps/package.js';
import { NODE_ENGINE_RANGE } from '../steps/node-engine.js';
import type { PackageJson } from '../steps/validate.js';

const mocks = vi.hoisted(() => ({
    execa: vi.fn().mockResolvedValue(undefined),
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
        expect(generated.dependencies?.['drizzle-typebox']).toBe('^0.3.3');
        expect(generated.devDependencies?.['drizzle-kit']).toBe('1.0.0-rc.4');
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
});
