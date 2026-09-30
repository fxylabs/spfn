/**
 * The files `spfn env audit` reads — `spfn.config.js` `env.audit.include`
 * minus `env.audit.ignore`, as project-root-relative paths with `/` separators.
 *
 * The walk never leaves the project: symbolic links are not followed (a link
 * into `node_modules` or out of the tree would otherwise pull a whole foreign
 * tree in), and `node_modules`, VCS and build output directories are never
 * entered, whatever the globs say.
 */

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AuditScope
{
    include: string[];
    ignore: string[];
}

export const DEFAULT_INCLUDE = ['src'];

/** Directories never entered: dependencies, VCS data and build output. */
const SKIPPED_DIRECTORIES = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
    '.next', '.turbo', '.vercel', '.output', '.spfn',
]);

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

const DECLARATION_FILE = /\.d\.[cm]?ts$/;

const GLOB_CHARACTER = /[*?]/;

/**
 * Every source file in scope, sorted.
 */
export function listAuditFiles(cwd: string, scope: AuditScope): string[]
{
    const include = scope.include.map(globToRegExp);
    const ignore = scope.ignore.map(globToRegExp);
    const files = new Set<string>();

    for (const root of new Set(scope.include.map(staticPrefix)))
    {
        walk(cwd, root, ignore, files);
    }

    return [...files].filter((file) => matchesAny(file, include)).sort();
}

/**
 * Whether a path matches one of the globs, itself or through a parent
 * directory — `src` covers `src/a/b.ts`, as `src/**` does.
 */
export function matchesAny(path: string, globs: RegExp[]): boolean
{
    const segments = path.split('/');

    return segments.some((_, index) =>
    {
        const prefix = segments.slice(0, index + 1).join('/');

        return globs.some((glob) => glob.test(prefix));
    });
}

/**
 * A glob as an anchored expression: `**` crosses directories, `*` and `?` do not.
 */
export function globToRegExp(glob: string): RegExp
{
    const body = normalizeGlob(glob)
        .split(/(\*\*\/|\*\*|\*|\?)/)
        .map((part) =>
        {
            switch (part)
            {
                case '**/': return '(?:.*/)?';
                case '**': return '.*';
                case '*': return '[^/]*';
                case '?': return '[^/]';
                default: return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            }
        })
        .join('');

    return new RegExp(`^${body}$`);
}

/**
 * A config glob in the form paths are compared in, refused when it could reach
 * outside the project.
 */
export function normalizeGlob(glob: string): string
{
    const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/\*\*$/, '');

    if (normalized.startsWith('/') || normalized.split('/').includes('..'))
    {
        throw new Error(`spfn.config.js env.audit: "${glob}" must be relative to the project root and stay inside it.`);
    }

    return normalized === '.' ? '**' : normalized;
}

/** The directory a glob's walk starts from: its segments before the first wildcard. */
function staticPrefix(glob: string): string
{
    const segments = normalizeGlob(glob).split('/');
    const firstWildcard = segments.findIndex((segment) => GLOB_CHARACTER.test(segment));

    return (firstWildcard === -1 ? segments : segments.slice(0, firstWildcard)).join('/');
}

function walk(cwd: string, relPath: string, ignore: RegExp[], files: Set<string>): void
{
    const fullPath = join(cwd, relPath);

    if (!existsSync(fullPath) || (relPath && matchesAny(relPath, ignore)))
    {
        return;
    }

    const stats = lstatSync(fullPath);

    if (stats.isFile())
    {
        addIfSource(relPath, files);
    }

    if (!stats.isDirectory())
    {
        return;
    }

    for (const entry of readdirSync(fullPath, { withFileTypes: true }))
    {
        const child = relPath ? `${relPath}/${entry.name}` : entry.name;

        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
        {
            walk(cwd, child, ignore, files);
        }
        else if (entry.isFile() && !matchesAny(child, ignore))
        {
            addIfSource(child, files);
        }
    }
}

function addIfSource(relPath: string, files: Set<string>): void
{
    if (SOURCE_FILE.test(relPath) && !DECLARATION_FILE.test(relPath))
    {
        files.add(relPath);
    }
}
