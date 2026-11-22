/**
 * The owner connection — rows O1, O2 and O5 of the #158 part 2 design case
 * table, and A1 of #405
 *
 * `db migrate`, `backup`, `restore`, `drop`, `db push` (its dry run and the
 * function package migrations it applies included) and `spfn add` connect as
 * the table owner, DATABASE_OWNER_URL, falling back to DATABASE_URL.
 * Everything that would open a connection or a child process is replaced by a
 * recorder, so each test reads which URL a command reached for, and what it
 * printed. The `.env` files load for real (core's loader): the owner commands
 * load DATABASE_OWNER_URL from one, and every other command leaves it out and
 * drops an inherited one at its entry (A6).
 */

import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const recorded = vi.hoisted(() => ({
    postgres: [] as string[],
    spawned: [] as { command: string; args: string[]; password: string | undefined }[],
    functionMigrations: [] as (string | undefined)[],
    drizzleCommands: [] as (string | undefined)[],
    migrationInfo: [] as string[],
    pushConnections: [] as [string, boolean][],
    /** Whether `process.env` held the owner URL when each postgres connection opened */
    ownerHeldAtConnect: [] as boolean[],
    /** The URL each privileges step on a connection of its own (migrate, add, grant) was handed */
    grantSteps: [] as string[],
}));

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));
vi.mock('postgres', () => ({
    default: vi.fn((url: string) =>
    {
        recorded.postgres.push(url);
        recorded.ownerHeldAtConnect.push('DATABASE_OWNER_URL' in process.env);

        return { end: vi.fn(async () => undefined) };
    }),
}));
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

/** The privileges step has rows of its own (app-grants.integration.test.ts): here only the URL it is handed. */
vi.mock('../utils/app-grants.js', () => ({
    entityGrantTarget: (schemas: string[]) => ({ schemas, tables: [], defaults: [] }),
    manifestGrantTargetOrExit: () => ({ schemas: [], tables: [], defaults: [] }),
    projectGrantTargetOrExit: async () => ({ target: { schemas: [], tables: [], defaults: [] }, source: 'entities' }),
    runAppGrantStep: vi.fn(async () => undefined),
    runAppGrantStepOn: vi.fn(async (url: string) => void recorded.grantSteps.push(url)),
    exitOnGrantFailure: vi.fn(),
    grantRetryNote: () => undefined,
    SCHEMA_APPLIED_PRIVILEGES_UNCHANGED: 'Schema applied; no privilege was changed',
}));

vi.mock('../utils/backup-files.js', () => ({ ensureBackupDir: vi.fn(async () => 'backups'), listBackupFiles: vi.fn(async () => []) }));

vi.mock('../utils/metadata.js', () => ({
    collectGitInfo: vi.fn(async () => undefined),
    collectMigrationInfo: vi.fn(async (url: string) => (recorded.migrationInfo.push(url), undefined)),
    saveBackupMetadata: vi.fn(async () => undefined),
    loadBackupMetadata: vi.fn(async () => undefined),
}));

vi.mock('../utils/drizzle.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../utils/drizzle.js')>(),
    runWithSpinner: vi.fn(async (_text: string, _command: string, _ok: string, _fail: string, url?: string) =>
        void recorded.drizzleCommands.push(url)),
    resolvePushSchemaSource: vi.fn(async () => ({ schema: './notes.entity.ts', label: 'notes.entity.ts' })),
    resolveProjectSchemaFiles: vi.fn(async () => ({ files: ['notes.entity.ts'], source: 'notes.entity.ts', imports: {} })),
    createPushConnection: vi.fn(async (url: string, options?: { readOnly?: boolean }) =>
    {
        recorded.pushConnections.push([url, options?.readOnly === true]);

        return {
            db: { transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ execute: async () => undefined }) },
            query: async () => [],
            close: async () => undefined,
            transactionReadOnly: 'on',
        };
    }),
}));

/** One project statement to apply, and no pending package migration to list. */
vi.mock('drizzle-kit/api-postgres', () => ({ pushSchema: vi.fn(async () => ({ sqlStatements: ['CREATE TABLE "notes" ("id" integer)'], hints: [] })) }));
vi.mock('../utils/unchanged-checks.js', () => ({ declaredChecks: vi.fn(async () => []), unchangedChecks: vi.fn(async () => []) }));
vi.mock('@spfn/core/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@spfn/core/db')>(),
    pendingFunctionMigrations: vi.fn(async () => []),
}));

