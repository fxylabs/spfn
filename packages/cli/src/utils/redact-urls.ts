/**
 * The CLI's one rule for printing text it did not write — a tool's output, a
 * driver's error, an app file's load error: the parts that carry credentials
 * are blanked first.
 */

/**
 * Blank the parts of a URL that carry credentials.
 *
 * A tool's own error message is not written with this CLI's rules in mind: a
 * failing migration prints the connection string it tried, and that string has
 * a password in it.
 */
export function redactUrls(text: string): string
{
    return text
        .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1<redacted>@')
        // The scheme word is consumed with the value: `Bearer abc` is one
        // credential in two words, and blanking only the second leaves the
        // first half of a header that reads as if it had been handled.
        .replace(
            /\b(authorization|token|password|secret)(\s*[:=]\s*)(?:bearer|basic|token)?\s*\S+/gi,
            '$1$2<redacted>',
        );
}
