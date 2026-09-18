/**
 * OAuth 2.1 resource indicator (RFC 8707)
 *
 * The one string that says which API an access token is good against. It is
 * required at authorize, defaulted from the grant at token, and compared again
 * at verification — and the three comparisons have to agree, or a token minted
 * for one spelling of a URL is refused by another.
 *
 * So there is one rule and it is applied at every entry point: parse and
 * re-serialise with `new URL(...).toString()`, store that, and compare the
 * normalised strings exactly. That folds away the differences a URL parser is
 * allowed to fold — a default port written out, a percent-encoding case, an
 * empty path becoming `/` — and folds away nothing else. A trailing slash is
 * not noise: `https://api.example.com/mcp` and `https://api.example.com/mcp/`
 * are different paths and stay different resources.
 *
 * A fragment is refused rather than stripped. RFC 8707 §2 forbids one, and
 * stripping would quietly hand back a token for a target the client did not ask
 * for.
 */

/**
 * The canonical form of a resource indicator, or null when the value is not one.
 *
 * @param value - The `resource` parameter as it arrived
 */
export function normalizeResource(value: string): string | null
{
    let url: URL;

    try
    {
        url = new URL(value);
    }
    catch
    {
        return null;
    }

    if (url.hash !== '')
    {
        return null;
    }

    return url.toString();
}

/**
 * Whether a presented resource names the same target as a grant's.
 *
 * Both sides go through `normalizeResource`: the grant's value was normalised
 * when it was stored, and normalising it again costs one parse and removes the
 * chance that a row written by an older rule is compared raw.
 */
export function sameResource(presented: string, granted: string): boolean
{
    const left = normalizeResource(presented);

    return left !== null && left === normalizeResource(granted);
}
