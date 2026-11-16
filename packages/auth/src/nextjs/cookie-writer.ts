/**
 * The one place a cookie of this package is built
 *
 * Every `Set-Cookie` this package writes — the session, its key id and CSRF
 * companion, and the pending cookies a flow holds mid-way — is constructed here,
 * with the attributes `server/lib/cookie-attributes.ts` decides once, from
 * configuration — the same definition the backend's own cookie writer (the
 * API-mode OAuth start) reads.
 *
 * Interceptor rules never push these onto a response themselves; they propose
 * (`interceptors/session-decision.ts`), and the decision writes. The two writers
 * outside the proxy — `saveSession` / `clearSession` and `clearSessionCookies` —
 * build their cookies here too.
 */

import type { NextResponse } from 'next/server.js';
import type { SetCookie } from '@spfn/core/nextjs';

import { sealSession, type SessionData } from '../server/lib/session';
import { deriveCsrfToken } from '../server/lib/csrf';
import { COOKIE_NAMES, getSessionTtl } from '../server/lib/config';
import { packageCookieAttributes } from '../server/lib/cookie-attributes';
import { packageCookieNames } from './cookie-names';
import type { CookieJar } from '../server/lib/oauth/start-cookies';

/**
 * A cookie of this package.
 *
 * @param name - one of the names `packageCookieNames` lists
 * @param value - the value; `''` with `maxAge` 0 expires it
 * @param maxAge - seconds
 * @param readable - the page reads it (the CSRF token); every other cookie is HttpOnly
 */
export function packageCookie(name: string, value: string, maxAge: number, readable = false): SetCookie
{
    return { name, value, options: packageCookieAttributes(maxAge, readable) };
}

/** The cookie that expires `name`. */
export function expiredCookie(name: string): SetCookie
{
    return packageCookie(name, '', 0, name === COOKIE_NAMES.CSRF);
}

/** How long a session lives: the kept lifetime when its sign-in asked to be kept. */
export function sessionTtlOf(session: Pick<SessionData, 'remember'>): number
{
    return getSessionTtl({ remember: session.remember === true });
}

/** The readable CSRF cookie for a session key, living as long as the session does. */
export async function csrfCookie(keyId: string, ttl: number): Promise<SetCookie>
{
    return packageCookie(COOKIE_NAMES.CSRF, await deriveCsrfToken(keyId), ttl, true);
}

/**
 * The whole set a session is: the sealed session, its key id and its CSRF token.
 *
 * Built in full before anything is returned, so a failure to seal or to derive
 * the token leaves nothing half-written. Throws on either.
 */
export async function sessionCookies(session: SessionData): Promise<SetCookie[]>
{
    const ttl = sessionTtlOf(session);

    return [
        packageCookie(COOKIE_NAMES.SESSION, await sealSession(session, ttl), ttl),
        packageCookie(COOKIE_NAMES.SESSION_KEY_ID, session.keyId, ttl),
        await csrfCookie(session.keyId, ttl),
    ];
}

/** Expire the session, its key id and its CSRF token — a session that is gone. */
export function clearedSessionCookies(): SetCookie[]
{
    return [COOKIE_NAMES.SESSION, COOKIE_NAMES.SESSION_KEY_ID, COOKIE_NAMES.CSRF].map(expiredCookie);
}

/** Expire every cookie of this package the jar can hold — signing out. */
export function signedOutCookies(jar: CookieJar): SetCookie[]
{
    return packageCookieNames(jar).map(expiredCookie);
}

/** The `getAll()` a NextRequest's cookie jar answers with. */
interface RequestCookieSource
{
    cookies: { getAll(): { name: string; value: string }[] };
}

/**
 * Expire every cookie of this package on a response
 *
 * For the route handler or middleware that answers "the API refused your
 * session" — it empties the jar so the next request arrives anonymous. Absent
 * cookies are not an error.
 *
 * The OAuth start cookies are named per start (#126), so their names are known
 * only from the request: pass it, and every in-flight start's pending and CSRF
 * cookie is expired too. Without it, the legacy fixed names are.
 *
 * @param response - Response to expire the cookies on
 * @param request - The request whose jar names the in-flight OAuth starts
 * @returns The same response, so the call chains
 *
 * @example
 * ```typescript
 * export function GET(request: NextRequest): NextResponse
 * {
 *     return clearSessionCookies(NextResponse.redirect(new URL('/login', request.url)), request);
 * }
 * ```
 */
export function clearSessionCookies(response: NextResponse, request?: RequestCookieSource): NextResponse
{
    const jar = (request?.cookies.getAll() ?? []).map(({ name, value }) => [name, value] as const);

    for (const cookie of signedOutCookies(jar))
    {
        response.cookies.set(cookie.name, cookie.value, cookie.options);
    }

    return response;
}
