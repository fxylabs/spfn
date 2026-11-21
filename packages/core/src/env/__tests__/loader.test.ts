/**
 * Environment Loader Tests
 *
 * .env 파일 로딩 규칙(서버/환경별/시크릿 분리)의 회귀 검증.
 * 특히 .env.server.local 폐지 이후 server 레이어는 .env.server만 로드해야 한다.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv, resetEnvLoadState } from '../loader';

describe('loadEnv - 파일 로딩 규칙', () =>
{
    const originalEnv = { ...process.env };
    let dir: string;

    beforeEach(() =>
    {
        process.env = { ...originalEnv };
        dir = mkdtempSync(join(tmpdir(), 'spfn-env-'));
    });

    afterEach(() =>
    {
        process.env = originalEnv;
        rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, body: string): void
    {
        writeFileSync(join(dir, name), body);
    }

    it('server=true면 .env.server를 로드한다', () =>
    {
        write('.env', 'SPFN_ENVTEST_BASE=1');
        write('.env.server', 'SPFN_ENVTEST_SRV=2');

        const result = loadEnv({ cwd: dir, nodeEnv: 'production', server: true });

        expect(result.loadedFiles).toContain('.env.server');
        expect(process.env.SPFN_ENVTEST_SRV).toBe('2');
    });

    it('.env.server.local은 더 이상 로드하지 않는다 (폐지됨)', () =>
    {
        write('.env.server', 'SPFN_ENVTEST_SRV=2');
        write('.env.server.local', 'SPFN_ENVTEST_SECRET=should-not-load');

        const result = loadEnv({ cwd: dir, nodeEnv: 'production', server: true });

        expect(result.loadedFiles).not.toContain('.env.server.local');
        expect(process.env.SPFN_ENVTEST_SECRET).toBeUndefined();
    });

    it('server=false면 .env.server를 로드하지 않는다', () =>
    {
        write('.env', 'SPFN_ENVTEST_BASE=1');
        write('.env.server', 'SPFN_ENVTEST_SRV=2');

        const result = loadEnv({ cwd: dir, nodeEnv: 'production', server: false });

        expect(result.loadedFiles).not.toContain('.env.server');
        expect(process.env.SPFN_ENVTEST_SRV).toBeUndefined();
    });

    it('nodeEnv=test에서는 .env.local을 스킵한다 (테스트 결정론성)', () =>
    {
        write('.env', 'SPFN_ENVTEST_BASE=1');
        write('.env.local', 'SPFN_ENVTEST_LOCAL=local');

        const result = loadEnv({ cwd: dir, nodeEnv: 'test', server: true });

        expect(result.loadedFiles).not.toContain('.env.local');
        expect(process.env.SPFN_ENVTEST_LOCAL).toBeUndefined();
    });

    it('나중 파일이 앞 파일을 덮어쓴다 (.env.server > .env)', () =>
    {
        write('.env', 'SPFN_ENVTEST_KEY=base');
        write('.env.server', 'SPFN_ENVTEST_KEY=server');

        loadEnv({ cwd: dir, nodeEnv: 'production', server: true });

        expect(process.env.SPFN_ENVTEST_KEY).toBe('server');
    });
});

/**
 * Issue #136 — the NODE_ENV warning used to be raised by the logger while it was
 * being imported, which is strictly before any .env file is read. It belongs to
 * loadEnv, and it is a warning about which file set was SELECTED, not about the
 * variable being absent once loading finishes.
 */
