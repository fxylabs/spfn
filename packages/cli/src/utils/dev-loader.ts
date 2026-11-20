/**
 * The module hook every process of the spfn CLI that loads the app's source
 * runs it under (`dev-loader/hooks.ts`): `.ts` is ESM whatever the app's
 * `package.json` says, as `spfn build` bundles it. The one place its `--import`
 * argument is built — for `bin/spfn.js`, which re-spawns every command with it,
 * and for each tsx child a command starts (the `spfn dev` server and watcher,
 * the `spfn provision` runner).
 *
 * Built by tsup both into the CLI's bundle and as the bin's own entry, each at
 * the root of `dist/`, so `register.js` is found beside either.
 */

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

/**
 * Whether this process was started with the hook registered for the
 * application rooted at `cwd` — by `bin/spfn.js`, whose tsx then loads the
 * app's files as a plain `import()` does.
 */
export function runsUnderDevLoader(cwd: string): boolean
{
    return process.execArgv.includes(devLoaderImport(cwd));
}
