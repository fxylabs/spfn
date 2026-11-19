/**
 * Watching what the generations read
 *
 * The orchestrator hands this the paths every generator's latest run read
 * (`./inputs`): files that exist, and paths the loader looked at and found
 * nothing, which do not. The nearest existing directory of each is watched with Node's
 * own, non-recursive `fs.watch`; when anything changes in one, and writes have
 * settled, `changed` is called. Which file the event named, and which kind of
 * event it was, is not used: platforms report them differently (macOS reports
 * most changes as a rename, a save may be an unlink and a create), so the
 * orchestrator compares every input with its stamp instead, and the result is
 * the same whichever event arrived.
 *
 * The set of directories is rebuilt from the paths on every `sync`, never
 * from a difference against what was watched before: a directory that
 * appeared on the way to a missing path is watched from the next sync on, one
 * nothing needs any more is closed, and one whose watcher reported anything
 * since the last sync is watched anew. That last rule is what keeps a watch
 * alive: on Linux, a watched directory that is removed and created again
 * leaves its watcher silent for good — no `error`, no `close` — so a watcher
 * is not trusted because it exists. A change made between the old watcher's
 * end and the new one is the orchestrator's to find: it compares every input
 * after each sync. chokidar (4.0.3) is not used for these:
 * once a file of a directory has been unwatched, of several missing paths then
 * added in that directory it reports only the first one's creation, and a
 * file it was told to watch and that was replaced inside a generation is
 * dropped from its list while the caller believes it watched.
 *
 * Watching is best effort: a directory `fs.watch` refuses (EACCES, ENOSPC at
 * the inotify limit, ENOENT when it vanished since it was found) or whose
 * watcher reports an error (EPERM on Windows when it is deleted) is warned
 * about once and skipped — never thrown into the generation that asked. It is
 * tried again at the next sync.
 */

import { existsSync, watch, type FSWatcher } from 'fs';
import { dirname, relative } from 'path';
import { logger } from '@spfn/core/logger';

const inputWatcherLogger = logger.child('@spfn/core:codegen');

/**
 * The quiet period: how long a change waits for writes to settle before
 * `changed` is called, every later change restarting the wait. chokidar's
 * `awaitWriteFinish` reports a file once its size held for 100 ms, polled
 * every 50 ms, so up to 150 ms after the last write; a directory event says
 * nothing about sizes, so this waits those 150 ms outright. The orchestrator's
 * late events — inputs the check after a generation found changed — wait the
 * same period (`schedule`).
 */
const SETTLE_MS = 150;

export class InputWatcher
{
    private paths: string[] = [];
    private readonly watchers = new Map<string, FSWatcher>();

    /** Directories whose watcher reported since the last sync: the directory may have been replaced. */
    private readonly reported = new Set<string>();
    private readonly warned = new Set<string>();
    private timer?: NodeJS.Timeout;

    /** `root` names directories in warnings; `changed` is called once writes in a watched directory settle. */
    constructor(private readonly root: string, private readonly changed: () => void)
    {
    }

    /** Whether a change was seen and `changed` is still to be called. */
    get pending(): boolean
    {
        return this.timer !== undefined;
    }

    /** Watch the nearest existing directory of each of `paths` (absolute), and no other. */
    sync(paths: Iterable<string>): void
    {
        this.paths = [...paths];

        const directories = new Set(this.paths.map(existingDirectory));

        for (const [directory, watcher] of this.watchers)
        {
            if (!directories.has(directory) || this.reported.has(directory))
            {
                watcher.close();
                this.watchers.delete(directory);
            }
        }

        this.reported.clear();
        directories.forEach(directory => this.watchers.has(directory) || this.watchDirectory(directory));
    }

    /**
     * Call `changed` once a quiet period has passed with no change in a watched
     * directory, as for a change in one: a change meanwhile restarts the wait.
     */
    schedule(): void
    {
        clearTimeout(this.timer);
        this.timer = setTimeout(() =>
        {
            this.timer = undefined;
            this.changed();
        }, SETTLE_MS);
    }

    close(): void
    {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.watchers.forEach(watcher => watcher.close());
        this.watchers.clear();
    }

    private watchDirectory(directory: string): void
    {
        try
        {
            const watcher = watch(directory, () =>
            {
                this.reported.add(directory);
                this.schedule();
            });

            watcher.on('error', error => this.unwatchable(directory, error));
            this.watchers.set(directory, watcher);
        }
        catch (error)
        {
            this.unwatchable(directory, error);
        }
    }

    /** Stop trying `directory` until the next sync, and say so once. */
    private unwatchable(directory: string, error: unknown): void
    {
        this.watchers.get(directory)?.close();
        this.watchers.delete(directory);

        if (this.warned.has(directory))
        {
            return;
        }

        const code = (error as NodeJS.ErrnoException | null)?.code ?? String(error);
        const inputs = this.paths.filter(path => existingDirectory(path) === directory).map(path => this.named(path));

        this.warned.add(directory);
        inputWatcherLogger.warn(
            `Cannot watch ${this.named(directory)} for ${inputs.join(', ')} (${code}): a change there is not noticed `
            + 'until another change regenerates.',
        );
    }

    private named(path: string): string
    {
        return relative(this.root, path) || '.';
    }
}

/** The nearest directory on the way to `path` that exists. */
function existingDirectory(path: string): string
{
    let directory = dirname(path);

    while (dirname(directory) !== directory && !existsSync(directory))
    {
        directory = dirname(directory);
    }

    return directory;
}
