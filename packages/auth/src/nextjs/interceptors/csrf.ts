/**
 * CSRF check for cookie-authenticated mutations
 *
 * Enforced here, in the Next.js proxy, because this is the only layer that knows
 * a request's credential was ambient: the browser sends an encrypted HttpOnly
 * session cookie, generalAuthInterceptor turns it into a short-lived bearer JWT,
 * and the backend then sees `scheme:'bearer'` for cookie callers and genuine
 * bearer callers alike. Requests the proxy does not authenticate from the session
 * cookie — no session, direct-to-backend bearer, clientProofV1, machine and ops
 * tokens — never reach this code and are unaffected.
 *
 * The threat model is in the README: the session cookie is SameSite=Lax, so this
 * covers what Lax does not (sibling-subdomain pivots, legacy browsers, domain
 * layout drift) and covers nothing an XSS on your own origin could not do anyway.
 */

import type { ProxyAbort, RequestInterceptorContext } from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

import { getCsrfMode, getCsrfExemptPaths, getSessionTtl, COOKIE_NAMES, type CsrfMode } from '../../server/lib/config';
import { CSRF_HEADER, deriveCsrfToken, matchesCsrfToken, timingSafeEqualString } from '../../server/lib/csrf';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';

/**
 * Methods that cannot mutate, so they need no token.
 *
 * Compared against the resolved *route* method, not the method the browser used
 * to reach the proxy: `GET /api/rpc/deleteAccount?input=…` is forwarded to the
 * backend as the route's DELETE, and SameSite=Lax does send the session cookie on
 * a cross-site top-level GET navigation. Gating on the wire method would leave
 * every mutation reachable that way.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Paths checked in every mode, `off` and `warn` included, and never exempt.
 *
 * `POST /_auth/oauth2/authorize` is the consent decision: it issues an
 * authorization code for a third-party client on the strength of the session
 * cookie alone. The package ships no consent screen, so an app's own page calls
 * it through this proxy, and a cross-site POST that got past a relaxed mode
 * would hand a code to a client the user never approved. Nothing else earns a
 * place here; everything else follows the configured mode.
 */
const ALWAYS_ENFORCED_PATHS = new Set(['/_auth/oauth2/authorize']);

/** Always-enforced paths an exempt list has already been warned about */
const exemptionsReported = new Set<string>();

/**
 * The readable CSRF cookie, as every place that issues one builds it.
 *
 * Mirrors the session cookie's attributes minus HttpOnly — the client has to read
 * it — and carries only the HMAC, never the key id it derives from.
 */
function csrfCookie(token: string, ttl: number): SetCookie
{
    return {
        name: COOKIE_NAMES.CSRF,
        value: token,
        options: {
            httpOnly: false,
            secure: cookieSecure,
            sameSite: 'lax',
            maxAge: ttl,
            path: '/',
        },
    };
}

/**
 * The 403 a failed check answers with.
 *
 * The body is the same whatever the reason: a caller learns that the request was
 * refused, never whether the header was absent, wrong, or impossible to check.
 *
 * It carries no cookie. The caller attaches one afterwards where there is a value
 * to attach — see refuseInvalidCsrf for why that order matters.
 */
function refusal(): ProxyAbort
{
    return {
        status: 403,
        body: {
            error: 'Forbidden',
            message: 'CSRF token missing or invalid',
        },
        setCookies: [],
    };
}

/**
 * The mode this request is checked under.
 *
 * Safe methods and exempt paths come out as `off`. An always-enforced path comes
 * out as `enforce` whatever the configuration says, and an exempt-list entry
 * naming it is ignored — with one warning, so the entry does not sit there
 * looking like it took effect.
 */
function checkModeFor(ctx: RequestInterceptorContext): CsrfMode
{
    if (SAFE_METHODS.has(ctx.method.toUpperCase()))
    {
        return 'off';
    }

    if (ALWAYS_ENFORCED_PATHS.has(ctx.path))
    {
        reportIgnoredExemption(ctx.path);

        return 'enforce';
    }

    const mode = getCsrfMode();

    if (mode !== 'off' && getCsrfExemptPaths().includes(ctx.path))
    {
        authLogger.interceptor.csrf.debug('Path is CSRF-exempt', { path: ctx.path });

        return 'off';
    }

    return mode;
}

/**
 * Warn, once per process, that the exempt list names an always-enforced path.
 */
function reportIgnoredExemption(path: string): void
{
    if (exemptionsReported.has(path) || !getCsrfExemptPaths().includes(path))
    {
        return;
    }

    exemptionsReported.add(path);
    authLogger.interceptor.csrf.warn(
        'CSRF exempt list names a path that is always checked — the entry is ignored',
        { path },
    );
}

