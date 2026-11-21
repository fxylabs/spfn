/**
 * `spfn dev`'s launcher and terminal off Linux, where both are `ps`'s to say
 * (#358): a real `DevSupervisor` with one real child, `process.platform` set
 * to darwin, and `execFile` replaced by a `ps` that answers as the row says —
 * the process table (`-A`, asked once, at start) and the terminal's foreground
 * (`-p <pid>`, asked only while stopping, once the launcher has exited). A
 * foreground answer is the terminal's state when that `ps` was started. The
 * launcher the table names is a real process the row starts, and ends when the
 * row says. The child's stop takes 1.5 s; `process.exit` is held.
 *
 * | #  | table, then                         | terminal          | catches                                                    |
 * |----|-------------------------------------|-------------------|------------------------------------------------------------|
 * | L1 | fails (EAGAIN)                      | taken             | "cannot tell" taken for a launcher that exited             |
 * | L2 | prints nothing it can parse         | taken             | the same, for output it cannot read                        |
 * | L3 | never answers                       | taken             | a `ps` waited for, asked again (a process per poll), or    |
 * |    |                                     |                   | with no bound                                              |
 * | L4 | names a launcher that exits once    | taken             | the launcher never asked again while stopping: `spfn dev`  |
 * |    | the stop has begun                  |                   | and the server left running behind the prompt              |
 * | L5 | names a launcher that has exited    | none              | a launcher's exit escalating where no Ctrl-C could ever    |
 * |    |                                     |                   | arrive (a process manager, CI)                             |
 * | L6 | names a launcher that exited before | taken before the  | a stale answer deciding (round 3's bg, `fg`, Ctrl-C): the  |
 * |    | the stop                            | stop, then fg     | terminal read before the stop began                        |
 * | L7 | names a launcher that has exited    | fails, or never   | `unknown` taken for `taken`; a foreground `ps` per poll    |
 * |    |                                     | answers           | rather than one at a time                                  |
 * | L8 | names a launcher that has exited,   | taken             | the launcher's half alone: a `pnpm exec … \| tee -i` whose |
 * |    | the job still foreground            | foreground        | job keeps the terminal killed at once                      |
 * | L9 | names a launcher `kill(pid, 0)`     | taken             | EPERM (a launcher running as another user) read as exited  |
 * |    | answers EPERM for                   |                   |                                                            |
 * | PC | names `spfn dev` as its own group's | taken             | the terminal's half alone (round 3's job control: Ctrl-Z,  |
 * |    | leader                              |                   | `bg`, `kill %1`)                                           |
 * | L10| names a launcher of two, the inner  | taken             | an inner launcher's exit taken for the job's end: `bash -c |
 * |    | exiting, the outer waiting on       |                   | 'pnpm exec spfn dev; …'`, its job still the shell's        |
 * | L11| names a launcher of two, the outer  | taken             | the parent taken for the launcher: yarn 1, whose `sh -c`   |
 * |    | exiting, the inner staying (yarn 1) |                   | stays, left running behind the prompt                      |
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('node:child_process', async original => ({ ...(await original<typeof import('node:child_process')>()), execFile: vi.fn() }));

type Answer = (callback: (error: Error | null, stdout: string) => void) => void;

/** Where a Ctrl-C goes, as a foreground `ps` started now answers: `ps -o pgid=,tpgid=`'s line. */
type Terminal = 'taken' | 'foreground' | 'none' | 'fails' | 'silent';

const ps = vi.mocked(execFile);
const platform = process.platform;
const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'exit'] as const).map(name => [name, process.listeners(name as NodeJS.Signals)] as const);
const streams = [process.stdout, process.stderr].map(stream => [stream, stream.listeners('error')] as const);
const STOPS_IN_1500_MS = 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1500)); setInterval(() => {}, 1000);';

let answer: Answer;
let terminal: Terminal;
/** The terminal's state as each foreground `ps` was started. */
let terminalAsks: Terminal[];
let launcher: ChildProcess;

beforeEach(() =>
{
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    terminal = 'taken';
    launcher = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    terminalAsks = [];
    ps.mockClear();
    ps.mockImplementation(((_file: string, args: string[], _options: object, callback: Parameters<Answer>[0]) =>
    {
        const respond = args[0] === '-A' ? answer : foreground(terminal);

        if (args[0] !== '-A')
        {
            terminalAsks.push(terminal);
        }

        setImmediate(() => respond(callback));

        return { kill: vi.fn() };
    }) as never);
});

