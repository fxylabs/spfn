import { execFile, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Where a Ctrl-C typed in this process's controlling terminal goes, as read now (#358):
 * - `foreground`: to this process's group — it reaches `spfn dev`;
 * - `taken`: to another group — the shell took the terminal back;
 * - `none`: nowhere — there is no controlling terminal (a process manager, CI,
 *   Windows), or no longer one (the terminal hung up: the kernel removes it
 *   before the SIGHUP is handled);
 * - `unknown`: the read failed, printed something it cannot parse, or did not
 *   answer.
 */
export type TerminalAnswer = 'foreground' | 'taken' | 'none' | 'unknown';

/** A `ps` not done by then is killed, and its answer is `unknown`. */
const PS_TIMEOUT_MS = 1000;
/** The least time between two `ps` started. */
const PS_INTERVAL_MS = 1000;

/**
 * Reads of the terminal's foreground for this process. Linux reads
 * `/proc/self/stat`, synchronously. Other POSIX systems ask `ps` without
 * waiting for it, one at a time and no more often than every
 * `PS_INTERVAL_MS`: a read asked for while a `ps` runs, or sooner, is not
 * made, and its caller asks again later.
 */
export class TerminalForeground
{
    private ps: ChildProcess | null = null;
    private askedAt = -Infinity;

    /** Read the terminal now; `answered` gets the answer, before the return on Linux, when `ps` answers elsewhere. */
    read(answered: (answer: TerminalAnswer) => void): void
    {
        if (process.platform === 'win32')
        {
            answered('none');
        }
        else if (process.platform === 'linux')
        {
            answered(answerFromProc());
        }
        else if (this.ps === null && Date.now() - this.askedAt >= PS_INTERVAL_MS)
        {
            this.askedAt = Date.now();
            this.ps = askPs(answer =>
            {
                this.ps = null;
                answered(answer);
            });
        }
    }

    /** Kill a `ps` still running: this process is exiting. */
    close(): void
    {
        this.ps?.kill('SIGKILL');
    }
}

function answerOf(own: number, terminalForeground: number): TerminalAnswer
{
    if (!Number.isInteger(own) || !Number.isInteger(terminalForeground) || own <= 0)
    {
        return 'unknown';
    }

    if (terminalForeground <= 0)
    {
        return 'none';
    }

    return own === terminalForeground ? 'foreground' : 'taken';
}

/** `pgrp` and `tpgid`, the 5th and 8th fields of `/proc/self/stat` (the 3rd and 6th after the command's last `)`). */
function answerFromProc(): TerminalAnswer
{
    try
    {
        const stat = readFileSync('/proc/self/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');

        return answerOf(Number(fields[2]), Number(fields[5]));
    }
    catch
    {
        // An unreadable /proc: nothing is known.
        return 'unknown';
    }
}

/** Start a `ps` for this process's group and its terminal's; null when it could not be started (answered `unknown` then). */
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
