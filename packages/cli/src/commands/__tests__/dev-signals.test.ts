/**
 * `spfn dev`'s supervision model (#358), with real processes: the real bin
 * (`bin/spfn.js`, which re-runs itself under tsx and the dev hook) runs `spfn
 * dev` in a fixture app whose `@spfn/core` is a stand-in. Its server, its
 * codegen watcher and the app's `spfn:next` script (run through `pnpm run`, as
 * `spfn dev` runs it) each log every signal they get, their pgid, and their
 * exit, with the time, to one file.
 *
 * Stand-in timings: the watcher's close takes 0.5 s, the server's shutdown 1 s
 * and ignores later signals (as core's does), Next.js 2 s — so Next.js, behind
 * `pnpm run` and `sh -c`, which exit at once, is the last to exit.
 *
 * | #  | signal                                    | catches, which would otherwise pass silently                    |
 * |----|-------------------------------------------|-----------------------------------------------------------------|
 * | S1 | SIGTERM, then SIGINT, to the bin's pid    | a bin that dies alone (the tree runs on, orphaned); Next.js     |
 * |    | (a process manager, `kill <pid>`)         | behind its wrappers never signalled; `spfn dev` exiting before  |
 * |    |                                           | a child (an orphan holding the port); a group left non-empty    |
 * | S2 | SIGINT to the bin's process group (the    | a child in the terminal's group: it gets the terminal's signal  |
 * |    | terminal's Ctrl-C)                        | and `spfn dev`'s, and the watcher abandons its generation       |
 * | S3 | SIGINT, then SIGTERM, to the bin's pid    | a SIGTERM after a SIGINT taken for a second Ctrl-C: under `pnpm |
 * |    | (`pnpm exec spfn dev` relays a Ctrl-C as  | exec spfn dev` one Ctrl-C would SIGKILL the server mid-shutdown |
 * |    | both)                                     |                                                                 |
 * | S4 | SIGTERM, then SIGINT, every child held    | a second Ctrl-C that kills the wrapper only: Next.js behind     |
 * |    | past the row                              | `pnpm run`/`sh -c` survives it, holding its port                |
 *
 * No process outlives a row: each stand-in exits by itself 30 s after it
 * starts, and teardown SIGKILLs every process carrying the row's environment
 * tag (`helpers/process-tree.ts`). Waits time out and fail the row rather than
 * hang it. Build the CLI first (`pnpm --filter spfn build`): the bin runs
 * `dist/`. Needs `pnpm` and Linux (`/proc`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killTagged, newRowTag, ROW_TAG_VARIABLE } from './helpers/process-tree';

const bin = join(__dirname, '../../../bin/spfn.js');
const ROLES = ['server', 'watcher', 'next'] as const;

type Role = typeof ROLES[number];

interface Line
{
    at: number;
    role: Role;
    pid: number;
    pgid: number;
    event: string;
}

let appDir: string;
let rowTag: string;

function write(path: string, content: string): void
{
    mkdirSync(dirname(join(appDir, path)), { recursive: true });
    writeFileSync(join(appDir, path), content);
}

/** Logs every stop signal, the start and the exit; exits by itself `STUB_CAP_MS` after starting. */
const SIGNAL_LOG = `import { appendFileSync, readFileSync } from 'node:fs';
const pgid = () => Number(readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ')[2]);
export const log = (role, event) => appendFileSync(process.env.SPFN_SIGNAL_LOG, \`\${Date.now()} \${role} \${process.pid} \${pgid()} \${event}\\n\`);
export function stub(role)
{
    log(role, 'start');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => log(role, signal));
    process.on('exit', () => log(role, 'exit'));
    setTimeout(() => process.exit(99), 30_000).unref();
}
export const stopAfter = (ms) =>
{
    let stopping = false;
    return () =>
    {
        if (!stopping)
        {
            stopping = true;
            setTimeout(() => process.exit(0), ms);
        }
    };
};
`;