describe('loadEnv - NODE_ENV warning', () =>
{
    const originalEnv = { ...process.env };
    let dir: string;
    let warnings: string[];
    let consoleErrorSpy: MockInstance;

    beforeEach(() =>
    {
        process.env = { ...originalEnv };
        dir = mkdtempSync(join(tmpdir(), 'spfn-env-'));
        warnings = [];
        // warn goes to console.error (see transports/console).
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) =>
        {
            warnings.push(args.map(String).join(' '));
        });
    });

    afterEach(() =>
    {
        consoleErrorSpy.mockRestore();
        process.env = originalEnv;
        rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, body: string): void
    {
        writeFileSync(join(dir, name), body);
    }

    function nodeEnvWarnings(): string[]
    {
        return warnings.filter(line => line.includes('NODE_ENV'));
    }

    it('names the file set it fell back to when NODE_ENV is set nowhere', () =>
    {
        delete process.env.NODE_ENV;
        write('.env', 'SPFN_ENVTEST_BASE=1');

        loadEnv({ cwd: dir });

        expect(nodeEnvWarnings()).toHaveLength(1);
        expect(nodeEnvWarnings()[0]).toContain('"local"');
    });

    it('names the file the wrong guess actually skipped', () =>
    {
        delete process.env.NODE_ENV;
        write('.env.server', 'NODE_ENV=development');
        write('.env.development', 'SPFN_ENVTEST_DEV=missed');

        loadEnv({ cwd: dir });

        expect(process.env.NODE_ENV).toBe('development');
        expect(process.env.SPFN_ENVTEST_DEV).toBeUndefined();
        expect(nodeEnvWarnings()).toHaveLength(1);
        expect(nodeEnvWarnings()[0]).toContain('.env.development was NOT loaded');
    });

    it('stays silent when a wrong guess skipped nothing', () =>
    {
        // The scaffolded app's shape: .env.server declares NODE_ENV, but there
        // is no .env.development file, so nothing was lost.
        delete process.env.NODE_ENV;
        write('.env.server', 'NODE_ENV=development');

        loadEnv({ cwd: dir });

        expect(process.env.NODE_ENV).toBe('development');
        expect(nodeEnvWarnings()).toHaveLength(0);
    });

    it('stays silent when the files declare what was guessed', () =>
    {
        // The example apps' shape: .env.local declares NODE_ENV=local.
        delete process.env.NODE_ENV;
        write('.env.local', 'NODE_ENV=local');

        loadEnv({ cwd: dir });

        expect(nodeEnvWarnings()).toHaveLength(0);
    });

    it('stays silent when the process started with NODE_ENV', () =>
    {
        process.env.NODE_ENV = 'development';
        write('.env', 'SPFN_ENVTEST_BASE=1');

        loadEnv({ cwd: dir });

        expect(nodeEnvWarnings()).toHaveLength(0);
    });

    it('stays silent when the caller named the environment', () =>
    {
        delete process.env.NODE_ENV;
        write('.env', 'SPFN_ENVTEST_BASE=1');

        loadEnv({ cwd: dir, nodeEnv: 'staging' });

        expect(nodeEnvWarnings()).toHaveLength(0);
    });

    it('warns once regardless of how many files were loaded', () =>
    {
        delete process.env.NODE_ENV;
        write('.env', 'SPFN_ENVTEST_BASE=1');
        write('.env.local', 'SPFN_ENVTEST_LOCAL=1');
        write('.env.server', 'SPFN_ENVTEST_SRV=1');

        loadEnv({ cwd: dir });

        expect(nodeEnvWarnings()).toHaveLength(1);
    });
});

/**
 * DATABASE_OWNER_URL is loaded from a file only when the caller asks (#405)
 *
 * The table owner's URL is for the spfn commands that change the schema, which
 * pass `ownerCredentials: true`. Every other caller — the server, provisioning,
 * app code, a later reload — leaves it out of process.env, and the first such
 * load in a process says so once, at debug, naming the file and never the value:
 * nothing is wrong, so at the default level nothing is printed. The logger's
 * level is read when it is created, so the debug rows load a fresh loader with
 * SPFN_LOG_LEVEL=debug.
 */
