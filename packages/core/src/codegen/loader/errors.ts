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
 * `projectOrigin` names where the failure arose: the first place under the
 * project root, outside `node_modules`, that the rewritten error names — the
 * frame that threw, the file a syntax error is in, the importer of what did
 * not resolve.
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

    error.message = rewrite(error.message, fileAt);
    error.stack = error.stack === undefined ? undefined : rewrite(error.stack, fileAt);

    return error;
}

/** Where under `root` (a real path) a rewritten error arose, relative to it: `src/server/routes/admin.ts:3:7`. */
export function projectOrigin(error: unknown, root: string): string | undefined
{
    const text = error instanceof Error ? error.stack ?? error.message : String(error);
    const prefix = root + sep;
    const places = text.split(/[\s'"()]+/).filter(place => place.startsWith(prefix) && !place.includes(`${sep}node_modules${sep}`));

    return places.length === 0 ? undefined : relative(root, places[0].replace(/[:,.]+$/, ''));
}
