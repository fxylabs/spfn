/**
 * Finding and loading the app's `server.config` — the one loader every reader
 * of the file uses: `startServer`, and `spfn provision` through its runner.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { plainObjectDefault } from '../app-config/config-module';
import type { ServerConfig } from './types';

/**
 * Where a `server.config` can be, in the order it is looked for.
 *
 * Both compiled extensions are listed because `spfn build` runs tsup, and tsup
 * picks the extension from the app's `package.json`: `.mjs` normally, `.js`
 * when the app declares `"type": "module"`. Only `.mjs` used to be listed, so
 * an app with that declaration silently lost its entire configuration in
 * production — no middlewares, no routes, no infrastructure switches — and the
 * raw `src/server/server.config.ts` fallback cannot stand in under plain node,
 * which resolves none of the `@/` path aliases the file is written with.
 */
export const SERVER_CONFIG_FILE_PATHS = [
    '.spfn/server/server.config.mjs',
    '.spfn/server/server.config.js',
    '.spfn/server/server.config',
    'src/server/server.config',
    'src/server/server.config.ts',
] as const;

/**
 * The config the app wrote, as opposed to a config file the build produced.
 * When plain node is what could not load it, the refusal says to build.
 */
const AUTHORED_CONFIG_PATH = 'src/server/server.config.ts';

/**
 * The codes with which node refuses the unbuilt source: TypeScript it cannot
 * run (no type stripping, or syntax stripping cannot erase), and an import it
 * cannot resolve — the `@/` aliases, which only the build or tsx resolve.
 * Under tsx (`spfn dev`, `spfn provision`) the first three cannot arise, and
 * the last means an import that is missing; the hint names both readings.
 */
const UNBUILT_SOURCE_CODES = new Set([
    'ERR_UNKNOWN_FILE_EXTENSION',
    'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
    'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
    'ERR_MODULE_NOT_FOUND',
]);

/**
 * The first config file that exists, imported, and its default export.
 *
 * Only a file that is absent means "no configuration" (`null`). A file that
 * exists and fails to import — a syntax error, an unresolvable import,
 * top-level code that throws (`configureAuth` refusing a policy value) — or
 * whose default export is not a plain object rejects, naming the file, so the
 * boot stops before anything listens. It used to be skipped, and the server
 * came up on defaults: no middlewares, no routes, no lifecycle, serving nothing
 * the app declared.
 *
 * `cwd` is a parameter so a test can point at a fixture directory.
 */
export async function loadServerConfigFile(cwd: string): Promise<{ path: string; config: ServerConfig } | null>
{
    const configPath = SERVER_CONFIG_FILE_PATHS.find(path => existsSync(join(cwd, path)));

    if (!configPath)
    {
        return null;
    }

    // A file URL, not a path: on Windows an absolute path is not a valid ESM specifier.
    const configModule = await import(pathToFileURL(join(cwd, configPath)).href).catch((error: unknown) =>
        Promise.reject(new Error(configLoadFailureMessage(configPath, error), { cause: error })));

    return { path: configPath, config: plainObjectDefault(configModule, configPath) as ServerConfig };
}

function configLoadFailureMessage(configPath: string, error: unknown): string
{
    const message = `Refusing to start: ${configPath} exists but failed to load: `
        + `${error instanceof Error ? error.message : String(error)}`;

    return configPath === AUTHORED_CONFIG_PATH && UNBUILT_SOURCE_CODES.has(errorCode(error))
        ? `${message}\nUnder plain node an @/ path alias does not resolve and not all TypeScript runs — `
            + 'run "spfn build" so the compiled config lands in .spfn/server/. Under tsx, the import named above is missing.'
        : message;
}

function errorCode(error: unknown): string
{
    const code = (error as { code?: unknown } | null)?.code;

    return typeof code === 'string' ? code : '';
}
