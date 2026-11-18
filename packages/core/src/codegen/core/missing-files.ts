/**
 * Watching for files that do not exist yet
 *
 * A router load that failed because an import resolved nowhere records every
 * path the import was looked for at (the codegen loader's `tried`), and
 * creating any of them is to regenerate. chokidar (4.0.3) cannot be relied on
 * for that: once a file of a directory has been unwatched, of several missing
 * paths then added in that directory only the first one added reports its
 * creation. So the orchestrator hands those paths here instead. The nearest
 * directory of each that exists is watched with Node's own, non-recursive
 * `fs.watch`; when anything changes in one, and writes have settled, the paths
 * are checked again: one that now exists is reported, and a directory that
 * appeared on the way to one is watched in its turn.
 */

import { existsSync, watch, type FSWatcher } from 'fs';
import { dirname, join } from 'path';

/** How long a change waits for writes to settle before the paths are checked, as chokidar's `awaitWriteFinish` waits. */
const SETTLE_MS = 150;

export class MissingFiles
{
    private paths = new Set<string>();
    private readonly watchers = new Map<string, FSWatcher>();
    private timer?: NodeJS.Timeout;

    /** `appeared` is called with a path (relative to `cwd`) once it exists. */
    constructor(private readonly cwd: string, private readonly appeared: (file: string) => void)
    {
    }

    /** Watch for those of `files` (relative to `cwd`) that do not exist, and for nothing else. */
    sync(files: Iterable<string>): void
    {
        this.paths = new Set([...files].filter(file => !this.exists(file)));
        this.watchDirectories();
    }

    close(): void
    {
        clearTimeout(this.timer);
        this.watchers.forEach(watcher => watcher.close());
        this.watchers.clear();
    }

    private exists(file: string): boolean
    {
        return existsSync(join(this.cwd, file));
    }

    /** The nearest directory on the way to `file` that exists. */
    private existingDirectory(file: string): string
    {
        let directory = dirname(file);

        while (directory !== '.' && !this.exists(directory))
        {
            directory = dirname(directory);
        }

        return directory;
    }

    private watchDirectories(): void
    {
        const directories = new Set([...this.paths].map(file => this.existingDirectory(file)));

        for (const [directory, watcher] of this.watchers)
        {
            if (!directories.has(directory))
            {
                watcher.close();
                this.watchers.delete(directory);
            }
        }

        for (const directory of directories)
        {
            if (!this.watchers.has(directory))
            {
                this.watchers.set(directory, watch(join(this.cwd, directory), () => this.schedule()));
            }
        }
    }

    private schedule(): void
    {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.check(), SETTLE_MS);
    }

    private check(): void
    {
        const appeared = [...this.paths].find(file => this.exists(file));

        if (appeared !== undefined)
        {
            this.paths.delete(appeared);
            this.appeared(appeared);

            return;
        }

        this.watchDirectories();

        // A path that appeared while the directories were being watched anew.
        if ([...this.paths].some(file => this.exists(file)))
        {
            this.schedule();
        }
    }
}
