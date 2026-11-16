/**
 * Session cookie names for Next.js
 *
 * The names carry the `SPFN_PORT` suffix, so they are only knowable at call
 * time — this module is the one place an app reads them from.
 */

import { COOKIE_NAMES } from '../server/lib/config';
import { ownStartCookieNames, type CookieJar } from '../server/lib/oauth/start-cookies';

/**
 * The cookie names that make up a browser session
 */
export interface SessionCookieNames
{
    /** Encrypted session data */
    session: string;
    /** Current key ID (for key rotation) */
    keyId: string;
    /**
     * Pending OAuth session under its legacy fixed name — written only by a
     * start made before per-start cookies (#126). Read `oauthPendingPrefix`.
     */
    oauthPending: string;
    /**
     * Every in-flight start's pending cookie begins with this (#126): the legacy
     * name followed by `.`, then `<issuedAt>.<id>`. Up to five can be present.
     */
    oauthPendingPrefix: string;
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
        oauthPendingPrefix: `${COOKIE_NAMES.OAUTH_PENDING}.`,
        csrf: COOKIE_NAMES.CSRF,
    };
}

/**
 * Every cookie this package can hold in a browser — the one list.
 *
 * The session and its key id and CSRF companions; the pending cookies the
 * second-factor, device-login, sign-up and password-reset flows hold mid-way;
 * and every OAuth start in flight, both of its cookies, plus the legacy fixed
 * names (#126) — those are named per start, so only the jar knows them.
 * Signing out expires exactly this list, so a cookie added to the package is
 * added here or is left behind at sign-out.
 *
 * @param jar - the request's cookies, which name the in-flight OAuth starts
 */
export function packageCookieNames(jar: CookieJar): string[]
{
    return [
        COOKIE_NAMES.SESSION,
        COOKIE_NAMES.SESSION_KEY_ID,
        COOKIE_NAMES.CSRF,
        COOKIE_NAMES.MFA_PENDING,
        COOKIE_NAMES.DEVICE_PENDING,
        COOKIE_NAMES.SIGNUP_SETUP,
        COOKIE_NAMES.PASSWORD_RESET_SETUP,
        ...ownStartCookieNames('pending', jar),
        ...ownStartCookieNames('csrf', jar),
    ];
}
