import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * package.json; an install puts each declared package under `cwd/node_modules`.
 */
function fakeProcess(_command: string, args: string[], { cwd }: { cwd: string }): void
{
    if (args.some(arg => arg.startsWith('create-next-app')))
    {
        mkdirSync(join(cwd, 'app'));
        writeFileSync(join(cwd, 'app', 'package.json'), JSON.stringify({ name: 'app', dependencies: { next: '16' } }));

        return;
    }

    const { dependencies, devDependencies } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));

    for (const name of [...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})])
    {
        mkdirSync(join(cwd, 'node_modules', name), { recursive: true });
        writeFileSync(join(cwd, 'node_modules', name, 'package.json'), '{}');
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
});

afterEach(() =>
{
    process.chdir(originalCwd);
    vi.clearAllMocks();
    rmSync(repository, { recursive: true, force: true });
});

async function createFrom(directory: string): Promise<string>
{
    mkdirSync(directory, { recursive: true });
    process.chdir(directory);
    await createCommand.parseAsync(['app', '--pm', 'npm', '--mode', 'bare', '--yes', '--skip-git'], { from: 'user' });

    return join(directory, 'app');
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