afterEach(() =>
{
    Object.defineProperty(process, 'platform', { value: platform });
    listeners.forEach(([name, kept]) => process.listeners(name as NodeJS.Signals).filter(listener => !kept.includes(listener)).forEach(listener => process.off(name, listener as never)));
    streams.forEach(([stream, kept]) => stream.listeners('error').filter(listener => !kept.includes(listener)).forEach(listener => stream.off('error', listener as never)));
    launcher.kill('SIGKILL');
    vi.restoreAllMocks();
});

/** `ps -A -o pid=,ppid=,pgid=`'s lines for this process, in group `pgid`, and its parent `ppid`, in `parentPgid`. */
function table(ppid: number, pgid: number, parentPgid = pgid): Answer
{
    return callback => callback(null, `  ${process.pid}  ${ppid}  ${pgid}\n  ${ppid}  1  ${parentPgid}\n`);
}

/** `ps -A -o pid=,ppid=,pgid=`'s lines for this process and `ancestors` (its parent first), all in group `pgid`; the last one's parent is init. */
function chain(pgid: number, ...ancestors: number[]): Answer
{
    const pids = [process.pid, ...ancestors];

    return callback => callback(null, pids.map((pid, index) => `  ${pid}  ${pids[index + 1] ?? 1}  ${pgid}\n`).join(''));
}

/** A second launcher process, for a launcher of two; ends with the row. */
function anotherLauncher(): ChildProcess
{
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

    onTestFinished(() => void other.kill('SIGKILL'));

    return other;
}

/** `ps -o pgid=,tpgid= -p <pid>` for `state`: this process's group, and the terminal's foreground group. */
function foreground(state: Terminal): Answer
{
    const tpgid = { taken: 1, foreground: process.pid, none: -1 };

    return (callback) =>
    {
        if (state === 'fails')
        {
            callback(Object.assign(new Error('Command failed: ps'), { code: 1 }), '');
        }
        else if (state !== 'silent')
        {
            callback(null, ` ${process.pid} ${tpgid[state]}\n`);
        }
    };
}

/** The `ps` calls of each kind: the process table, the terminal's foreground. */
function asked(): { table: number; terminal: number }
{
    return { table: ps.mock.calls.length - terminalAsks.length, terminal: terminalAsks.length };
}

interface Stop
{
    /** Runs just before the stop begins. */
    before?: () => void;

    /** Runs as the stop begins. */
    during?: () => void;

    /** `kill(pid, 0)` for the launcher answers EPERM: it runs as another user. */
    launcherForbidden?: boolean;
}

/** Stop until every child has ended. */
async function stop({ before, during, launcherForbidden }: Stop = {}): Promise<{ sent: unknown[]; exitCode: unknown }>
{
    const { DevSupervisor } = await import('../dev-supervisor.js');
    const supervisor = new DevSupervisor();
    const child = supervisor.start('server', process.execPath, ['-e', STOPS_IN_1500_MS], { cwd: process.cwd() })!;
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) =>
    {
        if (launcherForbidden && pid === launcher.pid && signal === 0)
        {
            throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        }

        return realKill(pid, signal);
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await new Promise(settle => setTimeout(settle, 300));
    before?.();

    const stopped = supervisor.stop();

    during?.();
    await child.ended;
    await stopped;

    return {
        sent: kill.mock.calls.filter(([pid, signal]) => pid === -child.process.pid! && signal !== 0).map(([, signal]) => signal),
        exitCode: exit.mock.calls[0]?.[0],
    };
}

/** The launcher, exited and reaped: no process has its pid. */
async function launcherExited(): Promise<void>
{
    launcher.kill('SIGKILL');
    await new Promise(settle => launcher.once('exit', settle));
}

const GRACEFUL = { sent: ['SIGTERM'], exitCode: 0 };

it.each<[string, string, Answer]>([
    ['L1', 'fails', callback => callback(Object.assign(new Error('spawn ps EAGAIN'), { code: 'EAGAIN' }), '')],
    ['L2', 'prints nothing it can parse', callback => callback(null, '   -\n')],
])('%s a `ps` that %s names no launcher: the graceful stop, though the would-be launcher exits', async (_row, _case, atStart) =>
{
    answer = atStart;

    const result = await stop({ during: () => void launcherExited() });

    expect({ ...result, asked: asked() }).toEqual({ ...GRACEFUL, asked: { table: 1, terminal: 0 } });
}, 20_000);

