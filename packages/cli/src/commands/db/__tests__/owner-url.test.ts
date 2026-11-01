/**
 * The owner connection — rows O1, O2 and O5 of the #158 part 2 design case table
 *
 * `db migrate`, `backup`, `restore` and `drop` connect as the table owner,
 * DATABASE_OWNER_URL, falling back to DATABASE_URL. Everything that would open
 * a connection or a child process is replaced by a recorder, so each test reads
 * which URL a command reached for, and what it printed.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const recorded = vi.hoisted(() => ({
    postgres: [] as string[],
    spawned: [] as { command: string; args: string[]; password: string | undefined }[],
    functionMigrations: [] as (string | undefined)[],
    drizzleCommands: [] as (string | undefined)[],
    migrationInfo: [] as string[],
}));

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));
vi.mock('postgres', () => ({ default: vi.fn((url: string) => (recorded.postgres.push(url), { end: vi.fn(async () => undefined) })) }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: vi.fn(async () => undefined) }));
vi.mock('prompts', () => ({ default: vi.fn(async () => ({ confirm: true })) }));
vi.mock('ora', () => ({ default: () => ({ start: () => ({ stop: vi.fn(), succeed: vi.fn(), fail: vi.fn(), start: vi.fn(), text: '' }) }) }));

vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('child_process')>(),
    spawn: vi.fn((command: string, args: string[], options: { env: Record<string, string | undefined> }) =>
    {
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });

        recorded.spawned.push({ command, args, password: options.env.PGPASSWORD });
        setImmediate(() => child.emit('close', 0));

        return child;
    }),
}));

vi.mock('fs', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('fs')>();

    return {
        ...actual,
        existsSync: (path: string) => String(path).endsWith('src/server/drizzle') || actual.existsSync(path),
        promises: { ...actual.promises, stat: vi.fn(async () => ({ size: 1 })) },
    };
});

vi.mock('../../../utils/function-migrations.js', () => ({
    discoverFunctionMigrations: () => [{ packageName: '@spfn/fixture' }],
    loadFunctionMigrationPlans: (functions: unknown) => functions,
    executeFunctionMigrations: vi.fn(async (_plans: unknown, url?: string) => (recorded.functionMigrations.push(url), 0)),
}));

vi.mock('../utils/backup-files.js', () => ({ ensureBackupDir: vi.fn(async () => 'backups'), listBackupFiles: vi.fn(async () => []) }));

vi.mock('../utils/metadata.js', () => ({
    collectGitInfo: vi.fn(async () => undefined),
    collectMigrationInfo: vi.fn(async (url: string) => (recorded.migrationInfo.push(url), undefined)),
    saveBackupMetadata: vi.fn(async () => undefined),
    loadBackupMetadata: vi.fn(async () => undefined),
}));

vi.mock('../utils/drizzle.js', () => ({
    runWithSpinner: vi.fn(async (_text: string, _command: string, _ok: string, _fail: string, url?: string) =>
        void recorded.drizzleCommands.push(url)),
}));

const { dbMigrate } = await import('../migrate');
const { dbBackup } = await import('../backup');
const { dbRestore } = await import('../restore');
const { dbDrop } = await import('../drop');

const APP_URL = 'postgresql://app_user:app-secret-pw@localhost:5432/notes';
const OWNER_URL = 'postgresql://app_owner:owner-secret-pw@localhost:5432/notes';

/** Run all four commands, each with the arguments it needs to reach a connection. */
async function runAllCommands(): Promise<void>
{
    await dbMigrate();
    await dbBackup({ format: 'custom', output: 'notes.dump' });
    await dbRestore('notes.dump');
    await dbDrop();
}

function userOf(args: string[]): string
{
    return args[args.indexOf('-U') + 1];
}

describe('owner connection for db migrate, backup, restore and drop', () =>
{
    let printed: string[];

    beforeEach(() =>
    {
        printed = [];
        Object.values(recorded).forEach((list) => list.splice(0));
        process.env.DATABASE_URL = APP_URL;

        for (const method of ['log', 'error', 'warn', 'info'] as const)
        {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')));
        }
    });

    afterEach(() =>
    {
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        vi.restoreAllMocks();
    });

    it('O1 with DATABASE_OWNER_URL set, all four commands connect with it', async () =>
    {
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await runAllCommands();

        expect(recorded.functionMigrations).toEqual([OWNER_URL]);
        expect(recorded.postgres).toEqual([OWNER_URL]);
        expect(recorded.spawned.map((child) => [child.command, userOf(child.args), child.password])).toEqual([
            ['pg_dump', 'app_owner', 'owner-secret-pw'],
            ['pg_restore', 'app_owner', 'owner-secret-pw'],
        ]);
        expect(recorded.migrationInfo).toEqual([OWNER_URL]);
        expect(recorded.drizzleCommands).toEqual([OWNER_URL]);
    });

    it('O2 without DATABASE_OWNER_URL, all four commands connect with DATABASE_URL as before', async () =>
    {
        await runAllCommands();

        expect(recorded.functionMigrations).toEqual([APP_URL]);
        expect(recorded.postgres).toEqual([APP_URL]);
        expect(recorded.spawned.map((child) => [child.command, userOf(child.args), child.password])).toEqual([
            ['pg_dump', 'app_user', 'app-secret-pw'],
            ['pg_restore', 'app_user', 'app-secret-pw'],
        ]);
        expect(recorded.drizzleCommands).toEqual([APP_URL]);
    });

    it('O5 no command prints the owner URL or its password', async () =>
    {
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await runAllCommands();

        expect(printed.length).toBeGreaterThan(0);
        expect(printed.filter((line) => line.includes('owner-secret-pw') || line.includes(OWNER_URL))).toEqual([]);
    });

    it('O5 with neither URL set, the message names the variables, not a value', async () =>
    {
        delete process.env.DATABASE_URL;

        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);

        await expect(dbBackup({})).rejects.toThrow('exit 1');
        expect(printed.join('\n')).toContain('Neither DATABASE_OWNER_URL nor DATABASE_URL is set');
        expect(exit).toHaveBeenCalledWith(1);
    });
});