/**
 * Refuse a cookie-authenticated mutation that has no valid CSRF header.
 *
 * Call only once the session has been unsealed — a refusal must never be the
 * answer to a request that had no session, or the status alone would tell an
 * unauthenticated caller whether someone is signed in. Unauthenticated requests
 * keep taking the existing path (the backend answers 401).
 *
 * The refusal carries a fresh CSRF cookie. A refused request skips the backend
 * and every response interceptor, so this is the only chance to repair a browser
 * whose token cookie went missing or stale — without it the client would be told
 * "wrong token" while holding nothing better to try, and the documented recovery
 * would need an unrelated GET to happen first.
 *
 * The consent POST is refused in every mode, `off` included (see
 * ALWAYS_ENFORCED_PATHS); the cookie it repairs is issued in every mode too, so
 * a page's retry with the mirrored header passes.
 *
 * @param ctx - Request interceptor context, mutated with `abort` on refusal
 * @param keyId - Key id of the session that authenticated this request
 * @returns True when the request was refused and the caller must stop
 */
export async function refuseInvalidCsrf(
    ctx: RequestInterceptorContext,
    keyId: string,
): Promise<boolean>
{
    const mode = checkModeFor(ctx);

    if (mode === 'off')
    {
        return false;
    }

    let expected: string;

    try
    {
        expected = await deriveCsrfToken(keyId);
    }
    catch (error)
    {
        // Fail closed, in every mode including the default `warn`. A deployment
        // that cannot derive the token is misconfigured, not unprotected, and
        // letting warn wave these through would leave a broken install silently
        // open while its logs looked like a healthy one's. No cookie either —
        // there is no value to issue.
        authLogger.interceptor.csrf.error(
            'Cannot derive the CSRF token — refusing regardless of mode',
            error as Error,
        );

        ctx.abort = refusal();

        return true;
    }

    // Read the header off the ORIGINAL browser request. ctx.headers is the set
    // buildProxyHeaders() forwards to the backend, and that is a fixed allowlist
    // — the CSRF header is not on it, deliberately: it is proxy-terminated and
    // has no meaning past this point. Reading ctx.headers here would refuse
    // every request instead.
    const presented = ctx.request.headers.get(CSRF_HEADER);

    if (matchesCsrfToken(expected, presented))
    {
        return false;
    }

    // One line per request that fails the check, in either mode. Never the
    // expected token or the key id — the log would otherwise hand out what the
    // check exists to withhold.
    const detail = {
        method: ctx.method,
        path: ctx.path,
        headerPresent: !!presented,
    };

    if (mode === 'warn')
    {
        authLogger.interceptor.csrf.warn('CSRF check would refuse this request (mode=warn)', detail);

        return false;
    }

    authLogger.interceptor.csrf.warn('CSRF check refused this request', detail);

    ctx.abort = refusal();

    // The repair is attached after the refusal is already in place. Building the
    // cookie needs the session TTL, which parses configuration and throws on a
    // malformed value — and a throw on the way out of here is swallowed upstream,
    // which would hand the caller the backend's 401 instead of this 403. Refusing
    // without the repair costs one user one extra page load; refusing with the
    // wrong status changes what the check means.
    ctx.abort.setCookies = [csrfCookie(expected, getSessionTtl())];

    return true;
}

/**
 * Queue the readable CSRF cookie for a session.
 *
 * Set wherever a session is established or renewed.
 *
 * Queued in every mode, including `off`, so that turning enforcement on later
 * does not require everyone to sign in again.
 */
export async function pushCsrfCookie(
    setCookies: SetCookie[],
    keyId: string,
    ttl: number,
): Promise<void>
{
    setCookies.push(csrfCookie(await deriveCsrfToken(keyId), ttl));
}

/**
 * Queue the readable CSRF cookie when the request's copy is missing or stale.
 *
 * The other half of the recovery path: a session that predates this feature
 * carries no cookie, and one whose value stopped matching — a key rotated down a
 * path that did not reissue, a jar half-cleared by an extension — would
 * otherwise sit broken until the session came within a day of expiry. A cookie
 * that is present but no longer matches is reissued; presence alone is not
 * proof. Any authenticated response repairs it, which is what makes one page
 * load enough.
 *
 * A derivation failure is logged rather than thrown: the request-side check
 * already refuses those, and turning every authenticated response into a 500 on
 * top of that helps nobody diagnose it.
 */
export async function pushCsrfCookieIfStale(
    setCookies: SetCookie[],
    presented: string | undefined,
    keyId: string,
): Promise<void>
{
    try
    {
        const token = await deriveCsrfToken(keyId);

        if (presented && timingSafeEqualString(token, presented))
        {
            return;
        }

        setCookies.push(csrfCookie(token, getSessionTtl()));
    }
    catch (error)
    {
        authLogger.interceptor.csrf.error('Cannot reissue the CSRF cookie', error as Error);
    }
}

/**
 * Queue removal of the readable CSRF cookie (logout, expired session).
 */
export function pushCsrfCookieRemoval(setCookies: SetCookie[]): void
{
    setCookies.push({
        name: COOKIE_NAMES.CSRF,
        value: '',
        options: { maxAge: 0, path: '/' },
    });
}
