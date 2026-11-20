/**
 * `spfn dev` runs the application's source in the module format `spfn build`
 * gives it
 *
 * `spfn build` bundles the app's server as ESM with esbuild, whatever its
 * `package.json` says, and esbuild decides each `.js` file by its own syntax.
 * Under `spfn dev` the same files run under tsx, which takes a file's format
 * from the nearest `package.json` `type` — CommonJS when there is none, as in a
 * scaffolded app. The app's imports then became `require()`, and tsx's
 * CommonJS handler re-evaluated every ESM-only `@spfn/*` file they reached into
 * a second instance beside the server's own: two `@spfn/core`, two `hono`,
 * each with its own module state (issue #329).
 *
 * This resolve hook states the format of every application source file tsx
 * would otherwise guess, by the rule `@spfn/core/codegen/loader` holds — the
 * one codegen loads the router by, so `spfn dev` and the codegen watcher agree
 * on every file: `.ts` and `.tsx` are ESM whatever the `type`; a type-less `.js`
 * or `.jsx` is decided by its own syntax, parsed here by esbuild — the parser
 * `spfn build` bundles the file with; a stated `type` or extension is left
 * alone; and a file is application source unless a `node_modules` directory
 * appears in its real path below its common ancestor with the application root.
 *
 * The hook runs in the thread that loads the app (`module.registerHooks`), and
 * the root is handed to it as data by `register.ts`.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applicationFormat, isDependency } from '@spfn/core/codegen/loader';
import { buildSync } from 'esbuild';

export interface ResolveResult
{
    url: string;
    format?: string | null;
    [key: string]: unknown;
}

export type NextResolve = (specifier: string, context?: unknown) => ResolveResult;

export type ResolveHook = (specifier: string, context: unknown, nextResolve: NextResolve) => ResolveResult;

/**
 * `module` when esbuild finds ESM syntax in the file — static `import`/`export`,
 * `import.meta`, top-level await — and `commonjs` otherwise, including a file
 * it cannot parse: Node compiles that as CommonJS too and reports the error.
 */
function formatBySyntax(file: string): 'module' | 'commonjs'
{
    try
    {
        const { metafile } = buildSync({ entryPoints: [file], write: false, metafile: true, logLevel: 'silent' });

        return Object.values(metafile.inputs)[0]?.format === 'esm' ? 'module' : 'commonjs';
    }
    catch
    {
        return 'commonjs';
    }
}

/** The query parameter tsx (4.22 on) marks a virtual path with: the URL's query appended after `%3F`. */
const TSX_VIRTUAL_QUERY = 'tsx-commonjs-virtual-query=';

/** The query parameters tsx marks a file it took for CommonJS with. */
const TSX_COMMONJS_PARAMETERS = ['tsx-commonjs-export-preparse=', TSX_VIRTUAL_QUERY];

/** The query parameter a file loaded through tsx's `tsImport`/`require` API carries: its loader's namespace. */
const TSX_NAMESPACE = 'tsx-namespace=';

/** Whether `part` (`name=value` of a query) is one of tsx's CommonJS parameters. */
function isTsxParameter(part: string): boolean
{
    return TSX_COMMONJS_PARAMETERS.some(parameter => part.startsWith(parameter));
}

/**
 * The query of a virtual path's copy as the app wrote it, followed by the
 * namespace parameter `searchParts` carries. tsx appends the namespace to the
 * copy as `namespace=<n>` and keeps `tsx-namespace=<n>` in the search; the
 * scoped loader of `tsImport` claims a file by the latter, so it is kept, and
 * its copy dropped.
 */
function virtualPathQuery(copy: string, searchParts: string[]): string[]
{
    const namespaces = searchParts.filter(part => part.startsWith(TSX_NAMESPACE));
    const copies = new Set(namespaces.map(part => part.slice('tsx-'.length)));

    return [...copy.split('&').filter(part => !copies.has(part)), ...namespaces];
}

