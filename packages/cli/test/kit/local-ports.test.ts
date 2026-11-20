/**
 * The four ports that run something on this machine.
 *
 * Most of these drive an injected runner rather than a real child process, and
 * the reason is not speed. What has to be proved about a package-manager port
 * is *what it asks for* — that "frozen" reaches pnpm as `--frozen-lockfile`,
 * that the registry session is in the environment and not in the argument
 * list, that a 401 is told apart from an unresolvable graph — and every one of
 * those is a property of the call, visible only at the call.
 *
 * Git is the exception and runs for real, in a temporary directory. Its
 * contract is about repository state rather than about arguments, and a fake
 * `git` could be made to agree with any implementation of it.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PnpmPackageManagerPort, classify } from '../../src/kit/local/package-manager.js';
import { SpfnDatabasePort } from '../../src/kit/local/database.js';
import { CommandGatePort, projectScripts } from '../../src/kit/local/gates.js';
import { SystemGitPort } from '../../src/kit/local/git.js';
import { createKitLocalPorts } from '../../src/kit/local/index.js';
import { summarize, type RunRequest, type RunResult } from '../../src/kit/local/process.js';
import { redactUrls } from '../../src/utils/redact-urls.js';
import { REGISTRY_TOKEN_ENV } from '../../src/kit/child-env.js';
import { DB_STATUS_JSON_MARKER, migrationStatusReport, unreadableStatusReport } from '../../src/commands/db/status.js';
import type { DatabasePort } from '../../src/kit/ports.js';

const SESSION = 'spfnr_session_do_not_leak';

let root: string;
let calls: RunRequest[];

beforeEach(() =>
{
    root = mkdtempSync(join(tmpdir(), 'spfn-kit-local-'));
    calls = [];
});

afterEach(() =>
{
    rmSync(root, { recursive: true, force: true });
});

/** A runner that records the call and answers with what a test dictates. */
function recording(answers: RunResult[] | ((request: RunRequest) => RunResult)): (request: RunRequest) => Promise<RunResult>
{
    let index = 0;

    return async (request: RunRequest) =>
    {
        calls.push(request);

        if (typeof answers === 'function')
        {
            return answers(request);
        }

        return answers[Math.min(index++, answers.length - 1)];
    };
}

function ok(stdout = ''): RunResult
{
    return { exitCode: 0, stdout, stderr: '', missing: false };
}

function failed(stderr: string, exitCode = 1): RunResult
{
    return { exitCode, stdout: '', stderr, missing: false };
}

function marked(report: unknown): string
{
    return `${DB_STATUS_JSON_MARKER}${JSON.stringify(report)}`;
}

