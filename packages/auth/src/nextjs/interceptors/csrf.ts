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

import { findRouteEntry } from '@spfn/core/nextjs/server';
import type { ProxyAbort, RequestInterceptorContext } from '@spfn/core/nextjs/server';

import { getCsrfMode, getCsrfExemptPaths, type CsrfMode } from '../../server/lib/config';
import { CSRF_HEADER, deriveCsrfToken, matchesCsrfToken } from '../../server/lib/csrf';
import { authLogger } from '../../server/logger';
import { routeMap as authRouteMap } from '../../generated/route-map';
import { repairCsrf } from './session-decision';

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

/** Paths of CSRF-required routes an exempt list has already been warned about */
const exemptionsReported = new Set<string>();

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
 * Safe methods and exempt paths come out as `off`. A route that declares
 * `.csrf('required')` comes out as `enforce` whatever the configuration says,
 * and an exempt-list entry naming its path is ignored — with one warning, so
 * the entry does not sit there looking like it took effect.
 *
 * The declaration is read from a route, never from a path list: a list has to
 * spell every parameterised path the proxy may produce, and the route it missed
 * is the one left open. Which routes declare it is `declaresRequired`'s to
 * say. Those routes are cookie-session mutations a third party must not be able
 * to trigger — the consent decision hands a code to a client, the disconnect
 * button cuts one off — so they are refused in `off` and `warn` too.
 */
function checkModeFor(ctx: RequestInterceptorContext): CsrfMode
{
    if (SAFE_METHODS.has(ctx.method.toUpperCase()))
    {
        return 'off';
    }

    if (declaresRequired(ctx))
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
 * Whether the route this request reaches declares `.csrf('required')` — in the
 * map this package ships or in the application's, either one is enough.
 *
 * A request that reaches one of this package's routes is checked against the
 * map the package ships, whatever the application's map says: `ctx.route` comes
 * from the application's generated copy, and a copy generated before a route
 * declared `.csrf('required')` — an upgrade nobody followed with a regeneration
 * — would otherwise switch the declaration off without anybody seeing it. The
 * lookup is by method and the path the backend will route, so a spelling the
 * backend resolves to the same route (`%61uthorize`, `x/../`) finds it too.
 * `ctx.route` is the application's own declaration, and a package entry that
 * matches the same method and path without declaring anything does not
 * override it: a declaration can only be added to, never taken away.
 */
function declaresRequired(ctx: RequestInterceptorContext): boolean
{
    return findRouteEntry(authRouteMap, ctx.method, ctx.path)?.csrf === 'required'
        || ctx.route?.csrf === 'required';
}

/**
 * Warn, once per process, that the exempt list names a CSRF-required route's path.
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
 * A route declaring `.csrf('required')` is refused in every mode, `off`
 * included (see checkModeFor); the cookie it repairs is issued in every mode
 * too, so a page's retry with the mirrored header passes.
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
    // check exists to withhold. The route by its template, never the filled
    // path: `redactPaths` is the backend's, and a capability in a path
    // parameter would be written here in full.
    const detail = {
        method: ctx.method,
        route: ctx.route?.path,
        headerPresent: !!presented,
    };

    if (mode === 'warn')
    {
        authLogger.interceptor.csrf.warn('CSRF check would refuse this request (mode=warn)', detail);

        return false;
    }

    authLogger.interceptor.csrf.warn('CSRF check refused this request', detail);

    ctx.abort = refusal();

    // The repair rides on the refusal: the session decision writes the token
    // cookie for this key onto it. A refusal whose repair cannot be built is
    // still the refusal — one extra page load for one user, never a different
    // status.
    repairCsrf(ctx, keyId);

    return true;
}
