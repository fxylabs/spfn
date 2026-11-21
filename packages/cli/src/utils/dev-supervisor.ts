import { execa, type ExecaChildProcess } from 'execa';
import { logger } from './logger.js';
import { TerminalWatch } from './terminal-foreground.js';

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
 * the server's is core's (`SHUTDOWN_TIMEOUT`). SIGTERM, SIGHUP and SIGQUIT
 * (Ctrl-\), whenever they come and however often, mean "stop": a repeat is not
 * an escalation, since `pnpm exec spfn dev` adds a SIGTERM to a Ctrl-C's
 * SIGINT, and the terminal hangs up after its job. A SIGINT once the stop has
 * begun — a person pressing Ctrl-C again — SIGKILLs every group left, and `spfn
 * dev` exits 130. If `spfn dev` exits any other way (an uncaught exception), it
 * SIGTERMs every group not signalled yet as it goes; only a SIGKILL of `spfn
 * dev` reaches no child.
 *
 * A second Ctrl-C means "stop waiting", and when it can no longer arrive it is
 * taken as given. It can arrive while `spfn dev`'s group is its terminal's
 * foreground group, as it is when started from a shell — directly, or behind
 * `pnpm run`, `npm run` or `npx`, which share the group and wait for `spfn dev`.
 * `pnpm exec`, `pnpm <bin>` and yarn 1 exit on the first Ctrl-C; the shell then
 * sees its job end and takes the terminal back, and a further Ctrl-C goes to
 * the shell. So while stopping, `spfn dev`, if it had the terminal's
 * foreground when it started, escalates as a second SIGINT does as soon as a
 * read (`TerminalWatch`, every `TERMINAL_READ_MS`) finds another group there —
 * the moment it begins to stop, if that group took it before. A read that
 * cannot tell (a failing or hung `ps`) does not escalate. Without a terminal
 * (a process manager, CI) nothing but a signal escalates.
 *
 * Each child is a session of its own (`detached` is `setsid`): it has no
 * controlling terminal, so job control does not touch it. A Ctrl-Z stops
 * `spfn dev` and leaves the children running, and a child reading the
 * terminal it inherited would get what the user types, taking it from the
 * shell — not SIGTTIN, not EIO. So children get no stdin. Windows has no process
 * groups: there the leader alone is signalled and waited for.
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

/** Each means "stop". SIGQUIT is a terminal's Ctrl-\, which reaches `spfn dev` only, as Ctrl-C does. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

type StopSignal = typeof STOP_SIGNALS[number];

const PROCESS_GROUPS = process.platform !== 'win32';
const GROUP_POLL_MS = 100;
/** How often the terminal is read while stopping. */
const TERMINAL_READ_MS = 100;
const KILLING = 'killing what is left of the server, Next.js and the codegen watcher';
const TERMINAL_LOST = 'spfn dev no longer has the terminal, so no second Ctrl-C can reach it';

export class DevSupervisor
{
    private readonly children = new Set<DevChild>();
    private readonly signalled = new Set<DevChild>();
    private readonly terminal = new TerminalWatch();
    private stopping = false;
    private killing = false;
    private exitCode = 0;

    constructor()
    {
        STOP_SIGNALS.forEach(signal => process.on(signal, () => this.onSignal(signal)));
        // spfn dev exiting otherwise — an uncaught exception, a write to a closed
        // stdout — stops each child not stopped yet. execa's own cleanup skips
        // detached children, so this is the only one they have.
        process.on('exit', () =>
        {
            this.terminal.close();
            this.children.forEach(child => this.signalOnce(child));
        });
        this.terminal.read();
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

        this.terminal.read();

        if (this.terminal.lost())
        {
            this.killAll(TERMINAL_LOST);
        }
        else
        {
            logger.info('[SPFN] Stopping the server, Next.js and the codegen watcher (Ctrl-C again to kill them now)');
            children.forEach(child => this.signalOnce(child));
            this.watchTerminal();
        }

        await Promise.all(children.map(child => child.ended));
        process.exit(this.exitCode);
    }

    private onSignal(signal: StopSignal): void
    {
        if (this.stopping && signal === 'SIGINT')
        {
            this.killAll('Second interrupt');

            return;
        }

        void this.stop();
    }

    /** The second Ctrl-C's escalation: SIGKILL every group left; `spfn dev` exits 130 once they are empty. */
    private killAll(reason: string): void
    {
        logger.warn(`[SPFN] ${reason}: ${KILLING}`);
        this.killing = true;
        this.exitCode = 130;
        this.children.forEach(child => signalGroup(child.process, 'SIGKILL'));
    }

    /** While stopping, read the terminal until something escalated or the stop is done; escalate once it is found lost. */
    private watchTerminal(): void
    {
        if (this.killing || this.children.size === 0)
        {
            return;
        }

        this.terminal.read();

        if (this.terminal.lost())
        {
            this.killAll(TERMINAL_LOST);

            return;
        }

        setTimeout(() => this.watchTerminal(), TERMINAL_READ_MS).unref();
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
