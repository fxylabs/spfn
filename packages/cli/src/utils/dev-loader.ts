/**
 * The module hook every process of the spfn CLI that loads the app's source
 * runs it under (`dev-loader/hooks.ts`): `.ts` is ESM whatever the app's
 * `package.json` says, as `spfn build` bundles it. The one place its `--import`
 * argument is built — for `bin/spfn.js`, which re-spawns every command with it,
 * and for each tsx child a command starts (the `spfn dev` server and watcher,
 * the `spfn provision` runner).
 *
 * The CLI's bundle and the bin's own entry share it as one chunk, which tsup
 * puts at the root of `dist/`, so `register.js` is found beside it.
 */

/**
 * The `globalThis` key `register.js` leaves the application root it registered
 * the hook for under.
 */
export const DEV_LOADER_ROOT = Symbol.for('spfn:dev-loader-root');

/**
 * Whether this process has the hook registered for the application rooted at
 * `cwd` — what `bin/spfn.js` gives every command, whatever launched it.
 */
export function hasDevLoader(cwd: string): boolean
{
    return (globalThis as Record<symbol, unknown>)[DEV_LOADER_ROOT] === cwd;
}

/**
 * The `--import` argument that registers the hook for the application rooted
 * at `cwd`. Resolved from the CLI's location, never from the app's cwd.
 */
export function devLoaderImport(cwd: string): string
{
    const loader = new URL('./dev-loader/register.js', import.meta.url);

    loader.searchParams.set('root', cwd);

    return loader.href;
}

/**
 * The command that runs `entry` under the app's tsx, through the package
 * manager, with the hook registered first.
 */
export function tsxCommand(pm: string, cwd: string, entry: string): { command: string; args: string[] }
{
    const tsxArgs = ['tsx', '--import', devLoaderImport(cwd), entry];

    return pm === 'npm'
        ? { command: 'npx', args: tsxArgs }
        : { command: pm, args: ['exec', ...tsxArgs] };
}