describe('the package-manager port', () =>
{
    it('asks for the exact graph when the operation says frozen', async () =>
    {
        await new PnpmPackageManagerPort({ run: recording([ok()]) })
            .install({ cwd: root, frozen: true, env: {} });

        expect(calls[0].file).toBe('pnpm');
        expect(calls[0].args).toEqual(['install', '--frozen-lockfile']);
    });

    it('says so plainly when the operation does not', async () =>
    {
        await new PnpmPackageManagerPort({ run: recording([ok()]) })
            .install({ cwd: root, frozen: false, env: {} });

        expect(calls[0].args).toEqual(['install', '--no-frozen-lockfile']);
    });

    it('puts the registry on the command line and the session in the environment', async () =>
    {
        await new PnpmPackageManagerPort({ run: recording([ok()]), registryUrl: 'http://127.0.0.1:4873/' })
            .install({ cwd: root, frozen: true, env: { [REGISTRY_TOKEN_ENV]: SESSION } });

        expect(calls[0].args).toContain('--registry');
        expect(calls[0].args).toContain('http://127.0.0.1:4873/');
        expect(calls[0].extraEnv?.[REGISTRY_TOKEN_ENV]).toBe(SESSION);

        for (const argument of calls[0].args)
        {
            expect(argument).not.toContain(SESSION);
        }
    });

    it('carries the isolation options an integration run needs', async () =>
    {
        await new PnpmPackageManagerPort({
            run: recording([ok()]),
            storeDir: join(root, 'store'),
            ignoreScripts: true,
            ignoreWorkspace: true,
        }).install({ cwd: root, frozen: true, env: {} });

        expect(calls[0].args).toEqual([
            'install', '--frozen-lockfile',
            '--store-dir', join(root, 'store'),
            '--ignore-scripts',
            '--ignore-workspace',
        ]);
    });

    it.each([
        ['ERR_PNPM_FETCH_401  GET https://registry/: Unauthorized', 'unauthorized'],
        ['ERR_PNPM_FETCH_403  GET https://registry/: Forbidden', 'unauthorized'],
        ['ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"', 'resolution'],
        ['ERR_PNPM_NO_MATCHING_VERSION No matching version found for @scope/x@9.9.9', 'resolution'],
        ['ERR_PNPM_FETCH_503 GET https://registry/: Service Unavailable', 'network'],
        ['request to https://registry/x failed, reason: ECONNREFUSED', 'network'],
        ['ELIFECYCLE  Command failed with exit code 1.', 'other'],
    ])('classifies %s as %s', async (stderr, expected) =>
    {
        const result = await new PnpmPackageManagerPort({ run: recording([failed(stderr)]) })
            .install({ cwd: root, frozen: true, env: {} });

        expect(result).toMatchObject({ ok: false, failure: expected });
    });

    it('reads the whole output, not only the tail a report would show', () =>
    {
        // The line that names the failure is the first of many.
        const noisy = failed(['ERR_PNPM_NO_MATCHING_VERSION', ...Array(20).fill('progress...')].join('\n'));

        expect(classify(noisy)).toBe('resolution');
    });

    it('reports a pnpm that is not installed as a plain failure, not a refusal', async () =>
    {
        const result = await new PnpmPackageManagerPort({
            run: recording([{ exitCode: 127, stdout: '', stderr: 'spawn pnpm ENOENT', missing: true }]),
        }).install({ cwd: root, frozen: true, env: {} });

        expect(result).toEqual({ ok: false, exitCode: 127, failure: 'other' });
    });
});

describe('the database port', () =>
{
    it('reads the report the CLI printed, through whatever else it printed', async () =>
    {
        const port = new SpfnDatabasePort({
            command: { file: 'node', args: ['spfn'] },
            run: recording([ok(`loading env\n${marked(migrationStatusReport({
                packages: [{ name: '@spfn/cms', total: 2, applied: 1, pending: 1, pendingTags: ['0002_x'] }],
                project: null,
            }))}\ndone`)]),
        });

        expect(await port.status({ cwd: root })).toEqual({
            configured: true,
            reachable: true,
            applied: ['@spfn/cms 1/2'],
            pending: ['@spfn/cms/0002_x'],
        });
        expect(calls[0].args).toEqual(['spfn', 'db', 'status', '--json']);
    });

    it('reports an unconfigured project as unconfigured, not as broken', async () =>
    {
        const port = new SpfnDatabasePort({
            command: { file: 'node', args: ['spfn'] },
            run: recording([ok(marked(unreadableStatusReport('not-configured')))]),
        });

        expect(await port.status({ cwd: root })).toMatchObject({ configured: false, reachable: false });
    });

    it('applies what is waiting and confirms afterwards that nothing is', async () =>
    {
        const before = marked(migrationStatusReport({
            packages: [{ name: '@spfn/cms', total: 2, applied: 1, pending: 1, pendingTags: ['0002_x'] }],
            project: null,
        }));
        const after = marked(migrationStatusReport({
            packages: [{ name: '@spfn/cms', total: 2, applied: 2, pending: 0, pendingTags: [] }],
            project: null,
        }));
        const port = new SpfnDatabasePort({
            command: { file: 'node', args: ['spfn'] },
            run: recording([ok(before), ok('migrated'), ok(after)]),
        });
        const result = await port.migrate({ cwd: root, withBackup: true });

        expect(result.ok).toBe(true);
        expect(result.pending).toEqual([]);
        expect(calls.map(call => call.args.slice(1))).toEqual([
            ['db', 'status', '--json'],
            ['db', 'migrate', '--with-backup'],
            ['db', 'status', '--json'],
        ]);
    });

    it('refuses to call a migration that left work behind a success', async () =>
    {
        const stillPending = marked(migrationStatusReport({
            packages: [{ name: '@spfn/cms', total: 2, applied: 1, pending: 1, pendingTags: ['0002_x'] }],
            project: null,
        }));
        const port = new SpfnDatabasePort({
            command: { file: 'node', args: ['spfn'] },
            run: recording([ok(stillPending), ok('migrated'), ok(stillPending)]),
        });
        const result = await port.migrate({ cwd: root, withBackup: false });

        expect(result.ok).toBe(false);
        expect(result.failure).toBe('migrations-still-pending');
    });

    it('reports a migration that failed, with a summary and no connection string', async () =>
    {
        const port = new SpfnDatabasePort({
            command: { file: 'node', args: ['spfn'] },
            run: recording([
                ok(marked(unreadableStatusReport('unreachable'))),
                failed('could not connect to postgres://admin:hunter2@db.internal:5432/app'),
            ]),
        });
        const result = await port.migrate({ cwd: root, withBackup: false });

        expect(result.ok).toBe(false);
        expect(result.failure).not.toContain('hunter2');
        expect(result.failure).toContain('<redacted>');
    });
});

