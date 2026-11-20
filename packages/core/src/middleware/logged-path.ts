/**
 * @spfn/core - The request path as a log line may name it
 *
 * A capability route carries its secret in the path — `/api/import/:token`, a
 * share link, a one-time download. Every core line that names the request path
 * (the request logger, proxy-guard, the error handler and its `onError`
 * context, rate limiting, the transaction context) reads it here, so a prefix
 * declared once with `defineServerConfig().logging({ redactPaths })` keeps the
 * secret out of all of them, at every level.
 *
 * Matching is against the decoded path the router matches (`c.req.path`), so a
 * percent-encoded spelling (`/api/%69mport/…`) reaches the same rule as the
 * route it is served by. An entry covers itself and everything below it on a
 * segment boundary: `/api/import` covers `/api/import` and `/api/import/abc`,
 * not `/api/importer`.
 */

import type { Context } from 'hono';

/** What replaces everything below a declared prefix. */
const REDACTED_SEGMENT = '[redacted]';

/** Characters that make an entry something other than a literal path prefix. */
const PATTERN_CHARACTERS = /[?#:*]/;

/** Set from server config; empty until something declares a prefix. */
let redactedPrefixes: readonly string[] = [];

/**
 * The one rule for a `redactPaths` declaration: a list of literal path
 * prefixes, each starting with `/`, not ending with `/`, and free of `?`, `#`,
 * `:` and `*` — a query, a fragment, a route parameter or a wildcard would
 * never equal the path it was meant to cover, so the entry would redact
 * nothing. Throws otherwise, so a server config carrying one fails to load and
 * the server refuses to start.
 */
export function parseRedactPaths(value: unknown): string[]
{
    if (!Array.isArray(value))
    {
        throw new Error(`Invalid logging.redactPaths: ${String(value)}. Must be an array of path prefixes.`);
    }

    for (const entry of value)
    {
        if (typeof entry !== 'string' || !entry.startsWith('/') || entry.endsWith('/') || PATTERN_CHARACTERS.test(entry))
        {
            throw new Error(
                `Invalid logging.redactPaths entry: ${JSON.stringify(entry)}. `
                + 'Each entry is a literal path prefix: it starts with "/", does not end with "/", '
                + 'and contains no "?", "#", ":" or "*" (e.g. "/api/import").',
            );
        }
    }

    return [...value];
}

/**
 * Declare the path prefixes no log line may name in full. `undefined` declares
 * none. `createServer` publishes the server config's `logging.redactPaths`
 * through it before any request is served.
 */
export function setRedactPaths(paths: string[] | undefined): void
{
    redactedPrefixes = paths === undefined ? [] : parseRedactPaths(paths);
}

/**
 * The request path for a log line: `c.req.path`, or `<prefix>/[redacted]` when
 * it falls under a declared prefix.
 *
 * The only way a core log line names the request path; use it in your own
 * middleware and handlers too.
 */
export function loggedPath(c: Context): string
{
    const path = c.req.path;
    const prefix = redactedPrefixes.find(entry => path === entry || path.startsWith(`${entry}/`));

    return prefix === undefined ? path : `${prefix}/${REDACTED_SEGMENT}`;
}
