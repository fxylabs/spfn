/**
 * `spfn dev`'s read of its terminal off Linux, where `ps` is asked (#358): a
 * real `DevSupervisor` with one real child, `process.platform` set to darwin,
 * and `execFile` replaced by a `ps` that answers "this group has the
 * terminal" until the stop begins, then as the row says. The child's stop
 * takes 1.5 s; `process.exit` is held.
 *
 * | #  | `ps` while stopping                  | catches                                                          |
 * |----|--------------------------------------|------------------------------------------------------------------|
 * | P1 | fails (EAGAIN)                       | "cannot tell" taken for "terminal lost": every group SIGKILLed,  |
 * |    |                                      | exit 130, on one failed read                                     |
 * | P2 | prints nothing it can parse          | the same, for output it cannot read                              |
 * | P3 | never answers                        | a read waited for, or started again while one is running; a     |
 * |    |                                      | `ps` with no bound                                               |
 * | P4 | names another group                  | the `ps` path never escalating: the rows above passing because   |
 * |    |                                      | nothing is read                                                  |
 */

import { execFile } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async original => ({ ...(await original<typeof import('node:child_process')>()), execFile: vi.fn() }));

type Answer = (callback: (error: Error | null, stdout: string) => void) => void;

const ps = vi.mocked(execFile);
const platform = process.platform;
const listeners = (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'exit'] as const).map(name => [name, process.listeners(name as NodeJS.Signals)] as const);
const group = 4242;
const inForeground: Answer = callback => callback(null, `${group} ${group}\n`);
const STOPS_IN_1500_MS = 'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1500)); setInterval(() => {}, 1000);';

let answer: Answer;

beforeEach(() =>
{
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    answer = inForeground;
    ps.mockImplementation(((_file: string, _args: string[], _options: object, callback: Parameters<Answer>[0]) =>
    {
        setImmediate(() => answer(callback));

        return { kill: vi.fn() };
    }) as never);
});

afterEach(() =>
{
    Object.defineProperty(process, 'platform', { value: platform });
    listeners.forEach(([name, kept]) => process.listeners(name as NodeJS.Signals).filter(listener => !kept.includes(listener)).forEach(listener => process.off(name, listener as never)));
    vi.restoreAllMocks();
});

/** Start the supervisor and its child, let `ps` answer once, switch it to `whileStopping`, and stop. */
async function stopWith(whileStopping: Answer): Promise<{ sent: unknown[]; exitCode: unknown; psCallsWhileStopping: number }>
{
    const { DevSupervisor } = await import('../dev-supervisor.js');
    const supervisor = new DevSupervisor();
    const child = supervisor.start('server', process.execPath, ['-e', STOPS_IN_1500_MS], { cwd: process.cwd() })!;
    const kill = vi.spyOn(process, 'kill');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await new Promise(settle => setTimeout(settle, 300));
    answer = whileStopping;

    const callsBefore = ps.mock.calls.length;
    const stopped = supervisor.stop();

    await child.ended;
    await stopped;

    return {
        sent: kill.mock.calls.filter(([pid, signal]) => pid === -child.process.pid! && signal !== 0).map(([, signal]) => signal),
        exitCode: exit.mock.calls[0]?.[0],
        psCallsWhileStopping: ps.mock.calls.length - callsBefore,
    };
}

it.each<[string, string, Answer]>([
    ['P1', 'fails', callback => callback(Object.assign(new Error('spawn ps EAGAIN'), { code: 'EAGAIN' }), '')],
    ['P2', 'prints nothing it can parse', callback => callback(null, '   -\n')],
])('%s a `ps` that %s while stopping cannot tell: the graceful stop', async (_row, _case, whileStopping) =>
{
    const { sent, exitCode, psCallsWhileStopping } = await stopWith(whileStopping);

    expect({ sent, exitCode, read: psCallsWhileStopping > 1 }).toEqual({ sent: ['SIGTERM'], exitCode: 0, read: true });
}, 20_000);

it('P3 a `ps` that never answers is not waited for, nor started again, and is bounded', async () =>
{
    const { sent, exitCode, psCallsWhileStopping } = await stopWith(() => undefined);

    expect({ sent, exitCode, psCallsWhileStopping }).toEqual({ sent: ['SIGTERM'], exitCode: 0, psCallsWhileStopping: 1 });
    expect(ps.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 1000, killSignal: 'SIGKILL' });
}, 20_000);

it('P4 a `ps` naming another group while stopping escalates: the terminal was taken back', async () =>
{
    const { sent, exitCode } = await stopWith(callback => callback(null, `${group} ${group + 1}\n`));

    expect({ sent, exitCode }).toEqual({ sent: ['SIGTERM', 'SIGKILL'], exitCode: 130 });
}, 20_000);
