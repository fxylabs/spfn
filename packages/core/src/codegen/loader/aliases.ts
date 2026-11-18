/**
 * tsconfig `paths`, as the codegen loader resolves them
 *
 * Every spfn app has `@/*` in a tsconfig — `spfn init` writes it, and the
 * scaffold documents `import env from '@/server/config/env.config'` as the
 * idiom — so the loader that imports the router has to resolve the same
 * mappings tsc does, or an ordinary app cannot generate anything.
 *
 * Which tsconfig: the nearest one to the importing file that declares `paths`,
 * searching upward to the project root. The scaffold's aliases live in
 * `src/server/tsconfig.json` — with `baseUrl: "../.."` — and that is the config
 * `spfn build` compiles the server with, so a backend-only app has them nowhere
 * else. A config declaring no `paths` is passed over rather than ending the
 * search, because the same `src/server/tsconfig.json` declares none in an app
 * that keeps its aliases at the root (Next.js puts them there).
 *
 * How a specifier matches, as tsc decides it: a pattern without `*` matches
 * only itself and wins; otherwise, of the patterns whose text before and after
 * the one `*` the specifier starts and ends with, the one with the longest
 * prefix. Each of that pattern's targets is substituted in order and the first
 * that names a module is taken — the loader tries them per import, so a `dist`
 * that holds some files and not others resolves each import through whichever
 * target has it.
 *
 * Handled: an `extends` chain, including one that names a package; targets
 * resolved against `baseUrl`, and against the config file that declares them
 * when there is no `baseUrl`; comments and trailing commas, because
 * TypeScript's own parser reads the file. A `baseUrl` with no `paths` resolves
 * nothing by itself: tsc's bare-specifier lookup against a directory is not
 * something the server build does either.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type * as ts from 'typescript';
import { logger } from '@spfn/core/logger';
import { typescript } from '../generators/typescript';

const aliasLogger = logger.child('@spfn/core:codegen');

/** The `paths` of one tsconfig, with the directory its targets resolve against. */
export interface ProjectPaths
{
    /** The tsconfig.json that declared them (or extended a config that did). */
    configPath: string;

    /** `baseUrl`, else the directory of the config that declared `paths`. */
    base: string;

    paths: ts.MapLike<string[]>;
}

/** The `paths` entry a specifier matched, and the paths its targets substitute to, in order. */
export interface PathsMatch
{
    pattern: string;
    targets: string[];
    candidates: string[];
}

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

/** `compilerOptions` of one tsconfig, with `extends` already merged. */
function readCompilerOptions(configPath: string, root: string): ts.CompilerOptions | undefined
{
    if (!existsSync(configPath))
    {
        return undefined;
    }

    const compiler = typescript();
    const { config, error } = compiler.readConfigFile(configPath, compiler.sys.readFile);

    if (error || !config)
    {
        aliasLogger.warn(`Could not read ${relative(root, configPath)}; its path aliases will not resolve`);

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
            aliasLogger.warn(
                `${relative(root, configPath)}: ${compiler.flattenDiagnosticMessageText(diagnostic.messageText, ' ')} `
                + '— path aliases it should have declared may be missing while the router loads',
            );
        }
    }

    return parsed.options;
}

/** Whether `directory` is `root` or below it. */
export function isWithin(root: string, directory: string): boolean
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
function searchDirectories(root: string, startDir: string): string[]
{
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

/** The `paths` that apply to a file in `startDir`, or undefined when no tsconfig up to `root` declares any. */
export function projectPaths(root: string, startDir: string): ProjectPaths | undefined
{
    for (const directory of searchDirectories(resolve(root), startDir))
    {
        const configPath = join(directory, 'tsconfig.json');
        const options = readCompilerOptions(configPath, root);

        if (options?.paths)
        {
            // A target is relative to baseUrl, and to the config that declared
            // `paths` when there is no baseUrl — TypeScript records that as
            // `pathsBasePath`, which its public typings do not carry.
            const declaredIn = (options as { pathsBasePath?: string }).pathsBasePath;

            return { configPath, base: options.baseUrl ?? declaredIn ?? directory, paths: options.paths };
        }
    }

    return undefined;
}

/** The part of `specifier` a pattern's `*` stands for, or undefined when the pattern does not match it. */
function wildcardOf(pattern: string, specifier: string): string | undefined
{
    const star = pattern.indexOf('*');
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    return specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
        ? specifier.slice(prefix.length, specifier.length - suffix.length)
        : undefined;
}

/** The pattern tsc takes for `specifier`: itself when declared, else the matching wildcard with the longest prefix. */
function matchingPattern(specifier: string, patterns: string[]): { pattern: string; wildcard: string } | undefined
{
    if (patterns.includes(specifier))
    {
        return { pattern: specifier, wildcard: '' };
    }

    return patterns
        .filter(pattern => pattern.split('*').length === 2)
        .map(pattern => ({ pattern, wildcard: wildcardOf(pattern, specifier) }))
        .filter((match): match is { pattern: string; wildcard: string } => match.wildcard !== undefined)
        .sort((a, b) => b.pattern.indexOf('*') - a.pattern.indexOf('*'))[0];
}

/** The `paths` entry `specifier` resolves through, with each target substituted; undefined when none matches. */
export function matchPaths(specifier: string, project: ProjectPaths): PathsMatch | undefined
{
    const match = matchingPattern(specifier, Object.keys(project.paths));

    if (!match)
    {
        return undefined;
    }

    const targets = project.paths[match.pattern];

    return {
        pattern: match.pattern,
        targets,
        candidates: targets.map(target => resolve(project.base, target.replace('*', match.wildcard))),
    };
}
