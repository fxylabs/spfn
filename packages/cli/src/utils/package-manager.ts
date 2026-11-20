import { existsSync, readFileSync } from 'fs';
import { dirname, join, posix, relative, sep } from 'path';
import { parse } from 'yaml';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
];

/**
 * The package manager the app in `appDir` uses.
 *
 * The app's own lockfile decides first. An ancestor's lockfile counts only when
 * `appDir` is a member of that ancestor's workspace — a directory merely
 * sitting inside a pnpm or yarn repository is its own project, and running the
 * repository's manager there installs the repository, not the app. Otherwise npm.
 */
export function detectPackageManager(appDir: string): PackageManager
{
    const workspaceRoot = findWorkspaceRoot(appDir);

    return lockfileManager(appDir)
        ?? (workspaceRoot ? lockfileManager(workspaceRoot) : null)
        ?? 'npm';
}

/**
 * The root of the workspace `dir` is a member of, or null.
 *
 * The nearest ancestor that declares a workspace — `pnpm-workspace.yaml`
 * `packages` or `package.json` `workspaces` — answers; `dir` belongs to it when
 * its path matches one of the declared globs and none of the negated (`!…`)
 * ones. `dir` need not exist yet.
 */
export function findWorkspaceRoot(dir: string): string | null
{
    for (const candidate of ancestorsOf(dirname(dir)))
    {
        const patterns = readWorkspacePatterns(candidate);

        if (patterns)
        {
            return isWorkspaceMember(relative(candidate, dir).split(sep).join('/'), patterns)
                ? candidate
                : null;
        }
    }

    return null;
}

/**
 * The packages of `names` that cannot be found from `appDir` — the lookup an
 * `import` in the app does: `node_modules` in `appDir` and each ancestor.
 * `NODE_PATH` and the global folders are left out on purpose: ESM ignores them,
 * and a package manager running the CLI sets `NODE_PATH` to its own store.
 */
export function findUnresolvedPackages(appDir: string, names: string[]): string[]
{
    const lookupDirs = ancestorsOf(appDir).map(dir => join(dir, 'node_modules'));

    return names.filter(name => !lookupDirs.some(dir => existsSync(join(dir, name, 'package.json'))));
}

function ancestorsOf(dir: string): string[]
{
    return dirname(dir) === dir ? [dir] : [dir, ...ancestorsOf(dirname(dir))];
}

function lockfileManager(dir: string): PackageManager | null
{
    return LOCKFILES.find(([lockfile]) => existsSync(join(dir, lockfile)))?.[1] ?? null;
}

/**
 * The workspace globs `dir` declares, or null when it declares no workspace.
 */
function readWorkspacePatterns(dir: string): string[] | null
{
    const pnpmWorkspacePath = join(dir, 'pnpm-workspace.yaml');
    const packageJsonPath = join(dir, 'package.json');

    if (existsSync(pnpmWorkspacePath))
    {
        return parse(readFileSync(pnpmWorkspacePath, 'utf-8'))?.packages ?? [];
    }

    if (!existsSync(packageJsonPath))
    {
        return null;
    }

    const { workspaces } = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

    return Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? null;
}

function isWorkspaceMember(memberPath: string, patterns: string[]): boolean
{
    const normalised = patterns.map(pattern => pattern.replace(/^(!?)\.\//, '$1').replace(/\/+$/, ''));
    const included = normalised.filter(pattern => !pattern.startsWith('!'));
    const excluded = normalised.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));

    return included.some(pattern => posix.matchesGlob(memberPath, pattern))
        && !excluded.some(pattern => posix.matchesGlob(memberPath, pattern));
}

export function getInstallCommand(pm: PackageManager): string
{
    switch (pm)
    {
        case 'bun':
            return 'bun install';
        case 'pnpm':
            return 'pnpm install';
        case 'yarn':
            return 'yarn';
        case 'npm':
        default:
            return 'npm install';
    }
}

export function getRunCommand(pm: PackageManager): string
{
    return pm === 'npm' ? 'npm run' : `${pm} run`;
}

export function getAddCommand(pm: PackageManager, packages: string[]): string
{
    const pkgs = packages.join(' ');

    switch (pm)
    {
        case 'bun':
            return `bun add ${pkgs}`;
        case 'pnpm':
            return `pnpm add ${pkgs}`;
        case 'yarn':
            return `yarn add ${pkgs}`;
        case 'npm':
        default:
            return `npm install ${pkgs}`;
    }
}

/**
 * Arguments for `<pm> run <script> <args…>` that reach the script itself.
 *
 * npm eats unknown flags as its own config unless a `--` separates them; pnpm,
 * yarn and bun forward a `--` verbatim, which breaks any command whose parser
 * honours it.
 */
export function getRunScriptArgs(pm: PackageManager, script: string, args: string[]): string[]
{
    return pm === 'npm'
        ? ['run', script, '--', ...args]
        : ['run', script, ...args];
}
