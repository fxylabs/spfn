/**
 * The server process never holds DATABASE_OWNER_URL (#405)
 *
 * The owner's URL reaches a process two ways. From a `.env` file: `loadEnv()`
 * leaves it out unless a schema command asks, so no server entry, custom entry
 * or later reload loads it, and the loader says so once, at debug, naming the
 * file. From the environment the process was started with: every server entry
 * that runs app code as the app — `startServer`, `createServer`, the serverless
 * app, `provisionInfrastructure` — removes it first, with one warning about
 * that environment. Each start below stops early (a required app variable is
 * unset, or a hook throws), after the point where the variable must be gone and
 * before anything connects.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@spfn/core/config';
import { createEnvRegistry, defineEnvSchema, envString } from '../../env';
import { loadEnv, resetEnvLoadState } from '../../env/loader';
import { serverLogger } from '../logger';
import { createServer } from '../create-server';
import { createServerlessApp, provisionInfrastructure, resetServerlessApp } from '../serverless';
import { startServer } from '../start-server';

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(),
}));

const OWNER_PASSWORD = 'owner-pw-that-must-never-reach-a-log';
const OWNER_URL = `postgresql://app_owner:${OWNER_PASSWORD}@localhost:5432/notes`;

/** A required variable left unset, so each start stops at the environment check. */
const appRegistry = createEnvRegistry(defineEnvSchema({
    I405_REQUIRED: envString({ description: 'Unset on purpose', required: true }),
}));

let app: string;
let previousCwd: string;
let loaderLines: string[];

/** The warnings that name the variable. */
function ownerWarnings(): string[]
{
    return vi.mocked(serverLogger.warn).mock.calls.map(call => String(call[0])).filter(line => line.includes('DATABASE_OWNER_URL'));
}

/** The lines on stderr (console.error) that name the variable. */
function ownerInfo(): string[]
{
    return loaderLines.filter(line => line.includes('DATABASE_OWNER_URL'));
}

function everythingLogged(): string
{
    return [...vi.mocked(serverLogger.warn).mock.calls, ...vi.mocked(serverLogger.error).mock.calls]
        .map(call => call.map(arg => String(arg)).join(' ')).concat(loaderLines).join('\n');
}

function ownerUrlInFile(): void
{
    writeFileSync(join(app, '.env.server'), `DATABASE_OWNER_URL=${OWNER_URL}\n`);
}

function ownerUrlInherited(): void
{
    vi.stubEnv('DATABASE_OWNER_URL', OWNER_URL);
}

function startStops(): Promise<void>
{
    return expect(startServer({ env: { registries: [appRegistry] } })).rejects.toThrow('process.exit(1)');
}

/** Run provisioning with a hook that records what it sees and stops there. */
async function ownerUrlSeenByProvisionHook(): Promise<string | undefined>
{
    let seen: string | undefined = 'hook never ran';

    await expect(provisionInfrastructure({
        lifecycle: {
            beforeInfrastructure: async () =>
            {
                seen = process.env.DATABASE_OWNER_URL;
                throw new Error('stop before the database');
            },
        },
    })).rejects.toThrow('stop before the database');

    return seen;
}

beforeEach(() =>
{
    app = mkdtempSync(join(tmpdir(), 'spfn-owner-credentials-'));
    previousCwd = process.cwd();
    process.chdir(app);
    resetEnvLoadState();
    loaderLines = [];

    vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
    vi.stubEnv('I405_REQUIRED', '');
    vi.stubEnv('DATABASE_OWNER_URL', undefined);
    vi.spyOn(serverLogger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(serverLogger, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void loaderLines.push(args.map(String).join(' ')));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
    {
        throw new Error(`process.exit(${code})`);
    }) as never);
});

