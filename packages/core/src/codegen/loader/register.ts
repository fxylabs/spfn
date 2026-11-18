/**
 * Loading project modules for codegen
 *
 * The hooks (`./hooks`) are registered with `module.registerHooks` on the first
 * load, in this thread, ahead of whatever the process registered before —
 * tsx under the CLI, the `spfn dev` hook in the watcher — so they decide a
 * load's own files and hand everything else down that chain.
 *
 * Loads are `import()` calls Node itself runs. Under vitest, which rewrites
 * `import()` in the source it transforms into its own module runner — where
 * neither the hooks nor the process's packages are — the call is compiled by
 * `vm` with Node's loader for its dynamic import instead
 * (`USE_MAIN_CONTEXT_DEFAULT_LOADER`, experimental on Node 22, hence only
 * there): the source's tests then load routers the way the built package does.
 *
 * Every load retains its project modules: Node never frees an ES module. That
 * is about 100 KB per load for a small app (more for a large one), once per
 * file change in the watcher — accepted, see the codegen README.
 */

import nodeModule, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { constants, runInThisContext } from 'node:vm';
import { closeGeneration, GENERATION_PARAMETER, loadHook, openGeneration, resolveHook } from './hooks';

/** `module.registerHooks` (Node 22.15+); the `@types/node` this package builds with predates it. */
const { registerHooks } = nodeModule as unknown as {
    registerHooks(hooks: { resolve: typeof resolveHook; load: typeof loadHook }): void;
};

type NativeImport = (specifier: string) => Promise<Record<string, unknown>>;

/** The wrapper argument vitest's module runner evaluates a module with; undeclared anywhere else. */
declare const __vite_ssr_import_meta__: unknown;

/** `import()` as Node runs it, whatever transformed this module. */
const nativeImport: NativeImport = typeof __vite_ssr_import_meta__ === 'object'
    ? runInThisContext('(specifier) => import(specifier)', { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })
    : specifier => import(specifier);

let registered = false;
let lastToken = 0;

function ensureRegistered(): void
{
    if (!registered)
    {
        registerHooks({ resolve: resolveHook, load: loadHook });
        registered = true;
    }
}

/** A token no load in this process has used: one generation of the project's modules. */
export function newGeneration(): string
{
    lastToken += 1;

    return String(lastToken);
}

/**
 * What a load evaluated, or what it threw, and the project files it reached
 * either way: a load that failed on a file is to be retried when that file
 * changes.
 */
export type ProjectLoad =
    | { ok: true; module: Record<string, unknown>; touched: string[] }
    | { ok: false; error: unknown; touched: string[] };

function generationURL(file: string, token: string): string
{
    const url = pathToFileURL(file);

    url.searchParams.set(GENERATION_PARAMETER, token);

    return url.href;
}

/**
 * Import `file` and the project modules it reaches under `token`, reading the
 * project at `root`. A second import of the same file under the same token is
 * the module the first one evaluated.
 */
export async function importProjectModule(file: string, root: string, token: string): Promise<ProjectLoad>
{
    ensureRegistered();
    openGeneration(token, root);

    const settled = await nativeImport(generationURL(file, token)).then(
        module => ({ ok: true as const, module }),
        (error: unknown) => ({ ok: false as const, error }),
    );

    return { ...settled, touched: closeGeneration(token) };
}

/**
 * `require()` `file` as an ES module, synchronously, under a token of its own:
 * for `.spfnrc.ts`, which `loadCodegenConfig` reads synchronously. It fails as
 * `require()` of an ES module does when the graph has top-level await.
 */
export function requireProjectModule(file: string, root: string): Record<string, unknown>
{
    const token = newGeneration();

    ensureRegistered();
    openGeneration(token, root);

    try
    {
        return createRequire(file)(generationURL(file, token)) as Record<string, unknown>;
    }
    finally
    {
        closeGeneration(token);
    }
}

/** Import a package's module natively, by the specifier resolved from `root` (else from this package). */
export function importPackageModule(specifier: string, root: string): Promise<Record<string, unknown>>
{
    return nativeImport(pathToFileURL(resolvePackage(specifier, root)).href);
}

function resolvePackage(specifier: string, root: string): string
{
    const fromRoot = tryResolve(createRequire(pathToFileURL(`${root}/`)), specifier);

    return fromRoot ?? createRequire(import.meta.url).resolve(specifier);
}

function tryResolve(require: NodeJS.Require, specifier: string): string | undefined
{
    try
    {
        return require.resolve(specifier);
    }
    catch
    {
        return undefined;
    }
}