describe('the gate port', () =>
{
    const database: DatabasePort = {
        async status()
        {
            return { configured: true, reachable: true, applied: [], pending: [] };
        },
        async migrate()
        {
            return { ok: true, applied: [], pending: [] };
        },
    };

    function withScripts(scripts: Record<string, string>): void
    {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts }), 'utf8');
    }

    it('runs the project\'s own script when it has one', async () =>
    {
        withScripts({ 'type-check': 'tsc --noEmit', test: 'vitest run', build: 'next build' });

        const port = new CommandGatePort({ database, run: recording([ok()]) });

        expect(await port.run('typecheck', { cwd: root })).toEqual({ ok: true });
        expect(calls[0].args).toEqual(['run', 'type-check']);

        await port.run('build', { cwd: root });
        expect(calls[1].args).toEqual(['run', 'build']);
    });

    it('falls back to the obvious command where there is one', async () =>
    {
        withScripts({});

        await new CommandGatePort({ database, run: recording([ok()]) }).run('typecheck', { cwd: root });

        expect(calls[0].args).toEqual(['exec', 'tsc', '--noEmit']);
    });

    it('fails a gate the project has no way to run, rather than passing it', async () =>
    {
        withScripts({});

        const result = await new CommandGatePort({ database, run: recording([ok()]) }).run('test', { cwd: root });

        expect(result.ok).toBe(false);
        expect(result.summary).toContain('no way to run the test gate');
        expect(calls).toHaveLength(0);
    });

    it('answers db-status from the same port the migration step used', async () =>
    {
        const pending: DatabasePort = {
            async status()
            {
                return { configured: true, reachable: true, applied: [], pending: ['x/0002'] };
            },
            async migrate()
            {
                return { ok: true, applied: [], pending: [] };
            },
        };

        expect(await new CommandGatePort({ database, run: recording([ok()]) }).run('db-status', { cwd: root }))
            .toEqual({ ok: true });
        expect((await new CommandGatePort({ database: pending, run: recording([ok()]) })
            .run('db-status', { cwd: root })).ok).toBe(false);
    });

    it('refuses the health gate rather than pretending to have checked a deployment', async () =>
    {
        const result = await new CommandGatePort({ database, run: recording([ok()]) }).run('health', { cwd: root });

        expect(result.ok).toBe(false);
        expect(result.summary).toContain('deployment');
    });

    it('summarises a failed gate without repeating whatever it printed', async () =>
    {
        withScripts({ test: 'vitest run' });

        const result = await new CommandGatePort({
            database,
            run: recording([failed('token=abcdef123\nTests: 1 failed, 4 passed')]),
        }).run('test', { cwd: root });

        expect(result.ok).toBe(false);
        expect(result.summary).toContain('1 failed');
        expect(result.summary).not.toContain('abcdef123');
    });

    it('reads a project with no package.json as a project with no scripts', () =>
    {
        expect(projectScripts(root)).toEqual({});
        writeFileSync(join(root, 'package.json'), '{ not json', 'utf8');
        expect(projectScripts(root)).toEqual({});
    });
});

