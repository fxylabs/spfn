/**
 * The drizzle config a command writes for drizzle-kit when the project has no
 * drizzle.config.ts of its own (`db generate`, `db check`, `db drop`,
 * `db studio`), and the one `db generate` writes over a project's own to name
 * the schema files it expanded
 *
 * The file carries a database URL, password included, so it is created
 * exclusively and readable by its owner only, and it is removed however the
 * CLI process ends: by the command once drizzle-kit exits, at process exit,
 * or on SIGINT, SIGTERM or SIGHUP.
 */

import { rmSync, writeFileSync } from 'fs';

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export interface TempDrizzleConfig
{
    /** Relative to the working directory, as drizzle-kit's `--config` takes it */
    path: string;
    /** Delete the file; safe to call more than once */
    remove: () => void;
}

/**
 * Write `content` to a fresh `drizzle.config.<pid>.<time>.temp.ts` in the
 * working directory with mode 0600, and arrange its removal on every exit path.
 */
export function writeTempDrizzleConfig(content: string): TempDrizzleConfig
{
    const path = `./drizzle.config.${process.pid}.${Date.now()}.temp.ts`;

    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });

    const remove = (): void =>
    {
        process.off('exit', remove);
        SIGNALS.forEach(signal => process.off(signal, onSignal));
        rmSync(path, { force: true });
    };

    // A listener replaces the signal's default action, so when no other
    // listener will end the process, the signal is raised again once the file
    // is gone.
    const onSignal = (signal: NodeJS.Signals): void =>
    {
        remove();
        if (process.listenerCount(signal) === 0)
        {
            process.kill(process.pid, signal);
        }
    };

    process.on('exit', remove);
    SIGNALS.forEach(signal => process.on(signal, onSignal));

    return { path, remove };
}