describe('loadEnv - DATABASE_OWNER_URL', () =>
{
    const OWNER_PASSWORD = 'owner-pw-that-must-never-reach-a-log';
    const OWNER_URL = `postgresql://app_owner:${OWNER_PASSWORD}@localhost:5432/notes`;
    const originalEnv = { ...process.env };
    let dir: string;
    let logged: { stdout: string[]; stderr: string[] };

    beforeEach(() =>
    {
        process.env = { ...originalEnv, NODE_ENV: 'production' };
        delete process.env.DATABASE_OWNER_URL;
        dir = mkdtempSync(join(tmpdir(), 'spfn-env-'));
        logged = { stdout: [], stderr: [] };
        resetEnvLoadState();
        // info goes to console.log, warn and error to console.error (see transports/console).
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.stdout.push(args.map(String).join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.stderr.push(args.map(String).join(' ')));
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        process.env = originalEnv;
        rmSync(dir, { recursive: true, force: true });
    });

    function ownerLines(lines: string[]): string[]
    {
        return lines.filter(line => line.includes('DATABASE_OWNER_URL'));
    }

    /** `loadEnv` of a loader whose logger was created with SPFN_LOG_LEVEL=debug. */
    async function loadEnvAtDebug(): Promise<typeof loadEnv>
    {
        vi.stubEnv('SPFN_LOG_LEVEL', 'debug');
        vi.resetModules();

        try
        {
            return (await import('../loader')).loadEnv;
        }
        finally
        {
            vi.unstubAllEnvs();
        }
    }

    it('O1 by default the key stays out of process.env, and at the default level nothing is printed: nothing is wrong', () =>
    {
        // Without this row every loadEnv() caller — a custom entry, provisioning,
        // a later reload — holds the owner's URL; or a correct configuration
        // logs a line on every boot, before `db status --json`'s object too.
        writeFileSync(join(dir, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\nSPFN_ENVTEST_SRV=2\n`);

        const result = loadEnv({ cwd: dir });

        expect(process.env.DATABASE_OWNER_URL).toBeUndefined();
        expect(process.env.SPFN_ENVTEST_SRV).toBe('2');
        expect(result.loadedKeys).not.toContain('DATABASE_OWNER_URL');
        expect(logged).toEqual({ stdout: [], stderr: [] });
    });

    it('O1 at debug: one line names the file and not the value', async () =>
    {
        writeFileSync(join(dir, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\n`);

        (await loadEnvAtDebug())({ cwd: dir });

        expect(ownerLines([...logged.stdout, ...logged.stderr])).toEqual([expect.stringMatching(
            /DEBUG.*DATABASE_OWNER_URL is in \.env\.server; the server does not load it; spfn db commands that change the schema do\./)]);
        expect([...logged.stdout, ...logged.stderr].join('\n')).not.toContain(OWNER_PASSWORD);
    });

    it('O1 at debug a second load in the process loads it no more and says nothing more', async () =>
    {
        // Without this row the line repeats on every reload, or a reload brings the key back.
        writeFileSync(join(dir, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\n`);
        const loadEnvDebug = await loadEnvAtDebug();

        loadEnvDebug({ cwd: dir });
        loadEnvDebug({ cwd: dir, override: true });

        expect(process.env.DATABASE_OWNER_URL).toBeUndefined();
        expect(ownerLines([...logged.stdout, ...logged.stderr])).toHaveLength(1);
    });

    it('O1 at debug names the file whose value would have won', async () =>
    {
        writeFileSync(join(dir, '.env'), 'DATABASE_OWNER_URL=postgresql://a@localhost/x\n');
        writeFileSync(join(dir, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\n`);

        (await loadEnvAtDebug())({ cwd: dir });

        expect(ownerLines([...logged.stdout, ...logged.stderr])).toEqual([expect.stringContaining('is in .env.server;')]);
    });

    it('O2 with ownerCredentials: true the file\'s value is loaded, silently', () =>
    {
        // Without this row the schema commands lose the owner's URL kept in a file.
        writeFileSync(join(dir, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\n`);

        const result = loadEnv({ cwd: dir, ownerCredentials: true });

        expect(process.env.DATABASE_OWNER_URL).toBe(OWNER_URL);
        expect(result.loadedKeys).toContain('DATABASE_OWNER_URL');
        expect(ownerLines([...logged.stdout, ...logged.stderr])).toEqual([]);
    });

    it('O3 a value the process already holds is left as it is, with no line: that is not the file\'s doing', () =>
    {
        // Without this row an owner command's own later reload would announce
        // that the server does not load the key, in the middle of a schema command.
        process.env.DATABASE_OWNER_URL = 'postgresql://shell@localhost/x';
        writeFileSync(join(dir, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\n`);

        loadEnv({ cwd: dir });

        expect(process.env.DATABASE_OWNER_URL).toBe('postgresql://shell@localhost/x');
        expect(ownerLines([...logged.stdout, ...logged.stderr])).toEqual([]);
    });
});
