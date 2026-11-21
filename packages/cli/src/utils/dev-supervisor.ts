import { execa, type ExecaChildProcess } from 'execa';
import { logger } from './logger.js';
import { Launcher } from './launcher.js';
import { TerminalForeground } from './terminal-foreground.js';

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
 * taken as given: when the launcher that started `spfn dev` from a terminal's
 * shell has exited (`Launcher`: the outermost of it, the process the shell
 * started) **and** another group has the terminal
 * (`TerminalForeground` answers `taken`). Each half alone is wrong. A
 * terminal taken with no launcher exited is job control: `spfn dev` typed
 * directly, Ctrl-Z, `bg`, `kill %1` — `fg` and Ctrl-C can still reach it. A
 * launcher exited with the terminal still the job's is a pipeline whose
 * reader survives the Ctrl-C (`pnpm exec spfn dev | tee -i log`), or a
 * launcher that left on its own: a further Ctrl-C still reaches `spfn dev`.
 * `pnpm run`, `npm run` and `npx` wait for `spfn dev`; `pnpm exec`, `pnpm
 * <bin>` and yarn 1 exit on the first Ctrl-C, the shell sees its job end and
 * takes the terminal back, and a further Ctrl-C goes to the shell. So when
 * the stop begins, and every `LAUNCHER_READ_MS` while it runs, `spfn dev` asks
 * whether its launcher has exited and, once it has, where a Ctrl-C goes; when
 * that is another group it escalates as a second SIGINT does. The terminal is
 * read only during the stop, so no answer from before it decides; `none` (a
 * process manager, CI, a terminal that hung up) and `unknown` never escalate.
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
/** How often a stop asks whether the launcher has exited (a `kill(pid, 0)`) and, once it has, where a Ctrl-C goes. */
const LAUNCHER_READ_MS = 100;
const KILLING = 'killing what is left of the server, Next.js and the codegen watcher';
const ALONE = 'the launcher that started spfn dev has exited and the shell has the terminal, so no second Ctrl-C can reach it';
/** A closed reader's exit status: what a shell reports for a process SIGPIPE ended (128 + 13). */
const READER_GONE = 141;

export class DevSupervisor
{
    private readonly children = new Set<DevChild>();
    private readonly signalled = new Set<DevChild>();
    private readonly launcher = new Launcher();
    private readonly terminal = new TerminalForeground();
    private stopping = false;
    private killing = false;
    private exitCode = 0;

    constructor()
    {
        STOP_SIGNALS.forEach(signal => process.on(signal, () => this.onSignal(signal)));
        // spfn dev exiting otherwise — an uncaught exception — stops each child
        // not stopped yet. execa's own cleanup skips detached children, so
        // this is the only one they have.
        process.on('exit', () =>
        {
            this.launcher.close();
            this.terminal.close();
            this.children.forEach(child => this.signalOnce(child));
        });
        [process.stdout, process.stderr].forEach(stream => stream.on('error', error => this.onOutputError(stream, error)));
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

        this.escalateIfAlone();

        if (!this.killing)
        {
            logger.info('[SPFN] Stopping the server, Next.js and the codegen watcher (Ctrl-C again to kill them now)');
            children.forEach(child => this.signalOnce(child));
        }

        this.watchLauncher();

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

    /** Every `LAUNCHER_READ_MS` while stopping, until something escalated or every group is empty: escalate once no second Ctrl-C can arrive. */
    private watchLauncher(): void
    {
        setTimeout(() =>
        {
            if (!this.killing && this.children.size > 0)
            {
                this.escalateIfAlone();
                this.watchLauncher();
            }
        }, LAUNCHER_READ_MS).unref();
    }

    /** Escalate when the launcher has exited and another group has the terminal; the terminal is read only once the launcher is gone. */
    private escalateIfAlone(): void
    {
        if (!this.launcher.exited())
        {
            return;
        }

        this.terminal.read((answer) =>
        {
            if (answer === 'taken' && !this.killing && this.children.size > 0)
            {
                this.killAll(ALONE);
            }
        });
    }

    /**
     * What reads `spfn dev`'s output has gone: a write fails with EPIPE (a pipe
     * whose reader exited: `spfn dev | head -1`, or `| tee log` after the
     * Ctrl-C that killed `tee`), or with EIO on a terminal that hung up.
     * Unhandled, either ends `spfn dev` and leaves its children unsupervised.
     * Outside a stop it is a reason to stop: the graceful one, as for a signal.
     * A closed pipe is what SIGPIPE stands for, and `spfn dev` exits as a
     * process SIGPIPE ended is reported, 141, once every group is empty: it did
     * not finish its work, its reader went away, and under `set -o pipefail`
     * the pipeline says so. A hung-up terminal's EIO comes after its SIGHUP,
     * whose stop it is (exit 0). During a stop it changes nothing: the stream
     * stays open, and each later write fails the same way.
     * Any other error on stdout or stderr is thrown, an uncaught exception as
     * without the listener. The codegen watcher's entry outlives its output by
     * itself (`watcherEntrySource`); `spfn dev` stops it.
     */
    private onOutputError(stream: NodeJS.WriteStream, error: NodeJS.ErrnoException): void
    {
        if (error.code !== 'EPIPE' && !(error.code === 'EIO' && stream.isTTY))
        {
            throw error;
        }

        void this.stop(error.code === 'EPIPE' ? READER_GONE : 0);
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
