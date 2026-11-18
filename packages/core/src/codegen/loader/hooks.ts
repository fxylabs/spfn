/**
 * The codegen loader's module hooks
 *
 * Codegen reads the router by importing it, in the process's own module graph:
 * the `@spfn/*` packages a route module imports are the ones the generating
 * process already holds, evaluated once. What has to happen again on every
 * load is the project's own code, so a load is tagged with a generation — the
 * router is imported as `router.ts?spfn-gen=<token>` — and these hooks hand the
 * tag on to every file of the project the load reaches. Node keys an ES module
 * by its URL, so a new tag is a new evaluation of the project, while a package
 * URL, which never carries one, is the module Node already has.
 *
 * What the hooks decide, only for a load's own files (the tagged entry, and
 * what a file the hooks resolved imports):
 *
 * - **Resolution.** tsconfig `paths` (`./aliases`), every target in order;
 *   extensionless and `.js` → `.ts` specifiers, and a directory's `index`, as
 *   TypeScript resolves them. A bare specifier no `paths` entry claims goes on
 *   down the chain (tsx, Node).
 * - **Format.** The rule `spfn dev` runs the app by (`./format`): `.ts` is ESM
 *   whatever the package's `type`; a type-less `.js` by its syntax.
 * - **Transform.** TypeScript's `transpileModule`, file by file. Its source map
 *   is kept while the load runs, so a stack frame inside a project file can be
 *   named by its own line (`originalLine`).
 * - **Generation tag.** Appended to files under the project root and outside
 *   `node_modules` only. A workspace package's source beside the app is
 *   transformed but not tagged: like a package, it is evaluated once.
 *
 * A file the rule leaves CommonJS (`.cts`, `.cjs`, a CommonJS-syntax `.js`) is
 * handed back to the chain untagged: the chain loads it as CommonJS, and what
 * it requires is a copy of its own (`module-evaluation.ts` refuses one of
 * `@spfn/core` in a CLI codegen process).
 *
 * Every other import passes through untouched, so registering the hooks in a
 * process — the CLI, the watcher, a test runner — changes nothing outside a
 * codegen load.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as ts from 'typescript';
import { typescript } from '../generators/typescript';
import { matchPaths, projectPaths, isWithin, type PathsMatch, type ProjectPaths } from './aliases';
import { applicationFormat, isDependency, packageType, type ModuleFormat } from './format';

/** The query parameter a load's files carry. */
export const GENERATION_PARAMETER = 'spfn-gen';

/**
 * Appended to the file name of an entry loaded with `require()`. tsx claims
 * `require()` of `.ts`, `.js` and `.mjs` through `Module._extensions` and
 * compiles them as CommonJS whatever format a hook states; a name ending in an
 * extension it does not claim reaches Node's own handler, which takes the hook's
 * format and source.
 */
export const REQUIRE_SUFFIX = '.spfn-esm';

export interface ResolveContext
{
    parentURL?: string;
    conditions?: string[];
    [key: string]: unknown;
}

export interface ResolveResult
{
    url: string;
    format?: string | null;
    shortCircuit?: boolean;
    [key: string]: unknown;
}

export interface LoadResult
{
    format?: string | null;
    source?: string | Uint8Array | null;
    shortCircuit?: boolean;
    [key: string]: unknown;
}

type NextResolve = (specifier: string, context?: ResolveContext) => ResolveResult;

type NextLoad = (url: string, context?: unknown) => LoadResult;

/** One load: the project root it reads, and what it touched. */
interface Generation
{
    root: string;
    paths: Map<string, ProjectPaths | undefined>;

    /** Real paths of the project files the load reached. */
    touched: Set<string>;
}

/** A file the hooks resolved for a load, by the URL it was given. */
interface OwnedFile
{
    file: string;
    token: string;
}

const generations = new Map<string, Generation>();
const owned = new Map<string, OwnedFile>();
const sourceMaps = new Map<string, SourceMap>();

/** Start a load under `token`, reading the project at `root`. */
export function openGeneration(token: string, root: string): void
{
    generations.set(token, { root: realpathSync(root), paths: new Map(), touched: new Set() });
}

/**
 * End a load: forget what only resolution needed, and return the project files
 * it touched. A module stays in Node's cache, so a later load under the same
 * token reuses it without resolving again.
 */
export function closeGeneration(token: string): string[]
{
    const touched = [...generations.get(token)?.touched ?? []];

    generations.delete(token);

    for (const [url, file] of owned)
    {
        if (file.token === token)
        {
            owned.delete(url);
            sourceMaps.delete(url);
        }
    }

    return touched;
}

/** The line a frame of a transformed project file stands for in its source, while its load runs. */
export function originalLine(url: string, line: number, column: number): number
{
    const origin = sourceMaps.get(url)?.findOrigin(line, column) as { lineNumber?: number } | undefined;

    return origin?.lineNumber ?? line;
}

function tokenOf(url: string): string | undefined
{
    return url.startsWith('file:') ? new URL(url).searchParams.get(GENERATION_PARAMETER) ?? undefined : undefined;
}

