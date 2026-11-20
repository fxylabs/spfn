/**
 * One `@spfn/core` per process
 *
 * Every entry of this package records, as it is evaluated, where it was loaded
 * from and what evaluated it. The build adds the call to each entry it emits,
 * with the entry's own `import.meta.url` and the version from `package.json`
 * (`tsup.config.ts`), so an entry added later records by construction. The
 * code below is inlined into every entry — each copy of an entry carries its
 * own — which is what lets a copy name its own evaluator.
 *
 * An evaluation's identity is its file path and its evaluator, and each one
 * counts how many times it was evaluated. To the server, the same path
 * evaluated again by the same evaluator — a test runner resetting its module
 * registry, HMR — is the same copy again. The same path by another evaluator,
 * or another path, is a second copy, with its own module state: a policy
 * registered on one is not what the other reads. A TypeScript loader runs a
 * CommonJS file of the app beside a server it runs as ESM and re-evaluates
 * every ESM-only `@spfn/*` file that file reaches into a CommonJS copy (#329);
 * a test loads the package both inlined by vitest and externally; or two
 * installs — two versions, or one version installed twice because pnpm
 * resolved its peers differently for two dependents — are each evaluated once.
 * Plain Node shares one instance across `import` and `require()` of an ES
 * module, and records one evaluation. The version is recorded for the message.
 *
 * The rule sits where the fact changes. `startServer` marks the process as a
 * server before it loads anything of the app, refusing a second copy recorded
 * before that; from then on `recordEvaluation` refuses one itself, so the
 * import that would bring it in — at boot or lazily in a request, a job, an
 * event handler — throws, and the copy never reaches its importer.
 *
 * The spfn CLI marks the same way every process of its own that loads the
 * app's source — `db`, `provision`, codegen (`markAppSourceProcess`): from the
 * mark on, a second copy is refused where it is recorded, as in a server.
 *
 * Codegen also checks after each router load (`codegenSecondCopy`), and there
 * a repeated evaluation of one path counts too: the codegen loader evaluates
 * the project again on every load and a package never, so a package evaluated
 * twice natively — given a generation query by mistake — is as much a second
 * copy as one evaluated as CommonJS. A marked process refuses it; any other
 * caller of codegen — a script, a test — is warned. vitest's own
 * re-evaluations, which a module reset makes, are not counted. Processes that
 * neither serve nor are marked (scripts, `spfn env`, a Next.js server
 * bundling the package) record and never refuse.
 *
 * The registry lives on `globalThis` under a `Symbol.for` key, so every copy
 * and every version reads and writes the same one: its shape is a contract
 * between versions.
 */

/**
 * What evaluated an entry, each told apart by a property only it has:
 *
 * - `vitest` — vitest's module runner (an inlined dependency): the
 *   `__vite_ssr_import_meta__` argument its wrapper hands every module. It also
 *   hands a `module`, without a `filename`.
 * - `cjs` — a CommonJS evaluation, Node's `Module#_compile` (as tsx's
 *   CommonJS transform runs it): a `module` with a `filename` and `paths`.
 *   Node's own `require()` of this ES module is not one — it shares the ESM
 *   instance. tsx's `require`/`tsImport` API evaluates in a namespace of its
 *   own, which `import.meta.url` carries as `?namespace=`.
 * - `esm` — Node's ESM loader: no `module`, and an `import.meta.resolve`.
 * - `bundle` — none of them: a bundler's chunk (Next.js webpack or Turbopack),
 *   whose `import.meta.url` is whatever the bundler made of it.
 */
type Evaluator = 'esm' | 'cjs' | 'vitest' | 'bundle';

/** One copy of an entry: where it was loaded from, what evaluated it, and the version it was built as. */
interface Evaluation
{
    /** The entry's file path, without query or hash; the URL itself when it is not a `file:` URL. */
    location: string;
    evaluator: Evaluator;
    /** tsx's API namespace of a CommonJS evaluation: a module cache of its own. */
    namespace?: string;
    version: string;
    /** For a CommonJS copy, the file that required it, as far as it is known. */
    requiredBy?: string;
    /** How many times this copy was evaluated. Absent in a record an older version wrote: once, as far as it said. */
    count?: number;
}

