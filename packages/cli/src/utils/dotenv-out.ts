/**
 * Write an env map as a dotenv file that holds secrets.
 *
 * Every value is quoted so it parses back — through `dotenv`, which `loadEnv`
 * uses — to exactly what was written: newlines, `#`, quotes, `=` and edge spaces
 * included. The file is created with mode 0600 and moved into place by rename,
 * so the destination is either the old file or the whole new one. POSIX only:
 * on Windows the mode is not enforced.
 */

import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parse } from 'dotenv';

/**
 * Quoting forms in order of preference. dotenv takes single-quoted and
 * backtick-quoted values literally and expands `\n`/`\r` in double-quoted ones;
 * a bare value is trimmed and stops at `#`.
 */
const QUOTES = ["'", '`', '"'] as const;

/**
 * Render values as dotenv lines, one per name in the given order.
 *
 * @throws Error naming each value dotenv cannot represent (never the value)
 */
export function formatDotenv(values: Record<string, string>): string
{
    const unrepresentable: string[] = [];
    const lines = Object.entries(values).map(([name, value]) =>
    {
        const line = dotenvLine(name, value);

        if (!line)
        {
            unrepresentable.push(name);
        }

        return line;
    });

    const content = lines.join('\n') + '\n';
    const mismatched = Object.keys(values).filter((name) => parse(content)[name] !== values[name]);
    const failed = [...new Set([...unrepresentable, ...mismatched])];

    if (failed.length > 0)
    {
        throw new Error(`Cannot write as dotenv without changing the value: ${failed.join(', ')}`);
    }

    return content;
}

/**
 * The first `NAME=<form>` line that parses back to the value on its own, or
 * undefined when none does.
 */
function dotenvLine(name: string, value: string): string | undefined
{
    // A value ending in a backslash would read as an escaped closing quote.
    const quoted = value.endsWith('\\') ? [] : QUOTES.map((quote) => `${quote}${value}${quote}`);

    return [...quoted, value]
        .map((form) => `${name}=${form}`)
        .find((line) => parse(line)[name] === value);
}

/**
 * Replace `path` with `content`: a temp file beside it, created 0600 (never
 * chmod-ed after the fact), flushed, then renamed over the destination. On any
 * failure the temp file is removed and the destination is untouched.
 */
export function writePrivateFileAtomic(path: string, content: string): void
{
    const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);

    try
    {
        writeAndClose(fd, content);
        renameSync(temp, path);
    }
    finally
    {
        rmSync(temp, { force: true });
    }
}

function writeAndClose(fd: number, content: string): void
{
    try
    {
        writeFileSync(fd, content);
        fsyncSync(fd);
    }
    finally
    {
        closeSync(fd);
    }
}
