/**
 * Loading a router for a generator
 *
 * `@spfn/core:route-map` and `@spfn/core:contract` both read the router by
 * importing it, and both need the same things settled before that import runs:
 * the environment the module observes, which otherwise follows whichever shell
 * invoked the generator, and the project's own path aliases, which jiti does not
 * read on its own.
 *
 * Both live here rather than in one generator so the two cannot drift: a
 * process-wide `NODE_ENV` pinned by whichever generator `.spfnrc.ts` happens to
 * list first would otherwise decide what the other one loads.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { createJiti } from 'jiti';
import type * as ts from 'typescript';
import type { RouteDef, Router } from '@spfn/core/route';
import { logger } from '@spfn/core/logger';
import { typescript } from './typescript';

const loadLogger = logger.child('@spfn/core:codegen');

// ============================================================================
// Environment
// ============================================================================

/**
 * Pin NODE_ENV before a router loads.
 *
 * A route module that reads the environment at import — a schema built from a
 * flag, a config module with a `development` branch — would otherwise make the
 * generated output depend on how the generator happened to be invoked. It is
 * also what stands in for the guard against a condition the guard cannot see,
 * such as one hoisted to a variable before the spread that registers it — but
 * only when the shell left NODE_ENV unset.
 *
 * The pin is process-wide and deliberately only applies when NODE_ENV is unset,
 * so calling it from both generators in one run is the same as calling it once:
 * the second call finds the value the first one set and leaves it alone.
 *
 * It is unconditional nowhere, and `spfn dev` is why: it sets `development`
 * before spawning the watcher, and a route registered only in development has
 * to be in the map the watcher writes or it 404s in `spfn dev` itself.
 * `spfn build` pins `production` and generates before it compiles, so what ships
 * is right; the cost is churn between the two, which the generated header makes
 * visible by naming the NODE_ENV the map was written under.
 */
export function pinNodeEnv(): void
{
    if (process.env.NODE_ENV)
    {
        return;
    }

    process.env.NODE_ENV = 'production';
    loadLogger.info('NODE_ENV was unset; pinned to "production" so generated output does not depend on the shell');
}

// ============================================================================
// tsconfig path aliases
// ============================================================================

/**
 * `readDirectory` is stubbed out: only `compilerOptions` is wanted here, and
 * letting TypeScript expand `include` would glob the whole project for nothing.
 */
function parseHost(compiler: typeof ts): ts.ParseConfigHost
{
    return {
        useCaseSensitiveFileNames: compiler.sys.useCaseSensitiveFileNames,
        readDirectory: () => [],
        fileExists: compiler.sys.fileExists,
        readFile: compiler.sys.readFile,
    };
}

/**
 * "No inputs were found in config file". The stubbed `readDirectory` produces it
 * every time and it says nothing about the config.
 */
const NO_INPUTS = 18003;

/**
 * One tsconfig `paths` entry, as jiti resolves it.
 *
 * `from`/`to` are the alias; `pattern`, `target` and `others` are kept so that a
 * specifier which did not resolve can say which target it was tried through and
 * which ones the entry also listed — jiti holds one alias per key, so those
 * others were never tried.
 */
interface AliasEntry
{
    from: string;
    to: string;
    pattern: string;
    target: string;
    others: string[];
}

/** What has to exist for a target to resolve: the directory a prefix names, or the file itself. */
function targetPath(target: string, base: string): string
{
    return resolve(base, target.endsWith('/*') ? target.slice(0, -2) : target);
}

/**
 * Codes the filesystem raises when it refuses to read a path at all.
 *
 * POSIX says EACCES; Windows and some container runtimes say EPERM for the same
 * directory. Keying on one of them would fix a developer machine and leave the
 * other platform crashing, so the guard names both.
 */
const UNREADABLE_CODES = new Set(['EACCES', 'EPERM']);

/** Whether an error is the filesystem refusing to read a path, rather than a fault to surface. */
function isUnreadable(error: unknown): boolean
{
    // A `throw` that is not an object at all must not make the guard itself throw and
    // bury what was really raised.
    return UNREADABLE_CODES.has((error as { code?: string } | null)?.code ?? '');
}