interface Registry
{
    evaluations: Map<string, Evaluation[]>;
    /** Set by `startServer`; from then on a second copy is refused where it is recorded. */
    server?: { logError: (message: string) => void; logged: Set<string> };
    /** Set by `markAppSourceProcess`: from then on a second copy is refused where it is recorded, and one found after a router load too. */
    appSource?: { refuse: true; foreignRunner?: ForeignRunner };
}

/** The wrapper argument vitest's module runner evaluates a module with; undeclared anywhere else. */
declare const __vite_ssr_import_meta__: unknown;

const REGISTRY_KEY = Symbol.for('@spfn/core:module-evaluations');

function registry(): Registry
{
    const holder = globalThis as { [REGISTRY_KEY]?: Registry };

    holder[REGISTRY_KEY] ??= { evaluations: new Map() };

    return holder[REGISTRY_KEY];
}

/**
 * The parts of `node:fs` and `node:path` the requirer is found with, taken by
 * `process.getBuiltinModule` (the `@types/node` this package builds with
 * predates it) and only in a CommonJS evaluation: every entry inlines this
 * file, and a bundled one must not import Node's modules.
 */
interface NodeBuiltins
{
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: 'utf8'): string;
    dirname(path: string): string;
    isAbsolute(path: string): boolean;
    join(...paths: string[]): string;
}

function nodeBuiltins(): NodeBuiltins
{
    const { getBuiltinModule } = process as unknown as { getBuiltinModule(id: string): object };

    return { ...getBuiltinModule('node:fs'), ...getBuiltinModule('node:path') } as NodeBuiltins;
}

/** Package names by the directory looked up from, each resolved once. */
const packageNamesByDirectory = new Map<string, string | undefined>();

/** The name of the package `file` belongs to — the nearest directory with a `package.json` — if `file` is a path at all. */
function packageNameOf(file: string, node: NodeBuiltins): string | undefined
{
    return node.isAbsolute(file) ? packageNameAt(node.dirname(file), node) : undefined;
}

function packageNameAt(directory: string, node: NodeBuiltins): string | undefined
{
    if (!packageNamesByDirectory.has(directory))
    {
        const packageJson = node.join(directory, 'package.json');
        const parent = node.dirname(directory);

        packageNamesByDirectory.set(directory, node.existsSync(packageJson)
            ? JSON.parse(node.readFileSync(packageJson, 'utf8')).name
            : parent === directory ? undefined : packageNameAt(parent, node));
    }

    return packageNamesByDirectory.get(directory);
}

/**
 * The files of the synchronous frames calling this one, innermost first, read
 * structurally from V8's call sites. None when the stack is not the call sites:
 * V8 does not call `Error.prepareStackTrace` re-entrantly, so an evaluation
 * inside another library's hook (an error formatter requiring the logger)
 * gets a formatted string, and the requirer is then unknown.
 */
function synchronousCallerFiles(): string[]
{
    const { prepareStackTrace, stackTraceLimit } = Error;

    Error.prepareStackTrace = (_error, sites) => sites;
    Error.stackTraceLimit = Infinity;

    try
    {
        const sites: unknown = new Error().stack;

        if (!Array.isArray(sites))
        {
            return [];
        }

        return (sites as NodeJS.CallSite[])
            .filter(site => !(site as NodeJS.CallSite & { isAsync(): boolean }).isAsync())
            .map(site => site.getFileName())
            .filter(file => file !== undefined && file !== null)
            .map(locationOf);
    }
    finally
    {
        Error.prepareStackTrace = prepareStackTrace;
        Error.stackTraceLimit = stackTraceLimit;
    }
}