/** The load a specifier or its importer belongs to, if any. */
function generationFor(specifier: string, parentURL: string | undefined): string | undefined
{
    const token = tokenOf(specifier) ?? (parentURL === undefined ? undefined : tokenOf(parentURL) ?? owned.get(parentURL)?.token);

    return token !== undefined && generations.has(token) ? token : undefined;
}

// ============================================================================
// Finding the file
// ============================================================================

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** What a `.js`-family specifier stands for in TypeScript source: `./x.js` → `./x.ts`. */
const SOURCE_FOR: Record<string, string[]> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
};

/** Whether `path` is a file. A path the process cannot read, or a name too long, names nothing: the next candidate is tried. */
function isFile(path: string): boolean
{
    return existsSync(path) && statSync(path).isFile();
}

/** The file `path` names as TypeScript resolves an import: as written, its source, with an extension, an index. */
function sourceFile(path: string): string | undefined
{
    const extension = extname(path);
    const stem = path.slice(0, path.length - extension.length);
    const candidates = [
        path,
        ...(SOURCE_FOR[extension] ?? []).map(source => stem + source),
        ...SOURCE_EXTENSIONS.map(source => path + source),
        ...SOURCE_EXTENSIONS.map(source => resolve(path, `index${source}`)),
    ];

    return candidates.find(isFile);
}

