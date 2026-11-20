import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock('execa', () => ({ execa: mocks.execa }));

import { DRIZZLE_TYPEBOX_REFUSAL, runInstall } from '../package-manager.js';

interface NpmCapture
{
    name: string;
    app: string;
    command: string;
    explained: boolean;
    stdout: string;
    stderr: string;
}

/**
 * Real npm 10.9.9 and 11.21.3 output, captured on 2026-11-20 by running
 * `command` in a throwaway app (`app` its dependencies); the home directory is
 * shortened to `~`, and the VM's own `always-auth` config warning is dropped.
 */
const captures: NpmCapture[] = JSON.parse(readFileSync(new URL('fixtures/npm-eresolve-captures.json', import.meta.url), 'utf8'));

afterEach(() =>
{
    vi.clearAllMocks();
});

/** Runs an npm install that fails as execa reports `capture`, and returns the report. */
async function reportFor({ command, stdout, stderr }: NpmCapture): Promise<string | null>
{
    mocks.execa.mockRejectedValueOnce(Object.assign(
        new Error(`Command failed with exit code 1: ${command}\n\n${stderr}\n\n${stdout}`),
        { exitCode: 1, stdout, stderr },
    ));

    return runInstall('npm', ['install'], { cwd: '/app' });
}

describe('runInstall on npm\'s real output', () =>
{
    it.each(captures.filter(capture => capture.explained))(
        'explains $name: npm\'s error is ERESOLVE over drizzle-typebox\'s peer on drizzle-orm',
        async capture =>
        {
            expect(await reportFor(capture)).toContain(DRIZZLE_TYPEBOX_REFUSAL);
        },
    );

    it.each(captures.filter(capture => !capture.explained))(
        'reports $name as npm wrote it, without the explanation',
        async capture =>
        {
            const report = await reportFor(capture);

            expect(report).toContain(capture.stderr.split('\n').find(line => line.startsWith('npm error code ')));
            expect(report).not.toContain(DRIZZLE_TYPEBOX_REFUSAL);
        },
    );

    it('covers npm 10 and 11, text and json, on both sides', () =>
    {
        const kinds = (explained: boolean) => new Set(captures
            .filter(capture => capture.explained === explained)
            .map(capture => capture.name.replace(/^[^,]*, /, '')));

        expect([...kinds(true)].sort()).toEqual(['npm 10.9.9, json', 'npm 10.9.9, text', 'npm 11.21.3, json', 'npm 11.21.3, text']);
        expect([...kinds(false)].sort()).toEqual([...kinds(true)].sort());
    });
});
