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
 * Matching is against a canonical spelling of the path (`matchedSpelling`),
 * not only the one the router serves: a request the router does not serve is
 * logged too, and `//api/import/<token>` or `/API/import/<token>` carries the
 * same token as the route it missed. An entry covers itself and everything
 * below it on a segment boundary: `/api/import` covers `/api/import` and
 * `/api/import/abc`, not `/api/importer`.
 */

import type { Context } from 'hono';
import { describeError } from '@spfn/core/logger';
import type { DatabaseErrorDescription, DescribeErrorOptions, ErrorDescription } from '@spfn/core/logger';

/** What replaces everything below a declared prefix. */
const REDACTED_SEGMENT = '[redacted]';

/** Characters that make an entry something other than a literal path prefix. */
const PATTERN_CHARACTERS = /[?#:*]/;

/** Rounds of percent-decoding before matching: a doubly encoded spelling, and one more */
const DECODE_ROUNDS = 3;

/** A declared prefix as it was written, which a line prints, and as it is matched */
interface RedactedPrefix
{
    declared: string;
    matched: string;
}

/** Set from server config; empty until something declares a prefix. */
let redactedPrefixes: readonly RedactedPrefix[] = [];

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
    redactedPrefixes = paths === undefined
        ? []
        : parseRedactPaths(paths).map(declared => ({ declared, matched: matchedSpelling(declared) }));
}

/** The declared prefix a path falls under, if any */
function redactedPrefixOf(path: string): string | undefined
{
    const spelling = matchedSpelling(path);

    return redactedPrefixes.find(({ matched }) => spelling === matched || spelling.startsWith(`${matched}/`))?.declared;
}

/**
 * The spelling of a path the prefixes are matched against: percent-decoded
 * `DECODE_ROUNDS` times over (`%2F` included; a decoded path stays put), dot
 * segments resolved, repeated slashes collapsed, lower case. A client joining
 * a base URL that ends in `/` sends `//api/import/<token>`, a proxy encoding
 * twice `/api/%2569mport/<token>`; the router serves neither, and the 404 is
 * logged with the token unless it matches here.
 */
function matchedSpelling(path: string): string
{
    let decoded = path;

    for (let round = 0; round < DECODE_ROUNDS; round++)
    {
        decoded = decodeOnce(decoded);
    }

    return withoutDotSegments(decoded.replace(/\/{2,}/g, '/')).toLowerCase();
}

/** One round of percent-decoding; a run of escapes that is not valid UTF-8 stays as written */
function decodeOnce(path: string): string
{
    return path.replace(/(?:%[0-9a-f]{2})+/gi, (escapes) =>
    {
        try
        {
            return decodeURIComponent(escapes);
        }
        catch
        {
            return escapes;
        }
    });
}

/** `.` and `..` segments resolved, as a URL parser resolves them; `..` never climbs above the root */
function withoutDotSegments(path: string): string
{
    const segments: string[] = [];

    for (const segment of path.split('/'))
    {
        if (segment === '..')
        {
            segments.splice(Math.max(segments.length - 1, 1));
        }
        else if (segment !== '.')
        {
            segments.push(segment);
        }
    }

    return segments.join('/');
}

/**
 * Whether the request path falls under a declared prefix. Under one, no line
 * may carry anything derived from the path: its parameters, an error raised
 * while serving it, the response built from it.
 */
export function isRedactedPath(c: Context): boolean
{
    return redactedPrefixOf(c.req.path) !== undefined;
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
    const prefix = redactedPrefixOf(path);

    return prefix === undefined ? path : `${prefix}/${REDACTED_SEGMENT}`;
}

/**
 * A caught error as a log line may carry it: its `describeError` description,
 * and under a declared prefix the same description without a message anywhere
 * in its cause chain. An error raised while serving a capability route may
 * quote the path — a validation failure naming the segment, `Import <token>
 * not found` — so its name, code, status and stack frames stay, its text goes.
 */
export function loggedError(
    c: Context,
    error: unknown,
    options?: DescribeErrorOptions,
): ErrorDescription | DatabaseErrorDescription
{
    const description = describeError(error, options);

    return isRedactedPath(c) ? withoutMessages(description) : description;
}

/** Drop every message down the cause chain, in place: the description stays marked as one */
function withoutMessages<T extends ErrorDescription | DatabaseErrorDescription>(description: T): T
{
    delete description.message;

    if (description.kind === 'error' && description.cause !== undefined)
    {
        withoutMessages(description.cause);
    }

    return description;
}

/**
 * A URL a request carries in a header (`Referer`) as a log line may name it:
 * its origin and `<prefix>/[redacted]` when its path falls under a declared
 * prefix, otherwise unchanged. A page served under a capability path sends
 * its own URL, secret and all, with every request it makes.
 */
export function loggedUrl(url: string): string
{
    if (!URL.canParse(url))
    {
        return url;
    }

    const { origin, pathname } = new URL(url);
    const prefix = redactedPrefixOf(pathname);

    return prefix === undefined ? url : `${origin}${prefix}/${REDACTED_SEGMENT}`;
}
