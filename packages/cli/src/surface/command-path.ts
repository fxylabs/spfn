/**
 * Command paths: whether a manifest's path template is safe to request, and
 * the request path a call builds from it.
 */

import type { SurfaceCommandDescriptor } from './types.js';

const PATH_BASE = 'https://spfn.invalid';

/**
 * Why a command path cannot be requested as it stands, or null when it can.
 * `prefix` is the surface's namespace with its trailing slash — every command
 * on a surface lives under it, and the server's factory enforces that.
 */
export function unstablePathBecause(path: string, prefix: string): string | null
{
    let url: URL;
    try
    {
        url = new URL(path, PATH_BASE);
    }
    catch
    {
        return 'is not a valid URL path';
    }

    if (url.origin !== PATH_BASE || url.search !== '' || url.hash !== '')
    {
        return 'is not a plain absolute path';
    }
    if (url.pathname !== path)
    {
        return 'changes when URL-normalized';
    }
    if (!url.pathname.startsWith(prefix))
    {
        return `is outside ${prefix}`;
    }

    const slashCount = (path.match(/\//g) ?? []).length;
    let decoded = path;
    for (let depth = 0; depth < 8; depth++)
    {
        let next: string;
        try
        {
            next = decodeURIComponent(decoded);
        }
        catch
        {
            return 'contains malformed percent encoding';
        }

        if (next.includes('\\') || (next.match(/\//g) ?? []).length !== slashCount
            || next.split('/').some(segment => segment === '.' || segment === '..'))
        {
            return 'contains encoded path separators or dot segments';
        }
        if (next === decoded)
        {
            return null;
        }
        decoded = next;
    }

    return 'uses too many percent-encoding layers';
}

/**
 * Whether a path parameter can climb out of its segment, at any depth of
 * encoding.
 *
 * `encodeURIComponent` confines a value to one segment — it encodes `/`, `\`
 * and `%` — so the request this client writes always has the template's segment
 * structure. What it does not neutralize is a dot segment: `.` and `..` are
 * unreserved and survive encoding unchanged. Anything downstream that decodes
 * the path before routing, a normalizing proxy most of all, would then act on
 * them. So the value is decoded as far as it goes and refused if any part of
 * it is a dot segment.
 *
 * Separators themselves are left alone. An id that genuinely contains `/` or
 * `%` is the operator's own data, it stays inside one segment, and the app
 * reads it back intact.
 */
function climbsOutOfItsSegment(value: string): boolean
{
    let decoded = value;

    for (let depth = 0; depth < 8; depth++)
    {
        if (decoded.split(/[/\\]/).some(part => part === '.' || part === '..'))
        {
            return true;
        }

        let next: string;
        try
        {
            next = decodeURIComponent(decoded);
        }
        catch
        {
            // Not valid encoding, so nothing downstream decodes it further.
            return false;
        }

        if (next === decoded)
        {
            return false;
        }
        decoded = next;
    }

    return true;
}

/**
 * Substitute `:name` segments from params. A missing parameter fails here,
 * before any request leaves the machine.
 *
 * The template is checked for namespace escape, and each value for climbing
 * out of its own segment. The substituted result is not re-checked: by then
 * every value is encoded, and reading an operator's own `%` or `/` back as an
 * attempted escape would refuse data the app accepts.
 */
export function buildCommandPath(
    command: SurfaceCommandDescriptor,
    params: Record<string, string>,
    query: Record<string, string>,
    namespace: string,
): string
{
    const templateReason = unstablePathBecause(command.path, `${namespace}/`);
    if (templateReason !== null)
    {
        throw new Error(`Refusing command path ${JSON.stringify(command.path)} because it ${templateReason}.`);
    }

    const path = command.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    {
        const value = params[name];
        if (value === undefined)
        {
            throw new Error(`Missing path parameter "${name}" (pass --param ${name}=<value>).`);
        }

        // An empty value would collapse the segment and change which route the
        // app matches, so it is a different request than the operator asked for.
        if (value === '')
        {
            throw new Error(`Path parameter "${name}" cannot be empty.`);
        }

        if (climbsOutOfItsSegment(value))
        {
            throw new Error(
                `Path parameter "${name}" contains dot segments and cannot be sent: ${JSON.stringify(value)}.`,
            );
        }

        return encodeURIComponent(value);
    });

    const search = new URLSearchParams(query).toString();

    return search.length > 0 ? `${path}?${search}` : path;
}
