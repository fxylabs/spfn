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
 * - **Format.** Only for the extensions the hooks serve: JavaScript and
 *   TypeScript source (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) by the rule
 *   `spfn dev` runs the app by (`./format`) — `.ts` is ESM whatever the
 *   package's `type`, a type-less `.js` by its syntax — and `.json`, served as
 *   an ES module with the parsed value as its default export, as tsx serves it
 *   to `spfn dev` (so both `import data from './data.json'` and the form
 *   `with { type: 'json' }` load; any other attribute fails as Node fails it,
 *   `checkAttributes`). Any other extension goes down the chain.
 * - **Transform.** TypeScript's `transpileModule`, file by file, with the
 *   options of the governing tsconfig that change what runs — decorators,
 *   class fields, JSX — and ESM output forced (`./compiler-options`). A syntax
 *   error it finds is thrown naming the file, line and column. Its source map is
 *   kept while the load runs, so a stack frame inside a project file can be
 *   named by its own line (`originalLine`), and a failed load's error by the
 *   source's (`./errors`).
 * - **Generation tag.** Appended to files under the project root and outside
 *   `node_modules` only. A workspace package's source beside the app is
 *   transformed but not tagged: like a package, it is evaluated once.
 * - **What a load read.** Each tagged file, with a stamp of the bytes the
 *   load hook read (`../core/inputs`); each tsconfig.json (with its `extends`
 *   chain) and package.json the load read; and every path under the root a
 *   resolution looked at and found nothing — the candidates a relative or
 *   `paths` specifier tried before the file it resolved to, all of them when
 *   it resolved nowhere, a tsconfig.json or package.json looked for in a
 *   directory with none — stamped absent (`closeGeneration`): the watcher
 *   regenerates when any of them differs from its stamp, so a resolution is
 *   made again when the one Node would now make is another.
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
import { governingCompilerOptions, matchPaths, projectPaths, isWithin, type FileReader, type PathsMatch, type ProjectPaths } from './aliases';
import { transpileOptions } from './compiler-options';
import { raisedAt } from './errors';
import { ABSENT, addStamp, readStamped, stampOf, type Inputs, type Stamp } from '../core/inputs';
import { applicationFormat, isDependency, packageType, type ModuleFormat } from './format';

/** The query parameter a load's files carry. */
export const GENERATION_PARAMETER = 'spfn-gen';

/**
 * Appended to the file name of the module that stands in for an entry loaded
 * with `require()` (`requiredEntry`). tsx claims `require()` of `.ts`, `.js`
 * and `.mjs` through `Module._extensions` and compiles them as CommonJS
 * whatever format a hook states; a name ending in an extension it does not
 * claim reaches Node's own handler, which takes the hook's format and source.
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

export interface LoadContext
{
    importAttributes?: Record<string, string>;
    [key: string]: unknown;
}

/** One load: the project root it reads, and what it touched. */
interface Generation
{
    root: string;
    paths: Map<string, ProjectPaths | undefined>;

    /** The governing tsconfig's compiler options, by directory. */
    compilerOptions: Map<string, ts.CompilerOptions>;

    /** Real paths of the project files the load reached. */
    touched: Set<string>;

    /**
     * What the load read under the root, by path (`../core/inputs`): each file
     * the load hook read, each config file read, and each path looked at and
     * found empty, stamped absent.
     */
    stamps: Map<string, Stamp>;
}

/** A file the hooks resolved for a load, by the URL it was given. */
interface OwnedFile
{
    file: string;
    token: string;

    /** Set for the stand-in of a `require()`d entry: the URL of the entry it re-exports. */
    reexports?: string;
}

const generations = new Map<string, Generation>();

const owned = new Map<string, OwnedFile>();
const sourceMaps = new Map<string, SourceMap>();

/** Start a load under `token`, reading the project at `root`. */
export function openGeneration(token: string, root: string): void
{
    generations.set(token, { root: realpathSync(root), paths: new Map(), compilerOptions: new Map(), touched: new Set(), stamps: new Map() });
}

/**
 * End a load: forget what only resolution needed, and return what it read —
 * its stamps, and each project file it reached but never read (its load
 * stopped before it) stamped now: what a watcher has to check for the load to
 * be retried. A module stays in Node's cache, so a later
 * load under the same token reuses it without resolving again.
 */