afterEach(() =>
{
    process.chdir(previousCwd);
    rmSync(app, { recursive: true, force: true });
    resetServerlessApp();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('a .env file: no server entry loads DATABASE_OWNER_URL', () =>
{
    it('A5 startServer with it in .env.server: never in process.env or core\'s env; nothing printed at the default level, no warning about the environment', async () =>
    {
        // Without this row the server reads the owner's URL back from the file it was kept in.
        ownerUrlInFile();

        await startStops();

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
        expect(env.DATABASE_OWNER_URL).toBeUndefined();
        expect(ownerWarnings()).toEqual([]);
        // The loader's line is at debug (env/__tests__/loader.test.ts, O1): a
        // correct configuration boots without one.
        expect(ownerInfo()).toEqual([]);
        expect(everythingLogged()).not.toContain(OWNER_PASSWORD);
    });

    it('A5 the custom-entry order, loadEnv() then startServer: no warning blames the shell', async () =>
    {
        // Without this row the documented entry gets a warning about an
        // inherited environment for a value that came from a file.
        ownerUrlInFile();

        loadEnv();
        await startStops();

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
        expect(ownerWarnings()).toEqual([]);
        expect(ownerInfo()).toEqual([]);
    });

    it('A5 a public loadEnv() after the start does not bring it back', async () =>
    {
        // Without this row any app code that reloads the environment holds the owner's URL.
        ownerUrlInFile();

        await startStops();
        loadEnv();

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
    });

    it('A5 a direct createServer after a custom entry\'s loadEnv(): not in process.env', async () =>
    {
        // Without this row an app that builds its own server holds the owner's URL from the file.
        ownerUrlInFile();

        loadEnv();
        await createServer({}).catch(() => undefined);

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
    });

    it('A5 provisionInfrastructure: its hook, app code run as the app, does not see it', async () =>
    {
        // Without this row deploy-time hooks (seeding, RBAC) hold the owner's URL.
        ownerUrlInFile();

        expect(await ownerUrlSeenByProvisionHook()).toBeUndefined();
    });

    it('A5 the serverless app with it in .env.server: not in process.env, no warning', async () =>
    {
        ownerUrlInFile();

        await expect(createServerlessApp({ env: { registries: [appRegistry] } })).rejects.toThrow('Environment validation failed');

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
        expect(ownerWarnings()).toEqual([]);
    });
});

describe('an inherited environment: every server entry removes DATABASE_OWNER_URL first', () =>
{
    it('A7 startServer: removed, one warning about the environment it was started with, naming no file', async () =>
    {
        // Without this row a shell export or a container's env hands the server the owner's URL.
        ownerUrlInherited();

        await startStops();

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
        expect(ownerWarnings()).toEqual([expect.stringContaining('was in the environment the server was started with')]);
        expect(ownerWarnings()[0]).not.toContain('.env');
        expect(everythingLogged()).not.toContain(OWNER_PASSWORD);
    });

    it('A7 a direct createServer: removed, one warning', async () =>
    {
        // Without this row an app that builds its own server keeps the inherited owner's URL.
        ownerUrlInherited();

        await createServer({}).catch(() => undefined);

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
        expect(ownerWarnings()).toHaveLength(1);
    });

    it('A7 provisionInfrastructure: removed before its hook runs, one warning', async () =>
    {
        // Without this row `spfn provision` started from a shell holding it runs the hooks with it.
        ownerUrlInherited();

        expect(await ownerUrlSeenByProvisionHook()).toBeUndefined();
        expect(ownerWarnings()).toHaveLength(1);
    });

    it('A7 the serverless app: removed, one warning', async () =>
    {
        ownerUrlInherited();

        await expect(createServerlessApp({ env: { registries: [appRegistry] } })).rejects.toThrow('Environment validation failed');

        expect('DATABASE_OWNER_URL' in process.env).toBe(false);
        expect(ownerWarnings()).toHaveLength(1);
    });

    it('A7 without it anywhere: no warning, no line', async () =>
    {
        await startStops();

        expect(ownerWarnings()).toEqual([]);
        expect(ownerInfo()).toEqual([]);
    });
});
