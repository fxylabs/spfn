import { execa, type ExecaChildProcess } from 'execa';
import { logger } from './logger.js';

/**
 * The process tree `spfn dev` owns (#358).
 *
 * Every child — the server, Next.js, the codegen watcher — is started as the
 * leader of a process group of its own, and is stopped by one SIGTERM to that
 * group: it reaches the process behind a wrapper (`pnpm run` and the `sh -c` it
 * runs the `spfn:next` script under, which forward nothing) the same as one
 * started directly, and it is sent once. A terminal's Ctrl-C goes to the
 * terminal's foreground group only — `spfn dev` itself, since `bin/spfn.js`
 * replaces its process rather than spawning one — so it reaches each child once,
 * through this supervisor, and never a second time from the terminal.
 *
 * `spfn dev` exits only once every group is empty, with no deadline of its own:
 * the server's is core's (`SHUTDOWN_TIMEOUT`). SIGTERM and SIGHUP, whenever they
 * come and however often, mean "stop": a repeat is not an escalation, since
 * `pnpm exec spfn dev` adds a SIGTERM to a Ctrl-C's SIGINT, and the terminal
 * hangs up after its job. A SIGINT once the stop has begun — a person pressing
 * Ctrl-C again — SIGKILLs every group left, and `spfn dev` exits 130. A SIGKILL
 * of `spfn dev` reaches no child.
 *
 * Children get no stdin: a background group reading the terminal would be
 * stopped by it (SIGTTIN) and never exit. Windows has no process groups: there
 * the leader alone is signalled and waited for.
 */

export type DevChildName = 'server' | 'Next.js' | 'codegen watcher';

/** A child `spfn dev` started, the leader of its own process group. */
export interface DevChild
{
    readonly name: DevChildName;
    readonly process: ExecaChildProcess;

    /** Resolves once no process is left in the child's group. */
    readonly ended: Promise<void>;
}

const PROCESS_GROUPS = process.platform !== 'win32';
const GROUP_POLL_MS = 100;

export class DevSupervisor
{
    private readonly children = new Set<DevChild>();
    private readonly signalled = new Set<DevChild>();
    private stopping = false;
    private exitCode = 0;

    constructor()
    {
        process.on('SIGINT', () => this.onSignal('SIGINT'));
        process.on('SIGTERM', () => this.onSignal('SIGTERM'));
        process.on('SIGHUP', () => this.onSignal('SIGHUP'));
    }

    /** Whether a stop has begun. */
    readonly isStopping = (): boolean => this.stopping;

    /**
     * The only way `spfn dev` starts a child: `command` with `args` in a group
     * of its own. Once a stop has begun it says so, starts nothing, and returns
     * null: a child started after the others were signalled would never be.
     */
    start(name: DevChildName, command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): DevChild | null
    {
        if (this.stopping)
        {
            logger.info(`[SPFN] ${name} not started: spfn dev is stopping`);

            return null;
        }

        const child = execa(command, args, {
            ...options,
            stdio: ['ignore', 'inherit', 'inherit'],
            reject: false,
            detached: PROCESS_GROUPS,
        });
        const supervised: DevChild = { name, process: child, ended: groupEnded(child) };

        this.children.add(supervised);
        supervised.ended.then(() =>
        {
            this.children.delete(supervised);
            this.signalled.delete(supervised);
        });

        return supervised;
    }

    /** Stop one child (a server restart): SIGTERM its group once; resolves once the group is empty. */
    stopChild(child: DevChild): Promise<void>
    {
        this.signalOnce(child);

        return child.ended;
    }

    /** Stop every child, then exit with `exitCode` once every group is empty. Only the first call acts. */
    async stop(exitCode = 0): Promise<void>
    {
        if (this.stopping)
        {
            return;
        }

        this.stopping = true;
        this.exitCode = exitCode;

        const children = [...this.children];

        children.forEach(child => this.signalOnce(child));
        await Promise.all(children.map(child => child.ended));
        process.exit(this.exitCode);
    }

    private onSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void
    {
        if (this.stopping && signal === 'SIGINT')
        {
            logger.warn('[SPFN] Second interrupt: killing what is left of the server, Next.js and the codegen watcher');
            this.exitCode = 130;
            this.children.forEach(child => signalGroup(child.process, 'SIGKILL'));

            return;
        }

        void this.stop();
    }

    /** SIGTERM the child's group, unless it was already sent one or has ended. */
    private signalOnce(child: DevChild): void
    {
        if (this.children.has(child) && !this.signalled.has(child))
        {
            this.signalled.add(child);
            signalGroup(child.process, 'SIGTERM');
        }
    }
}

/** Send `signal` to every process in the group `child` leads; a group already empty is skipped. */
function signalGroup(child: ExecaChildProcess, signal: NodeJS.Signals): void
{
    if (child.pid === undefined)
    {
        return;
    }

    try
    {
        process.kill(PROCESS_GROUPS ? -child.pid : child.pid, signal);
    }
    catch
    {
        // ESRCH: nothing is left in the group.
    }
}

/**
 * Resolves once the leader has exited and no process is left in its group: a
 * wrapper (`pnpm run`, `sh -c`) exits before what it runs.
 */
async function groupEnded(child: ExecaChildProcess): Promise<void>
{
    await child;

    while (PROCESS_GROUPS && child.pid !== undefined && groupAlive(child.pid))
    {
        await new Promise(settle => setTimeout(settle, GROUP_POLL_MS));
    }
}

function groupAlive(pgid: number): boolean
{
    try
    {
        process.kill(-pgid, 0);

        return true;
    }
    catch (error)
    {
        // EPERM: a process of the group runs as another user — still there.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}
