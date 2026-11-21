/**
 * What a command that loads the app's TypeScript stops with when nothing can
 * load it: the one message, naming tsx and the app's own command to add it.
 *
 * `bin/spfn.js` re-spawns every command under tsx and the CLI's module hook
 * when it finds tsx; a process without the hook is one where it found none,
 * and there Node alone would fail on the first file it cannot load (an
 * extensionless import, a path alias) with a message that names neither.
 * `spfn env`, `spfn db` (`push`, `tenant`, and `generate` with the entity
 * registry) and `spfn provision` ask before their first app import. Codegen
 * needs no tsx: core's loader compiles the app's TypeScript itself.
 */

import { join } from 'node:path';
import { hasDevLoader } from './dev-loader.js';
import { resolveFrom } from './env-schema.js';
import { detectPackageManager, getAddCommand } from './package-manager.js';

/** A file name tsx loads and Node alone may not: `.ts`, `.tsx`, `.mts`, `.cts`. */
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/**
 * The path of tsx's import API — the app's own copy first, then the one next
 * to the CLI — or undefined when neither is installed.
 */
export function tsxApiPath(cwd: string): string | undefined
{
    return resolveFrom(join(cwd, 'noop.js'), 'tsx/esm/api') ?? resolveFrom(import.meta.url, 'tsx/esm/api');
}

/** The one message for an app without tsx, naming the app's own command to add it. */
export function missingTsxMessage(cwd: string): string
{
    return `tsx is not installed in this project, and it is what loads TypeScript. Add it: ${getAddCommand(detectPackageManager(cwd), ['tsx'], { dev: true })}`;
}

/** `missingTsxMessage` when no tsx is installed for the app or the CLI; else undefined. */
export function missingTsx(cwd: string): string | undefined
{
    return tsxApiPath(cwd) === undefined ? missingTsxMessage(cwd) : undefined;
}

/**
 * Throws `missingTsx`'s message before `file`, the app's, is imported in this
 * process: when it is TypeScript, the process has no hook and no tsx is
 * installed.
 */
export function assertTypeScriptLoadable(cwd: string, file: string): void
{
    const message = TYPESCRIPT_FILE.test(file) && !hasDevLoader(cwd) ? missingTsx(cwd) : undefined;

    if (message !== undefined)
    {
        throw new Error(message);
    }
}
