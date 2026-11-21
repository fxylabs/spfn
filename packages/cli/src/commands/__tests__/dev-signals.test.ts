/**
 * `spfn dev`'s supervision model (#358), with real processes: the real bin
 * (`bin/spfn.js`, which re-runs itself under tsx and the dev hook) runs `spfn
 * dev` in a fixture app whose `@spfn/core` is a stand-in. Its server, its
 * codegen watcher and the app's `spfn:next` script (run through `pnpm run`, as
 * `spfn dev` runs it) each log every signal they get, their pgid and parent,
 * and their exit, with the time, to one file.
 *
 * Stand-in timings: the watcher's close takes 0.5 s, the server's shutdown 1 s
 * and ignores later signals (as core's does), Next.js 2 s — so Next.js, behind
 * `pnpm run` and `sh -c`, which exit at once, is the last to exit.
 *
 * | #  | signal                                    | catches, which would otherwise pass silently                    |
 * |----|-------------------------------------------|-----------------------------------------------------------------|
 * | S1 | SIGTERM, SIGINT or SIGQUIT to the bin's   | a bin that dies alone (the tree runs on, orphaned); Next.js     |
 * |    | pid (a process manager, `kill <pid>`)     | behind its wrappers never signalled; `spfn dev` exiting before  |
 * |    |                                           | a child (an orphan holding the port); a group left non-empty    |
 * | S2 | SIGINT to the bin's process group (the    | a child in the terminal's group: it gets the terminal's signal  |
 * |    | terminal's Ctrl-C)                        | and `spfn dev`'s, and the watcher abandons its generation       |
 * | S3 | SIGINT, then SIGTERM, to the bin's pid    | a SIGTERM after a SIGINT taken for a second Ctrl-C: under `pnpm |
 * |    | (`pnpm exec spfn dev` relays a Ctrl-C as  | exec spfn dev` one Ctrl-C would SIGKILL the server mid-shutdown |
 * |    | both)                                     |                                                                 |
 * | S4 | SIGTERM, then SIGINT, every child held    | a second Ctrl-C that kills the wrapper only: Next.js behind     |
 * |    | past the row                              | `pnpm run`/`sh -c` survives it, holding its port                |
 * | S5 | SIGQUIT to the bin's process group (the   | `spfn dev` killed by a Ctrl-\ the children no longer get: the   |
 * |    | terminal's Ctrl-\)                        | whole tree runs on, orphaned                                    |
 * | S6 | an uncaught exception in `spfn dev`        | the children orphaned: execa's exit cleanup skips detached ones |
 * | T1 | one Ctrl-C to `pnpm exec spfn dev` typed  | `spfn dev` and a slow server running on behind the shell's      |
 * |    | in an interactive bash in a terminal, the | prompt, for the server's whole stop, after the launcher exited  |
 * |    | server's stop longer than the row         | and no second Ctrl-C could reach them                           |
 * | T2 | one Ctrl-C to `pnpm dev` / `spfn dev`     | over-eager killing: a launcher that waits for `spfn dev` taken  |
 * |    | typed in that bash, a slow server         | for one that left, and the server's graceful stop cut short     |
 * | T3 | `pnpm exec spfn dev &`, then `fg`, then   | the foreground read once, at start: `spfn dev` and the server   |
 * |    | one Ctrl-C                                | left behind the prompt after the launcher exited                |
 * | T4 | `pnpm exec spfn dev &` never brought      | a job never in the foreground taken for one that lost it: a     |
 * |    | forward, then `kill -INT %1`              | `kill` of a background job SIGKILLing the server                |
 * | T5 | the terminal hanging up (`script` killed) | a hang-up taken for the shell taking the terminal back: every   |
 * |    | under a running `spfn dev`                | child SIGKILLed instead of its graceful stop; a write to the    |
 * |    |                                           | hung-up terminal (EIO) ending `spfn dev` or the watcher         |
 * | T6 | one Ctrl-C to `spfn dev \| tee log` and   | the Ctrl-C killing `tee`, and the next line (EPIPE) ending      |
 * |    | `pnpm exec spfn dev \| tee log`           | `spfn dev` — the server unsupervised, nothing killed at once —  |
 * |    |                                           | or the watcher, before its close                                |
 *
 * The non-Linux read (`ps`) is `utils/__tests__/dev-supervisor-ps.test.ts`'s.
 *
 * No process outlives a row: each stand-in exits by itself 30 s after it
 * starts, and teardown SIGKILLs every process carrying the row's environment
 * tag (`helpers/process-tree.ts`). Waits time out and fail the row rather than
 * hang it. Build the CLI first (`pnpm --filter spfn build`): the bin runs
 * `dist/`. Needs `pnpm` and Linux (`/proc`); the T rows need `script`
 * (util-linux) for the terminal and `bash` for the shell typed in.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { killTagged, newRowTag, ROW_TAG_VARIABLE, taggedPids } from './helpers/process-tree';

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
    ppid: number;
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
export const log = (role, event) => appendFileSync(process.env.SPFN_SIGNAL_LOG, \`\${Date.now()} \${role} \${process.pid} \${pgid()} \${event} \${process.ppid}\\n\`);
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

/**
 * Preloaded into the bin (`--import`), it throws from `spfn dev` — the process
 * the bin re-ran itself as — once the server, the watcher and Next.js have started.
 */
