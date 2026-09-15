/**
 * @spfn/auth - Return-path validation
 *
 * One rule for every flow that hands a caller-supplied destination back to the
 * browser: the verified-email signup link, the password reset link, and the
 * OAuth start/callback seams. Apps that build their own destination before
 * calling an auth route import the same function rather than writing a second
 * rule that drifts from this one.
 *
 * The module imports nothing on purpose — it is part of the client bundle
 * (`@spfn/auth/nextjs/client`), which must not pull server code in behind it.
 */

/**
 * The characters a URL parser deletes from anywhere in its input before it reads
 * the input as a URL: ASCII tab, LF and CR (WHATWG URL, "remove all ASCII tab or
 * newline"). The rule below reads the value as written, so a value holding one of
 * them is not the value the browser parses — `/<tab>/evil.com` is read as the
 * protocol-relative `//evil.com` and lands on another origin. Refusing the three
 * outright also keeps a raw CR or LF out of any `Location` header the value
 * reaches, which is what would split that header in two.
 */
const URL_STRIPPED_CHARACTER = /[\t\n\r]/;

/**
 * Whether a return path can be handed back to the browser.
 *
 * Only a path within the app is allowed. The rejected shapes are the ones that
 * turn a return path into an open redirect: an absolute URL, a protocol-relative
 * `//host` that a browser reads as another origin, a backslash that some
 * browsers normalize into a slash, any `..` traversal, and any character a URL
 * parser strips before parsing (see above).
 *
 * The value is judged exactly as written: nothing is percent-decoded here. A
 * `/a%0d%0a` is therefore a path containing those six literal characters and is
 * accepted — no decoder downstream turns it back into header bytes.
 */
export function isSafeReturnPath(returnPath: string): boolean
{
    if (!returnPath.startsWith('/'))
    {
        return false;
    }

    if (returnPath.startsWith('//') || returnPath.includes('\\'))
    {
        return false;
    }

    if (returnPath.includes('..') || URL_STRIPPED_CHARACTER.test(returnPath))
    {
        return false;
    }

    // A path cannot carry a protocol prefix; `/\thttps:` and friends are caught
    // above, this catches `/foo:bar` forms that some parsers read as an authority.
    return !/^\/[^/?#]*:/.test(returnPath);
}
