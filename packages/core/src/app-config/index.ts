/**
 * `spfn.config.js` — the app's serving shape, read by both the CLI and the server.
 *
 * The file has existed since `spfn init` started writing it, and until now
 * nothing read it back. It is the one committed place that describes how an app
 * is served, which makes it the right home for the ports: an app that wants a
 * different port says so once here instead of repeating the number across its
 * `server.config.ts`, Dockerfile, compose file, `next.config.ts` and env
 * example, where nothing checks that the copies still agree.
 *
 * This module is deliberately free of side effects. `@spfn/core/config`
 * validates the whole environment schema the moment it is imported, which is
 * fine inside a server and wrong inside a CLI that has not been handed an
 * app's environment yet.
 *
 * @module app-config
 */

import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { join } from 'path';

/**
 * Ports the app is served on.
 *
 * Two names because two processes are started. Next.js reads `PORT` as its own,
 * so the SPFN server cannot claim that name without the two colliding whenever
 * they run together.
 */
export interface SpfnPorts
{
    /** Next.js frontend. Passed to `next` as `-p`. */
    next?: number;

    /** SPFN API server. */
    server?: number;
}

/**
 * Where the app's own environment schema lives.
 *
 * Read by the CLI (`spfn env`, `spfn secret`), which cannot otherwise find an
 * app's variables: a package's schema sits at `<package>/config`, an app's
 * sits wherever the app put it.
 */
export interface SpfnEnvConfig
{
    /**
     * Modules that export `envSchema`, as paths relative to the project root —
     * e.g. `['src/server/config/env.config.ts']`. TypeScript and the
     * tsconfig path aliases it imports through are supported.
     */
    schemas?: string[];

    /** What `spfn env audit` scans. */
    audit?: SpfnEnvAuditConfig;
}

/**
 * The files `spfn env audit` reads, as globs relative to the project root.
 *
 * `node_modules`, build output, `*.d.ts` files and symbolic links are never
 * scanned, whatever the globs say.
 */
export interface SpfnEnvAuditConfig
{
    /**
     * Directories or globs to scan — e.g. `['src', 'scripts/*.ts']`.
     *
     * @default ['src']
     */
    include?: string[];

    /**
     * Directories or globs to leave out — e.g. `['src/legacy/**']`. A file left
     * out may read `process.env` directly, and names it reads do not count as read.
     */
    ignore?: string[];
}

export interface SpfnAppConfig
{
    ports?: SpfnPorts;

    /** Host the SPFN API server binds. */
    host?: string;

    /** The app's environment schema modules, and what `spfn env audit` scans. */
    env?: SpfnEnvConfig;

    /** Deployment settings — untouched by this module, kept so the type is whole. */
    [key: string]: unknown;
}

/**
 * The single place each default exists.
 *
 * Defaults live at the bottom of the chain and nowhere else. A default declared
 * at an input layer — a commander option, a generated entry file, an env schema
 * — cannot be told apart from a value someone supplied, so it silently outranks
 * whatever is below it. Three separate defects in this repository came from
 * exactly that, including an env schema default that forced the environment to
 * be consulted last and made an injected port unreachable.
 */
export const PORT_DEFAULTS = {
    next: 3790,
    server: 8790,
} as const;

export const HOST_DEFAULT = 'localhost';

const CONFIG_FILE_NAMES = [
    'spfn.config.js',
    'spfn.config.mjs',
] as const;

/**
 * Read `spfn.config.js` from an app directory.
 *
 * Returns an empty object when there is no file, and also when the file cannot
 * be imported — a malformed deployment config must not stop a server from
 * booting. The caller decides whether the absence is worth reporting.
 */
export async function loadAppConfig(cwd: string = process.cwd()): Promise<SpfnAppConfig>
{
    for (const fileName of CONFIG_FILE_NAMES)
    {
        const fullPath = join(cwd, fileName);

        if (!existsSync(fullPath))
        {
            continue;
        }

        try
        {
            // A file URL, not a path: on Windows an absolute path is not a
            // valid ESM specifier, and this file is imported at runtime.
            const module = await import(pathToFileURL(fullPath).href);

            return (module.default ?? {}) as SpfnAppConfig;
        }
        catch (error)
        {
            // Falling back to defaults, and saying so. A file that exists and
            // cannot be imported is a typo, not an absence — silence would send
            // the server to port 8790 while its own config named another, and
            // the only symptom would be a port nobody chose.
            //
            // console, not the server logger: this runs inside the CLI too,
            // before any logger is configured.
            console.warn(
                `⚠️  ${fileName} could not be imported — falling back to defaults `
                + `for ports and host. ${error instanceof Error ? error.message : String(error)}`,
            );

            return {};
        }
    }

    return {};
}

/**
 * The port each process binds, given a loaded config and the environment.
 *
 * Three layers, in this order, and no more: environment variable, then
 * `spfn.config.js`, then the default.
 */
export function resolvePorts(
    config: SpfnAppConfig,
    env: NodeJS.ProcessEnv = process.env,
): { next: number; server: number }
{
    return {
        next: readPort(env.NEXT_PORT) ?? config.ports?.next ?? PORT_DEFAULTS.next,
        server: readPort(env.SPFN_PORT) ?? config.ports?.server ?? PORT_DEFAULTS.server,
    };
}

/**
 * The host the SPFN server binds, on the same three layers.
 *
 * `localhost` by default: a container states `SPFN_HOST=0.0.0.0` in its own
 * files, where that decision belongs, rather than every developer machine
 * publishing a dev server to its network.
 */
export function resolveHost(
    config: SpfnAppConfig,
    env: NodeJS.ProcessEnv = process.env,
): string
{
    return env.SPFN_HOST || config.host || HOST_DEFAULT;
}

/**
 * Where the SPFN server binds, including the address a server config may still
 * carry through `.port()` / `.host()`.
 *
 * Those two are deprecated and sit between `spfn.config.js` and the default for
 * one release, so an app that has not moved yet keeps the address it had. Once
 * they are removed this collapses back to {@link resolvePorts} and
 * {@link resolveHost}.
 */
export function resolveServerAddress(
    config: SpfnAppConfig,
    deprecated: { port?: number; host?: string } = {},
    env: NodeJS.ProcessEnv = process.env,
): { port: number; host: string }
{
    return {
        port: readPort(env.SPFN_PORT)
            ?? config.ports?.server
            ?? deprecated.port
            ?? PORT_DEFAULTS.server,
        host: env.SPFN_HOST
            || config.host
            || deprecated.host
            || HOST_DEFAULT,
    };
}

function readPort(value: string | undefined): number | undefined
{
    if (!value)
    {
        return undefined;
    }

    const port = Number(value);

    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}