describe('the git port', () =>
{
    const git = new SystemGitPort();

    beforeEach(() =>
    {
        mkdirSync(join(root, 'project'), { recursive: true });
    });

    function project(): string
    {
        return join(root, 'project');
    }

    it('starts a repository, and leaves an existing one alone', async () =>
    {
        await git.init({ cwd: project() });

        execSync('git config user.email probe@example.com && git config user.name Probe', { cwd: project() });
        writeFileSync(join(project(), 'a.txt'), 'first\n', 'utf8');
        execSync('git add -A && git commit -q -m first', { cwd: project() });

        const head = await git.head({ cwd: project() });

        // A second init must not reinitialise over the commit just made.
        await git.init({ cwd: project() });

        expect(await git.head({ cwd: project() })).toBe(head);
    });

    it('reports a repository with no commits as having no HEAD', async () =>
    {
        await git.init({ cwd: project() });

        expect(await git.head({ cwd: project() })).toBeNull();
    });

    it('commits everything in the worktree and names the commit it made', async () =>
    {
        await git.init({ cwd: project() });
        writeFileSync(join(project(), 'a.txt'), 'content\n', 'utf8');
        mkdirSync(join(project(), 'src'), { recursive: true });
        writeFileSync(join(project(), 'src', 'b.ts'), 'export const b = 1;\n', 'utf8');

        const { commit } = await git.commit({ cwd: project(), message: 'chore: install campaign-landing 1.0.0' });

        expect(commit).toMatch(/^[0-9a-f]{40}$/);
        expect(await git.head({ cwd: project() })).toBe(commit);
        expect(await git.isClean({ cwd: project() })).toBe(true);
    });

    it('sees an edit as a dirty worktree', async () =>
    {
        await git.init({ cwd: project() });
        writeFileSync(join(project(), 'a.txt'), 'content\n', 'utf8');
        await git.commit({ cwd: project(), message: 'first' });

        writeFileSync(join(project(), 'a.txt'), 'edited\n', 'utf8');

        expect(await git.isClean({ cwd: project() })).toBe(false);
    });

    it('refuses to call an unreadable worktree clean', async () =>
    {
        // Not a repository at all: the question could not be asked, and
        // answering "clean" would turn that into permission to proceed.
        await expect(git.isClean({ cwd: project() })).rejects.toThrow(/git status failed/);
    });
});

describe('what every local port shares', () =>
{
    it('blanks the credentials inside a URL a tool printed', () =>
    {
        expect(redactUrls('postgres://user:pw@host/db')).toBe('postgres://<redacted>@host/db');
        expect(redactUrls('Authorization: Bearer abc.def')).toBe('Authorization: <redacted>');
        expect(redactUrls('nothing to hide here')).toBe('nothing to hide here');
    });

    it('summarises the tail, where a failure says what went wrong', () =>
    {
        const long = { exitCode: 1, stdout: '', stderr: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'), missing: false };

        expect(summarize(long)).toContain('line 39');
        expect(summarize(long)).not.toContain('line 5 ');
    });

    it('builds all four ports, with the gate port sharing the database port', async () =>
    {
        const nothingPending = marked(migrationStatusReport({ packages: [], project: null }));
        const ports = createKitLocalPorts({ database: { run: recording([ok(nothingPending)]) } });

        expect(await ports.gates.run('db-status', { cwd: root })).toEqual({ ok: true });
        expect(typeof ports.loadProjectModule).toBe('function');
    });
});
