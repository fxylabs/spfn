import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectPackageManager, getRunScriptArgs } from '../package-manager.js';

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

describe('detectPackageManager', () =>
{
    let repository: string | undefined;

    afterEach(() =>
    {
        rmSync(repository!, { recursive: true, force: true });
        repository = undefined;
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
});
