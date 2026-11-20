import { spawnSync } from 'child_process';
import { execa, type Options } from 'execa';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, posix, relative, sep } from 'path';
import { stripVTControlCharacters } from 'util';
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
 * Why pnpm, run in `appDir`, would install something other than the app, or
 * null: pnpm installs the nearest `pnpm-workspace.yaml`'s workspace whether or
 * not it lists the directory it runs in.
 */
export function pnpmNonMemberReason(appDir: string): string | null
{
    const root = ancestorsOf(appDir).find(dir => existsSync(join(dir, 'pnpm-workspace.yaml')));
    const patterns = root && root !== appDir ? readWorkspacePatterns(root, 'pnpm') : null;

    if (!root || !patterns || isWorkspaceMember(memberPath(root, appDir), patterns))
    {
        return null;
    }

    return `${appDir} is not in the packages of ${join(root, 'pnpm-workspace.yaml')}, so pnpm installed that workspace instead.`
        + ' Add the directory to its packages, or install with the app\'s own manager (--pm npm).';
}

/**
 * The packages the app in `appDir` declares — every name in its `package.json`
 * `dependencies` and `devDependencies` — that do not resolve from it.
 *
 * Optional and peer dependencies are left out: an optional one may fail to
 * install by design, and a peer is the app's to declare in those two lists.
 * Node itself answers, in a child process started in `appDir`, so that the
 * CLI's own resolution (a `NODE_PATH` its package manager set, preload flags)
 * plays no part: see `RESOLVE_SCRIPT`.
 */
export function findUnresolvedPackages(appDir: string): string[]
{
    const { dependencies, devDependencies } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8').replace(/^\uFEFF/, ''));
    const names = [...Object.keys(dependencies ?? {}), ...Object.keys(devDependencies ?? {})];
    const pnpRuntime = pnpRuntimeOf(appDir);
    const { NODE_PATH, NODE_OPTIONS, NODE_PRESERVE_SYMLINKS, ...env } = process.env;

    const child = spawnSync(
        process.execPath,
        [...(pnpRuntime ? ['--require', pnpRuntime] : []), '--input-type=module', '--eval', RESOLVE_SCRIPT, JSON.stringify(names)],
        { cwd: appDir, env, encoding: 'utf-8' },
    );

    if (child.status !== 0)
    {
        throw new Error(`Could not ask Node what resolves from ${appDir}: ${child.stderr || child.error}`);
    }

    return JSON.parse(child.stdout);
}

/**
 * Prints the names in `argv[1]` whose package does not resolve from the
 * working directory. A package resolves when Node finds its `package.json`:
 * every package has one and Node's lookup is defined by it, while an entry
 * point is optional (`@types/node` has none). `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * counts as found, since Node raises it only after reading the package's
 * `package.json`, whose `exports` do not list that file. Plain installs go
 * through the ESM resolver, which ignores `NODE_PATH` and the global folders as
 * an `import` in the app does; it locates a package by its directory alone, so
 * the file's existence is checked. Under Plug'n'Play (`process.versions.pnp`,
 * set by the preloaded `.pnp.cjs`) PnP's `require.resolve` answers.
 */
const RESOLVE_SCRIPT = `
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(process.cwd() + '/package.json');
const locate = process.versions.pnp ? require.resolve : specifier => fileURLToPath(import.meta.resolve(specifier));

function resolves(name)
{
    try
    {
        return existsSync(locate(name + '/package.json'));
    }
    catch (error)
    {
        return error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
    }
}

process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).filter(name => !resolves(name))));
`;

/**
 * The Plug'n'Play runtime that resolves the app in `appDir`, or null: the
 * `.pnp.cjs` of the project the app is — its own — or of the workspace it is a
 * member of (`findWorkspace`). A `.pnp.cjs` anywhere else above it belongs to a
 * project the app is not part of: PnP would take the app for that project's
 * top-level workspace, and Node's plain lookup is what applies to it.
 */
