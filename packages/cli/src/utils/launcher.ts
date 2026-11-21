import { execFile, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The launcher that started `spfn dev` from a terminal's shell, and whether it
 * has exited (#358).
 *
 * A shell runs each job in a process group of its own. Typed directly, `spfn
 * dev` is the process the shell started (`bin/spfn.js` replaces its process
 * rather than spawning one), and its parent, the shell, is outside the group:
 * it has no launcher. Under `pnpm exec`, `pnpm <bin>`, `pnpm run`, `npm run`,
 * `npx` or yarn, the launcher is `spfn dev`'s ancestors inside its own group:
 * from its parent up, while the group is `spfn dev`'s. The launcher need not
 * lead the group: in `cat | pnpm exec spfn dev` the leader is `cat`, and the
 * launcher is pnpm; in `true | spfn dev` there is none.
 *
 * It has exited once the outermost of those ancestors has — the process the
 * shell itself started: `kill(pid, 0)` answers ESRCH. The shell's job ends, and
 * the shell takes the terminal back, when that process is gone, not when an
 * inner one is: in `bash -c 'pnpm exec spfn dev; sleep 20'`, pnpm exits on a
 * Ctrl-C while the `bash -c` waits on, the job still listed and `fg` + Ctrl-C
 * still reaching `spfn dev`. A launcher that waits for `spfn dev` (`pnpm run`,
 * `npm run`, `npx`) is there until `spfn dev` exits; one that exits on the
 * first Ctrl-C (`pnpm exec`, `pnpm <bin>`, yarn 1, whose `sh -c` stays behind
 * as `spfn dev`'s parent while yarn, the outermost, exits) is not. Whether a second Ctrl-C can still arrive is the
 * terminal's to say (`TerminalForeground`), not the launcher's: in `pnpm exec
 * spfn dev | tee -i log` the launcher exits and the job keeps the terminal.
 *
 * Linux reads `/proc`. Other POSIX systems ask `ps` once, at start, without
 * waiting for it; until it answers, and when it fails, no launcher is known.
 * Whether it exited is `kill(pid, 0)` on every system, a system call, not a
 * process. Windows has no process groups: no launcher.
 */
export class Launcher
{
    private pid: number | null = null;
    private ps: ChildProcess | null = null;

    constructor()
    {
        if (process.platform === 'linux')
        {
            this.pid = outermostLauncher(procEntry);
        }
        else if (process.platform !== 'win32')
        {
            this.ps = askPs(table =>
            {
                this.ps = null;
                this.pid = outermostLauncher(pid => table.get(pid));
            });
        }
    }

    /** Whether a launcher was found and has exited since. */
    exited(): boolean
    {
        return this.pid !== null && !processExists(this.pid);
    }

    /** Kill a `ps` still running: this process is exiting. */
    close(): void
    {
        this.ps?.kill('SIGKILL');
    }
}

interface ProcessEntry
{
    ppid: number;
    pgid: number;
}

/** A `ps` not done by then is killed, and no launcher is known. */
const PS_TIMEOUT_MS = 1000;
/** A bound on the walk up the parents, for a table that loops. */
const MAX_ANCESTORS = 64;

/** The outermost of this process's ancestors in its own process group: none when its parent is outside it. */
function outermostLauncher(lookup: (pid: number) => ProcessEntry | undefined): number | null
{
    const group = lookup(process.pid)?.pgid;
    let outermost: number | null = null;
    let pid = lookup(process.pid)?.ppid ?? 0;
    let entry = lookup(pid);

    for (let walked = 0; entry !== undefined && entry.pgid === group && walked < MAX_ANCESTORS; walked++)
    {
        outermost = pid;
        pid = entry.ppid;
        entry = lookup(pid);
    }

    return outermost;
}

/** `ppid` and `pgrp`, the 4th and 5th fields of `/proc/<pid>/stat` (the 2nd and 3rd after the command's last `)`). */
function procEntry(pid: number): ProcessEntry | undefined
{
    try
    {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');

        return entryOf(stat.slice(stat.lastIndexOf(') ') + 2).split(' ').slice(1, 3));
    }
    catch
    {
        // The process is gone, or /proc is unreadable: nothing is known of it.
        return undefined;
    }
}

/** Start one `ps` for every process; `answered` gets the table, empty when `ps` failed. */
function askPs(answered: (table: Map<number, ProcessEntry>) => void): ChildProcess | null
{
    try
    {
        return execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 },
            (error, stdout) => answered(error === null ? tableFromPs(stdout) : new Map()));
    }
    catch
    {
        // A spawn error Node throws rather than reports (most come to the callback).
        answered(new Map());

        return null;
    }
}

function tableFromPs(stdout: string): Map<number, ProcessEntry>
{
    const table = new Map<number, ProcessEntry>();

    for (const line of stdout.split('\n'))
    {
        const [pid, ...rest] = line.trim().split(/\s+/);
        const entry = entryOf(rest);

        if (entry !== undefined)
        {
            table.set(Number(pid), entry);
        }
    }

    return table;
}

function entryOf([ppid, pgid]: string[]): ProcessEntry | undefined
{
    const entry = { ppid: Number(ppid), pgid: Number(pgid) };

    return Number.isInteger(entry.ppid) && Number.isInteger(entry.pgid) && entry.pgid > 0 ? entry : undefined;
}

function processExists(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);

        return true;
    }
    catch (error)
    {
        // EPERM: it runs as another user — still there.
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}
