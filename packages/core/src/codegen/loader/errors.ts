/**
 * A failed load, in the project's own terms
 *
 * Node reports a failure inside a load by the URLs the hooks gave the
 * project's files — `routes/admin.ts?spfn-gen=3` — at lines of the transform,
 * and for a syntax error it names no file in the message at all. The loader
 * holds the source map of every file it transformed while the load runs, so
 * before the load is closed its error is rewritten (`locateLoadError`): every
 * URL of the load's own files in the stack and the message becomes the file's
 * path, without the generation query, at the line and column of the source.
 * A frame of code the transform added (TypeScript's decorator and class
 * helpers) has no source position and is dropped.
 *
 * Process-wide source maps (`--enable-source-maps`, `setSourceMapsEnabled`) are
 * not turned on: codegen runs inside an adopter's process when called
 * programmatically, and in a CLI process the loader's own maps already cover
 * every project file.
 *
 * `projectOrigin` names where the failure arose. That is a fact of the
 * error's frames, never of its message: a message is free text and may name
 * any file — the one a route failed to read, say. So the origin is the first
 * frame under the project root, outside `node_modules` (or the source line V8
 * puts above the message of an error found while linking: an import of a name
 * the module does not export). A failure the loader itself raises has no
 * frame in the project — a transform's syntax error, an import that resolved
 * nowhere — and the loader knows the file: it carries it on the error
 * (`raisedAt`), and that is the origin when no frame gives one.
 */

import type { SourceMap } from 'node:module';
import { relative, sep } from 'node:path';

/** A file of a running load, by the URL it was given, and the source map of its transform. */
export type ProjectFileAt = (url: string) => { file: string; sourceMap?: SourceMap } | undefined;

/** A `file:` URL with a query, and the line and column a frame gives after it. */
const URL_AT = /(file:\/\/[^\s'"()]+\?[^\s'"():]*)(?::(\d+))?(?::(\d+))?/g;

/** A stack line, its URLs rewritten; undefined for a frame of code the transform added. */
function rewriteLine(line: string, fileAt: ProjectFileAt): string | undefined
{
    let added = false;
    const rewritten = line.replace(URL_AT, (match, url: string, lineNumber?: string, columnNumber?: string) =>
    {
        const found = fileAt(url);

        if (found === undefined || lineNumber === undefined)
        {
            return found?.file ?? match;
        }

        const origin = found.sourceMap === undefined
            ? { lineNumber: Number(lineNumber), columnNumber: Number(columnNumber ?? 1) }
            : found.sourceMap.findOrigin(Number(lineNumber), Number(columnNumber ?? 1)) as { lineNumber?: number; columnNumber?: number };

        added ||= origin.lineNumber === undefined;

        return `${found.file}:${origin.lineNumber}${columnNumber === undefined ? '' : `:${origin.columnNumber}`}`;
    });

    return added && /^\s+at /.test(line) ? undefined : rewritten;
}

function rewrite(text: string, fileAt: ProjectFileAt): string
{
    return text.split('\n')
        .map(line => rewriteLine(line, fileAt))
        .filter((line): line is string => line !== undefined)
        .join('\n');
}

/** Rewrite a load's error in place to name the project's files as written; anything but an error is returned as it is. */
export function locateLoadError(error: unknown, fileAt: ProjectFileAt): unknown
{
    if (!(error instanceof Error))
    {
        return error;
    }

    // Any code can set `message` and `stack`; one that is not a string is left as it is.
    if (typeof error.message === 'string')
    {
        error.message = rewrite(error.message, fileAt);
    }

    if (typeof error.stack === 'string')
    {
        error.stack = rewrite(error.stack, fileAt);
    }

    return error;
}

/** Where the loader raised a failure, on the error: a `Symbol.for` key, so the hooks and the generators may be two bundles. */
const RAISED_AT = Symbol.for('@spfn/core/codegen:raised-at');

/** Mark a failure the loader raises as found in `file` (an absolute path), at `line:column` when it knows them. */
export function raisedAt<E extends Error>(error: E, file: string, line?: number, column?: number): E
{
    return Object.assign(error, { [RAISED_AT]: line === undefined ? file : `${file}:${line}:${column}` });
}

/**
 * The lines of an error that say where it arose, its message left out: V8's
 * source line above the message, and the frames below it.
 */
function locationLines(error: Error): string[]
{
    // Any code can set `stack` and `message`; one that is not a string is none.
    const stack = typeof error.stack === 'string' ? error.stack : '';
    const message = typeof error.message === 'string' ? error.message : '';
    const messageAt = message === '' ? -1 : stack.indexOf(message);
    const isFrame = (line: string): boolean => /^\s+at /.test(line);

    if (messageAt === -1)
    {
        return stack.split('\n').filter(isFrame);
    }

    return [stack.slice(0, messageAt).split('\n')[0], ...stack.slice(messageAt + message.length).split('\n').filter(isFrame)];
}

/** The first place under `root`, outside `node_modules`, that one of `lines` names, relative to `root`. */
function firstPlace(lines: string[], root: string): string | undefined
{
    const prefix = root + sep;
    const place = lines
        .flatMap(line => line.split(/[\s'"()]+/))
        .find(token => token.startsWith(prefix) && !token.includes(`${sep}node_modules${sep}`));

    return place === undefined ? undefined : relative(root, place.replace(/[:,.]+$/, ''));
}

/** Where under `root` (a real path) a rewritten error arose, relative to it: `src/server/routes/admin.ts:3:7`. */
export function projectOrigin(error: unknown, root: string): string | undefined
{
    if (!(error instanceof Error))
    {
        return undefined;
    }

    const raised = (error as { [RAISED_AT]?: string })[RAISED_AT];

    return firstPlace(locationLines(error), root) ?? (raised === undefined ? undefined : firstPlace([raised], root));
}