function pnpRuntimeOf(appDir: string): string | null
{
    const workspace = findWorkspace(appDir);

    return [appDir, ...(workspace ? [workspace.root] : [])]
        .map(dir => join(dir, '.pnp.cjs'))
        .find(existsSync) ?? null;
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

/**
 * Why npm refused the install and how to fix it, printed under npm's own lines
 * when npm's error is `ERESOLVE` over drizzle-typebox's peer on drizzle-orm
 * (`refusesDrizzleTypebox`): that peer range admits no prerelease, so npm
 * refuses drizzle-typebox beside the `1.0.0-rc.4` SPFN pins, as it does in every npm app an earlier `spfn init`
 * scaffolded. The CLI does not predict this; npm alone knows what it resolves.
 */
export const DRIZZLE_TYPEBOX_REFUSAL = 'npm refused the install (ERESOLVE above) over drizzle-typebox:'
    + ' its peer range on drizzle-orm excludes the drizzle-orm prerelease SPFN pins.'
    + ' Remove drizzle-typebox from the package.json that declares it (the app\'s, or its npm workspace root\'s),'
    + ' move to a drizzle-typebox version that accepts the prerelease, or import drizzle-orm/typebox-legacy instead.';

/**
 * Runs `pm` with `args` — every install and add the CLI makes goes through
 * here — and resolves to null when it succeeds. When it fails, resolves to the
 * report to print: the failure, the manager's own output in it, and below it
 * `DRIZZLE_TYPEBOX_REFUSAL` when that is what npm refused.
 */
export async function runInstall(pm: PackageManager, args: string[], options?: Options): Promise<string | null>
{
    try
    {
        await execa(pm, args, options);

        return null;
    }
    catch (error)
    {
        return pm === 'npm' && refusesDrizzleTypebox(error)
            ? `${String(error)}\n\n${DRIZZLE_TYPEBOX_REFUSAL}`
            : String(error);
    }
}

/**
 * The stanzas in which npm names drizzle-typebox's peer on drizzle-orm as the
 * conflict: the dependency it could not resolve, or the conflicting peer that
 * dependency brought. The same edge listed under "Found:" is only how the
 * installed drizzle-orm got there, so it does not count.
 */
const DRIZZLE_TYPEBOX_CONFLICT = [
    /^Could not resolve dependency:\npeer drizzle-orm@"[^"\n]*" from drizzle-typebox@/m,
    /^Conflicting peer dependency: drizzle-orm@.*\n.*\n {2}peer drizzle-orm@"[^"\n]*" from drizzle-typebox@/m,
];

/**
 * Whether a failed npm run's error is `ERESOLVE` over drizzle-typebox's peer
 * on drizzle-orm. npm reports the error as `npm error` lines on stderr and,
 * under `json`, as `{ "error": { "code", "detail" } }` on stdout (alone under
 * `loglevel=silent`); `detail` holds the same stanzas without the prefix. An
 * `ERESOLVE` npm only warned about (under `force`) is not its error.
 */
function refusesDrizzleTypebox(error: unknown): boolean
{
    const { stdout, stderr } = isObject(error) ? error : {};
    const reports = [npmErrorText(stderr), npmJsonErrorDetail(stdout)];

    return reports.some(report => report !== null
        && DRIZZLE_TYPEBOX_CONFLICT.some(conflict => conflict.test(report)));
}

/** The `npm error` lines of `stderr`, unprefixed, when their code is `ERESOLVE`. */
function npmErrorText(stderr: unknown): string | null
{
    const text = (typeof stderr === 'string' ? stripVTControlCharacters(stderr).split('\n') : [])
        .filter(line => /^npm error( |$)/.test(line))
        .map(line => line.replace(/^npm error ?/, ''))
        .join('\n');

    return /^code ERESOLVE$/m.test(text) ? text : null;
}

