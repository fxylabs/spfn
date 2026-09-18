/**
 * Session cookie names for Next.js
 *
 * The names carry the `SPFN_PORT` suffix, so they are only knowable at call
 * time — this module is the one place an app reads them from.
 */

import { type NextResponse } from 'next/server';
import { COOKIE_NAMES } from '../server/lib/config';

/**
 * The cookie names that make up a browser session
 */
export interface SessionCookieNames
{
    /** Encrypted session data */
    session: string;
    /** Current key ID (for key rotation) */
    keyId: string;
    /** Pending OAuth session — present only mid-flow */
    oauthPending: string;
    /** CSRF token — the only one the browser can read */
    csrf: string;
}

/**
 * Names of the cookies that make up a browser session
 *
 * Read at call time, never at import: the names carry the `SPFN_PORT` suffix,
 * and an app that spells them itself keeps clearing the old name after a
 * release renames one.
 *
 * @example
 * ```typescript
 * const names = sessionCookieNames();
 * const raw = request.cookies.get(names.session);
 * ```
 */
export function sessionCookieNames(): SessionCookieNames
{
    return {
        session: COOKIE_NAMES.SESSION,
        keyId: COOKIE_NAMES.SESSION_KEY_ID,
        oauthPending: COOKIE_NAMES.OAUTH_PENDING,
        csrf: COOKIE_NAMES.CSRF,
    };
}

/**
 * Expire every session cookie on a response
 *
 * For the route handler or middleware that answers "the API refused your
 * session" — it empties the jar so the next request arrives anonymous. The
 * path matches the one the setters use, because a delete under a different
 * path leaves the cookie in place. Absent cookies are not an error.
 *
 * @param response - Response to expire the cookies on
 * @returns The same response, so the call chains
 *
 * @example
 * ```typescript
 * export function GET(): NextResponse
 * {
 *     return clearSessionCookies(NextResponse.redirect(new URL('/login', request.url)));
 * }
 * ```
 */
export function clearSessionCookies(response: NextResponse): NextResponse
{
    for (const name of Object.values(sessionCookieNames()))
    {
        response.cookies.delete({ name, path: '/' });
    }

    return response;
}
