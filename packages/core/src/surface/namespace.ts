/**
 * Surface namespace and route builder
 *
 * A namespace is the path every command on a surface lives under — `/_ops`
 * for operators, `/_app` or anything else an app chooses for another caller.
 * It is refused at definition time unless it is a plain absolute path of
 * URL-safe segments: no trailing slash, no dots, no percent signs, no
 * parameters. Every check downstream — the prefix a route must carry, the
 * module paths, the manifest URL, the CLI's own path checks — is a string
 * comparison against it, and only a literal path keeps those comparisons
 * honest.
 *
 * The route builder is `route` with the namespace applied, so a definition
 * carries only the part of the path the app owns:
 *
 * ```ts
 * const pageAdd = app.route.post('/pages')   // POST /_app/pages
 *     .handler(async () => ({ ok: true }));
 * ```
 */

import { route, type RouteBuilder } from '../route/route-builder';
import { SurfaceError } from './error';
import { capitalized, type SurfaceWording } from './wording';

const NAMESPACE = /^(?:\/[A-Za-z0-9_-]+)+$/;

/** `route`, with a surface's namespace applied. */
export interface SurfaceRouteBuilder
{
    get: (path: string) => RouteBuilder;
    post: (path: string) => RouteBuilder;
    put: (path: string) => RouteBuilder;
    patch: (path: string) => RouteBuilder;
    delete: (path: string) => RouteBuilder;
}

export function assertNamespace(namespace: string): void
{
    if (typeof namespace !== 'string' || !NAMESPACE.test(namespace))
    {
        throw new SurfaceError(
            `Surface namespace ${JSON.stringify(namespace)} is invalid. `
            + 'Use an absolute path of [A-Za-z0-9_-] segments without a trailing slash, such as "/_app".',
        );
    }
}

/** Where a surface serves its manifest. */
export function manifestPathOf(namespace: string): string
{
    return `${namespace}/_manifest`;
}

/**
 * The reserved route name of a surface's manifest: `get`, the namespace
 * encoded, `Manifest`. `/_ops` → `getOpsManifest`, `/_app` → `getAppManifest`.
 *
 * The encoding is one-to-one, so two surfaces mounted side by side never
 * register two routes under one name. The leading `/` is dropped, and then:
 *
 * - a lowercase letter or a digit stays as it is;
 * - `_` followed by a lowercase letter becomes that letter in uppercase
 *   (`_app` → `App`), which keeps the common namespaces readable;
 * - every other character is escaped with `_`: an uppercase letter `X` →
 *   `_X`, any other `_` → `__`, `-` → `_d`, `/` → `_s`.
 *
 * A `_` in the output therefore always opens a two-character escape, and an
 * uppercase letter outside one always stands for `_` and a lowercase letter. Read left
 * to right, every name decodes to exactly one namespace: `/app` →
 * `getappManifest`, `/Ops` → `get_OpsManifest`, `/a/b` → `geta_sbManifest`,
 * `/a_b` → `getaBManifest`, `/a-b` → `geta_dbManifest`.
 */
export function manifestNameOf(namespace: string): string
{
    return `get${namespace.slice(1).replace(/_[a-z]|[A-Z_/-]/g, encodedCharacter)}Manifest`;
}

const ESCAPES: Record<string, string> = { '_': '_', '-': 'd', '/': 's' };

function encodedCharacter(match: string): string
{
    if (match.length === 2)
    {
        return match.charAt(1).toUpperCase();
    }

    return `_${ESCAPES[match] ?? match}`;
}

function toSurfacePath(namespace: string, path: string, wording: SurfaceWording): string
{
    const label = capitalized(wording.noun);

    if (!path.startsWith('/'))
    {
        throw new SurfaceError(
            `${label} route path "${path}" must start with "/". It is appended to "${namespace}", `
            + `so "${path}" would read as "${namespace}${path}".`,
        );
    }

    if (path === '/')
    {
        throw new SurfaceError(
            `${label} route path "/" names no command — "${namespace}" itself is not a command.`,
        );
    }

    return namespace + path;
}

export function surfaceRouteBuilder(namespace: string, wording: SurfaceWording): SurfaceRouteBuilder
{
    const method = (name: keyof SurfaceRouteBuilder) =>
        (path: string) => route[name](toSurfacePath(namespace, path, wording));

    return {
        get: method('get'),
        post: method('post'),
        put: method('put'),
        patch: method('patch'),
        delete: method('delete'),
    };
}
