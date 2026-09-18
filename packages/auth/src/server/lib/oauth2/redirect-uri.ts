/**
 * OAuth 2.1 redirect URI rules
 *
 * Two jobs, and they are not the same job. Registration decides whether a URI
 * may be written down at all; matching decides whether the URI on an authorize
 * request is one that was. Registration is where policy lives (no plain http off
 * loopback, https only on origins the application allows, no fragment ever), and
 * matching is deliberately dumb: exact, on everything except a loopback port.
 *
 * The loopback exception is the whole reason a CLI can use this flow. `claude`
 * opens a listener on whatever port the OS hands it and cannot know that port
 * when it registers, so RFC 8252 §7.3 lets the port vary — and nothing else.
 * `localhost`, `127.0.0.1` and `[::1]` are three different registrations that do
 * not stand in for one another: they resolve differently on a machine with a
 * split-horizon resolver, and a client that registered one and is answered on
 * another is a client something redirected.
 *
 * IPv6 arrives in as many spellings as there are ways to write zeroes, so both
 * sides are read through `new URL(...).hostname`, which answers `[::1]` for
 * every one of them. The registered value is stored verbatim — the registration
 * response echoes it back and must not answer a client with a URI it did not
 * write — so the normalisation happens here, on both sides, at every comparison.
 */

import { isLoopbackHostname } from './config';

/** Why a redirect URI cannot be registered, in RFC 7591 §3.2.2 terms. */
export type RedirectUriRefusal = 'invalid_redirect_uri';

/**
 * Whether a URI may be registered, given the https origins this application
 * allows.
 *
 * @param uri - The value exactly as the client wrote it
 * @param allowedRedirectOrigins - `https://` origins from the lifecycle config
 * @returns null when it may; the refusal detail when it may not
 */
export function refuseRedirectUriRegistration(
    uri: string,
    allowedRedirectOrigins: string[],
): string | null
{
    let url: URL;

    try
    {
        url = new URL(uri);
    }
    catch
    {
        return `"${uri}" is not an absolute URI.`;
    }

    if (url.hash !== '')
    {
        return `"${uri}" carries a fragment. A fragment never survives the redirect, so a client `
            + 'that registered one would be waiting for something it can never be sent.';
    }

    if (hasDotSegment(uri))
    {
        return `"${uri}" has a "." or ".." path segment. Those resolve away before a path is `
            + 'compared, so the URI does not name one destination; register the path it resolves to.';
    }

    return refuseRedirectOrigin(url, uri, allowedRedirectOrigins);
}

/** Loopback http, or an https origin this application allows. Nothing else. */
function refuseRedirectOrigin(url: URL, uri: string, allowedRedirectOrigins: string[]): string | null
{
    if (url.protocol === 'http:')
    {
        return isLoopbackHostname(url.hostname)
            ? null
            : `"${uri}" is plain http off loopback. The authorization code would cross the network in `
                + 'the clear; register an https URI, or a loopback one for a client on this machine.';
    }

    if (url.protocol !== 'https:')
    {
        return `"${uri}" is neither https nor loopback http. Custom-protocol redirects are not `
            + 'registered here.';
    }

    return allowedRedirectOrigins.includes(url.origin)
        ? null
        : `"${uri}" is on an origin this application does not allow. Add ${url.origin} to `
            + 'authorizationServer.allowedRedirectOrigins, or register a loopback URI.';
}

/**
 * Whether the path, as written, carries a `.` or `..` segment.
 *
 * Read off the raw string and not the parsed URL, because parsing is what makes
 * this necessary: `new URL('http://127.0.0.1:5/x/../cb').pathname` is `/cb`, so
 * a URI that is not the registered one is compared as though it were. The port
 * may vary on loopback and the path may not, and a dot segment is a way of
 * writing any registered path at all — one that also lets the presented string
 * carry whatever a client's own logging, or a proxy in front of the listener,
 * is going to treat as the destination.
 *
 * Both separators, and however many of them the authority was written with. The
 * WHATWG parser reads `\` as a path separator for http and https, so `/x/..\cb`
 * resolves to `/cb` exactly as `/x/../cb` does. It is as forgiving about the
 * authority: `http:/x/../cb` carries one slash and `http:\\host\x\..\cb` two
 * backslashes, and both parse. Splitting the authority off on `[/\\]{0,2}` and
 * the rest on `[/\\]` covers every spelling of both.
 *
 * `%2e` is the same segment percent-encoded, which `new URL` resolves too.
 */
function hasDotSegment(uri: string): boolean
{
    const path = uri.replace(/^[^:]*:[/\\]{0,2}[^/\\?#]*/, '').split(/[?#]/)[0] ?? '';

    return path.split(/[/\\]/).some(isDotSegment);
}

function isDotSegment(segment: string): boolean
{
    const decoded = segment.replace(/%2e/gi, '.');

    return decoded === '.' || decoded === '..';
}

/**
 * Whether a presented redirect URI is one of the registered ones.
 *
 * Host, path and query must be identical; the port may differ only when both
 * sides are loopback http. A presented URI carrying a fragment or a dot segment
 * matches nothing — registration already refuses both, so this is the request
 * side of the same two rules.
 */
export function matchesRegisteredRedirectUri(presented: string, registered: string[]): boolean
{
    let request: URL;

    try
    {
        request = new URL(presented);
    }
    catch
    {
        return false;
    }

    if (request.hash !== '' || hasDotSegment(presented))
    {
        return false;
    }

    return registered.some(candidate => sameRedirectTarget(request, candidate));
}

/** One registered URI against the presented one, with the loopback port rule. */
function sameRedirectTarget(request: URL, registered: string): boolean
{
    let known: URL;

    try
    {
        known = new URL(registered);
    }
    catch
    {
        return false;
    }

    if (request.protocol !== known.protocol
        || request.hostname !== known.hostname
        || request.pathname !== known.pathname
        || request.search !== known.search)
    {
        return false;
    }

    return portMayVary(known) || request.port === known.port;
}

/**
 * Whether this registration is one whose port a client cannot know in advance:
 * a loopback listener on an ephemeral port, which is how every CLI does this.
 */
function portMayVary(registered: URL): boolean
{
    return registered.protocol === 'http:' && isLoopbackHostname(registered.hostname);
}

/**
 * The host shown on the consent screen, so the person approving can see where
 * the code is about to be sent.
 */
export function redirectHostOf(uri: string): string
{
    return new URL(uri).host;
}
