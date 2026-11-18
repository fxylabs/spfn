/**
 * The module format of an application's own source
 *
 * One rule, used by both places that load an app's TypeScript beside the
 * `@spfn/*` packages it imports: the `spfn dev` hook (`spfn/dist/dev-loader`)
 * and the codegen loader (`./hooks`). `spfn build` bundles the server as ESM
 * with esbuild whatever the app's `package.json` says, and decides each `.js`
 * by its own syntax; a runner that took the format from `package.json` `type`
 * instead — CommonJS when there is none, as in a scaffolded app — turned the
 * app's imports into `require()` and evaluated every ESM-only `@spfn/*` file
 * they reached a second time, as CommonJS (#329, #335).
 *
 * - `.ts` and `.tsx` are ESM, whatever the `type`.
 * - `.js` and `.jsx` in a package with no `type` are decided by the file's own
 *   syntax, as Node's detection decides it: static `import`/`export`,
 *   `import.meta` or top-level await make it ESM, anything else CommonJS. The
 *   caller supplies the parser: the CLI uses esbuild's, the one `spfn build`
 *   bundles with; core, which does not depend on esbuild, TypeScript's.
 * - A stated `type`, and a stated extension (`.mjs`, `.cjs`, `.mts`, `.cts`), is
 *   the author's statement and is left alone.
 *
 * A file is application source unless it is a dependency: a `node_modules`
 * directory appears in its real path below the longest common ancestor of that
 * path and the application root's. So a workspace package beside the app is
 * application source, what is installed under it is not, and a directory named
 * `node_modules` above the app (an app checked out under one) does not count.
 */

import { readFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** `module` or `commonjs`, as a resolve hook states it. */
export type ModuleFormat = 'module' | 'commonjs';

/** Decides a type-less `.js` by its syntax. */
export type SyntaxFormat = (file: string) => ModuleFormat;

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
export function packageType(file: string): string | undefined
{
    const packageJson = findPackageJSON(pathToFileURL(file));

    return packageJson === undefined ? undefined : JSON.parse(readFileSync(packageJson, 'utf8')).type;
}

/**
 * The format to state for an application source file, or undefined to leave
 * the one its author stated (an extension, a `type`) to whatever loads it.
 */
export function applicationFormat(file: string, bySyntax: SyntaxFormat): ModuleFormat | undefined
{
    const extension = extname(file);

    if (extension === '.ts' || extension === '.tsx')
    {
        return 'module';
    }

    return (extension === '.js' || extension === '.jsx') && packageType(file) === undefined
        ? bySyntax(file)
        : undefined;
}
