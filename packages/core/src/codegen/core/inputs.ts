/**
 * What a generation read
 *
 * Every project file a load reads gets a stamp, taken by the codegen loader as
 * it reads the file: a hash of the source the read returned. A path the loader
 * looked for something at and found nothing — every candidate an import's
 * resolution tried before the file it resolved to (or all of them, when it
 * resolved nowhere), a tsconfig.json or package.json looked for in a directory
 * that has none — gets a stamp saying it did not exist. The stamp therefore describes the exact bytes the generation
 * used, and nothing else: no stat field stands in for them, since a file can
 * be rewritten in place with its size and modification time kept
 * (`rsync --inplace -t`, `touch -r`), and a clock that file times are compared
 * with may lag the file system's.
 *
 * The watcher compares the stamps against the file system after each
 * generation (`checkStamp`): existence, then the hash of what is there now. A
 * change is found whichever file event reported it, or none did.
 *
 * Loads report what they read into the collector the orchestrator opens
 * around each `generate()` call (`collectInputs`), which attributes the files
 * to the generator that ran: no record is kept between loads, or in a module.
 * A load outside a collector — `spfn codegen run` without a watcher, a test
 * calling a generator directly — reports into nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export type Stamp = { exists: false } | { exists: true; hash: string };

/** Stamps by real path. */
export type Inputs = Map<string, Stamp>;

/** The stamp of a path a resolution looked for at and found nothing. */
export const ABSENT: Stamp = { exists: false };

/** Whether `file` is a file: missing, a directory, or a path through a file (ENOTDIR) is not. */
function isFile(file: string): boolean
{
    try
    {
        return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
    }
    catch
    {
        return false;
    }
}

/** Read `file` as the load hook does, with the stamp of what was read. */
export function readStamped(file: string): { source: string; stamp: Stamp }
{
    const source = readFileSync(file, 'utf8');

    return { source, stamp: { exists: true, hash: createHash('sha1').update(source).digest('hex') } };
}

/** The stamp of `file` as it is now: absent when it is not a file, or cannot be read. */
export function stampOf(file: string): Stamp
{
    if (!isFile(file))
    {
        return ABSENT;
    }

    try
    {
        return readStamped(file).stamp;
    }
    catch
    {
        return ABSENT;
    }
}

/**
 * The stamp of a path one record holds two different reads of: what was built
 * from them mixes both, so it matches no content, and the path is stale
 * whatever is on disk at the check.
 */
const TORN: Stamp = { exists: true, hash: '' };

function sameStamp(a: Stamp, b: Stamp): boolean
{
    return a.exists ? b.exists && a.hash === b.hash : !b.exists;
}

/**
 * Compare `stamp` with `file` as it is now: fresh when both say it does not
 * exist, or both hold the same content. `exists` is whether `file` is a file now.
 */
export function checkStamp(file: string, stamp: Stamp): { fresh: boolean; exists: boolean }
{
    const now = stampOf(file);

    return { fresh: sameStamp(now, stamp), exists: now.exists };
}

/**
 * Add a read of `file` to `inputs`. A path read again keeps its stamp when
 * the read found the same; a path found different is `TORN`.
 */
export function addStamp(inputs: Inputs, file: string, stamp: Stamp): void
{
    const first = inputs.get(file);

    if (first === undefined)
    {
        inputs.set(file, stamp);
    }
    else if (!sameStamp(first, stamp))
    {
        inputs.set(file, TORN);
    }
}

const collector = new AsyncLocalStorage<Inputs>();

/**
 * Run `fn` with a collector open: every load inside it reports the files it
 * read into the returned `inputs`, whether `fn` resolves or rejects (a load
 * that failed is to be retried when a file it read or looked for changes). A
 * path two loads found different — the environment probe loads the router
 * again for each variation, and a save can land between two loads — is
 * stamped `TORN`: stale even if it changes back before the check.
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

    inputs.forEach((stamp, file) => addStamp(into, file, stamp));
}
