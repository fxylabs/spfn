/**
 * `spfn dev`'s supervision model (#358), with real processes: the real bin
 * (`bin/spfn.js`, which re-runs itself under tsx and the dev hook) runs `spfn
 * dev` in a fixture app whose `@spfn/core` is a stand-in. Its server, its
 * codegen watcher and the app's `spfn:next` script (run through `pnpm run`, as
 * `spfn dev` runs it) each log every signal they get, their pgid and parent,
 * and their exit, with the time, to one file. A stand-in's `exit` is its own
 * stop run to completion; killed, it logs none.
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
 * |    |                                           | (the server SIGTERMed first, or not at all when the launcher    |
 * |    |                                           | exited before `spfn dev` handled the Ctrl-C)                    |
 * | T2 | one Ctrl-C to `pnpm dev` / `spfn dev`     | over-eager killing: a launcher that waits for `spfn dev`, or    |
 * |    | typed in that bash, a slow server         | `spfn dev` leading its own job, taken for a launcher that left, |
 * |    |                                           | and the server's graceful stop cut short                        |
 * | T3 | `pnpm exec spfn dev &`, then `fg`, then   | the launcher read once, at start: `spfn dev` and the server     |
 * |    | one Ctrl-C                                | left behind the prompt after the launcher exited                |
 * | T4 | `pnpm exec spfn dev &` never brought      | a launcher's exit counted only after a Ctrl-C from the          |
 * |    | forward, then `kill -INT %1`              | foreground: the job gone from the shell (no `fg`, no Ctrl-C,    |
 * |    |                                           | no `kill %1` reaches it) and the server running on behind it    |
 * | T5 | the terminal hanging up (`script` killed) | a hang-up taken for the launcher exiting (`pnpm exec` exits on  |
 * |    | under `spfn dev` and `pnpm exec spfn dev` | it): every child SIGKILLed instead of its graceful stop; a      |
 * |    |                                           | write to the hung-up terminal (EIO) ending `spfn dev` or the    |
 * |    |                                           | watcher                                                         |
 * | T6 | one Ctrl-C to `spfn dev \| tee log` and   | the Ctrl-C killing `tee`, and the next line (EPIPE) ending      |
 * |    | `pnpm exec spfn dev \| tee log`           | `spfn dev` — the server unsupervised, nothing killed at once —  |
 * |    |                                           | or the watcher, before its close                                |
 * | T7 | one Ctrl-C to `true \| spfn dev`, whose   | the group's leader taken for the launcher when it launched      |
 * |    | group's leader (`true`) exits at once     | nothing: the graceful stop SIGKILLed though a second Ctrl-C     |
 * |    |                                           | still reaches `spfn dev`                                        |
 * | T8 | one Ctrl-C to `cat \| pnpm exec spfn dev` | the launcher taken for the group's leader (`cat`, which         |
 * |    | (the launcher, pnpm, does not lead)       | launched nothing): the graceful stop running on behind the      |
 * |    |                                           | prompt after pnpm exited                                        |
 * | X1 | one Ctrl-C to `pnpm exec spfn dev \| tee  | the launcher's exit alone taken for "no second Ctrl-C can       |
 * | X9 | -i log` / `\| (trap '' INT; cat)`: pnpm   | arrive": the server SIGKILLed while the job still has the       |
 * |    | exits, the reader survives                | terminal and a second Ctrl-C still reaches `spfn dev`           |
 * | PB | a launcher (`bash -c '… &'`) that exits   | the same, for a launcher that leaves on its own (round 4's pty  |
 * |    | on its own, the job held open by a reader | controller probe)                                               |
 * |    | ignoring SIGINT; then one Ctrl-C          |                                                                 |
 * | PA | `spfn dev` typed, Ctrl-Z, `bg`, `kill %1` | the terminal's half alone (round 3's proxy): every child        |
 * |    |                                           | SIGKILLed, though `fg` and Ctrl-C still reach it                |
 * | PE | `pnpm exec spfn dev` typed, Ctrl-Z, `bg`, | the job gone from the shell (pnpm exits on the SIGTERM) and the |
 * |    | `kill %1`                                 | server running on behind the prompt                             |
 * | Q1 | `bash -c 'pnpm exec spfn dev; …' &`,     | an inner launcher's exit taken for the job's end: pnpm exits,   |
 * | Q2 | then `kill -INT %1`; or that typed,       | the shell has the terminal only because the job is in the       |
 * |    | Ctrl-Z, `bg`, `kill -INT %1`: the wrapper | background, and the server is SIGKILLed while `fg` + Ctrl-C     |
 * |    | waits on                                  | would still reach `spfn dev`                                    |
 * | PD | `spfn dev \| head -1`                     | a closed reader outside a stop ignored: `spfn dev` and every    |
 * |    |                                           | child running on, writing nowhere; or reported as success (0,   |
 * |    |                                           | not SIGPIPE's 141) to `$PIPESTATUS` and `set -o pipefail`       |
 *
 * The launcher off Linux (`ps`, once, at start) is `utils/__tests__/dev-supervisor-ps.test.ts`'s.
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

/** The repository's pnpm: a fixture naming none gets corepack's newest, which installs `next` from the registry before a script. */
const packageManager = JSON.parse(readFileSync(join(__dirname, '../../../../../package.json'), 'utf8')).packageManager;

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
    process.on('exit', code => log(role, code === 0 ? 'exit' : \`exit\${code}\`));
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
    write('package.json', JSON.stringify({ name: 'dev-signals-fixture', private: true, packageManager, dependencies: { next: '15.0.0' },
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
 * The shell's prompt, set by the row rather than left to bash: its default
 * ends in `$ ` or, for root (CI's container), `# `. Set by the first line typed,
 * not inherited: `script` runs its command through `$SHELL -c`, and a
 * non-interactive bash unsets `PS1`. That line is quoted so that its echo is
 * not the prompt.
 */
const PROMPT = '<dev-signals prompt> ';
const SET_PROMPT = "PS1='<dev-signals'' prompt> '";

/**
 * An interactive bash in a terminal of its own (`script`), with `line` typed at
 * its prompt: the terminal's foreground job is what the line starts, and the
 * shell takes the terminal back when that job ends.
 */
async function typeInTerminal(line: string, stopMs: StopMs): Promise<Dev>
{
    const env: NodeJS.ProcessEnv = { ...(await rowEnv(stopMs)), TERM: 'dumb' };

    delete env.PROMPT_COMMAND;
    delete env.PS0;

    // `exec`: whatever `$SHELL` is (unset in CI's container: `sh`), bash replaces it rather than run under it.
    const terminal = devOf(spawn('script', ['-qf', '-c', 'exec bash --norc --noprofile -i', '/dev/null'], { cwd: appDir, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));

    // Typed ahead of bash's first prompt: the terminal holds it until bash reads.
    terminal.child.stdin!.write(`${SET_PROMPT}\n`);
    await prompted(terminal, 1);
    terminal.child.stdin!.write(`${line}\n`);

    return terminal;
}

/** Resolves once the shell has shown its prompt `count` times: ready for a line, or the terminal back from a job. */
async function prompted(terminal: Dev, count: number): Promise<void>
{
    await until(terminal, `the shell's prompt #${count}`, () => terminal.output().split(PROMPT).length > count);
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
        // Its own stop run to completion (exit 0): not killed, not its 30 s cap.
        ranItsStop: exited !== undefined,
        // Its parent when it exited is the one it started under: spfn dev, still there.
        supervisedToTheEnd: started !== undefined && exited !== undefined && exited.ppid === started.ppid,
    };
}

const KILL_LINE = 'the launcher that started spfn dev has exited and the shell has the terminal, so no second Ctrl-C can reach it: killing what is left';

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
        // The launcher exits on the Ctrl-C: the shell has the terminal back.
        await prompted(terminal, 2);
        await nothingLeft(terminal, 10_000);

        // spfn dev SIGTERMs the server when the launcher is still there as its
        // stop begins, and kills it on the next read; when the launcher exited
        // first, it kills at once and sends no SIGTERM.
        expect([[], ['SIGTERM']], terminal.output()).toContainEqual(serverStop().signals);
        expect({ ranItsStop: serverStop().ranItsStop, said: terminal.output().includes(KILL_LINE), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ ranItsStop: false, said: true, groupsLeft: [] });
    }, 60_000);

    it.each([
        ['pnpm dev', 'pnpm dev'],
        ['spfn dev', './node_modules/.bin/spfn dev --no-agent-files'],
    ])('T2 one Ctrl-C to `%s`, which waits for spfn dev: the server gets its whole graceful stop', async (_launcher, line) =>
    {
        const terminal = await typeInTerminal(line, { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await nothingLeft(terminal);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left'), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false, groupsLeft: [] });
    }, 60_000);

    it('T3 `pnpm exec spfn dev &` brought forward with `fg`: one Ctrl-C, the launcher exits, and spfn dev kills what is left at once', async () =>
    {
        const terminal = await typeInTerminal('pnpm exec spfn dev --no-agent-files &', { server: 25_000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        await prompted(terminal, 2);
        terminal.child.stdin!.write('fg\n');
        // A Ctrl-C typed before the shell has handed the job the terminal is the shell's.
        await new Promise(settle => setTimeout(settle, 1000));
        terminal.child.stdin!.write('\x03');
        // The launcher exits on the Ctrl-C: the shell has the terminal back.
        await prompted(terminal, 3);
        await nothingLeft(terminal, 10_000);

        expect({ ranItsStop: serverStop().ranItsStop, said: terminal.output().includes(KILL_LINE), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ ranItsStop: false, said: true, groupsLeft: [] });
    }, 60_000);

    it('T4 `pnpm exec spfn dev &` never brought forward, then `kill -INT %1`: the launcher exits, so spfn dev kills what is left at once', async () =>
    {
        const terminal = await typeInTerminal('pnpm exec spfn dev --no-agent-files &', { server: 25_000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        await prompted(terminal, 2);
        terminal.child.stdin!.write('kill -INT %1\n');
        await nothingLeft(terminal, 10_000);

        expect({ ranItsStop: serverStop().ranItsStop, said: terminal.output().includes(KILL_LINE), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ ranItsStop: false, said: true, groupsLeft: [] });
    }, 60_000);

    it.each([
        ['spfn dev', './node_modules/.bin/spfn dev --no-agent-files'],
        ['pnpm exec spfn dev', 'pnpm exec spfn dev --no-agent-files'],
    ])('T5 the terminal hanging up under `%s`: each child gets its SIGTERM and its graceful stop', async (_launcher, line) =>
    {
        const terminal = await typeInTerminal(line, { server: 3000, watcher: 500, next: 500 });

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

    it('T7 `true | spfn dev`, whose group `true` leads and exits at once: no launcher, so one Ctrl-C gives the server its graceful stop', async () =>
    {
        const terminal = await typeInTerminal('true | ./node_modules/.bin/spfn dev --no-agent-files', { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await nothingLeft(terminal);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left'), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false, groupsLeft: [] });
    }, 60_000);

    it('T8 one Ctrl-C to `cat | pnpm exec spfn dev`, led by `cat`: the launcher (pnpm) exits, the shell has the terminal, so spfn dev kills what is left at once', async () =>
    {
        const terminal = await typeInTerminal('cat | pnpm exec spfn dev --no-agent-files', { server: 25_000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await prompted(terminal, 2);
        await nothingLeft(terminal, 10_000);

        expect({ ranItsStop: serverStop().ranItsStop, said: terminal.output().includes(KILL_LINE), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ ranItsStop: false, said: true, groupsLeft: [] });
    }, 60_000);

    it.each([
        ['X1 pnpm exec spfn dev | tee -i log', 'pnpm exec spfn dev --no-agent-files | tee -i out.log'],
        ['X9 pnpm exec spfn dev | (trap \'\' INT; cat)', "pnpm exec spfn dev --no-agent-files | (trap '' INT; cat)"],
    ])('%s: one Ctrl-C, the launcher exits but the job keeps the terminal, so the server gets its whole graceful stop', async (_line, line) =>
    {
        const terminal = await typeInTerminal(line, { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x03');
        await nothingLeft(terminal);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left'), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false, groupsLeft: [] });
    }, 60_000);

    it('PB a launcher that exits on its own, its job still the terminal\'s foreground: one Ctrl-C gives the server its graceful stop', async () =>
    {
        // bash -c leads the job and is spfn dev's parent; it exits once the row says so, and `cat`, ignoring SIGINT, holds the job open.
        const terminal = await typeInTerminal("bash -c './node_modules/.bin/spfn dev --no-agent-files & until [ -e exit-now ]; do sleep 0.05; done' | (trap '' INT; cat)",
            { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        writeFileSync(join(appDir, 'exit-now'), '');
        await until(terminal, 'the launcher exiting', () => !taggedPids(rowTag).some(pid => cmdlineOf(pid).includes('exit-now')));
        terminal.child.stdin!.write('\x03');
        await nothingLeft(terminal);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left'), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false, groupsLeft: [] });
    }, 60_000);

    it('PA `spfn dev` typed, Ctrl-Z, `bg`, then `kill %1`: the graceful stop, spfn dev being its own launcher', async () =>
    {
        const terminal = await typeInTerminal('./node_modules/.bin/spfn dev --no-agent-files', { server: 3000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x1a');
        await prompted(terminal, 2);
        terminal.child.stdin!.write('bg\n');
        await prompted(terminal, 3);
        terminal.child.stdin!.write('kill %1\n');
        await nothingLeft(terminal);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left'), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false, groupsLeft: [] });
    }, 60_000);

    it('PE `pnpm exec spfn dev` typed, Ctrl-Z, `bg`, then `kill %1`: the launcher exits on it, the shell reports the job done, so spfn dev kills what is left at once', async () =>
    {
        const terminal = await typeInTerminal('pnpm exec spfn dev --no-agent-files', { server: 25_000, watcher: 500, next: 500 });

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        terminal.child.stdin!.write('\x1a');
        await prompted(terminal, 2);
        terminal.child.stdin!.write('bg\n');
        await prompted(terminal, 3);
        terminal.child.stdin!.write('kill %1\n');
        await nothingLeft(terminal, 10_000);

        expect({ ranItsStop: serverStop().ranItsStop, said: terminal.output().includes(KILL_LINE), groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({ ranItsStop: false, said: true, groupsLeft: [] });
    }, 60_000);

    it.each([
        ['Q1', '&', []],
        ['Q2', '', ['\x1a', 'bg\n']],
    ])('%s `bash -c \'pnpm exec spfn dev; …\'` in the background, then `kill -INT` to the job: pnpm exits, the wrapper the shell started waits on, so the graceful stop', async (_row, background, toBackground) =>
    {
        // The wrapper outlives pnpm, ignoring the SIGINT, until the row says so.
        const wrapper = "bash -c 'trap : INT; pnpm exec spfn dev --no-agent-files; until [ -e exit-now ]; do sleep 0.05; done'";
        const terminal = await typeInTerminal(`${wrapper} ${background}`, { server: 3000, watcher: 500, next: 500 });
        const wrapperLeft = () => taggedPids(rowTag).some(pid => cmdlineOf(pid).includes('exit-now'));

        let prompts = background === '' ? 1 : 2;

        await until(terminal, 'server, watcher and Next.js starting', allStarted);
        await prompted(terminal, prompts);

        for (const input of toBackground)
        {
            terminal.child.stdin!.write(input);
            await prompted(terminal, ++prompts);
        }

        terminal.child.stdin!.write('kill -INT %1\n');
        await settled(() => groupsLeft().length === 0 && lines().some(line => line.event === 'start'), 10_000);

        expect({ ...serverStop(), killed: terminal.output().includes('killing what is left'), groupsLeft: groupsLeft(), wrapperLeft: wrapperLeft() }, terminal.output())
            .toEqual({ signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true, killed: false, groupsLeft: [], wrapperLeft: true });
        writeFileSync(join(appDir, 'exit-now'), '');
        await nothingLeft(terminal);
    }, 60_000);

    it('PD `spfn dev | head -1`: head exits after one line, and spfn dev\'s next line stops it and every child, gracefully, exiting 141 as SIGPIPE\'s', async () =>
    {
        const terminal = await typeInTerminal('./node_modules/.bin/spfn dev --no-agent-files | head -1; echo "statuses ${PIPESTATUS[*]}."',
            { server: 3000, watcher: 500, next: 500 });

        // The next line spfn dev writes, `Server ready …`, comes once the server has started.
        await until(terminal, 'the server starting', () => lines().some(line => line.role === 'server' && line.event === 'start'));
        await nothingLeft(terminal);
        await prompted(terminal, 2);

        const exited = Object.fromEntries(ROLES.map(role => [role, lines().some(line => line.role === role && line.event === 'exit')]));
        // The stop can come before the watcher or Next.js has started: one that had not, killed by its SIGTERM, has no stop to run.
        const started = Object.fromEntries(ROLES.map(role => [role, lines().some(line => line.role === role)]));

        expect({ server: serverStop(), exited, statuses: /statuses ([\d ]+)\./.exec(terminal.output())?.[1], groupsLeft: groupsLeft() }, terminal.output())
            .toEqual({
                server: { signals: ['SIGTERM'], ranItsStop: true, supervisedToTheEnd: true },
                exited: { ...started, server: true },
                statuses: '141 0',
                groupsLeft: [],
            });
    }, 60_000);
});