const { dbMigrate } = await import('../migrate');
const { dbBackup } = await import('../backup');
const { dbRestore } = await import('../restore');
const { dbDrop } = await import('../drop');
const { dbPush } = await import('../push');
const { dbGrant } = await import('../grant');
const { dbStatus, DB_STATUS_JSON_MARKER } = await import('../status');
const { readReport } = await import('../../../kit/local/database.js');
const { resetEnvLoadState } = await import('@spfn/core/env/loader');
const { addCommand } = await import('../../add');
const { COMMAND_CONNECTIONS, enterCommand, loadEnvFor } = await import('../../../utils/database-connection.js');

const APP_URL = 'postgresql://app_user:app-secret-pw@localhost:5432/notes';
const OWNER_URL = 'postgresql://app_owner:owner-secret-pw@localhost:5432/notes';

/**
 * Run all four commands, each with the arguments it needs to reach a
 * connection, calling `before` ahead of each.
 */
async function runAllCommands(before: () => void = () => undefined): Promise<void>
{
    for (const run of [
        dbMigrate,
        () => dbBackup({ format: 'custom', output: 'notes.dump' }),
        () => dbRestore('notes.dump'),
        dbDrop,
    ])
    {
        before();
        await run();
    }
}

/**
 * `db push`, `db push --dry-run`, then `spfn add @spfn/fixture`, calling
 * `before` ahead of each, in an app (the working directory) where the package
 * is already installed and ships migrations.
 */
async function runSchemaCommands(before: () => void = () => undefined): Promise<void>
{
    const packageRoot = join(process.cwd(), 'node_modules', '@spfn', 'fixture');

    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@spfn/fixture', spfn: { migrations: { dir: './migrations' } } }));

    for (const run of [
        () => dbPush({ force: true }),
        () => dbPush({ dryRun: true }),
        () => addCommand.parseAsync(['@spfn/fixture'], { from: 'user' }),
        () => dbGrant(),
    ])
    {
        before();
        await run();
    }
}

/** Run `commands` in a scratch app whose `.env.server` holds `envServer`. */
async function inApp(envServer: string, commands: () => Promise<unknown>): Promise<void>
{
    const app = mkdtempSync(join(tmpdir(), 'spfn-owner-url-'));
    const previousCwd = process.cwd();

    writeFileSync(join(app, '.env.server'), envServer);
    process.chdir(app);

    try
    {
        await commands();
    }
    finally
    {
        process.chdir(previousCwd);
        rmSync(app, { recursive: true, force: true });
    }
}

function userOf(args: string[]): string
{
    return args[args.indexOf('-U') + 1];
}

