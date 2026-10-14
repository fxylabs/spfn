/**
 * HTTP client for an app's command surface
 *
 * Talks to the running (usually deployed) app: fetches
 * `GET <namespace>/_manifest` for command discovery and invokes commands
 * against their declared method and path. The server owns validation — the
 * client sends what its caller gave it and relays the server's answer.
 *
 * `spfn ops` is this client on `/_ops`; any namespace a `defineSurface`
 * serves is reached the same way. The client writes nothing to a terminal:
 * what it drops from a manifest goes to `onWarning`, and what it refuses is
 * thrown — an app URL that would carry the credential in the clear among it.
 *
 * @example
 * ```ts
 * import { createSurfaceClient } from 'spfn/surface';
 *
 * const client = createSurfaceClient({
 *     appUrl: 'https://app.example',
 *     namespace: '/_app',
 *     token: async () => issueToken(),
 * });
 * const answer = await client.call('pageAdd', { params: {}, query: {}, body: { title: 'Hello' } });
 * ```
 */

import { buildCommandPath } from './command-path.js';
import { renderCommandUsage } from './describe.js';
import { trustedManifest, type ManifestReader, type SurfaceWarningSink } from './manifest-trust.js';
import { plain } from './plain.js';
import { assertTransportSafe } from './transport.js';
import type { SurfaceCallInput, SurfaceCommandDescriptor, SurfaceManifest, SurfaceResponse } from './types.js';

const NAMESPACE = /^(?:\/[A-Za-z0-9_-]+)+$/;

export interface SurfaceClientOptions
{
    /** The app's URL, base path included. https, or http against loopback. */
    appUrl: string;

    /** The surface's namespace, e.g. `/_app`. Its manifest is `<namespace>/_manifest`. */
    namespace: string;

    /** The bearer credential, or a function resolving it before each request. */
    token: string | (() => Promise<string>);

    /** Told about every command or module the client drops. Default: silent. */
    onWarning?: SurfaceWarningSink;
}

export interface SurfaceClient
{
    /** Fetch the manifest, keeping only the commands this client can call. */
    manifest(): Promise<SurfaceManifest>;

    /** One command's usage text, from a manifest already fetched. */
    describe(manifest: SurfaceManifest, name: string): string;

    /** Fetch the manifest and invoke the named command. */
    call(name: string, input: SurfaceCallInput): Promise<SurfaceResponse>;

    /** Invoke a command taken from a manifest already fetched. */
    invoke(command: SurfaceCommandDescriptor, input: SurfaceCallInput): Promise<SurfaceResponse>;
}

/** The manifest request answered something other than 200. */
export class SurfaceManifestError extends Error
{
    constructor(message: string, readonly status: number)
    {
        super(message);
        this.name = 'SurfaceManifestError';
    }
}

/**
 * Append an absolute path to the app URL, keeping whatever base path the
 * caller gave.
 *
 * Concatenation rather than `new URL(path, appUrl)`, because an absolute path
 * resolved against a base replaces it: an app mounted at
 * `https://example.com/api` would be called at `https://example.com/_ops/...`.
 * Every request goes through here so the two halves of the ops CLI — the ops
 * calls and the administrator sign-in — agree about where the app is.
 */
export function joinUrl(appUrl: string, path: string): string
{
    return appUrl.replace(/\/+$/, '') + path;
}

async function request(
    appUrl: string,
    token: string,
    method: string,
    path: string,
    body?: unknown,
): Promise<SurfaceResponse>
{
    const response = await fetch(joinUrl(appUrl, path), {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    let parsed: unknown = text;
    try
    {
        parsed = text.length > 0 ? JSON.parse(text) : null;
    }
    catch
    {
        // Non-JSON answer (proxy error page, ...) — relay as text.
    }

    return { status: response.status, body: parsed };
}

function manifestRefusal(namespace: string, status: number): SurfaceManifestError
{
    if (status === 401 || status === 403)
    {
        return new SurfaceManifestError(`The app refused the token (GET ${namespace}/_manifest answered ${status}).`, status);
    }
    if (status === 404)
    {
        return new SurfaceManifestError(`No surface at ${namespace} on this app (GET ${namespace}/_manifest answered 404).`, status);
    }

    return new SurfaceManifestError(`Manifest request failed with status ${status}.`, status);
}

function assertNamespace(namespace: string): void
{
    if (typeof namespace !== 'string' || !NAMESPACE.test(namespace))
    {
        throw new Error(
            `Surface namespace ${JSON.stringify(namespace)} is invalid. `
            + 'Use an absolute path of [A-Za-z0-9_-] segments without a trailing slash, such as "/_app".',
        );
    }
}

function findCommand(manifest: SurfaceManifest, name: string): SurfaceCommandDescriptor
{
    const command = manifest.commands.find(candidate => candidate.name === name);
    if (!command)
    {
        throw new Error(`Unknown command "${plain(name)}".`);
    }

    return command;
}

/**
 * Create a client for one surface of one app. The app URL and namespace are
 * checked here, so a client that exists can only send its credential where
 * it is safe to.
 */
export function createSurfaceClient(options: SurfaceClientOptions): SurfaceClient
{
    assertTransportSafe(options.appUrl);
    assertNamespace(options.namespace);

    const { appUrl, namespace } = options;
    const token = async () => (typeof options.token === 'function' ? await options.token() : options.token);
    const reader: ManifestReader = { namespace, prefix: `${namespace}/`, warn: options.onWarning ?? (() => undefined) };

    const manifest = async (): Promise<SurfaceManifest> =>
    {
        const { status, body } = await request(appUrl, await token(), 'GET', `${namespace}/_manifest`);
        if (status !== 200)
        {
            throw manifestRefusal(namespace, status);
        }

        return trustedManifest(body, reader);
    };

    const invoke = async (command: SurfaceCommandDescriptor, input: SurfaceCallInput): Promise<SurfaceResponse> =>
    {
        const path = buildCommandPath(command, input.params, input.query, namespace);

        return await request(appUrl, await token(), command.method, path, input.body);
    };

    return {
        manifest,
        invoke,
        describe: (fetched, name) => renderCommandUsage(findCommand(fetched, name)),
        call: async (name, input) => await invoke(findCommand(await manifest(), name), input),
    };
}
