/**
 * What a generation read
 *
 * Every project file a load reads gets a stamp, taken by the codegen loader's
 * load hook as it reads the file: a stat taken before the read (inode, size,
 * modification time in nanoseconds) and a hash of the source the read
 * returned. A path an import that resolved nowhere was looked for at gets a
 * stamp saying it did not exist. The stamp therefore describes the exact bytes
 * the generation used: a write after the stat changes the modification time,
 * so a comparison errs towards "changed", never towards "unchanged".
 *
 * The watcher compares the stamps against the file system after each
 * generation (`checkStamp`), so a change is found whichever file event
 * reported it, or none did.
 *
 * Loads report what they read into the collector the orchestrator opens
 * around each `generate()` call (`collectInputs`), which attributes the files
 * to the generator that ran: no record is kept between loads, or in a module.
 * A load outside a collector — `spfn codegen run` without a watcher, a test
 * calling a generator directly — reports into nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, type BigIntStats } from 'node:fs';

export type Stamp =
    | { exists: false }
    | {
        exists: true;
        ino: bigint;
        size: bigint;
        mtimeNs: bigint;
        hash: string;

        /** Wall-clock time the stat was taken, in nanoseconds (`isRacy`). */
        takenNs: bigint;
    };

/** Stamps by real path. */
export type Inputs = Map<string, Stamp>;

/**
 * A modification time this close to when its stat was taken may not change on
 * a further write: file systems keep it at the granularity of the kernel's
 * clock tick, or of seconds. Such a stamp's stat is not trusted on its own
 * (git's "racily clean" entries, the same reasoning).
 */
const RACY_NS = 2_000_000_000n;

/** The stamp of a path an import that resolved nowhere was looked for at. */
export const ABSENT: Stamp = { exists: false };

function hashOf(source: string): string
{
    return createHash('sha1').update(source).digest('hex');
}

function nowNs(): bigint
{
    return BigInt(Date.now()) * 1_000_000n;
}

/** The stat of `file`, or undefined when there is none to take: missing, or a path through a file (ENOTDIR). */
function statOf(file: string): BigIntStats | undefined
{
    try
    {
        return statSync(file, { bigint: true, throwIfNoEntry: false });
    }
    catch
    {
        return undefined;
    }
}

function stampFrom(stats: BigIntStats, takenNs: bigint, source: string): Stamp
{
    return { exists: true, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, hash: hashOf(source), takenNs };
}

/**
 * Read `file` as the load hook does, with its stamp: the stat is taken before
 * the read, so a write racing the read leaves a stamp that compares stale.
 */
export function readStamped(file: string): { source: string; stamp: Stamp }
{
    const takenNs = nowNs();
    const stats = statSync(file, { bigint: true });
    const source = readFileSync(file, 'utf8');

    return { source, stamp: stampFrom(stats, takenNs, source) };
}

/** The stamp of `file` as it is now: absent when it is not a file, or cannot be read. */
export function stampOf(file: string): Stamp
{
    try
    {
        return readStamped(file).stamp;
    }
    catch
    {
        return ABSENT;
    }
}

function isRacy(stamp: Stamp & { exists: true }): boolean
{
    return stamp.mtimeNs + RACY_NS > stamp.takenNs;
}

/**
 * Compare `stamp` with `file` as it is now. Existence differs: stale. The same
 * inode, size and modification time, on a stamp that is not racy: fresh.
 * Otherwise the file is read and hashed: the same hash is fresh, and the
 * stamp returned for it replaces the old one, so the next check is a stat.
 * `exists` is whether `file` is a file now.
 */
export function checkStamp(file: string, stamp: Stamp): { fresh: boolean; stamp: Stamp; exists: boolean }
{
    const stats = statOf(file);
    const exists = stats?.isFile() ?? false;

    if (!exists || !stamp.exists)
    {
        return { fresh: exists === stamp.exists, stamp, exists };
    }

    if (stats!.ino === stamp.ino && stats!.size === stamp.size && stats!.mtimeNs === stamp.mtimeNs && !isRacy(stamp))
    {
        return { fresh: true, stamp, exists };
    }

    const now = stampOf(file);

    return now.exists && now.hash === stamp.hash ? { fresh: true, stamp: now, exists } : { fresh: false, stamp, exists };
}

const collector = new AsyncLocalStorage<Inputs>();

/**
 * Run `fn` with a collector open: every load inside it reports the files it
 * read into the returned `inputs`, whether `fn` resolves or rejects (a load
 * that failed is to be retried when a file it read or looked for changes). A
 * path read twice keeps its first stamp: if it changed between the two reads,
 * it differs from the first.
 */
export async function collectInputs(fn: () => Promise<void>): Promise<{ inputs: Inputs; failure?: { error: unknown } }>
{
    const inputs: Inputs = new Map();
    const failure = await collector.run(inputs, fn).then(() => undefined, (error: unknown) => ({ error }));

    return { inputs, failure };
}

/** Add what a load read to the collector open around it, if any. */
export function reportInputs(inputs: Inputs): void
{
    const into = collector.getStore();

    if (into === undefined)
    {
        return;
    }

    for (const [file, stamp] of inputs)
    {
        if (!into.has(file))
        {
            into.set(file, stamp);
        }
    }
}