function writeApp(): void
{
    write('package.json', JSON.stringify({ name: 'dev-signals-fixture', private: true, dependencies: { next: '15.0.0' }, scripts: { 'spfn:next': 'node next-stand-in.mjs' } }));
    write('pnpm-lock.yaml', '');
    write('src/server/.keep', '');
    write('signal-log.mjs', SIGNAL_LOG);
    write('next-stand-in.mjs', 'import { stub, stopAfter } from \'./signal-log.mjs\';\nstub(\'next\');\n'
        + 'const stop = stopAfter(Number(process.env.NEXT_STOP_MS));\n'
        + 'process.on(\'SIGTERM\', stop);\nprocess.on(\'SIGINT\', stop);\nsetInterval(() => undefined, 1000);\n');
    write('node_modules/@spfn/core/package.json', JSON.stringify({ name: '@spfn/core', version: '0.0.0-stand-in', type: 'module',
        exports: { './config': './config.mjs', './server': './server.mjs', './codegen': './codegen.mjs' } }));
    write('node_modules/@spfn/core/config.mjs', 'export {};\n');
    write('node_modules/@spfn/core/server.mjs', 'import { stub, stopAfter } from \'../../../signal-log.mjs\';\n'
        + 'export async function startServer()\n{\n    stub(\'server\');\n'
        + '    const stop = stopAfter(Number(process.env.SERVER_STOP_MS));\n'
        + '    process.on(\'SIGTERM\', stop);\n    process.on(\'SIGINT\', stop);\n    setInterval(() => undefined, 1000);\n'
        + '    return { config: { port: Number(process.env.SPFN_PORT) } };\n}\n');
    // The watcher entry's own handlers stop it: close() resolves WATCHER_STOP_MS on.
    write('node_modules/@spfn/core/codegen.mjs', 'import { stub } from \'../../../signal-log.mjs\';\n'
        + 'export class CodegenOrchestrator\n{\n    static loadsGenerators = true;\n'
        + '    watch() { setInterval(() => undefined, 1000); return new Promise(() => undefined); }\n'
        + '    close() { return new Promise(settle => setTimeout(settle, Number(process.env.WATCHER_STOP_MS))); }\n}\n'
        + 'export const loadCodegenConfig = () => ({});\nexport const createGeneratorsFromConfig = () => [];\n'
        + 'export const markAppSourceProcess = () => stub(\'watcher\');\n');
}

function lines(): Line[]
{
    const file = join(appDir, 'signals.log');

    return existsSync(file)
        ? readFileSync(file, 'utf8').trim().split('\n').map((line) =>
        {
            const [at, role, pid, pgid, event] = line.split(' ');

            return { at: Number(at), role: role as Role, pid: Number(pid), pgid: Number(pgid), event };
        })
        : [];
}

/** Each stand-in's signals, in order. */
function signalsByRole(): Record<Role, string[]>
{
    const signals = lines().filter(line => line.event.startsWith('SIG'));

    return Object.fromEntries(ROLES.map(role => [role, signals.filter(line => line.role === role).map(line => line.event)])) as Record<Role, string[]>;
}

function freePort(): Promise<number>
{
    return new Promise((settle, fail) =>
    {
        const server = createServer().listen(0, '127.0.0.1', () =>
        {
            const { port } = server.address() as AddressInfo;

            server.close(() => settle(port));
        }).on('error', fail);
    });
}

interface Dev
{
    child: ChildProcess;
    output: () => string;

    /** The exit code, and when it exited. */
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

/** The bin, `spfn dev`, in a process group of its own, as a terminal or a process manager starts it. */
async function startDev(stopMs: { server: number; watcher: number; next: number }): Promise<Dev>
{
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        [ROW_TAG_VARIABLE]: rowTag,
        SPFN_SIGNAL_LOG: join(appDir, 'signals.log'),
        SPFN_PORT: String(await freePort()),
        NEXT_PORT: String(await freePort()),
        SERVER_STOP_MS: String(stopMs.server),
        WATCHER_STOP_MS: String(stopMs.watcher),
        NEXT_STOP_MS: String(stopMs.next),
    };

    for (const name of ['SPFN_APP_URL', 'SPFN_CODEGEN_PROCESS', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'DATABASE_URL', 'SPFN_CLI_RELAUNCHED_IN'])
    {
        delete env[name];
    }