/** The `detail` of npm's JSON error on `stdout`, when its code is `ERESOLVE`. */
function npmJsonErrorDetail(stdout: unknown): string | null
{
    const { error } = parseObject(stdout);

    return isObject(error) && error.code === 'ERESOLVE' && typeof error.detail === 'string'
        ? error.detail
        : null;
}

/** `text` parsed as JSON when it is an object; an empty object otherwise. */
function parseObject(text: unknown): Record<string, unknown>
{
    try
    {
        const value: unknown = typeof text === 'string' ? JSON.parse(text) : null;

        return isObject(value) ? value : {};
    }
    catch
    {
        return {};
    }
}

/**
 * Arguments for adding `packages` to the app (`dev`: as devDependencies), the
 * one definition `init`, `create`, `add` and `setup` share.
 */
export function getAddArgs(pm: PackageManager, packages: string[], { dev = false } = {}): string[]
{
    switch (pm)
    {
        case 'npm':
            return ['install', ...(dev ? ['--save-dev'] : []), ...packages];
        case 'bun':
            return ['add', ...(dev ? ['--dev'] : []), ...packages];
        default:
            return ['add', ...(dev ? ['-D'] : []), ...packages];
    }
}

/** The command line `getAddArgs` stands for, for a hint to the user. */
export function getAddCommand(pm: PackageManager, packages: string[], options: { dev?: boolean } = {}): string
{
    return [pm, ...getAddArgs(pm, packages, options)].join(' ');
}

export function getRunCommand(pm: PackageManager): string
{
    return pm === 'npm' ? 'npm run' : `${pm} run`;
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

/** A command and its arguments, as execa takes them. */
export interface CommandLine
{
    command: string;
    args: string[];
}

/** Whether the yarn that answers in `cwd` has `dlx`. */
export type YarnDlxProbe = (cwd: string) => Promise<boolean>;

/**
 * How the CLI runs a package without installing it (create-next-app, shadcn)
 * for an app that installs with `pm`, in `cwd`.
 *
 * yarn keeps `yarn dlx` where it exists: with corepack that is Yarn 4 (`dlx`
 * is one of corepack's transparent commands, so it gets Yarn 4 outside a
 * project although `yarn --version` there says 1.x), and the app comes out a
 * Yarn 4 app. yarn 1 has no `dlx` (`yarn dlx` runs a script named `dlx`), so
 * there, and for every other manager, `npx --yes` runs the package. The app's
 * manager still installs: create-next-app takes it as `--use-<pm>`, shadcn
 * reads it from the lockfile.
 */
export async function getOneOffCommandLine(
    pm: PackageManager,
    cwd: string,
    spec: string,
    args: string[],
    yarnHasDlx: YarnDlxProbe = hasYarnDlx,
): Promise<CommandLine>
{
    if (pm === 'yarn' && await yarnHasDlx(cwd))
    {
        return { command: 'yarn', args: ['dlx', spec, ...args] };
    }

    return { command: 'npx', args: ['--yes', spec, ...args] };
}

/**
 * Asks yarn itself, in `cwd`, through the very `yarn dlx` the CLI would run:
 * the yarn on PATH, corepack's transparent-command rule, an ancestor's
 * `packageManager` pin and a `yarnPath` all decide this call as they decide
 * the real one. Yarn 2+ prints the usage of `dlx` and exits 0; yarn 1 runs a
 * script named `dlx`, which fails, and no yarn at all fails to spawn.
 */
export async function hasYarnDlx(cwd: string): Promise<boolean>
{
    const { exitCode, stdout } = await execa('yarn', ['dlx', '--help'], { cwd, reject: false });

    return exitCode === 0 && stdout.includes('yarn dlx');
}

/** `commandLine` as the user would type it, for a hint. */
export function formatCommandLine({ command, args }: CommandLine): string
{
    return [command, ...args].join(' ');
}
