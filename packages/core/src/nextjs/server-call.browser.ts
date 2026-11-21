/**
 * @spfn/core/nextjs/server-call, as a browser build resolves it
 *
 * A call made in the browser speaks for itself: it has no inbound request whose
 * address it could assert, and no key to assert it with.
 */

export function forwardedClientHeaders(): Record<string, string>
{
    return {};
}