/**
 * Whether a target can resolve anything at all.
 *
 * TypeScript and tsup substitute each target and take the first that resolves
 * the *requested module*; jiti holds one alias per key, so the nearest this can
 * get is asking whether the directory a prefix names holds anything. That is
 * the difference that matters in practice: a `dist` left behind by `rm -rf
 * dist/*`, or created empty by a tool that then failed, exists and resolves
 * nothing, and taking it ahead of `./src/*` left every import unresolved.
 *
 * A target with no wildcard names a file, and `existsSync` is the whole of the
 * question for it — it reports false for a path it cannot read rather than
 * throwing.
 *
 * The wildcard branch has to say so itself. `throwIfNoEntry: false` suppresses
 * only ENOENT: a directory the process cannot read stats fine and then makes
 * `readdirSync` throw, and an unreadable parent makes `statSync` throw too. That
 * used to reach the developer as a bare `EACCES: permission denied, scandir` from
 * inside `loadRouterModule`, before the catch that names the file and the cause.
 * A target that cannot be read resolves nothing, so it counts as unresolvable and
 * the next target in the entry is tried — which is what the caller already does
 * for a missing one. Every other error is left to throw.
 */
function targetResolves(target: string, base: string): boolean
{
    const path = targetPath(target, base);

    if (!target.endsWith('/*'))
    {
        return existsSync(path);
    }

    try
    {
        const stats = statSync(path, { throwIfNoEntry: false });

        return stats?.isDirectory() === true && readdirSync(path).length > 0;
    }
    catch (error)
    {
        if (!isUnreadable(error))
        {
            throw error;
        }

        return false;
    }
}

/** The target a `paths` entry resolves through, and the ones it passed over. */
interface TargetChoice
{
    target: string;

    /** Targets the pattern also listed. Named in a failure, since jiti tried none of them. */
    others: string[];
}

/**
 * The target a `paths` entry resolves through.
 *
 * TypeScript tries each target in order and takes the first that resolves, and
 * so does tsup; jiti holds one alias per key. Taking the first target
 * unconditionally therefore failed a project whose first target is a build
 * output that has not been produced — an ordinary shape for a `paths` entry
 * listing `./dist/*` before `./src/*`.
 */
function chooseTarget(pattern: string, targets: string[], base: string): TargetChoice | undefined
{
    const present = targets.filter(target => targetResolves(target, base));
    const [target] = present.length > 0 ? present : targets;

    if (!target)
    {
        return undefined;
    }

    if (present.length > 1)
    {
        loadLogger.warn(
            `tsconfig "paths" maps ${pattern} to ${present.length} targets that could each resolve a module; `
            + `while the router loads, only the first (${target}) does`,
        );
    }

    if (present.length === 0 && targets.length > 1)
    {
        loadLogger.warn(
            `tsconfig "paths" maps ${pattern} to ${targets.length} targets and none of them exists with anything `
            + `in it; ${target} is used, and an import through it will name itself as unresolved`,
        );
    }

    return { target, others: targets.filter(candidate => candidate !== target) };
}

/** One `paths` entry as a jiti alias, or `undefined` when jiti cannot express it. */
function toAlias(pattern: string, targets: string[], base: string): AliasEntry | undefined
{
    const choice = chooseTarget(pattern, targets, base);

    if (!choice)
    {
        return undefined;
    }

    const { target, others } = choice;

    if (!pattern.includes('*'))
    {
        return { from: pattern, to: resolve(base, target), pattern, target, others };
    }

    // jiti matches an alias by path segment, so the only mapping it can express
    // is a prefix: "@/*" -> "./src/*" becomes "@/" -> "<base>/src".
    if (!pattern.endsWith('/*') || !target.endsWith('/*'))
    {
        loadLogger.warn(
            `tsconfig "paths" maps ${pattern} to ${target}, which is not a directory prefix mapping; it will not `
            + 'resolve while the router loads',
        );

        return undefined;
    }

    // The trailing slash is kept, so "@x/*" and "@x" — one entry per form, which
    // is how a package maps its own subpaths beside its entry point — become two
    // aliases instead of collapsing onto "@x" and losing the exact one. jiti
    // resolves "@x/a" through "@x/" either way.
    return { from: pattern.slice(0, -1), to: resolve(base, target.slice(0, -2)), pattern, target, others };
}