it('L3 a `ps` that never answers is not waited for, not asked again, and is bounded', async () =>
{
    answer = () => undefined;

    const result = await stop();

    expect({ ...result, asked: asked() }).toEqual({ ...GRACEFUL, asked: { table: 1, terminal: 0 } });
    expect(ps.mock.calls[0]?.[1]).toEqual(['-A', '-o', 'pid=,ppid=,pgid=']);
    expect(ps.mock.calls[0]?.[2]).toMatchObject({ timeout: 1000, killSignal: 'SIGKILL' });
}, 20_000);

it('L4 a launcher that exits once the stop has begun, the shell having the terminal, escalates, the table read once', async () =>
{
    answer = table(launcher.pid!, launcher.pid!);

    const result = await stop({ during: () => void launcherExited() });

    expect({ ...result, table: asked().table }).toEqual({ sent: ['SIGTERM', 'SIGKILL'], exitCode: 130, table: 1 });
    expect(ps.mock.calls.at(-1)?.[1]).toEqual(['-o', 'pgid=,tpgid=', '-p', String(process.pid)]);
    expect(ps.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 1000, killSignal: 'SIGKILL' });
}, 20_000);

it('L5 a launcher that has exited, in a session without a controlling terminal: the graceful stop', async () =>
{
    answer = table(launcher.pid!, launcher.pid!);
    terminal = 'none';
    await launcherExited();

    expect(await stop()).toEqual(GRACEFUL);
}, 20_000);

it('L6 a launcher that exited, the terminal the shell\'s until `fg` just before the Ctrl-C: no answer from before the stop decides', async () =>
{
    answer = table(launcher.pid!, launcher.pid!);
    await launcherExited();

    const result = await stop({ before: () => (terminal = 'foreground') });

    expect({ ...result, asked: terminalAsks.length > 0, whileTheShellHadIt: terminalAsks.includes('taken') })
        .toEqual({ ...GRACEFUL, asked: true, whileTheShellHadIt: false });
}, 20_000);

it.each<[string, Terminal]>([
    ['fails', 'fails'],
    ['never answers', 'silent'],
])('L7 a launcher that has exited and a foreground `ps` that %s: `unknown`, the graceful stop', async (_case, state) =>
{
    answer = table(launcher.pid!, launcher.pid!);
    terminal = state;
    await launcherExited();

    const result = await stop();

    expect(result).toEqual(GRACEFUL);
    expect(asked().terminal).toBe(state === 'silent' ? 1 : 2);
}, 20_000);

it('L8 a launcher that has exited, its job still the terminal\'s foreground (`pnpm exec spfn dev | tee -i log`): the graceful stop', async () =>
{
    answer = table(launcher.pid!, launcher.pid!);
    terminal = 'foreground';
    await launcherExited();

    expect(await stop()).toEqual(GRACEFUL);
}, 20_000);

it('L9 a launcher `kill(pid, 0)` answers EPERM for (another user\'s) is there: the graceful stop', async () =>
{
    answer = table(launcher.pid!, launcher.pid!);

    const result = await stop({ launcherForbidden: true });

    expect({ ...result, asked: asked() }).toEqual({ ...GRACEFUL, asked: { table: 1, terminal: 0 } });
}, 20_000);

it('PC `spfn dev` leading its own group, its parent (the shell) outside it: no launcher, the graceful stop (Ctrl-Z, `bg`, `kill %1`)', async () =>
{
    answer = table(launcher.pid!, process.pid, launcher.pid!);

    const result = await stop({ during: () => void launcherExited() });

    expect({ ...result, asked: asked() }).toEqual({ ...GRACEFUL, asked: { table: 1, terminal: 0 } });
}, 20_000);

it('L10 a launcher of two whose inner one exits while the outer, the one the shell started, waits on: the graceful stop', async () =>
{
    const outer = anotherLauncher();

    answer = chain(outer.pid!, launcher.pid!, outer.pid!);

    const result = await stop({ during: () => void launcherExited() });

    expect({ ...result, asked: asked() }).toEqual({ ...GRACEFUL, asked: { table: 1, terminal: 0 } });
}, 20_000);

it('L11 a launcher of two whose outer one exits while the inner stays (yarn 1 and its `sh -c`), the shell having the terminal: escalates', async () =>
{
    const inner = anotherLauncher();

    answer = chain(launcher.pid!, inner.pid!, launcher.pid!);

    expect(await stop({ during: () => void launcherExited() })).toMatchObject({ sent: ['SIGTERM', 'SIGKILL'], exitCode: 130 });
}, 20_000);