/**
 * The URL `url` names a file by, undoing the virtual URL tsx (4.22 and 4.23)
 * gives a file it took for CommonJS. tsx appends its parameters to the query,
 * and when the URL had a query, it appends that whole query — the app's own
 * part included — to the path after `%3F`, marks it with
 * `tsx-commonjs-virtual-query`, and re-serialises the search (`?raw` becomes
 * `?raw=`). As tsx's own inverse (`getFilePathFromVirtualQuery`) reads it, the
 * file is the path up to its last `%3F`; the app's query is taken from the
 * path's copy, which is as the app wrote it, without tsx's parameters, and a
 * `tsImport` namespace stays — the URL tsx gives the same import as ESM. A URL
 * with none of tsx's CommonJS parameters is returned untouched.
 */
function withoutCommonJsQuery(url: string): string
{
    const plain = new URL(url);
    const searchParts = plain.search.slice(1).split('&');

    if (!searchParts.some(isTsxParameter))
    {
        return url;
    }

    const virtualPathEnd = searchParts.some(part => part.startsWith(TSX_VIRTUAL_QUERY))
        ? plain.pathname.toLowerCase().lastIndexOf('%3f')
        : -1;
    const queryParts = virtualPathEnd === -1
        ? searchParts
        : virtualPathQuery(plain.pathname.slice(virtualPathEnd + '%3F'.length), searchParts);

    if (virtualPathEnd !== -1)
    {
        plain.pathname = plain.pathname.slice(0, virtualPathEnd);
    }

    plain.search = queryParts.filter(part => part !== '' && !isTsxParameter(part)).join('&');

    return plain.href;
}

/** What the hook states for one URL tsx resolved: the URL to load it by, and its format. */
interface Statement
{
    url: string;
    format: string;
}

/** A resolved URL as the hook reads it: the URL naming its file, and the file's path. */
interface ParsedUrl
{
    url: string;
    file: string;
}

/**
 * A file's identity on disk: inode, size and status-change time, which any
 * write, rename onto it or chmod moves.
 */
function revisionOf(file: string): string
{
    const stats = statSync(file, { bigint: true, throwIfNoEntry: false });

    return stats === undefined ? 'gone' : `${stats.ino}:${stats.size}:${stats.ctimeNs}`;
}

/**
 * The resolve hook for the application rooted at `root`.
 *
 * Kept by the URL tsx resolved is only what the URL's text decides: the URL
 * naming the file and its path. What the file system says is asked on every
 * resolve — whether the file exists, its real path (a symlink can be
 * retargeted), whether that is a dependency, the `package.json` `type` over a
 * `.js` — since a file the app's codegen or an editor writes can appear or
 * change under a URL already resolved. The one answer kept is a type-less
 * `.js` file's syntax, by its real path and revision (`revisionOf`), as it is
 * the one that costs a parse. Real paths are the system's (`realpathSync.native`):
 * one call, where Node's own walks the path a `lstat` at a time.
 */
export function createResolveHook(root: string): ResolveHook
{
    const realRoot = realpathSync.native(root);
    const parsedUrls = new Map<string, ParsedUrl>();
    const syntaxFormats = new Map<string, { revision: string; format: 'module' | 'commonjs' }>();

    function parse(resolvedUrl: string): ParsedUrl
    {
        if (!parsedUrls.has(resolvedUrl))
        {
            const url = withoutCommonJsQuery(resolvedUrl);

            parsedUrls.set(resolvedUrl, { url, file: fileURLToPath(url) });
        }

        return parsedUrls.get(resolvedUrl)!;
    }

    function bySyntax(file: string): 'module' | 'commonjs'
    {
        const revision = revisionOf(file);

        if (syntaxFormats.get(file)?.revision !== revision)
        {
            syntaxFormats.set(file, { revision, format: formatBySyntax(file) });
        }

        return syntaxFormats.get(file)!.format;
    }

    function statementFor(resolvedUrl: string): Statement | undefined
    {
        const { url, file } = parse(resolvedUrl);
        // A URL that names no file is another loader's virtual module, or a file not written yet.
        const realFile = existsSync(file) ? realpathSync.native(file) : undefined;
        const format = realFile === undefined || isDependency(realFile, realRoot)
            ? undefined
            : applicationFormat(realFile, bySyntax);

        return format === undefined ? undefined : { url: format === 'module' ? url : resolvedUrl, format };
    }

    return (specifier, context, nextResolve) =>
    {
        const result = nextResolve(specifier, context);
        const statement = result.url.startsWith('file:') ? statementFor(result.url) : undefined;

        return statement === undefined ? result : { ...result, ...statement };
    };
}