describe('owner connection for the schema commands, db backup, restore and drop', () =>
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
        expect(recorded.grantSteps).toEqual([OWNER_URL]);
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

    it('A1 with DATABASE_OWNER_URL set, db push, its dry run, the package migrations push applies and spfn add connect with it', async () =>
    {
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await inApp('', runSchemaCommands);

        expect(recorded.pushConnections).toEqual([[OWNER_URL, false], [OWNER_URL, true]]);
        expect(recorded.functionMigrations).toEqual([OWNER_URL, OWNER_URL]);
        expect(recorded.grantSteps).toEqual([OWNER_URL, OWNER_URL]);
        expect(printed.filter((line) => line.includes('owner-secret-pw'))).toEqual([]);
    });

    it('A1 without DATABASE_OWNER_URL, the same commands connect with DATABASE_URL as before', async () =>
    {
        await inApp('', runSchemaCommands);

        expect(recorded.pushConnections).toEqual([[APP_URL, false], [APP_URL, true]]);
        expect(recorded.functionMigrations).toEqual([APP_URL, APP_URL]);
    });

    it('A1 with DATABASE_OWNER_URL alone (no DATABASE_URL), db push builds its config and connects with it', async () =>
    {
        delete process.env.DATABASE_URL;
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await dbPush({ force: true });

        expect(recorded.pushConnections).toEqual([[OWNER_URL, false]]);
        expect(recorded.functionMigrations).toEqual([OWNER_URL]);
    });

    it('A6 DATABASE_OWNER_URL only in .env.server: every owner command loads it from the file and connects with it', async () =>
    {
        // Without this row an owner command that loads the files as the server
        // does runs as the app role from a file setup, and only a 42501 says so.
        // Each command loads the file itself: none inherits an earlier one's load.
        const forget = () => void delete process.env.DATABASE_OWNER_URL;

        await inApp(`DATABASE_OWNER_URL=${OWNER_URL}\n`, async () =>
        {
            await runAllCommands(forget);
            await runSchemaCommands(forget);
        });

        expect(recorded.postgres).toEqual([OWNER_URL]);
        expect(recorded.spawned.map((child) => userOf(child.args))).toEqual(['app_owner', 'app_owner']);
        expect(recorded.drizzleCommands).toEqual([OWNER_URL]);
        expect(recorded.pushConnections).toEqual([[OWNER_URL, false], [OWNER_URL, true]]);
        expect(recorded.functionMigrations).toEqual([OWNER_URL, OWNER_URL, OWNER_URL]);
    });

    it('A6 DATABASE_OWNER_URL only in .env.server: db status, an app command, runs without it in its environment', async () =>
    {
        // Without this row an app command could hold the owner's URL from a
        // file, and any code it loads could read it.
        await inApp(`DATABASE_OWNER_URL=${OWNER_URL}\n`, () => dbStatus({ json: true }));

        expect(recorded.postgres).toEqual([APP_URL]);
        expect(process.env.DATABASE_OWNER_URL).toBeUndefined();
    });

    it('J1 DATABASE_OWNER_URL in .env.server, the documented setup: db status --json writes its one line to stdout, and nothing about the owner\'s URL', async () =>
    {
        // Without this row a loader's line lands on stdout before the report,
        // and a reader that parses stdout (spfn kit install) fails. The loader's
        // notice is at debug, below the default level: a correct configuration
        // prints nothing about it.
        const stdout: string[] = [];
        const stderr: string[] = [];
        const into = (lines: string[]) => (...args: unknown[]) => void lines.push(args.map(String).join(' '));

        vi.spyOn(console, 'log').mockImplementation(into(stdout));
        vi.spyOn(console, 'info').mockImplementation(into(stdout));
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
        vi.spyOn(console, 'error').mockImplementation(into(stderr));
        vi.spyOn(console, 'warn').mockImplementation(into(stderr));
        resetEnvLoadState();

        await inApp(`DATABASE_OWNER_URL=${OWNER_URL}\n`, () => dbStatus({ json: true }));

        // What spfn kit install reads, then the one line it should be
        expect(readReport({ exitCode: 0, stdout: stdout.join('\n'), stderr: '', missing: false })).toMatchObject({ schemaVersion: 1, configured: true });
        expect(stdout).toHaveLength(1);
        expect(stdout[0].startsWith(DB_STATUS_JSON_MARKER)).toBe(true);
        expect(JSON.parse(stdout[0].slice(DB_STATUS_JSON_MARKER.length))).toMatchObject({ schemaVersion: 1, configured: true });
        expect([...stdout, ...stderr].filter((line) => line.includes('DATABASE_OWNER_URL'))).toEqual([]);
        expect([...stdout, ...stderr].join('\n')).not.toContain('owner-secret-pw');
    });

    it('A6 DATABASE_OWNER_URL exported in the shell: db status drops it before it connects, and says nothing about it', async () =>
    {
        // Without this row an app command run from a shell that exports the
        // owner's URL holds it for its whole run, its connection included.
        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await inApp('', () => dbStatus({ json: true }));

        expect(recorded.postgres).toEqual([APP_URL]);
        expect(recorded.ownerHeldAtConnect).toEqual([false]);
        expect(process.env.DATABASE_OWNER_URL).toBeUndefined();
        expect(printed.filter((line) => line.includes('DATABASE_OWNER_URL'))).toEqual([]);
    });

    it('A6 each command of the connection table holds DATABASE_OWNER_URL, from a file or inherited, exactly when its connection is owner', async () =>
    {
        // Without this row a command added to the table, or moved between
        // connections, could load the owner's URL it must not hold, or miss it.
        const holds: Record<string, boolean> = {};
        const keepsInherited: Record<string, boolean> = {};

        await inApp(`DATABASE_OWNER_URL=${OWNER_URL}\n`, async () =>
        {
            for (const command of Object.keys(COMMAND_CONNECTIONS) as (keyof typeof COMMAND_CONNECTIONS)[])
            {
                loadEnvFor(command);
                holds[command] = process.env.DATABASE_OWNER_URL === OWNER_URL;
                process.env.DATABASE_OWNER_URL = OWNER_URL;
                enterCommand(command);
                keepsInherited[command] = process.env.DATABASE_OWNER_URL === OWNER_URL;
                delete process.env.DATABASE_OWNER_URL;
            }
        });

        const ownerCommands = Object.fromEntries(Object.entries(COMMAND_CONNECTIONS)
            .map(([command, { connection }]) => [command, connection === 'owner']));

        expect(holds).toEqual(ownerCommands);
        expect(keepsInherited).toEqual(ownerCommands);
        expect(Object.values(holds).filter(Boolean)).toHaveLength(8);
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