const CRASH_DEV = `import { existsSync, readFileSync } from 'node:fs';
const started = () => existsSync(process.env.SPFN_SIGNAL_LOG)
    && ['server', 'watcher', 'next'].every(role => readFileSync(process.env.SPFN_SIGNAL_LOG, 'utf8').includes(\` \${role} \`));
if (process.env.SPFN_CLI_RELAUNCHED_IN !== undefined)
{
    const check = setInterval(() =>
    {
        if (started())
        {
            clearInterval(check);
            throw new Error('stand-in: an uncaught exception in spfn dev');
        }
    }, 50);
}
`;

function writeApp(): void
{
    write('package.json', JSON.stringify({ name: 'dev-signals-fixture', private: true, dependencies: { next: '15.0.0' },
        scripts: { 'spfn:next': 'node next-stand-in.mjs', dev: 'spfn dev --no-agent-files' } }));
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
    write('crash-dev.mjs', CRASH_DEV);
    mkdirSync(join(appDir, 'node_modules/.bin'));
    symlinkSync(bin, join(appDir, 'node_modules/.bin/spfn'));
}

function lines(): Line[]
{
    const file = join(appDir, 'signals.log');

    return existsSync(file)
        ? readFileSync(file, 'utf8').trim().split('\n').map((line) =>
        {
            const [at, role, pid, pgid, event, ppid] = line.split(' ');

            return { at: Number(at), role: role as Role, pid: Number(pid), pgid: Number(pgid), event, ppid: Number(ppid) };
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

type StopMs = { server: number; watcher: number; next: number };

/** The environment of what a row starts: the row's tag, free ports, the stand-ins' stop times. */
async function rowEnv(stopMs: StopMs): Promise<NodeJS.ProcessEnv>
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

    return env;
}

/** The bin, `spfn dev` (under `nodeArgs`), in a process group of its own, as a terminal or a process manager starts it. */
async function startDev(stopMs: StopMs, nodeArgs: string[] = []): Promise<Dev>
{
    return devOf(spawn(process.execPath, [...nodeArgs, bin, 'dev', '--no-agent-files'], { cwd: appDir, env: await rowEnv(stopMs), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/**
 * An interactive bash in a terminal of its own (`script`), with `line` typed at
 * its prompt: the terminal's foreground job is what the line starts, and the
 * shell takes the terminal back when that job ends.
 */
async function typeInTerminal(line: string, stopMs: StopMs): Promise<Dev>
{
    const env = { ...(await rowEnv(stopMs)), TERM: 'dumb' };
    const terminal = devOf(spawn('script', ['-qf', '-c', 'bash --norc --noprofile -i', '/dev/null'], { cwd: appDir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));

    await until(terminal, 'the shell\'s prompt', () => terminal.output().includes('$ '));
    terminal.child.stdin!.write(`${line}\n`);

    return terminal;
}

function devOf(child: ChildProcess): Dev
{
    let output = '';

    child.stdout!.on('data', chunk => (output += chunk));
    child.stderr!.on('data', chunk => (output += chunk));

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(settle =>
        child.on('exit', (code, signal) => settle({ code, signal, at: Date.now() })));

    return { child, output: () => output.replace(/\x1b\[[0-9;]*m/g, ''), exited };
}

/** Resolves once `condition` holds; rejects `ms` on (30 s), or once the bin has exited without it. */
async function until(dev: Dev, what: string, condition: () => boolean, ms = 30_000): Promise<void>
{
    const deadline = Date.now() + ms;

    while (!condition())
    {
        if (Date.now() > deadline || dev.child.exitCode !== null || dev.child.signalCode !== null)
        {
            throw new Error(`${what} did not happen:\n${dev.output().slice(-3000)}\n${JSON.stringify(lines())}`);
        }

        await new Promise(settle => setTimeout(settle, 50));
    }
}

/** Resolves once `condition` holds or `ms` on, whichever is first: the row's assertion says which. */
async function settled(condition: () => boolean, ms: number): Promise<void>
{
    const deadline = Date.now() + ms;

    while (!condition() && Date.now() < deadline)
    {
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

/** The row's processes but the terminal and its shell: `spfn dev`, its launcher, the stand-ins. */
function treeLeft(): string[]
{
    return taggedPids(rowTag).map(cmdlineOf).filter(cmdline => cmdline !== '' && !/^(script|bash) /.test(cmdline));
}

function cmdlineOf(pid: number): string
{
    try
    {
        return readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/g, ' ');
    }
    catch
    {
        // Gone already.
        return '';
    }
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
    it.each(['SIGTERM', 'SIGINT', 'SIGQUIT'] as const)('S1 %s to the bin\'s pid reaches each child once; spfn dev exits after the last, leaving no process', async (signal) =>
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

    it('S5 a terminal\'s Ctrl-\\ (SIGQUIT to the bin\'s group) stops spfn dev as Ctrl-C does, leaving no process', async () =>
    {
        const dev = await startDev({ server: 1000, watcher: 500, next: 2000 });

        await until(dev, 'server, watcher and Next.js starting', allStarted);
        process.kill(-dev.child.pid!, 'SIGQUIT');

        const exit = await exitOf(dev);

        expect(signalsByRole(), dev.output()).toEqual({ server: ['SIGTERM'], watcher: ['SIGTERM'], next: ['SIGTERM'] });
        expect({ code: exit.code, groupsLeft: groupsLeft() }, dev.output()).toEqual({ code: 0, groupsLeft: [] });
    }, 60_000);

    it('S6 spfn dev dying of an uncaught exception stops each child as it goes, leaving no process', async () =>
    {
        const dev = await startDev({ server: 1000, watcher: 500, next: 2000 }, ['--import', join(appDir, 'crash-dev.mjs')]);
        const exit = await exitOf(dev);

        // Without the stop the stand-ins run on until their own 30 s cap.
        await settled(() => groupsLeft().length === 0, 10_000);

        expect(dev.output()).toContain('stand-in: an uncaught exception in spfn dev');
        expect(signalsByRole(), dev.output()).toEqual({ server: ['SIGTERM'], watcher: ['SIGTERM'], next: ['SIGTERM'] });
        expect({ code: exit.code, groupsLeft: groupsLeft() }, dev.output()).toEqual({ code: 1, groupsLeft: [] });
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

/** The server's stop as the server records it. */
function serverStop(): { signals: string[]; ranItsStop: boolean; supervisedToTheEnd: boolean }
{
    const server = lines().filter(line => line.role === 'server');
    const started = server.find(line => line.event === 'start');
    const exited = server.find(line => line.event === 'exit');

    return {
        signals: signalsByRole().server,
        // Its own stop run to completion: not killed.
        ranItsStop: exited !== undefined,
        // Its parent when it exited is the one it started under: spfn dev, still there.
        supervisedToTheEnd: started !== undefined && exited !== undefined && exited.ppid === started.ppid,
    };
}

const KILL_LINE = 'spfn dev no longer has the terminal, so no second Ctrl-C can reach it: killing what is left';

/**
 * Ends the row once no process of it is left behind the prompt (10 s when
 * only a kill can end the server in time), failing with the list otherwise.
 */
async function nothingLeft(terminal: Dev, ms = 30_000): Promise<void>
{
    await until(terminal, 'no process left behind the prompt', () => treeLeft().length === 0, ms)
        .catch(error => expect.fail(`${error}\n${treeLeft().join('\n')}`));
}

describe.skipIf(process.platform !== 'linux')('spfn dev typed in a terminal (#358)', () =>
{
    it('T1 one Ctrl-C to `pnpm exec spfn dev`, which exits on it: no second Ctrl-C can come, so spfn dev kills what is left at once', async () =>
    {
        // The server's stop outlasts the wait below: only the kill ends it in time.
        const terminal = await typeInTerminal('pnpm exec spfn dev --no-agent-files', { server: 25_000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await until(terminal, 'no process left behind the prompt', () => treeLeft().length === 0, 10_000)
            .catch(error => expect.fail(`${error}\n${treeLeft().join('\n')}`));

        expect({
            server: signalsByRole().server,
            serverStoppedGracefully: lines().some(line => line.role === 'server' && line.event === 'exit'),
            said: terminal.output().includes('spfn dev no longer has the terminal, so no second Ctrl-C can reach it: killing what is left'),
            groupsLeft: groupsLeft(),
        }, terminal.output()).toEqual({ server: ['SIGTERM'], serverStoppedGracefully: false, said: true, groupsLeft: [] });
    }, 60_000);

    it.each([
        ['pnpm dev', 'pnpm dev'],
        ['spfn dev', './node_modules/.bin/spfn dev --no-agent-files'],
    ])('T2 one Ctrl-C to `%s`, which waits for spfn dev: the server gets its whole graceful stop', async (_launcher, line) =>
    {
        const terminal = await typeInTerminal(line, { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await until(terminal, 'no process left behind the prompt', () => treeLeft().length === 0);

        const server = lines().filter(line => line.role === 'server');
        const signalled = server.find(line => line.event === 'SIGTERM');
        const exited = server.find(line => line.event === 'exit');

        expect({
            server: signalsByRole().server,
            stopTookItsTime: signalled !== undefined && exited !== undefined && exited.at - signalled.at >= 3000,
            killed: terminal.output().includes('killing what is left'),
            groupsLeft: groupsLeft(),
        }, terminal.output()).toEqual({ server: ['SIGTERM'], stopTookItsTime: true, killed: false, groupsLeft: [] });
    }, 60_000);

    it('T3 `pnpm exec spfn dev &` brought forward with `fg`: one Ctrl-C, the launcher exits, and spfn dev kills what is left at once', async () =>
    {
        const terminal = await typeInTerminal('pnpm exec spfn dev --no-agent-files &', { server: 25_000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('fg\n');
        // spfn dev reads the terminal every 100 ms: a person's Ctrl-C after `fg` comes later than that.
        await new Promise(settle => setTimeout(settle, 1000));
        terminal.child.stdin!.write('\x03');
        await nothingLeft(terminal, 10_000);

        expect({ ranItsStop: serverStop().ranItsStop, said: terminal.output().includes(KILL_LINE), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ ranItsStop: false, said: true, groupsLeft: [] });
    }, 60_000);

    it('T4 `pnpm exec spfn dev &` never brought forward, then `kill -INT %1`: the graceful stop', async () =>
    {
        const terminal = await typeInTerminal('pnpm exec spfn dev --no-agent-files &', { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('kill -INT %1\n');
        await nothingLeft(terminal);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left') }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false });
    }, 60_000);

    it('T5 the terminal hanging up under `spfn dev`: each child gets its SIGTERM and its graceful stop', async () =>
    {
        const terminal = await typeInTerminal('./node_modules/.bin/spfn dev --no-agent-files', { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        // The terminal's other end closing: the kernel hangs the terminal up.
        process.kill(terminal.child.pid!, 'SIGKILL');
        await settled(() => treeLeft().length === 0, 30_000);

        const exited = Object.fromEntries(ROLES.map(role => [role, lines().some(line => line.role === role && line.event === 'exit')]));

        expect({ signals: signalsByRole(), exited, supervisedToTheEnd: serverStop().supervisedToTheEnd, left: treeLeft() })
            .toEqual({
                signals: { server: ['SIGTERM'], watcher: ['SIGTERM'], next: ['SIGTERM'] },
                exited: { server: true, watcher: true, next: true },
                supervisedToTheEnd: true,
                left: [],
            });
    }, 60_000);

    it.each([
        ['spfn dev | tee log', './node_modules/.bin/spfn dev --no-agent-files | tee out.log', false],
        ['pnpm exec spfn dev | tee log', 'pnpm exec spfn dev --no-agent-files | tee out.log', true],
    ])('T6 one Ctrl-C to `%s`, which kills tee: spfn dev outlives its output and does its duty', async (_line, line, killsAtOnce) =>
    {
        // When the kill is due, the server's stop outlasts the wait: only the kill ends it in time.
        const terminal = await typeInTerminal(line, { server: killsAtOnce ? 25_000 : 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await nothingLeft(terminal, killsAtOnce ? 10_000 : 30_000);

        const { signals, ...stop } = serverStop();
        const watcherRanItsStop = lines().some(line => line.role === 'watcher' && line.event === 'exit');

        expect({ ...stop, watcherRanItsStop, groupsLeft: groupsLeft() }, `${terminal.output()}\n${JSON.stringify(signals)}`)
            .toEqual({ ranItsStop: !killsAtOnce, supervisedToTheEnd: !killsAtOnce, watcherRanItsStop: !killsAtOnce, groupsLeft: [] });
    }, 60_000);
});