    const child = spawn(process.execPath, [bin, 'dev', '--no-agent-files'], { cwd: appDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';

    child.stdout!.on('data', chunk => (output += chunk));
    child.stderr!.on('data', chunk => (output += chunk));

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(settle =>
        child.on('exit', (code, signal) => settle({ code, signal, at: Date.now() })));

    return { child, output: () => output.replace(/\x1b\[[0-9;]*m/g, ''), exited };
}

/** Resolves once `condition` holds; rejects 30 s on, or once the bin has exited without it. */
async function until(dev: Dev, what: string, condition: () => boolean): Promise<void>
{
    const deadline = Date.now() + 30_000;

    while (!condition())
    {
        if (Date.now() > deadline || dev.child.exitCode !== null || dev.child.signalCode !== null)
        {
            throw new Error(`${what} did not happen:\n${dev.output().slice(-3000)}\n${JSON.stringify(lines())}`);
        }

        await new Promise(settle => setTimeout(settle, 50));
    }
}

/** The bin's exit; rejects 20 s on rather than hang the row. */
async function exitOf(dev: Dev): Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>
{
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_settle, fail) =>
    {
        timer = setTimeout(() => fail(new Error(`spfn dev did not exit:\n${dev.output().slice(-3000)}\n${JSON.stringify(signalsByRole())}`)), 20_000);
    });

    return Promise.race([dev.exited, timeout]).finally(() => clearTimeout(timer));
}

const allStarted = () => ROLES.every(role => lines().some(line => line.role === role && line.event === 'start'));

/** The stand-ins' process groups that still have a process in them. */
function groupsLeft(): number[]
{
    const groups = [...new Set(lines().map(line => line.pgid))];

    return groups.filter((pgid) =>
    {
        try
        {
            process.kill(-pgid, 0);

            return true;
        }
        catch
        {
            return false;
        }
    });
}

beforeEach(() =>
{
    appDir = mkdtempSync(join(tmpdir(), 'spfn-dev-signals-'));
    rowTag = newRowTag();
    writeApp();
});

afterEach(async () =>
{
    await killTagged(rowTag);
    rmSync(appDir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('spfn dev supervision (#358)', () =>
{
    it.each(['SIGTERM', 'SIGINT'] as const)('S1 %s to the bin\'s pid reaches each child once; spfn dev exits after the last, leaving no process', async (signal) =>
    {
        const dev = await startDev({ server: 1000, watcher: 500, next: 2000 });

        await until(dev, 'server, watcher and Next.js starting', allStarted);
        process.kill(dev.child.pid!, signal);

        const exit = await exitOf(dev);
        const lastChildExit = Math.max(...lines().filter(line => line.event === 'exit').map(line => line.at));

        expect(signalsByRole(), dev.output()).toEqual({ server: ['SIGTERM'], watcher: ['SIGTERM'], next: ['SIGTERM'] });
        expect({ code: exit.code, signal: exit.signal, afterLastChild: exit.at >= lastChildExit, groupsLeft: groupsLeft() }, dev.output())
            .toEqual({ code: 0, signal: null, afterLastChild: true, groupsLeft: [] });
    }, 60_000);

    it('S2 a terminal\'s Ctrl-C (SIGINT to the bin\'s group) reaches each child once, through spfn dev only', async () =>
    {
        const dev = await startDev({ server: 1000, watcher: 500, next: 2000 });

        await until(dev, 'server, watcher and Next.js starting', allStarted);
        process.kill(-dev.child.pid!, 'SIGINT');

        const exit = await exitOf(dev);

        expect(signalsByRole(), dev.output()).toEqual({ server: ['SIGTERM'], watcher: ['SIGTERM'], next: ['SIGTERM'] });
        expect({ code: exit.code, groupsLeft: groupsLeft() }, dev.output()).toEqual({ code: 0, groupsLeft: [] });
    }, 60_000);

    it('S3 a SIGTERM after a SIGINT (pnpm exec relaying a Ctrl-C) is no second Ctrl-C: the server finishes its shutdown', async () =>
    {
        const dev = await startDev({ server: 1500, watcher: 500, next: 500 });

        await until(dev, 'server, watcher and Next.js starting', allStarted);
        process.kill(dev.child.pid!, 'SIGINT');
        await until(dev, 'the server signalled', () => signalsByRole().server.length > 0);
        process.kill(dev.child.pid!, 'SIGTERM');

        const exit = await exitOf(dev);
        const serverExit = lines().find(line => line.role === 'server' && line.event === 'exit');

        expect({ code: exit.code, serverExited: serverExit !== undefined, groupsLeft: groupsLeft() }, dev.output())
            .toEqual({ code: 0, serverExited: true, groupsLeft: [] });
    }, 60_000);

    it('S4 a SIGINT once the stop has begun kills every group left, Next.js behind its wrappers included, and exits 130', async () =>
    {
        // Every stand-in outlasts the row's wait: only the kill ends them in time.
        const dev = await startDev({ server: 25_000, watcher: 25_000, next: 25_000 });

        await until(dev, 'server, watcher and Next.js starting', allStarted);
        process.kill(dev.child.pid!, 'SIGTERM');
        await until(dev, 'every child signalled', () => ROLES.every(role => signalsByRole()[role].length > 0));
        process.kill(dev.child.pid!, 'SIGINT');

        const exit = await exitOf(dev);

        expect({ code: exit.code, groupsLeft: groupsLeft() }, dev.output()).toEqual({ code: 130, groupsLeft: [] });
    }, 60_000);
});