export function closeGeneration(token: string): Inputs
{
    const generation = generations.get(token);
    const inputs: Inputs = new Map(generation?.stamps);

    generation?.touched.forEach(file => inputs.set(file, inputs.get(file) ?? stampOf(file)));
    generations.delete(token);

    for (const [url, file] of owned)
    {
        if (file.token === token)
        {
            owned.delete(url);
            sourceMaps.delete(url);
        }
    }

    return inputs;
}

/** A file of a running load, by the URL it was given, and the source map of its transform (`./errors`). */
export function projectFileAt(url: string): { file: string; sourceMap?: SourceMap } | undefined
{
    const file = owned.get(url);

    return file === undefined ? undefined : { file: file.file, sourceMap: sourceMaps.get(url) };
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

/** The files `path` may name as TypeScript resolves an import, in order: as written, its source, with an extension, an index. */
function candidatesFor(path: string): string[]
{
    const extension = extname(path);
    const stem = path.slice(0, path.length - extension.length);

    return [
        path,
        ...(SOURCE_FOR[extension] ?? []).map(source => stem + source),
        ...SOURCE_EXTENSIONS.map(source => path + source),
        ...SOURCE_EXTENSIONS.map(source => resolve(path, `index${source}`)),
    ];
}

/** Add a stamp to what the load read, when `path` is the project's: under the root, not a dependency. */
function record(generation: Generation, path: string, stamp: Stamp): void
{
    if (isWithin(generation.root, path) && !isDependency(path, generation.root))
    {
        addStamp(generation.stamps, path, stamp);
    }
}

/** A `FileReader` for the load's config files: what it reads, or finds missing, is recorded. */
function readerFor(generation: Generation): FileReader
{
    return (path) =>
    {
        const read = readIfFile(path);

        record(generation, path, read?.stamp ?? ABSENT);

        return read?.source;
    };
}

function readIfFile(path: string): ReturnType<typeof readStamped> | undefined
{
    try
    {
        return readStamped(path);
    }
    catch
    {
        return undefined;
    }
}

/**
 * The file the first of `paths` that names one names, as TypeScript resolves
 * an import. Each candidate tried before it is recorded absent: a file created
 * at one is what the resolution finds next.
 */
function sourceFile(generation: Generation, paths: string[]): string | undefined
{
    for (const candidate of paths.flatMap(candidatesFor))
    {
        if (isFile(candidate))
        {
            return candidate;
        }

        record(generation, candidate, ABSENT);
    }

    return undefined;
}

/** A relative, absolute or `file:` specifier as a path, or undefined for a bare one. */
function pathOf(specifier: string, parentURL: string | undefined): string | undefined
{
    if (specifier.startsWith('file:'))
    {
        return fileURLToPath(specifier.replace(/[?#].*$/, ''));
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
        generation.paths.set(directory, projectPaths(generation.root, directory, readerFor(generation)));
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

    return raisedAt(Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' }), from);
}

/**
 * A relative or absolute specifier the chain did not resolve either, worded as
 * Node words it but naming the specifier as written before the importer, so
 * the importer is the first project file the message names.
 */
function unresolvedPath(specifier: string, parentURL: string | undefined, error: unknown): unknown
{
    if ((error as { code?: string } | null)?.code !== 'ERR_MODULE_NOT_FOUND')
    {
        return error;
    }

    const from = parentURL?.startsWith('file:') ? fileURLToPath(parentURL) : String(parentURL);

    return raisedAt(Object.assign(
        new Error(`Cannot find module '${specifier}' imported from ${from}: no file by that name, with a JavaScript or `
            + 'TypeScript extension, or as a directory\'s index'),
        { code: 'ERR_MODULE_NOT_FOUND' },
    ), from);
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

    return raisedAt(Object.assign(
        new Error(`Cannot find module '${specifier}' imported from ${from}: no tsconfig "paths" entry maps it, and `
            + `Node did not resolve it (${(error as Error).message.split('\n')[0]})`),
        { code: 'ERR_MODULE_NOT_FOUND' },
    ), from);
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

/**
 * What the hooks serve `file` as: JSON as an ES module; JavaScript and
 * TypeScript source by the rule, else by the format its author stated; any
 * other extension not at all (undefined), which leaves it to the chain.
 */
function formatOf(file: string, generation: Generation): ModuleFormat | undefined
{
    const extension = extname(file);

    if (extension === '.json')
    {
        return 'module';
    }

    if (!SOURCE_EXTENSIONS.includes(extension))
    {
        return undefined;
    }

    return applicationFormat(file, formatBySyntax, readerFor(generation))
        ?? STATED_FORMATS[extension]
        ?? (packageType(file, readerFor(generation)) === 'module' ? 'module' : 'commonjs');
}

// ============================================================================
// The hooks
// ============================================================================

/** The URL a load's own ES module is given: tagged when it is the project's. */
function ownedURL(file: string, token: string): string
{
    const generation = generations.get(token)!;
    const tagged = isWithin(generation.root, file) && !isDependency(file, generation.root);
    const url = pathToFileURL(file);

    if (tagged)
    {
        url.searchParams.set(GENERATION_PARAMETER, token);
        generation.touched.add(file);
    }

    return url.href;
}

/** Resolve `file` for the load under `token`: owned when the hooks serve it as an ES module, else back to the chain. */
function own(file: string, token: string, context: ResolveContext, nextResolve: NextResolve, entry: boolean): ResolveResult
{
    const real = realpathSync(file);

    if (formatOf(real, generations.get(token)!) !== 'module')
    {
        return nextResolve(pathToFileURL(real).href, context);
    }

    const url = ownedURL(real, token);

    if (entry && context.conditions?.includes('require') === true)
    {
        return requiredEntry(url, real, token);
    }

    owned.set(url, { file: real, token });

    return { url, format: 'module', shortCircuit: true };
}

/**
 * An entry loaded with `require()` — `.spfnrc.ts`, which `loadCodegenConfig`
 * reads synchronously — is handed a stand-in: a module of the hooks' own,
 * named `<file>.spfn-esm` so that Node's handler rather than tsx's runs it,
 * which imports the entry under the entry's own URL and re-exports it. The
 * entry is then an ES module Node imported, and its `import.meta.url`,
 * `filename` and `dirname` are those of the file.
 */
function requiredEntry(url: string, file: string, token: string): ResolveResult
{
    const standIn = new URL(url);

    standIn.pathname += REQUIRE_SUFFIX;
    owned.set(standIn.href, { file, token, reexports: url });

    return { url: standIn.href, format: 'module', shortCircuit: true };
}

/** The stand-in's source: the entry's exports, and its default export (undefined when it has none). */
function standInSource(entry: string): string
{
    return `import * as entry from ${JSON.stringify(entry)};\n`
        + `export * from ${JSON.stringify(entry)};\n`
        + 'export default entry.default;\n';
}

/** A bare specifier: through `paths` when an entry claims it, else down the chain. */
function resolveBare(specifier: string, context: ResolveContext, nextResolve: NextResolve, token: string): ResolveResult
{
    const generation = generations.get(token)!;
    const paths = pathsFor(generation, context.parentURL);
    const match = paths === undefined ? undefined : matchPaths(specifier, paths);
    const file = match === undefined ? undefined : sourceFile(generation, match.candidates);

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

    return TYPESCRIPT.test(file)
        || (!isDependency(realpathSync(file), generation.root) && applicationFormat(file, formatBySyntax, readerFor(generation)) !== undefined);
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

    const file = sourceFile(generations.get(token)!, [path]);

    if (file !== undefined)
    {
        return own(file, token, context, nextResolve, tokenOf(specifier) !== undefined);
    }

    const chained = chainResolves(specifier, context, nextResolve);

    if ('error' in chained)
    {
        throw unresolvedPath(specifier, context.parentURL, chained.error);
    }

    return chained.result;
}

/** The compiler options of the tsconfig that governs `file`, read once per directory per load. */
function projectOptions(generation: Generation, file: string): ts.CompilerOptions
{
    const directory = dirname(file);

    if (!generation.compilerOptions.has(directory))
    {
        generation.compilerOptions.set(directory, governingCompilerOptions(generation.root, directory, readerFor(generation)) ?? {});
    }

    return generation.compilerOptions.get(directory)!;
}

const TRANSFORMED = new Set(['.ts', '.tsx', '.mts', '.jsx']);

/**
 * A JSON file as the ES module tsx serves it to `spfn dev`: the parsed value as
 * the default export, and an object's top-level keys as named exports, as
 * esbuild bundles it for `spfn build`. Node's own JSON module would need
 * `with { type: 'json' }` and has only the default; here both forms load. A
 * leading byte-order mark is dropped, as all three drop it.
 */
function jsonModule(file: string, text: string): string
{
    // A leading byte-order mark is not JSON, and Node, tsx and esbuild drop it.
    const source = text.replace(/^\uFEFF/, '');
    const problem = jsonProblem(source);

    if (problem !== undefined)
    {
        throw raisedAt(new SyntaxError(`${file}: ${problem}`), file);
    }

    const value: unknown = JSON.parse(source);
    const keys = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    const named = keys
        .filter(key => key !== 'default')
        .map((key, index) => `const key${index} = data[${JSON.stringify(key)}];\nexport { key${index} as ${JSON.stringify(key)} };`);

    return [`const data = JSON.parse(${JSON.stringify(source)});`, 'export default data;', ...named].join('\n');
}

/** Why `source` is not JSON, or undefined when it is. */
function jsonProblem(source: string): string | undefined
{
    try
    {
        JSON.parse(source);

        return undefined;
    }
    catch (error)
    {
        return (error as Error).message;
    }
}

/** A syntax error TypeScript found, naming the file, line and column: Node would name none of them. */
function syntaxError(compiler: typeof ts, file: string, diagnostic: ts.Diagnostic): SyntaxError
{
    const { line, character } = diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0);

    return raisedAt(
        new SyntaxError(`${file}:${line + 1}:${character + 1} ${compiler.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`),
        file,
        line + 1,
        character + 1,
    );
}

function transform(url: string, { file, token }: OwnedFile): string
{
    const { source, stamp } = readStamped(file);
    const generation = generations.get(token);

    if (generation !== undefined)
    {
        record(generation, file, stamp);
    }

    if (extname(file) === '.json')
    {
        return jsonModule(file, source);
    }

    if (!TRANSFORMED.has(extname(file)))
    {
        return source;
    }

    const compiler = typescript();
    const output = compiler.transpileModule(source, {
        fileName: file,
        compilerOptions: transpileOptions(compiler, projectOptions(generations.get(token)!, file)),
        reportDiagnostics: true,
    });
    const error = output.diagnostics?.find(diagnostic => diagnostic.category === compiler.DiagnosticCategory.Error && diagnostic.file);

    if (error !== undefined)
    {
        throw syntaxError(compiler, file, error);
    }

    if (output.sourceMapText !== undefined)
    {
        sourceMaps.set(url, new SourceMap(JSON.parse(output.sourceMapText)));
    }

    return output.outputText.replace(/\n\/\/# sourceMappingURL=.*$/, '');
}

/** Node's error for an import attribute, as its own loader raises it: a `TypeError` with Node's code. */
function attributeError(code: string, message: string): TypeError
{
    return Object.assign(new TypeError(message), { code });
}

/**
 * The import attribute checks Node makes on a file it loads, which serving the
 * file here would otherwise skip: no attribute but `type`, `type` only
 * `json`, and `json` only on a JSON file — with Node's codes and messages. A
 * JSON import with no attribute is the one departure: tsx (`spfn dev`) and
 * esbuild (`spfn build`) accept it, so the generator does.
 */
function checkAttributes(url: string, file: string, attributes: Record<string, string> = {}): void
{
    for (const [key, value] of Object.entries(attributes))
    {
        if (key !== 'type' || value !== 'json')
        {
            throw attributeError('ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', `Import attribute "${key}" with value "${value}" is not supported in ${url}`);
        }
    }

    if (attributes.type === 'json' && extname(file) !== '.json')
    {
        throw attributeError('ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', `Module "${url}" is not of type "json"`);
    }
}

export function loadHook(url: string, context: LoadContext, nextLoad: NextLoad): LoadResult
{
    const file = owned.get(url);

    if (file === undefined)
    {
        return nextLoad(url, context);
    }

    checkAttributes(url, file.file, context.importAttributes);

    return { format: 'module', source: file.reexports === undefined ? transform(url, file) : standInSource(file.reexports), shortCircuit: true };
}
