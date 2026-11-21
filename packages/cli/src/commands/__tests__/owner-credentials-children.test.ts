/**
 * `spfn dev`, `spfn start` and `spfn provision` hand no child the owner's
 * credentials in the environment it inherits — row A3 of #405
 *
 * The app connects as the app role only; a child that inherited
 * DATABASE_OWNER_URL would hold credentials row-level security does not apply
 * to, and nothing would say so. Each command runs in a scratch app with every
 * child recorded instead of spawned, with the environment execa would hand it
 * (the command's `env` over the CLI's own, unless `extendEnv: false`). The
 * owner URL comes from the shell, which these commands drop at their entry;
 * from `.env.server`, which the pre-start migration check's `loadEnv()` leaves
 * out (its database is a dead port, so the check reports it could not read and
 * the boot goes on); or from a keychain reference in `.env.server`, which
 * `spfn dev` and `spfn provision` resolve for their children (`spfn start`
 * resolves none).
 *
 * Each command is an app command, so the CLI process itself drops an inherited
 * owner URL at its entry: the pre-start check of `spfn dev`/`start` runs, and
 * every child is spawned, from a process that does not hold it (Codex's probe
 * on #421: the check ran with the shell's owner URL in `process.env`).
 *
 * These rows guard the inherited environment only. A child that loads `.env`
 * files itself does not load the variable from them either (core's loader),
 * and the server entries remove an inherited one (core,
 * server/__tests__/owner-credentials.test.ts).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recorded = vi.hoisted(() => ({
    children: [] as { command: string; args: string[]; env: NodeJS.ProcessEnv; parentHeld: boolean }[],
    /** Whether `process.env` held the owner URL when each pre-start check ran */
    checks: [] as boolean[],
    /** What a `secret:keychain:` reference in `.env.server` resolves to */
    keychain: {} as Record<string, string>,
    /** The stand-in server's pending ready-file write, cancelled at teardown */
    readyWrite: undefined as ReturnType<typeof setTimeout> | undefined,
}));

vi.mock('execa', () => ({
    execa: vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv; extendEnv?: boolean; cwd?: string } = {}) =>
    {
        recorded.children.push({
            command,
            args,
            env: options.extendEnv === false ? { ...options.env } : { ...process.env, ...options.env },
            parentHeld: 'DATABASE_OWNER_URL' in process.env,
        });

        // `spfn dev` starts Next.js once its server entry wrote the ready
        // file (not `spfn start`'s prod-server.mjs, which no row waits for)
        if (args.some((arg) => basename(arg) === 'server.mjs') && options.cwd)
        {
            const readyFile = join(options.cwd, '.spfn', 'server-ready');

            recorded.readyWrite = setTimeout(() => writeFileSync(readyFile, '8790'), 50);
        }

        return Object.assign(Promise.resolve({ exitCode: 0 }), { kill: vi.fn() });
    }),
}));

// The real pre-start check (a dead port: it reports it could not read), with
// what this process held when it ran
vi.mock('../../utils/migration-status.js', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../../utils/migration-status.js')>();

    return {
        ...actual,
        checkPendingMigrationsBeforeStart: vi.fn((...args: Parameters<typeof actual.checkPendingMigrationsBeforeStart>) =>
        {
            recorded.checks.push('DATABASE_OWNER_URL' in process.env);

            return actual.checkPendingMigrationsBeforeStart(...args);
        }),
    };
});

vi.mock('../../utils/secret-store/index.js', () => ({
    resolveKeychainEnv: vi.fn(async () => ({ env: { ...recorded.keychain }, missing: [] })),
}));

// `spfn provision` runs its runner under the app's tsx; the scratch app has none
vi.mock('../../utils/tsx-required.js', () => ({ missingTsx: () => undefined }));

const { devCommand } = await import('../dev.js');
const { provisionCommand } = await import('../provision.js');
const { startCommand } = await import('../start.js');

const OWNER_PASSWORD = 'owner-secret-pw';
const OWNER_URL = `postgresql://app_owner:${OWNER_PASSWORD}@127.0.0.1:1/notes`;
const APP_URL = 'postgresql://app_user:app-pw@127.0.0.1:1/notes';

const SCENARIOS = [
    { name: 'exported in the shell', source: 'shell' },
    { name: 'in .env.server', source: 'file' },
    { name: 'a keychain reference in .env.server', source: 'keychain' },
] as const;

type OwnerUrlSource = typeof SCENARIOS[number]['source'];