/**
 * The file this CommonJS evaluation of the entry was required for: the
 * outermost requirer — the file the chain of `require()` calls starts at,
 * which is the one loaded as CommonJS from ESM (an app's `server.config.ts`
 * under an old runner, a `.cjs` the app imports, a dependency requiring
 * @spfn/core). The direct requirer is often another file of this package
 * reaching this one, which names nothing the app can change.
 *
 * Read from the call sites, not `module.parent`: Node's ESM loader runs a
 * `.cjs` it imports with a `require` of its own when loader hooks are
 * registered (tsx, `spfn dev`), and what that loads has no `parent`. The chain
 * is the synchronous frames; an `async` frame is the importer awaiting it, not
 * a requirer. Left out is what is certain not to be the requirer without
 * knowing where the app is: Node's internals and the loader's (tsx's) frames
 * around the require. This package's own frames are not: they are the
 * outermost only when it synchronously loads app code itself, which only
 * codegen's `require()` of `.spfnrc.ts` does — as an ES module, which shares
 * the process's instance and records no CommonJS copy.
 */
function requiringFile(): string | undefined
{
    const node = nodeBuiltins();

    return synchronousCallerFiles()
        .filter(file => !file.startsWith('node:'))
        .filter(file => packageNameOf(file, node) !== 'tsx')
        .at(-1);
}

function isCommonJsModule(): boolean
{
    return typeof module === 'object' && module !== null
        && typeof module.filename === 'string' && Array.isArray(module.paths);
}

function evaluatorOf(): Evaluator
{
    if (typeof __vite_ssr_import_meta__ === 'object')
    {
        return 'vitest';
    }

    if (isCommonJsModule())
    {
        return 'cjs';
    }

    return typeof import.meta.resolve === 'function' ? 'esm' : 'bundle';
}

