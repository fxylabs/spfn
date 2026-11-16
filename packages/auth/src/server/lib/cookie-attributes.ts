/**
 * @spfn/auth - The attributes of this package's cookies
 *
 * One definition, read by every writer: the Next.js proxy's cookie writer
 * (`nextjs/cookie-writer.ts`) and the backend's own — the API-mode OAuth start,
 * which sets its CSRF cookie itself. `HttpOnly` unless the page has to read it,
 * `SameSite=Lax` (an OAuth redirect has to carry it back), `Path=/`, and
 * `Secure` from `SPFN_AUTH_COOKIE_SECURE`, else `NODE_ENV`.
 *
 * No Next.js and no Hono here, so the server bundle imports it without either.
 *
 * @module server/lib/cookie-attributes
 */

/** What every cookie of this package is written with. */
export interface PackageCookieAttributes
{
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
    path: '/';
    maxAge: number;
}

/**
 * Whether cookies carry `Secure`.
 *
 * `SPFN_AUTH_COOKIE_SECURE` when set (`'true'` / `'false'`), else
 * `NODE_ENV === 'production'`. Read on every write, like the rest of the auth
 * configuration, so no writer can hold a copy decided before the override.
 */
function cookieSecure(): boolean
{
    const override = process.env.SPFN_AUTH_COOKIE_SECURE;

    return override !== undefined ? override === 'true' : process.env.NODE_ENV === 'production';
}

/**
 * The attributes of a cookie of this package.
 *
 * @param maxAge - seconds; 0 expires it
 * @param readable - the page reads it (the CSRF token); every other cookie is HttpOnly
 */
export function packageCookieAttributes(maxAge: number, readable = false): PackageCookieAttributes
{
    return {
        httpOnly: !readable,
        secure: cookieSecure(),
        sameSite: 'lax',
        path: '/',
        maxAge,
    };
}
