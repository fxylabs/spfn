/**
 * Whether this spfn CLI is the app's own: the same `@spfn/core` install
 * resolves from the CLI and from the application root. A CLI installed
 * globally, or run by `npx`/`dlx` in an app with its own `@spfn/core`, brings
 * another install; once the app's source imports the app's core, the process
 * holds two, and the refusal must name the CLI as their cause, not the app's
 * dependency tree.
 */

import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ForeignRunner } from '@spfn/core/server';
import { detectPackageManager, type PackageManager } from './package-manager.js';

/** The command that runs the app's own installed bin. */
const EXEC_COMMANDS: Record<PackageManager, string> = {
    pnpm: 'pnpm exec',
    npm: 'npx',
    yarn: 'yarn',
    bun: 'bunx',
};

/** The root of the `@spfn/core` install `require` resolves from `from`; undefined when there is none. */
function coreInstall(from: string): string | undefined
{
    let file: string;

    try
    {
        file = createRequire(from).resolve('@spfn/core/server');
    }
    catch
    {
        return undefined;
    }

    let directory = dirname(file);

    while (!existsSync(join(directory, 'package.json')) && dirname(directory) !== directory)
    {
        directory = dirname(directory);
    }

    return realpathSync(directory);
}

/**
 * The CLI as a foreign runner of the app rooted at `cwd` — its own
 * `@spfn/core` and the remedy for `args` (the command line after `spfn`) —
 * or undefined when it uses the app's install, or the app has none.
 */
export function foreignRunner(cwd: string, args: string[]): ForeignRunner | undefined
{
    const own = coreInstall(import.meta.url);
    const app = coreInstall(join(cwd, 'package.json'));

    if (own === undefined || app === undefined || own === app)
    {
        return undefined;
    }

    const command = `${EXEC_COMMANDS[detectPackageManager(cwd)]} spfn ${args.join(' ')}`.trimEnd();

    return {
        location: own,
        remedy: `this spfn CLI is not the app's own — it brings its @spfn/core (\`${own}\`) beside the app's `
            + `(\`${app}\`). Run the app's own spfn: \`${command}\` (add spfn to the app's devDependencies if it `
            + 'has none).',
    };
}
