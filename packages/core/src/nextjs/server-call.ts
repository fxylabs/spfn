/**
 * @spfn/core/nextjs/server-call - What a server-side `createApi` call adds
 *
 * Loaded by the isomorphic client, by dynamic import, only where `next/headers`
 * answers. Server-only: a browser build resolves this subpath to
 * `server-call.browser.ts` (the `browser` export condition), so no signing code
 * reaches a browser bundle.
 */

export { forwardedClientHeaders } from './proxy/client-address';
