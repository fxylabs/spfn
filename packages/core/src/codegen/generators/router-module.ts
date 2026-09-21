/**
 * Loading a router for a generator
 *
 * `@spfn/core:route-map` and `@spfn/core:contract` both read the router by
 * importing it, and both need the same two things settled before that import
 * runs: the environment the module observes, which otherwise follows whichever
 * shell invoked the generator, and the project's own path aliases, which jiti
 * does not read on its own.
 *
 * Both live here rather than in one generator so the two cannot drift: a
 * process-wide `NODE_ENV` pinned by whichever generator `.spfnrc.ts` happens to
 * list first would otherwise decide what the other one loads.
 */

import { existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { createJiti } from 'jiti';
import ts from 'typescript';
import { logger } from '@spfn/core/logger';

const loadLogger = logger.child('@spfn/core:codegen');

// ============================================================================
// Environment
// ============================================================================

/**
 * Pin NODE_ENV before a router loads.
 *
 * A route module that reads the environment at import — a schema built from a
 * flag, a config module with a `development` branch — would otherwise make the
 * generated output depend on how the generator happened to be invoked.
 *
 * The pin is process-wide and deliberately only applies when NODE_ENV is unset,
 * so calling it from both generators in one run is the same as calling it once:
 * the second call finds the value the first one set and leaves it alone.
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
const PARSE_HOST: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
};

/** One `paths` entry as a jiti alias, or `undefined` when jiti cannot express it. */
function toAlias(pattern: string, targets: string[], base: string): { from: string; to: string } | undefined
{
    const [target] = targets;

    if (!target)
    {
        return undefined;
    }

    if (targets.length > 1)
    {
        loadLogger.warn(
            `tsconfig "paths" maps ${pattern} to ${targets.length} targets; while the router loads, only the `
            + `first (${target}) resolves`,
        );
    }

    if (!pattern.includes('*'))
    {
        return { from: pattern, to: resolve(base, target) };
    }

    // jiti matches an alias by path segment, so the only mapping it can express
    // is a prefix: "@/*" -> "./src/*" becomes "@" -> "<base>/src".
    if (!pattern.endsWith('/*') || !target.endsWith('/*'))
    {
        loadLogger.warn(
            `tsconfig "paths" maps ${pattern} to ${target}, which is not a directory prefix mapping; it will not `
            + 'resolve while the router loads',
        );

        return undefined;
    }

    return { from: pattern.slice(0, -2), to: resolve(base, target.slice(0, -2)) };
}

/** `compilerOptions` of the project's tsconfig, with `extends` already merged. */
function readCompilerOptions(cwd: string): ts.CompilerOptions | undefined
{
    const configPath = join(cwd, 'tsconfig.json');

    if (!existsSync(configPath))
    {
        return undefined;
    }

    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);

    if (error || !config)
    {
        loadLogger.warn(`Could not read ${relative(cwd, configPath)}; its path aliases will not resolve`);

        return undefined;
    }

    return ts.parseJsonConfigFileContent(config, PARSE_HOST, cwd).options;
}

/**
 * The project's tsconfig `paths`, as the alias map jiti resolves.
 *
 * jiti does not read tsconfig: a specifier resolves through its `alias` option
 * or not at all. Every spfn app has `@/*` in its tsconfig — `spfn init` writes
 * it, and the scaffold documents `import env from '@/server/config/env.config'`
 * as the idiom — so a generator that loads the router has to hand jiti the same
 * mappings tsc uses, or an ordinary app cannot generate anything.
 *
 * Handled: an `extends` chain, including one that names a package; `paths`
 * targets resolved against `baseUrl`, and against the config file that declares
 * them when there is no `baseUrl`; comments and trailing commas, because
 * TypeScript's own parser reads the file.
 *
 * Not handled, each with a warning and no alias for that entry: a pattern whose
 * `*` is not a trailing `/*` (jiti matches a prefix, not a template), and every
 * target after the first (jiti takes one). Two patterns that reduce to the same
 * prefix keep the wildcard one, because the exact form of it — `@spfn/auth`
 * beside `@spfn/auth/*` — still resolves through the directory. A `baseUrl`
 * with no `paths` produces nothing: resolving every bare specifier against a
 * directory is not something an alias map can say. A project without a
 * `tsconfig.json` of its own gets no aliases either — the search does not walk
 * up, because the directory the generator runs in is the project it generates.
 */
export function tsconfigAliases(cwd: string): Record<string, string>
{
    const options = readCompilerOptions(cwd);

    if (!options?.paths)
    {
        return {};
    }

    // A target is relative to baseUrl, and to the config that declared `paths`
    // when there is no baseUrl — TypeScript records that as `pathsBasePath`,
    // which its public typings do not carry.
    const base = options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? cwd;

    // Wildcards first: "@spfn/auth/*" and "@spfn/auth" both reduce to the alias
    // "@spfn/auth", and only the wildcard one resolves the subpaths.
    const entries = Object.entries(options.paths)
        .sort(([left], [right]) => Number(right.includes('*')) - Number(left.includes('*')));

    const aliases = new Map<string, string>();

    for (const [pattern, targets] of entries)
    {
        const alias = toAlias(pattern, targets, base);

        if (alias && !aliases.has(alias.from))
        {
            aliases.set(alias.from, alias.to);
        }
    }

    return Object.fromEntries(aliases);
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
function describeFailure(error: unknown, subject: string): string
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
        + 'through the "paths" of the tsconfig.json beside the project root — a mapping held in any other tsconfig '
        + 'is not read. Check that the specifier is mapped there, and that what it points at exists: a workspace '
        + 'package resolves to a dist/ that has to have been built.';
}

export interface RouterModuleLoad
{
    /** Project root: jiti resolves from here, and the tsconfig is read here. */
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

    const jiti = createJiti(cwd, {
        interopDefault: true,
        moduleCache: false,
        alias: tsconfigAliases(cwd),
    });

    try
    {
        return jiti(absoluteRouterPath) as Record<string, unknown>;
    }
    catch (error)
    {
        throw fail(`Failed to load ${relative(cwd, absoluteRouterPath)}: ${describeFailure(error, subject)}`);
    }
}