describe('the environment spfn dev and spfn start hand their children lacks the owner\'s credentials', () =>
{
    const environmentBefore = { ...process.env };
    const previousCwd = process.cwd();
    let app: string;
    let printed: string[];

    beforeEach(() =>
    {
        app = mkdtempSync(join(tmpdir(), 'spfn-owner-children-'));
        recorded.children.splice(0);
        recorded.checks.splice(0);
        recorded.keychain = {};
        printed = [];
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        delete process.env.NODE_ENV;

        for (const method of ['log', 'error', 'warn', 'info'] as const)
        {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        }
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (printed.push(String(chunk)), true));
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        vi.restoreAllMocks();
        vi.useRealTimers();
        Object.keys(process.env).filter((key) => !(key in environmentBefore)).forEach((key) => delete process.env[key]);
        Object.assign(process.env, environmentBefore);
        clearTimeout(recorded.readyWrite);
        rmSync(app, { recursive: true, force: true });
    });

    /** A Next.js app with an SPFN server, built for `spfn start`; the owner URL from `source`. */
    function writeApp(source: OwnerUrlSource): void
    {
        writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'notes', dependencies: { next: '15.0.0' } }));
        mkdirSync(join(app, 'src', 'server'), { recursive: true });
        mkdirSync(join(app, '.spfn', 'server'), { recursive: true });
        mkdirSync(join(app, '.next'), { recursive: true });
        writeFileSync(join(app, '.spfn', 'prod-server.mjs'), '');

        if (source === 'shell')
        {
            process.env.DATABASE_URL = APP_URL;
            process.env.DATABASE_OWNER_URL = OWNER_URL;
        }
        else if (source === 'file')
        {
            writeFileSync(join(app, '.env.server'), `DATABASE_URL=${APP_URL}\nDATABASE_OWNER_URL=${OWNER_URL}\n`);
        }
        else
        {
            writeFileSync(join(app, '.env.server'), `DATABASE_URL=${APP_URL}\nDATABASE_OWNER_URL=secret:keychain:owner\n`);
            recorded.keychain = { DATABASE_OWNER_URL: OWNER_URL };
        }

        process.chdir(app);
    }

    /** The children that carry the owner's credentials under any name, by command line. */
    function childrenHoldingOwner(): string[]
    {
        return recorded.children
            .filter(({ env }) => 'DATABASE_OWNER_URL' in env || Object.values(env).some((value) => value?.includes(OWNER_PASSWORD)))
            .map(({ command, args }) => [command, ...args].join(' '));
    }

    it.each(SCENARIOS)('A3 spfn dev, owner URL $name: the pre-start check runs without it, and the server, Next.js and the codegen watcher do not inherit it', async ({ source }) =>
    {
        writeApp(source);
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        // Never settles: spfn dev keeps running until a signal
        void devCommand.parseAsync(['--no-agent-files'], { from: 'user' });

        await vi.waitFor(() => expect(recorded.children.map(({ args }) => args.join(' '))).toContainEqual(expect.stringContaining('spfn:next')), { timeout: 10_000 });

        expect(recorded.children.map(({ args }) => args.find((arg) => arg.startsWith(join(app, '.spfn'))) ?? args.join(' ')))
            .toEqual([join(app, '.spfn', 'watcher.mjs'), join(app, '.spfn', 'server.mjs'), expect.stringContaining('spfn:next')]);
        expect(childrenHoldingOwner()).toEqual([]);
        expect(recorded.checks).toEqual([false]);
        expect(recorded.children.filter(({ parentHeld }) => parentHeld)).toEqual([]);
        expect(printed.filter((line) => line.includes(OWNER_PASSWORD))).toEqual([]);
    });

    it.each(SCENARIOS)('A3 spfn start, owner URL $name: the pre-start check runs without it, and no child of --server-only, --next-only or both inherits it', async ({ source }) =>
    {
        writeApp(source);

        for (const flags of [['--server-only'], ['--next-only'], []])
        {
            // commander keeps a parsed option on the command for the next parse
            startCommand.setOptionValue('serverOnly', undefined).setOptionValue('nextOnly', undefined);
            await startCommand.parseAsync(flags, { from: 'user' });
        }

        expect(recorded.children.map(({ command, args }) => [command, ...args].join(' '))).toEqual([
            `node ${join(app, '.spfn', 'prod-server.mjs')}`,
            expect.stringMatching(/^npx next start /),
            expect.stringMatching(/ concurrently /),
        ]);
        expect(childrenHoldingOwner()).toEqual([]);
        expect(recorded.checks).toEqual([false, false]);
        expect(recorded.children.filter(({ parentHeld }) => parentHeld)).toEqual([]);
        expect(printed.filter((line) => line.includes(OWNER_PASSWORD))).toEqual([]);
    });

    it.each(SCENARIOS)('A3 spfn provision, owner URL $name: not inherited by the runner, whose hooks run as the app', async ({ source }) =>
    {
        // Without this row the runner loads server.config with the owner's URL
        // in its environment, before core's provisioning could remove it.
        writeApp(source);

        await provisionCommand.parseAsync([], { from: 'user' });

        expect(recorded.children.map(({ args }) => args.find((arg) => arg.endsWith('provision.mjs')))).toEqual([join(app, '.spfn', 'provision.mjs')]);
        expect(childrenHoldingOwner()).toEqual([]);
        expect(recorded.children.filter(({ parentHeld }) => parentHeld)).toEqual([]);
    });
});
