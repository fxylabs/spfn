import { execFile, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Where a Ctrl-C typed in this process's controlling terminal goes, as read now:
 * - `foreground`: to this process's group — it reaches `spfn dev`;
 * - `taken`: not to this process's group — the shell took the terminal back,
 *   or there is no terminal (a process manager, a pipe, CI);
 * - `none`: nowhere this process can tell (Windows);
 * - `unknown`: the read failed, printed something it cannot parse, or did not
 *   answer.
 */
export type TerminalAnswer = 'foreground' | 'taken' | 'none' | 'unknown';

/** A `ps` not done by then is killed, and its answer is `unknown`. */
const PS_TIMEOUT_MS = 1000;

/**
 * Reads of the terminal's foreground for one process. Linux reads
 * `/proc/self/stat`, synchronously and at once. Other POSIX systems ask `ps`
 * without waiting for it: `read()` starts a `ps` unless one is still running,
 * and its answer is taken when it comes.
 */
export class TerminalWatch
{
    private latest: TerminalAnswer = 'unknown';
    private sawForeground = false;
    private ps: ChildProcess | null = null;

    /** Read the terminal again; on Linux the answer is in by the return, elsewhere when `ps` answers. */
    read(): void
    {
        if (process.platform === 'win32')
        {
            this.take('none');
        }
        else if (process.platform === 'linux')
        {
            this.take(answerFromProc());
        }
        else if (this.ps === null)
        {
            this.ps = askPs(answer =>
            {
                this.ps = null;
                this.take(answer);
            });
        }
    }

    /**
     * Whether a Ctrl-C from the terminal could reach this process once, and
     * another group has the terminal now: a further Ctrl-C goes to the shell.
     * Not when the last read cannot tell.
     */
    lost(): boolean
    {
        return this.sawForeground && this.latest === 'taken';
    }

    /** Kill a `ps` still running: this process is exiting. */
    close(): void
    {
        this.ps?.kill('SIGKILL');
    }

    private take(answer: TerminalAnswer): void
    {
        this.latest = answer;
        this.sawForeground ||= answer === 'foreground';
    }
}

function answerOf(own: number, terminalForeground: number): TerminalAnswer
{
    if (!Number.isInteger(own) || !Number.isInteger(terminalForeground) || own <= 0)
    {
        return 'unknown';
    }

    return own === terminalForeground ? 'foreground' : 'taken';
}

/** `pgrp` and `tpgid`, the 5th and 8th fields of `/proc/self/stat` (the 3rd and 6th after the command's `)`). */
function answerFromProc(): TerminalAnswer
{
    try
    {
        const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');

        return answerOf(Number(fields[2]), Number(fields[5]));
    }
    catch
    {
        // An unreadable or unexpected /proc: nothing is known.
        return 'unknown';
    }
}

/** Start a `ps` for this process's groups; null when it could not be started (answered `unknown` then). */
function askPs(answered: (answer: TerminalAnswer) => void): ChildProcess | null
{
    try
    {
        return execFile('ps', ['-o', 'pgid=,tpgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL' },
            (error, stdout) => answered(error === null ? answerFromPs(stdout) : 'unknown'));
    }
    catch
    {
        // A spawn error Node throws rather than reports (most come to the callback).
        answered('unknown');

        return null;
    }
}

function answerFromPs(stdout: string): TerminalAnswer
{
    const [own, terminalForeground] = stdout.trim().split(/\s+/).map(Number);

    return answerOf(own, terminalForeground);
}