/** `compilerOptions` of one tsconfig, with `extends` already merged. */
function readCompilerOptions(configPath: string, cwd: string): ts.CompilerOptions | undefined
{
    if (!existsSync(configPath))
    {
        return undefined;
    }

    const compiler = typescript();
    const { config, error } = compiler.readConfigFile(configPath, compiler.sys.readFile);

    if (error || !config)
    {
        loadLogger.warn(`Could not read ${relative(cwd, configPath)}; its path aliases will not resolve`);

        return undefined;
    }

    const parsed = compiler.parseJsonConfigFileContent(config, parseHost(compiler), dirname(configPath));

    // An `extends` target TypeScript cannot read leaves `paths` empty rather
    // than failing, and the router then fails to load for a reason that looks
    // like a missing mapping. Reachable in ordinary CI: a base config outside
    // the package, not copied into a Docker stage.
    for (const diagnostic of parsed.errors)
    {
        if (diagnostic.code !== NO_INPUTS)
        {
            loadLogger.warn(
                `${relative(cwd, configPath)}: ${compiler.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} `
                + '— path aliases it should have declared may be missing while the router loads',
            );
        }
    }

    return parsed.options;
}

/** Whether `directory` is `root` or below it. */
function isWithin(root: string, directory: string): boolean
{
    const step = relative(root, directory);

    return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

/**
 * The directories to look in, nearest first: from `startDir` up to and
 * including the project root.
 *
 * The search stops at the project root, because a tsconfig above it belongs to
 * whatever contains the project — a monorepo root, a home directory — and not
 * to the project being generated. A `startDir` outside the root contributes
 * nothing, leaving the root itself.
 */
function searchDirectories(cwd: string, startDir: string): string[]
{
    const root = resolve(cwd);
    const directories: string[] = [];

    for (let directory = resolve(startDir); isWithin(root, directory); directory = dirname(directory))
    {
        directories.push(directory);

        if (directory === root)
        {
            return directories;
        }
    }

    return [root];
}

/** `paths` as jiti aliases, with their targets resolved against `base`. */
function aliasesOf(paths: ts.MapLike<string[]>, base: string): AliasEntry[]
{
    const aliases = new Map<string, AliasEntry>();

    for (const [pattern, targets] of Object.entries(paths))
    {
        const alias = toAlias(pattern, targets, base);

        if (alias && !aliases.has(alias.from))
        {
            aliases.set(alias.from, alias);
        }
    }

    return [...aliases.values()];
}

/**
 * The project's tsconfig `paths`, as the alias map jiti resolves.
 *
 * jiti does not read tsconfig: a specifier resolves through its `alias` option
 * or not at all. Every spfn app has `@/*` in a tsconfig — `spfn init` writes it,
 * and the scaffold documents `import env from '@/server/config/env.config'` as
 * the idiom — so a generator that loads the router has to hand jiti the same
 * mappings tsc uses, or an ordinary app cannot generate anything.
 *
 * Which tsconfig: the nearest one to the router file that declares `paths`,
 * searching upward to the project root. The scaffold's aliases live in
 * `src/server/tsconfig.json` — with `baseUrl: "../.."` — and that is the config
 * `spfn build` compiles the server with, so a backend-only app has them nowhere
 * else. A config declaring no `paths` is passed over rather than ending the
 * search, because the same `src/server/tsconfig.json` declares none in an app
 * that keeps its aliases at the root (Next.js puts them there).
 *
 * Handled: an `extends` chain, including one that names a package; `paths`
 * targets resolved against `baseUrl`, and against the config file that declares
 * them when there is no `baseUrl`; several targets per pattern, taking the first
 * that resolves as tsc and tsup do; comments and trailing commas, because
 * TypeScript's own parser reads the file.
 *
 * Not handled, each with a warning and no alias for that entry: a pattern whose
 * `*` is not a trailing `/*` (jiti matches a prefix, not a template). A
 * `baseUrl` with no `paths` produces nothing: resolving every bare specifier
 * against a directory is not something an alias map can say.
 */
function projectAliases(cwd: string, startDir: string): AliasEntry[]
{
    for (const directory of searchDirectories(cwd, startDir))
    {
        const options = readCompilerOptions(join(directory, 'tsconfig.json'), cwd);

        if (options?.paths)
        {
            // A target is relative to baseUrl, and to the config that declared
            // `paths` when there is no baseUrl — TypeScript records that as
            // `pathsBasePath`, which its public typings do not carry.
            const declaredIn = (options as { pathsBasePath?: string }).pathsBasePath;

            return aliasesOf(options.paths, options.baseUrl ?? declaredIn ?? directory);
        }
    }

    return [];
}

/** The alias map jiti is handed: see `projectAliases`, of which this is the public shape. */
export function tsconfigAliases(cwd: string, startDir: string = cwd): Record<string, string>
{
    return Object.fromEntries(projectAliases(cwd, startDir).map(alias => [alias.from, alias.to]));
}

// ============================================================================
// Loading
// ============================================================================

/**
 * An import that never resolved and a module that threw are different repairs.
 *
 * The message used to advise the second for both, which sends a developer whose
 * router imports `@/server/routes` looking for a module-scope side effect that
 * is not there.
 */
function describeFailure(error: unknown, subject: string, aliases: AliasEntry[]): string
{
    const message = error instanceof Error ? error.message : String(error);
    const unresolved = /Cannot find module '([^']+)'/.exec(message);

    if (!unresolved)
    {
        return `${message}\n\n`
            + `The ${subject} is read from the loaded router, so a route module must be importable without side `
            + 'effects. Check that nothing at module scope opens a connection or reads a missing environment value.';
    }

    return `${message.split('\n')[0]}\n\n`
        + `"${unresolved[1]}" did not resolve while the router was being imported. Imports resolve through Node and `
        + 'through the "paths" of the nearest tsconfig.json that declares them, searching from the router file up to '
        + 'the project root. Check that the specifier is mapped in one of those, and that what it points at exists: '
        + 'a workspace package resolves to a dist/ that has to have been built.'
        + describePassedOverTargets(unresolved[1], aliases);
}

