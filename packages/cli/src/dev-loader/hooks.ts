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
 * would otherwise guess:
 *
 * - `.ts` and `.tsx` are ESM, whatever the `type`.
 * - `.js` and `.jsx` in a package with no `type` are decided by the file's own
 *   syntax, as Node's detection decides it: static `import`/`export`,
 *   `import.meta` or top-level await make it ESM, anything else CommonJS. The
 *   parser is esbuild's — the one `spfn build` bundles the file with.
 * - A stated `type`, and a stated extension (`.mjs`, `.cjs`, `.mts`, `.cts`), is
 *   the author's statement and is left alone.
 *
 * A file is application source unless it is a dependency: a `node_modules`
 * directory appears in its real path below the longest common ancestor of that
 * path and the application root's. So a workspace package beside the app is
 * application source, what is installed under it is not, and a directory named
 * `node_modules` above the app (an app checked out under one) does not count.
 *
 * The hook runs in the thread that loads the app (`module.registerHooks`), and
 * the root is handed to it as data by `register.ts`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import nodeModule from 'node:module';
import { extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

export interface ResolveResult
{
    url: string;
    format?: string | null;
    [key: string]: unknown;
}

export type NextResolve = (specifier: string, context?: unknown) => ResolveResult;

export type ResolveHook = (specifier: string, context: unknown, nextResolve: NextResolve) => ResolveResult;

/** `module.findPackageJSON` (Node 22.14+); the `@types/node` this package builds with predates it. */
const { findPackageJSON } = nodeModule as unknown as { findPackageJSON(specifier: URL): string | undefined };

/**
 * Whether `file` is a dependency of the application at `root` (both real
 * paths): a `node_modules` segment below their longest common ancestor.
 */
export function isDependency(file: string, root: string): boolean
{
    const fileSegments = file.split(sep);
    const rootSegments = root.split(sep);
    const common = fileSegments.findIndex((segment, index) => segment !== rootSegments[index]);

    return fileSegments.slice(common === -1 ? fileSegments.length : common).includes('node_modules');
}

/** The `type` of the package `file` belongs to, if it states one. */
function packageType(file: string): string | undefined
{
    const packageJson = findPackageJSON(pathToFileURL(file));

    return packageJson === undefined ? undefined : JSON.parse(readFileSync(packageJson, 'utf8')).type;
}

/**
 * `module` when esbuild finds ESM syntax in the file — static `import`/`export`,
 * `import.meta`, top-level await — and `commonjs` otherwise, including a file
 * it cannot parse: Node compiles that as CommonJS too and reports the error.
 */
function formatBySyntax(file: string): string
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

/** The format to state for an application source file, or undefined to leave the chain's. */
function applicationFormat(file: string): string | undefined
{
    const extension = extname(file);

    if (extension === '.ts' || extension === '.tsx')
    {
        return 'module';
    }

    return (extension === '.js' || extension === '.jsx') && packageType(file) === undefined
        ? formatBySyntax(file)
        : undefined;
}

/** The query parameter tsx (4.22 on) marks a virtual path with: the URL's query appended after `%3F`. */
const TSX_VIRTUAL_QUERY = 'tsx-commonjs-virtual-query=';

/** The query parameters tsx marks a file it took for CommonJS with. */
const TSX_COMMONJS_PARAMETERS = ['tsx-commonjs-export-preparse=', TSX_VIRTUAL_QUERY];

/** Whether `part` (`name=value` of a query) is one of tsx's own parameters. */
function isTsxParameter(part: string): boolean
{
    return TSX_COMMONJS_PARAMETERS.some(parameter => part.startsWith(parameter));
}

/**
 * The URL `url` names a file by, undoing the virtual URL tsx (4.22 and 4.23)
 * gives a file it took for CommonJS. tsx appends its parameters to the query,
 * and when the URL had a query, it appends that whole query — the app's own
 * part included — to the path after `%3F`, marks it with
 * `tsx-commonjs-virtual-query`, and re-serialises the search (`?raw` becomes
 * `?raw=`). As tsx's own inverse (`getFilePathFromVirtualQuery`) reads it, the
 * file is the path up to its last `%3F`; the app's query is taken from the
 * path's copy, which is as the app wrote it, without tsx's parameters. A URL
 * with none of tsx's parameters is returned untouched.
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
    const queryParts = virtualPathEnd === -1 ? searchParts : plain.pathname.slice(virtualPathEnd + '%3F'.length).split('&');

    if (virtualPathEnd !== -1)
    {
        plain.pathname = plain.pathname.slice(0, virtualPathEnd);
    }

    plain.search = queryParts.filter(part => part !== '' && !isTsxParameter(part)).join('&');

    return plain.href;
}

/** The resolve hook for the application rooted at `root`. Formats are decided once per file. */
export function createResolveHook(root: string): ResolveHook
{
    const realRoot = realpathSync(root);
    const formats = new Map<string, string | undefined>();

    function formatOf(file: string): string | undefined
    {
        if (!formats.has(file))
        {
            formats.set(file, isDependency(file, realRoot) ? undefined : applicationFormat(file));
        }

        return formats.get(file);
    }

    return (specifier, context, nextResolve) =>
    {
        const result = nextResolve(specifier, context);

        if (!result.url.startsWith('file:'))
        {
            return result;
        }

        const url = withoutCommonJsQuery(result.url);
        const file = fileURLToPath(url);
        // A URL that names no file is another loader's virtual module, not application source.
        const format = existsSync(file) ? formatOf(realpathSync(file)) : undefined;

        if (format === undefined)
        {
            return result;
        }

        return format === 'module' ? { ...result, url, format } : { ...result, format };
    };
}
