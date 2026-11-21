/**
 * The next steps a scaffolded app is told (#378): one list, printed once by
 * whichever command ran, naming `spfn db push` wherever the scaffold holds an
 * entity — a new app has no project migration, so `db migrate` would leave its
 * first query on a missing table.
 *
 * The scaffold's server templates are copied for real (that is where the entity
 * comes from); create-next-app, installs and the other files are stubbed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    spinner: {
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn(),
        fail: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('ora', () => ({ default: () => mocks.spinner }));
// create-next-app leaves the project directory behind; every other command is a no-op
vi.mock('execa', () => ({
    execa: vi.fn(async (_command: string, args: string[], options: { cwd: string }) =>
    {
        if (args.includes('create-next-app@latest'))
        {
            mkdirSync(join(options.cwd, args[args.indexOf('create-next-app@latest') + 1]));
        }
    }),
}));
vi.mock('../../setup.js', () => ({ setupIcons: vi.fn() }));
vi.mock('../steps/validate.js', () => ({
    validateProject: vi.fn(async (cwd: string) => ({ packageJson: { name: 'app' }, packageJsonPath: join(cwd, 'package.json') })),
}));
vi.mock('../steps/api-proxy.js', () => ({ setupApiProxy: vi.fn() }));
vi.mock('../steps/next-config.js', () => ({ setupNextConfig: vi.fn() }));
vi.mock('../steps/docker.js', () => ({ setupDockerFiles: vi.fn() }));
vi.mock('../steps/deployment-config.js', () => ({ setupDeploymentConfig: vi.fn() }));
vi.mock('../steps/package.js', () => ({ setupPackageJson: vi.fn(), confirmInstalled: vi.fn() }));
vi.mock('../steps/config-files.js', () => ({ setupConfigFiles: vi.fn() }));
vi.mock('../steps/readme.js', () => ({ setupReadme: vi.fn() }));

const { initializeSpfn } = await import('../index.js');
const { createCommand } = await import('../../create.js');
const { scaffoldNextSteps } = await import('../next-steps.js');

let directory: string;
let previousCwd: string;
let printed: string[];

beforeEach(() =>
{
    directory = mkdtempSync(join(tmpdir(), 'spfn-next-steps-'));
    previousCwd = process.cwd();
    process.chdir(directory);
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
});

afterEach(() =>
{
    process.chdir(previousCwd);
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
});

const output = () => printed.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
const count = (text: string, part: string) => text.split(part).length - 1;

describe('the next steps of a scaffolded app', () =>
{
    it('N1 spfn init --mode full: one list, naming db push and never db migrate', async () =>
    {
        writeFileSync(join(directory, 'package.json'), '{}');

        await initializeSpfn({ yes: true, mode: 'full', pm: 'pnpm' });

        expect(count(output(), 'Next steps:')).toBe(1);
        expect(output()).toContain("Create the database tables (the auth migrations, then the app's tables): pnpm spfn db push");
        expect(output()).not.toContain('db migrate');
    });

    it('N2 spfn create --mode bare: one list, after cd, naming db push — its examples entity has a table to create', async () =>
    {
        await createCommand.parseAsync(['my-app', '--mode', 'bare', '--pm', 'npm', '--yes', '--skip-install', '--skip-git'], { from: 'user' });

        expect(count(output(), 'Next steps:')).toBe(1);
        expect(output()).toContain('  1. cd my-app');
        expect(output()).toContain("Create the database tables (the app's tables): npx spfn db push");
        expect(output()).not.toContain('db migrate');
        expect(output().indexOf('db push')).toBeLessThan(output().indexOf('npm run spfn:dev'));
    });

    it('N3 a bare scaffold with no entity file names no database command', () =>
    {
        const steps = scaffoldNextSteps({ pm: 'pnpm', mode: 'bare', appDir: directory }).join('\n');

        expect(steps).not.toContain('db push');
        expect(steps).not.toContain('db migrate');
    });
});