/** A relative, absolute or `file:` specifier as a path, or undefined for a bare one. */
function pathOf(specifier: string, parentURL: string | undefined): string | undefined
{
    if (specifier.startsWith('file:'))
    {
        return fileURLToPath(specifier.replace(/[?#].*$/, '')).replace(new RegExp(`${REQUIRE_SUFFIX}$`), '');
    }

    if (isAbsolute(specifier))
    {
        return specifier;
    }

    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';

    return relative && parentURL?.startsWith('file:') ? resolve(dirname(fileURLToPath(parentURL)), specifier) : undefined;
}

function pathsFor(generation: Generation, parentURL: string | undefined): ProjectPaths | undefined
{
    const directory = parentURL?.startsWith('file:') ? dirname(fileURLToPath(parentURL)) : generation.root;

    if (!generation.paths.has(directory))
    {
        generation.paths.set(directory, projectPaths(generation.root, directory));
    }

    return generation.paths.get(directory);
}

/** An alias that matched and resolved nothing, worded as Node words a missing module, with what was tried. */
function unresolvedAlias(specifier: string, parentURL: string | undefined, match: PathsMatch): Error
{
    const from = parentURL?.startsWith('file:') ? fileURLToPath(parentURL) : String(parentURL);
    const error = new Error(
        `Cannot find module '${specifier}' imported from ${from}. The tsconfig "paths" entry "${match.pattern}" maps `
        + `it to ${match.targets.map(target => `"${target}"`).join(', ')}; each was tried, in order, and names no `
        + `file: ${match.candidates.join(', ')}`,
    );

    return Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' });
}

function chainResolves(
    specifier: string,
    context: ResolveContext,
    nextResolve: NextResolve,
): { result: ResolveResult } | { error: unknown }
{
    try
    {
        return { result: nextResolve(specifier, context) };
    }
    catch (error)
    {
        return { error };
    }
}

/**
 * The chain's failure to find a bare specifier, naming the whole specifier —
 * Node names only the package part (`'@/server'` for `@/server/routes/users`),
 * which for an alias nobody mapped is the part that says least.
 */
function unresolvedBare(specifier: string, parentURL: string | undefined, error: unknown): unknown
{
    if ((error as { code?: string } | null)?.code !== 'ERR_MODULE_NOT_FOUND')
    {
        return error;
    }

    const from = parentURL?.startsWith('file:') ? fileURLToPath(parentURL) : String(parentURL);

    return Object.assign(
        new Error(`Cannot find module '${specifier}' imported from ${from}: no tsconfig "paths" entry maps it, and `
            + `Node did not resolve it (${(error as Error).message.split('\n')[0]})`),
        { code: 'ERR_MODULE_NOT_FOUND' },
    );
}

// ============================================================================
// Format
// ============================================================================

/** Whether a node is TypeScript's `await` at the top level, without entering a function. */
function hasTopLevelAwait(compiler: typeof ts, node: ts.Node): boolean
{
    if (compiler.isFunctionLike(node) || compiler.isClassLike(node))
    {
        return false;
    }

    if (compiler.isAwaitExpression(node) || (compiler.isForOfStatement(node) && node.awaitModifier !== undefined))
    {
        return true;
    }

    return compiler.forEachChild(node, child => hasTopLevelAwait(compiler, child) || undefined) === true;
}

/**
 * ESM when TypeScript finds ESM syntax — static `import`/`export`, `import.meta`
 * (its `externalModuleIndicator`) or top-level await — and CommonJS otherwise.
 */
function formatBySyntax(file: string): ModuleFormat
{
    const compiler = typescript();
    const source = compiler.createSourceFile(file, readFileSync(file, 'utf8'), compiler.ScriptTarget.Latest, false, compiler.ScriptKind.JS);
    const isModule = (source as { externalModuleIndicator?: unknown }).externalModuleIndicator !== undefined
        || hasTopLevelAwait(compiler, source);

    return isModule ? 'module' : 'commonjs';
}

const STATED_FORMATS: Record<string, ModuleFormat> = { '.mts': 'module', '.mjs': 'module', '.cts': 'commonjs', '.cjs': 'commonjs' };

/** The rule's format, else the one its author stated. */
function formatOf(file: string): ModuleFormat
{
    const extension = extname(file);

    return applicationFormat(file, formatBySyntax)
        ?? STATED_FORMATS[extension]
        ?? (packageType(file) === 'module' ? 'module' : 'commonjs');
}

// ============================================================================
// The hooks
// ============================================================================

/** The URL a load's own ES module is given: tagged when it is the project's, renamed when it is `require()`d. */
function ownedURL(file: string, token: string, required: boolean): string
{
    const generation = generations.get(token)!;
    const tagged = isWithin(generation.root, file) && !isDependency(file, generation.root);
    const url = pathToFileURL(required ? file + REQUIRE_SUFFIX : file);

    if (tagged)
    {
        url.searchParams.set(GENERATION_PARAMETER, token);
        generation.touched.add(file);
    }

    return url.href;
}

/** Resolve `file` for the load under `token`: owned when it is an ES module, else back to the chain. */
function own(file: string, token: string, context: ResolveContext, nextResolve: NextResolve, entry: boolean): ResolveResult
{
    const real = realpathSync(file);

    if (formatOf(real) !== 'module')
    {
        return nextResolve(pathToFileURL(real).href, context);
    }

    const url = ownedURL(real, token, entry && context.conditions?.includes('require') === true);

    owned.set(url, { file: real, token });

    return { url, format: 'module', shortCircuit: true };
}

/** A bare specifier: through `paths` when an entry claims it, else down the chain. */
function resolveBare(specifier: string, context: ResolveContext, nextResolve: NextResolve, token: string): ResolveResult
{
    const generation = generations.get(token)!;
    const paths = pathsFor(generation, context.parentURL);
    const match = paths === undefined ? undefined : matchPaths(specifier, paths);
    const file = match?.candidates.map(sourceFile).find(candidate => candidate !== undefined);

    if (file !== undefined)
    {
        return own(file, token, context, nextResolve, false);
    }

    const chained = chainResolves(specifier, context, nextResolve);

    if ('error' in chained)
    {
        throw match === undefined ? unresolvedBare(specifier, context.parentURL, chained.error) : unresolvedAlias(specifier, context.parentURL, match);
    }

    return needsTransform(chained.result.url, generation)
        ? own(fileURLToPath(chained.result.url), token, context, nextResolve, false)
        : chained.result;
}

const TYPESCRIPT = /\.(?:ts|tsx|mts)$/;

/**
 * A file a bare specifier resolved to that only this loader can run: a
 * workspace package's own source, decided by the app's rule, or TypeScript a
 * package ships. Either is transformed and run as ESM, and evaluated once —
 * neither is under the app root, so neither is tagged.
 */
function needsTransform(url: string, generation: Generation): boolean
{
    if (!url.startsWith('file:') || url.includes('?'))
    {
        return false;
    }

    const file = fileURLToPath(url);

    if (!existsSync(file))
    {
        return false;
    }

    return TYPESCRIPT.test(file) || (!isDependency(realpathSync(file), generation.root) && applicationFormat(file, formatBySyntax) !== undefined);
}

export function resolveHook(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult
{
    const token = generationFor(specifier, context.parentURL);

    if (token === undefined)
    {
        return nextResolve(specifier, context);
    }

    const path = pathOf(specifier, context.parentURL);

    if (path === undefined)
    {
        return resolveBare(specifier, context, nextResolve, token);
    }

    const file = sourceFile(path);

    return file === undefined ? nextResolve(specifier, context) : own(file, token, context, nextResolve, tokenOf(specifier) !== undefined);
}

/** Compiler options for one file: ESM out, the syntax Node runs, a source map for the probe's line numbers. */
function transpileOptions(compiler: typeof ts): ts.CompilerOptions
{
    return {
        module: compiler.ModuleKind.ESNext,
        target: compiler.ScriptTarget.ES2022,
        jsx: compiler.JsxEmit.ReactJSX,
        sourceMap: true,
    };
}

const TRANSFORMED = new Set(['.ts', '.tsx', '.mts', '.jsx']);

function transform(url: string, file: string): string
{
    const source = readFileSync(file, 'utf8');

    if (!TRANSFORMED.has(extname(file)))
    {
        return source;
    }

    const compiler = typescript();
    const output = compiler.transpileModule(source, { fileName: file, compilerOptions: transpileOptions(compiler) });

    if (output.sourceMapText !== undefined)
    {
        sourceMaps.set(url, new SourceMap(JSON.parse(output.sourceMapText)));
    }

    return output.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, '');
}

export function loadHook(url: string, context: unknown, nextLoad: NextLoad): LoadResult
{
    const file = owned.get(url);

    return file === undefined ? nextLoad(url, context) : { format: 'module', source: transform(url, file.file), shortCircuit: true };
}