/** A file URL as the path it names (a Windows drive path too); any other URL as it is. Query and hash dropped. */
function locationOf(url: string): string
{
    const bare = url.replace(/[?#].*$/, '');

    if (!bare.startsWith('file:'))
    {
        return bare;
    }

    const path = decodeURIComponent(new URL(bare).pathname);

    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, '\\') : path;
}

function thisEvaluation(url: unknown, version: string): Evaluation
{
    const evaluator = evaluatorOf();
    const location = typeof url === 'string' ? locationOf(url) : 'an unknown location';

    return evaluator === 'cjs'
        ? {
            location,
            evaluator,
            namespace: typeof url === 'string' ? /[?&]namespace=([^&#]*)/.exec(url)?.[1] : undefined,
            version,
            requiredBy: requiringFile(),
        }
        : { location, evaluator, version };
}

function sameCopy(a: Evaluation, b: Evaluation): boolean
{
    return a.location === b.location && a.evaluator === b.evaluator && a.namespace === b.namespace;
}

/**
 * Called once by each built entry, with its own name (`@spfn/core/server`),
 * its own `import.meta.url`, and the package version it was built as.
 *
 * @throws Error in a server process, when this evaluation is a second copy of
 *   the entry — from the evaluating module, so the import that asked for it fails
 */
export function recordEvaluation(entry: string, url: unknown, version: string): void
{
    const evaluation = thisEvaluation(url, version);
    const seen = registry().evaluations.get(entry) ?? [];

    const same = seen.find(other => sameCopy(other, evaluation));

    if (same !== undefined)
    {
        same.count = (same.count ?? 1) + 1;

        return;
    }

    if ((registry().server !== undefined || registry().appSource !== undefined) && seen.length > 0)
    {
        refuseSecondCopy(new Map([[entry, [...seen, evaluation]]]));
    }

    registry().evaluations.set(entry, [...seen, evaluation]);
}

/**
 * Marks this process as a server. Called by `startServer` before it loads
 * anything of the app; from then on a second copy of an entry is refused where
 * it is recorded.
 *
 * @param logError where a refusal after boot is logged, once, besides being thrown
 * @throws Error when a second copy was recorded before the mark
 */
export function markServerProcess(logError: (message: string) => void): void
{
    registry().server ??= { logError, logged: new Set() };

    refuseCopiesRecordedBefore();
}

/**
 * A runner — the spfn CLI — whose own `@spfn/core` is not the app's: a CLI
 * installed globally or run by `npx`/`dlx` in an app with its own core. Two
 * installs, one of them under `location`, are then the runner's doing, and
 * `remedy` says what to do instead of deduping the app.
 */
export interface ForeignRunner
{
    /** The root of the runner's own `@spfn/core` install, a real path. */
    location: string;
    remedy: string;
}

/**
 * Marks this process as one the spfn CLI started to load the app's source: a
 * second copy of an entry is then refused where it is recorded, as in a server,
 * and one `codegenSecondCopy` finds after a router load is refused rather than
 * warned about. Called in-process by the spfn CLI before it loads anything of
 * the app — every `spfn db` command, the `spfn provision` runner, the codegen
 * commands (`codegen run`, `build`'s generation step, `contract`) and the
 * `spfn dev` watcher entry; the mark is not an environment variable, so no
 * process they spawn (the dev server, `next`, `drizzle-kit`) inherits it.
 *
 * @param options.foreignRunner set when the caller's own `@spfn/core` is not the app's
 * @throws Error when a second copy was recorded before the mark
 */
export function markAppSourceProcess(options: { foreignRunner?: ForeignRunner } = {}): void
{
    registry().appSource ??= { refuse: true, foreignRunner: options.foreignRunner };

    refuseCopiesRecordedBefore();
}

function refuseCopiesRecordedBefore(): void
{
    const split = [...registry().evaluations].filter(([, evaluations]) => evaluations.length > 1);

    if (split.length > 0)
    {
        throw new Error(secondCopyMessage(new Map(split)));
    }
}

/** An evaluation, once per time it was evaluated — vitest's re-evaluations, from a module reset, once in all. */
function codegenEvaluations(evaluation: Evaluation): Evaluation[]
{
    const count = evaluation.evaluator === 'vitest' ? 1 : evaluation.count ?? 1;

    return Array.from({ length: count }, () => evaluation);
}

/**
 * Every entry evaluated more than once in this process — by two evaluators, from
 * two installs, or one path natively twice — as the refusal describes it, and
 * whether this process refuses it (`markAppSourceProcess`); undefined when each
 * entry was evaluated once.
 */
export function codegenSecondCopy(): { message: string; refuse: boolean } | undefined
{
    const split = [...registry().evaluations]
        .map(([entry, evaluations]) => [entry, evaluations.flatMap(codegenEvaluations)] as const)
        .filter(([, evaluations]) => evaluations.length > 1);

    return split.length === 0
        ? undefined
        : { message: secondCopyMessage(new Map(split)), refuse: registry().appSource !== undefined };
}

function refuseSecondCopy(split: Map<string, Evaluation[]>): never
{
    const message = secondCopyMessage(split);
    const server = registry().server;

    if (server !== undefined && !server.logged.has(message))
    {
        server.logged.add(message);
        server.logError(message);
    }

    throw new Error(message);
}

function secondCopyMessage(split: Map<string, Evaluation[]>): string
{
    const loads = [...split].map(([entry, evaluations]) => describeSplit(entry, evaluations));

    return `Refusing a second copy of @spfn/core in this process: ${loads.join('; ')}. Each copy keeps its own `
        + 'state — rate-limit policies, trusted proxy hops, the router — so what the app configures on one is not '
        + `what the other serves. ${remedies([...split.values()]).join(' ')}`;
}

const EVALUATOR_NAMES: Record<Evaluator, string> = {
    esm: 'natively as ESM',
    cjs: 'as CommonJS',
    vitest: 'by vitest\'s module runner',
    bundle: 'as a bundler\'s chunk',
};

/** Two installs by their locations; one install evaluated twice by its evaluators. */
function describeSplit(entry: string, evaluations: Evaluation[]): string
{
    const locations = new Set(evaluations.map(evaluation => evaluation.location));

    if (locations.size > 1)
    {
        const oneEvaluator = new Set(evaluations.map(evaluation => evaluation.evaluator)).size === 1;
        const installs = evaluations.map(evaluation => `\`${evaluation.location}\` (${evaluation.version}`
            + `${oneEvaluator ? '' : `, ${describeEvaluator(evaluation)}`})`);

        return `${entry} was loaded from ${locations.size === 2 ? 'two' : locations.size} installs: ${installs.join(' and ')}`;
    }

    const [{ location, version }] = evaluations;

    return `${entry} (\`${location}\`, ${version}) was evaluated `
        + `${evaluations.length === 2 ? 'twice' : `${evaluations.length} times`}: `
        + evaluations.map(describeEvaluator).join(' and ');
}

function describeEvaluator(evaluation: Evaluation): string
{
    const namespace = evaluation.namespace === undefined ? '' : ` in tsx namespace ${evaluation.namespace}`;
    const requiredBy = evaluation.requiredBy === undefined ? '' : `, required by ${evaluation.requiredBy}`;

    return `${EVALUATOR_NAMES[evaluation.evaluator]}${namespace}${requiredBy}`;
}

/** Whether the file at `location` is inside the directory `root`, on either separator. */
function isInside(location: string, root: string): boolean
{
    return location.startsWith(`${root}/`) || location.startsWith(`${root}\\`);
}

/** What to do about two installs: the runner's, when one of them is a foreign runner's own; else dedupe. */
function twoInstallsRemedy(splits: Evaluation[][]): string
{
    const runner = registry().appSource?.foreignRunner;
    const runnersOwn = runner !== undefined && splits.some(evaluations =>
        evaluations.some(evaluation => isInside(evaluation.location, runner.location)));

    return runnersOwn
        ? `Two installs of @spfn/core: ${runner.remedy}`
        : 'Two installs of @spfn/core: dedupe — make @spfn/core resolve to one install for the app and every '
            + '@spfn package (`pnpm why @spfn/core`; a peer such as drizzle-orm, next or react resolved differently '
            + 'for two dependents installs it twice).';
}

/** What to do, by what tells the copies apart: their installs, or the evaluators beside each other. */
function remedies(splits: Evaluation[][]): string[]
{
    const twoInstalls = splits.some(evaluations => new Set(evaluations.map(evaluation => evaluation.location)).size > 1)
        ? [twoInstallsRemedy(splits)]
        : [];
    const byEvaluator = splits.flatMap(evaluations => evaluatorRemedies(evaluations));

    return [...new Set([...twoInstalls, ...byEvaluator])];
}

function evaluatorRemedies(evaluations: Evaluation[]): string[]
{
    const evaluators = new Set(evaluations.map(evaluation => evaluation.evaluator));
    const commonJs = evaluations
        .filter(evaluation => evaluation.evaluator === 'cjs')
        .map(evaluation => commonJsRemedy(evaluation.requiredBy));
    const vitest = evaluators.has('vitest') && evaluators.size > 1
        ? ['The test loads @spfn/core both inlined by vitest (`server.deps.inline`) and externally: make it one of '
            + 'them — inline every package that imports @spfn/core together with it, or none.']
        : [];
    const bundle = evaluators.has('bundle') && evaluators.size > 1
        ? ['A bundled copy of @spfn/core runs beside a loaded one: bundle every importer of @spfn/core, or none.']
        : [];
    const native = evaluations.filter(evaluation => evaluation.evaluator === 'esm').map(evaluation => evaluation.location);
    const repeated = native.length > new Set(native).size
        ? ['One file was evaluated natively more than once, which Node does only for an import URL that differs by '
            + 'its query: import @spfn/* without a query. If no code of yours does, the codegen loader tagged a '
            + 'package as project source — report it.']
        : [];

    return [...commonJs, ...vitest, ...bundle, ...repeated];
}

/** What to do about a CommonJS copy, by the file that required it. */
function commonJsRemedy(requiredBy: string | undefined): string
{
    if (requiredBy !== undefined && /\.tsx?$/.test(requiredBy))
    {
        return `${requiredBy} is TypeScript run as CommonJS: the spfn CLI is older than this @spfn/core, or the `
            + 'process was not started by the spfn CLI — upgrade spfn together with @spfn/core and run the app '
            + 'through it (`spfn dev`, `spfn db`, `spfn provision`).';
    }

    if (requiredBy !== undefined && /\.(c?js|jsx|cts)$/.test(requiredBy))
    {
        return `${requiredBy} is CommonJS, and under the spfn CLI a CommonJS file that requires @spfn/* gets a `
            + 'copy of its own: import @spfn/* from an ES module (.ts, .mts, or .js written with import/export).';
    }

    return 'Run the app as one module format: add "type": "module" to its package.json.';
}
