/**
 * Teardown for rows that start a real `spfn dev`: every child it starts leads
 * a process group of its own (#358), so killing the group of the process a row
 * started no longer reaches them. Instead each row tags the environment of what
 * it starts — every descendant inherits it — and teardown SIGKILLs every
 * process whose initial environment carries the tag, wherever it was
 * reparented to. Linux only (`/proc`), where CI and the dev VM run.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

export const ROW_TAG_VARIABLE = 'SPFN_TEST_PROCESS_TREE';

/** A tag for one row's processes, set as `ROW_TAG_VARIABLE` in their environment. */
export function newRowTag(): string
{
    return randomUUID();
}

/** The pids of every process whose environment carries `tag`. */
export function taggedPids(tag: string): number[]
{
    const marker = `${ROW_TAG_VARIABLE}=${tag}\0`;

    return readdirSync('/proc')
        .filter(entry => /^\d+$/.test(entry))
        .map(Number)
        .filter(pid => pid !== process.pid && readEnviron(pid).includes(marker));
}

/** SIGKILL every process tagged `tag`, twice over: one forked while the first sweep ran is caught by the second. */
export async function killTagged(tag: string): Promise<void>
{
    for (const _sweep of [1, 2])
    {
        taggedPids(tag).forEach(pid => signal(pid, 'SIGKILL'));
        await new Promise(settle => setTimeout(settle, 200));
    }
}

function readEnviron(pid: number): string
{
    try
    {
        return readFileSync(`/proc/${pid}/environ`, 'latin1');
    }
    catch
    {
        // Gone, or another user's.
        return '';
    }
}

function signal(pid: number, name: NodeJS.Signals): void
{
    try
    {
        process.kill(pid, name);
    }
    catch
    {
        // ESRCH: already gone.
    }
}
