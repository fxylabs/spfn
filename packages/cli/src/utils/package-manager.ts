import { existsSync, readFileSync } from 'fs';
import { dirname, join, posix, relative, sep } from 'path';
import { parse } from 'yaml';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** A workspace and the manager its root's lockfile selects. */
export interface Workspace
{
    root: string;
    packageManager: PackageManager;
}

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
];

/**
 * The package manager the app in `appDir` uses.
 *
 * The app's own lockfile decides, before any ancestor is read. Otherwise the
 * manager of the workspace `appDir` is a member of (`findWorkspace`) — a
 * directory merely sitting inside a pnpm or yarn repository is its own project,
 * and running the repository's manager there installs the repository, not the
 * app. Otherwise npm.
 */
export function detectPackageManager(appDir: string): PackageManager
{
    return lockfileManager(appDir) ?? findWorkspace(appDir)?.packageManager ?? 'npm';
}

/**
 * The workspace `dir` is a member of, or null. `dir` need not exist yet.
 *
 * An ancestor's lockfile selects its manager, and that manager's declaration
 * alone decides membership: `pnpm-workspace.yaml` `packages` for pnpm,
 * `package.json` `workspaces` for yarn, npm and bun. An ancestor without a
 * lockfile is pnpm's when it has a `pnpm-workspace.yaml` (no other manager reads
 * that file), npm's otherwise. The nearest ancestor that declares a workspace
 * answers: `dir` belongs to it when its path matches one of the globs and none
 * of the negated (`!…`) ones. A declaration that cannot be read, or is not the
 * documented shape, declares no workspace.
 */
export function findWorkspace(dir: string): Workspace | null
{
    for (const root of ancestorsOf(dirname(dir)))
    {
        const packageManager = lockfileManager(root) ?? (existsSync(join(root, 'pnpm-workspace.yaml')) ? 'pnpm' : 'npm');
        const patterns = readWorkspacePatterns(root, packageManager);

        if (patterns)
        {
            return isWorkspaceMember(memberPath(root, dir), patterns)
                ? { root, packageManager }
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
 * The workspace globs `packageManager`'s declaration in `dir` lists, or null
 * when it declares no workspace. A `pnpm-workspace.yaml` without `packages`
 * declares a workspace of the root alone.
 */
function readWorkspacePatterns(dir: string, packageManager: PackageManager): string[] | null
{
    if (packageManager === 'pnpm')
    {
        const manifest = readManifest(join(dir, 'pnpm-workspace.yaml'), text => parse(text, { logLevel: 'error' }) ?? {});

        return isObject(manifest) ? stringsOrNull(manifest.packages ?? []) : null;
    }

    const manifest = readManifest(join(dir, 'package.json'), JSON.parse);
    const workspaces = isObject(manifest) ? manifest.workspaces : undefined;

    return stringsOrNull(workspaces) ?? (isObject(workspaces) ? stringsOrNull(workspaces.packages) : null);
}

/**
 * The parsed content of `path`, a byte-order mark stripped as npm, pnpm and yarn
 * do; undefined when it is missing or does not parse. Someone else's file above
 * the app is never the app's error.
 */
function readManifest(path: string, parseText: (text: string) => unknown): unknown
{
    if (!existsSync(path))
    {
        return undefined;
    }

    try
    {
        return parseText(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
    }
    catch
    {
        return undefined;
    }
}

function isObject(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOrNull(value: unknown): string[] | null
{
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
}

/** `dir` relative to the workspace `root`, `/`-separated as workspace globs are. */
function memberPath(root: string, dir: string): string
{
    return relative(root, dir).split(sep).join('/');
}

function isWorkspaceMember(path: string, patterns: string[]): boolean
{
    const normalised = patterns.map(pattern => pattern.replace(/^(!?)\.\//, '$1').replace(/\/+$/, ''));
    const included = normalised.filter(pattern => !pattern.startsWith('!'));
    const excluded = normalised.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1));

    return included.some(pattern => posix.matchesGlob(path, pattern))
        && !excluded.some(pattern => posix.matchesGlob(path, pattern));
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