/**
 * The targets the failing specifier was never tried through.
 *
 * tsc substitutes every target of a matching pattern and takes the first that
 * resolves the requested module; jiti holds one alias per key, so exactly one
 * was tried. When the pattern listed others, the import that just failed would
 * very likely have resolved through one of them, and saying so is the whole
 * repair — the alternative is a developer reading "did not resolve" about a
 * module that plainly exists under `./src`.
 */
function describePassedOverTargets(specifier: string, aliases: AliasEntry[]): string
{
    // Matched on either spelling: the loader names the specifier it was given
    // for an alias it has no mapping for, and the path it resolved to for one it
    // does — and it is the second that reaches here.
    const alias = aliases.find(entry => specifier.startsWith(entry.from) || specifier.startsWith(entry.to));

    if (!alias || alias.others.length === 0)
    {
        return '';
    }

    return `\n\nIt was resolved through "${alias.target}", the first target of the "paths" entry `
        + `"${alias.pattern}" that names a directory holding anything. That entry also lists `
        + `${alias.others.map(other => `"${other}"`).join(', ')}, which the router load never tried: one alias per `
        + 'key is all the loader can express, so the whole load goes through a single target.';
}

export interface RouterModuleLoad
{
    /** Project root: jiti resolves from here, and the tsconfig search stops here. */
    cwd: string;

    absoluteRouterPath: string;

    /** What is being generated, named in the failure message: `route map`. */
    subject: string;

    /** Wraps the message in the calling generator's own error type. */
    fail: (message: string) => Error;
}

/**
 * Import the router module, or throw the caller's error describing why not.
 */
export function loadRouterModule(load: RouterModuleLoad): Record<string, unknown>
{
    const { cwd, absoluteRouterPath, subject, fail } = load;

    const aliases = projectAliases(cwd, dirname(absoluteRouterPath));

    const jiti = createJiti(cwd, {
        interopDefault: true,
        moduleCache: false,
        alias: Object.fromEntries(aliases.map(alias => [alias.from, alias.to])),
    });

    try
    {
        return jiti(absoluteRouterPath) as Record<string, unknown>;
    }
    catch (error)
    {
        throw fail(
            `Failed to load ${relative(cwd, absoluteRouterPath)}: ${describeFailure(error, subject, aliases)}`,
        );
    }
}

export function isRouter(value: unknown): value is Router<Record<string, RouteDef<any> | Router<any>>>
{
    return value !== null
        && typeof value === 'object'
        && 'routes' in value
        && '_routes' in value;
}

export interface ResolvedRouter
{
    router: Router<any>;

    /**
     * The export it was found under.
     *
     * Both generators try `appRouter`, `default` and `router` in turn, so a file
     * holding more than one router is read from whichever of those it declares.
     * The guard then reads that same one rather than every `defineRouter(` in
     * the file: a router the loader did not find is a router production never
     * mounts.
     */
    exportName: string;
}

/** The first candidate export holding a router, and the name it was found under. */
export function resolveRouterExport(module: Record<string, unknown>, candidates: string[]): ResolvedRouter | undefined
{
    for (const exportName of candidates)
    {
        const candidate = module[exportName];

        if (isRouter(candidate))
        {
            return { router: candidate, exportName };
        }
    }

    return undefined;
}
