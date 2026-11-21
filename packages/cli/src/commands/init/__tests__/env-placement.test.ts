/**
 * The env reference is split by consumer, and nothing but a test keeps it split.
 *
 * A backend-only key that drifts into `.env.local` is loaded by the Next.js
 * process, which is how `DATABASE_URL` ended up in three example apps. These cases
 * derive the backend-only key list from the scaffold's own server templates, then
 * assert it against both what `spfn init` writes and what the examples commit.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setupConfigFiles, serverOnlyEnvKeys } from '../steps/config-files.js';
import { collectDeclaredKeys, gitignoreCovers } from '../../../utils/env-file.js';
import type { ScaffoldMode } from '../mode.js';

const SERVER_ONLY_KEYS = serverOnlyEnvKeys();
const MODES: ScaffoldMode[] = ['bare', 'full'];

// packages/cli/src/commands/init/__tests__ → repository root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

let testDirectory: string | undefined;

afterEach(async () =>
{
    if (testDirectory)
    {
        await rm(testDirectory, { recursive: true, force: true });
        testDirectory = undefined;
    }
});

describe('env reference placement', () =>
{
    it('derives the backend-only keys from the server templates', () =>
    {
        expect(SERVER_ONLY_KEYS).toContain('DATABASE_URL');
        expect(SERVER_ONLY_KEYS).toContain('SPFN_LOG_LEVEL');
        // A commented-out key is still a backend key: whoever uncomments
        // it must not find .env.local an acceptable home for it.
        expect(SERVER_ONLY_KEYS).toContain('SPFN_AUTH_GOOGLE_CLIENT_ID');
        // Next.js keys are the other side of the split and must stay out of the list.
        expect(SERVER_ONLY_KEYS).not.toContain('SPFN_API_URL');
        expect(SERVER_ONLY_KEYS).not.toContain('SPFN_AUTH_SESSION_SECRET');
    });

    it.each(MODES)('keeps backend-only keys out of the Next.js env files (%s mode)', async (mode) =>
    {
        const directory = await scaffoldConfig(mode);

        for (const filename of ['.env.local.example', '.env.local'])
        {
            const content = await readFile(join(directory, filename), 'utf8');

            expect(serverKeysIn(content), `${filename} (${mode} mode)`).toEqual([]);
        }
    });

    it.each(MODES)('writes one reference per consumer and no combined file (%s mode)', async (mode) =>
    {
        const directory = await scaffoldConfig(mode);

        expect(existsSync(join(directory, '.env.local.example'))).toBe(true);
        expect(existsSync(join(directory, '.env.server.example'))).toBe(true);
        expect(existsSync(join(directory, '.env.example'))).toBe(false);
        expect(existsSync(join(directory, '.env.local.spfn.example'))).toBe(false);
    });

    it('leaves an older scaffold\'s combined .env.example untouched', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-env-combined-'));
        const combinedPath = join(testDirectory, '.env.example');
        const original = 'SPFN_API_URL=http://example.invalid\n';
        await writeFile(combinedPath, original);

        await setupConfigFiles(testDirectory, 'full');

        await expect(readFile(combinedPath, 'utf8')).resolves.toBe(original);
        expect(existsSync(join(testDirectory, '.env.local.example'))).toBe(true);
    });

    it('keeps both references tracked under a broad .env* ignore glob', async () =>
    {
        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-env-ignore-'));
        spawnSync('git', ['init', '-q'], { cwd: testDirectory, stdio: 'ignore' });
        // What create-next-app ships, and what would otherwise untrack the references.
        await writeFile(join(testDirectory, '.gitignore'), '.env*\n');

        await setupConfigFiles(testDirectory, 'full');

        expect(isGitIgnored(testDirectory, '.env.local.example')).toBe(false);
        expect(isGitIgnored(testDirectory, '.env.server.example')).toBe(false);
        // The rules that keep real secrets out of a commit still hold.
        expect(isGitIgnored(testDirectory, '.env.local')).toBe(true);
        expect(isGitIgnored(testDirectory, '.env.server')).toBe(true);
    });

    it('ignores the temporary drizzle config spfn db writes: the scaffold, the repository and each example\'s own .gitignore (#405)', async () =>
    {
        // Without this row a SIGKILLed spfn db generate leaves a file holding a
        // database URL that the next `git add .` commits.
        const temp = `drizzle.config.${process.pid}.${Date.now()}.temp.ts`;

        testDirectory = await mkdtemp(join(tmpdir(), 'spfn-temp-config-ignore-'));
        spawnSync('git', ['init', '-q'], { cwd: testDirectory, stdio: 'ignore' });
        await setupConfigFiles(testDirectory, 'full');

        expect(isGitIgnored(testDirectory, temp)).toBe(true);

        expect(isGitIgnored(REPO_ROOT, temp)).toBe(true);

        // An example's own .gitignore goes with it when the app is copied out of the repository.
        const ignoreFiles = (await readdir(join(REPO_ROOT, 'examples'), { withFileTypes: true }))
            .map((entry) => join(REPO_ROOT, 'examples', entry.name, '.gitignore'))
            .filter((path) => existsSync(path));

        expect(ignoreFiles.length).toBeGreaterThan(0);

        for (const path of ignoreFiles)
        {
            expect(gitignoreCovers((await readFile(path, 'utf-8')).split('\n'), 'drizzle.config.*.temp.ts'), path).toBe(true);
        }
    });

    it('keeps the temporary drizzle config out of a Docker build context: the .dockerignore spfn init writes (#405)', async () =>
    {
        // Without this row a file holding a database URL, left by a SIGKILLed
        // spfn db command, is copied into the image by `COPY . .`.
        const template = join(REPO_ROOT, 'packages', 'cli', 'templates', '.dockerignore');

        expect(gitignoreCovers((await readFile(template, 'utf-8')).split('\n'), 'drizzle.config.*.temp.ts')).toBe(true);
    });

    it('has no backend-only key in any example app .env.local.example', async () =>
    {
        const references = await exampleLocalReferences();

        expect(references.length).toBeGreaterThan(0);

        for (const { path, content } of references)
        {
            expect(serverKeysIn(content), `${path} must not hold backend-only keys`).toEqual([]);
        }
    });
});

async function scaffoldConfig(mode: ScaffoldMode): Promise<string>
{
    testDirectory = await mkdtemp(join(tmpdir(), `spfn-env-placement-${mode}-`));
    await setupConfigFiles(testDirectory, mode);

    return testDirectory;
}

/** The backend-only keys a file declares, commented-out declarations included. */
function serverKeysIn(content: string): string[]
{
    const declared = collectDeclaredKeys(content);

    return SERVER_ONLY_KEYS.filter((key) => declared.has(key));
}

function isGitIgnored(cwd: string, filename: string): boolean
{
    const result = spawnSync('git', ['check-ignore', '-q', '--', filename], {
        cwd,
        stdio: 'ignore',
    });

    return result.status === 0;
}

/** Every `examples/*` app that commits a Next.js env reference, with its contents. */
async function exampleLocalReferences(): Promise<{ path: string; content: string }[]>
{
    const examplesDir = join(REPO_ROOT, 'examples');
    const entries = await readdir(examplesDir, { withFileTypes: true });
    const references: { path: string; content: string }[] = [];

    for (const entry of entries)
    {
        const path = join(examplesDir, entry.name, '.env.local.example');

        if (entry.isDirectory() && existsSync(path))
        {
            references.push({ path, content: await readFile(path, 'utf8') });
        }
    }

    return references;
}
