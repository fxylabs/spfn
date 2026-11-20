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
import { locateLoadError } from './errors';
import { closeGeneration, GENERATION_PARAMETER, loadHook, openGeneration, projectFileAt, resolveHook } from './hooks';
import { reportInputs, type Inputs } from '../core/inputs';

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
 * What a load evaluated, or what it threw — rewritten to name the project's
 * files as written (`./errors`) — and what it read either way: the project
 * files and config files it read, stamped, with the paths its resolutions
 * looked at and found nothing, stamped absent (`./hooks`). A load that failed
 * on a file is to be retried when that file changes or appears.
 */
export type ProjectLoad =
    | { ok: true; module: Record<string, unknown>; inputs: Inputs }
    | { ok: false; error: unknown; inputs: Inputs };

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
        (error: unknown) => ({ ok: false as const, error: locateLoadError(error, projectFileAt) }),
    );

    return { ...settled, inputs: closeGeneration(token) };
}

/** What `require()` returned, or what it threw. */
function settleRequire(file: string, url: string): { ok: true; module: Record<string, unknown> } | { ok: false; error: unknown }
{
    try
    {
        return { ok: true, module: createRequire(file)(url) as Record<string, unknown> };
    }
    catch (error)
    {
        return { ok: false, error };
    }
}

/**
 * `require()` `file` as an ES module, synchronously, under a token of its own:
 * for `.spfnrc.ts`, which `loadCodegenConfig` reads synchronously. It fails as
 * `require()` of an ES module does when the graph has top-level await; what it
 * throws names the project's files as written (`./errors`). What it read,
 * loaded or not, goes to the inputs collector open around it, if any
 * (`../core/inputs`).
 */
export function requireProjectModule(file: string, root: string): Record<string, unknown>
{
    const token = newGeneration();

    ensureRegistered();
    openGeneration(token, root);

    const settled = settleRequire(file, generationURL(file, token));
    const error = settled.ok ? undefined : locateLoadError(settled.error, projectFileAt);

    reportInputs(closeGeneration(token));

    if (!settled.ok)
    {
        throw error;
    }

    return settled.module;
}

/** Import a package's module natively, by its file (`resolvePackageModule`). */
export function importPackageModule(file: string): Promise<Record<string, unknown>>
{
    return nativeImport(pathToFileURL(file).href);
}

/** The file a package specifier names, resolved from `root`, else from this package; undefined when neither resolves it. */
export function resolvePackageModule(specifier: string, root: string): string | undefined
{
    return tryResolve(createRequire(pathToFileURL(`${root}/`)), specifier)
        ?? tryResolve(createRequire(import.meta.url), specifier);
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
