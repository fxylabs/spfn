import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Whether this process's group is the foreground group of its controlling
 * terminal: whether a Ctrl-C typed in that terminal now reaches it. False
 * without a controlling terminal (a process manager, a pipe, CI) and on
 * Windows. Linux reads `/proc/self/stat`; other POSIX systems ask `ps`.
 */
export function inTerminalForeground(): boolean
{
    if (process.platform === 'win32')
    {
        return false;
    }

    const groups = process.platform === 'linux' ? groupsFromProc() : groupsFromPs();

    return groups !== null && groups.terminalForeground > 0 && groups.own === groups.terminalForeground;
}

interface Groups
{
    own: number;
    terminalForeground: number;
}

/** `pgrp` and `tpgid`, the 5th and 8th fields of `/proc/self/stat` (the 3rd and 6th after the command's `)`). */
function groupsFromProc(): Groups
{
    const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');

    return { own: Number(fields[2]), terminalForeground: Number(fields[5]) };
}

function groupsFromPs(): Groups | null
{
    try
    {
        const [own, terminalForeground] = execFileSync('ps', ['-o', 'pgid=,tpgid=', '-p', String(process.pid)], { encoding: 'utf8' })
            .trim().split(/\s+/).map(Number);

        return { own, terminalForeground };
    }
    catch
    {
        // No ps: no terminal this process can tell it has.
        return null;
    }
}
