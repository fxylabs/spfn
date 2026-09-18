/**
 * @spfn/auth - OAuth 2.1 consent screen (Next.js route handlers)
 *
 * The authorization server lives on the API origin; this is the one piece of it
 * that cannot, because consent is a decision only the signed-in person can make
 * and the session cookie is on the web app. `GET` draws the screen, `POST` takes
 * the answer, and neither of them decides anything: both forward the request to
 * `/_auth/oauth2/authorize`, which validates it against the registration and
 * hands back either what to draw or the refusal to act on.
 *
 * Three rules shape everything below, and each of them is an attack that would
 * otherwise work:
 *
 * - **The only URLs this file redirects to are `loginPath` and a URI the API
 *   returned.** The request's own `redirect_uri` is forwarded and never built
 *   into a `Location` — an unregistered one is exactly the open redirect the
 *   registration check exists to close, and the API is the only side that can
 *   tell the two apart.
 * - **Everything interpolated into the page is escaped.** `client_name` arrives
 *   from unauthenticated dynamic registration, and `state` and `resource` come
 *   from the query string of a link somebody was sent.
 * - **The POST carries its own CSRF token.** The handler's server-side call to
 *   the API mints the CSRF header itself and so would always pass; the check
 *   that matters is the browser form's, and it is made before the API is called
 *   at all.
 */

import { cookies } from 'next/headers.js';
import { NextResponse, type NextRequest } from 'next/server';

import { authApi } from '@spfn/auth';
import type { AuthRouter } from '@spfn/auth';
import type { RouterInput } from '@spfn/core/nextjs';
import { logger } from '@spfn/core/logger';

import { sessionCookieNames } from './cookie-names';
import { getSession } from './session-helpers';
import { matchesCsrfToken } from '../server/lib/csrf';
import { isSafeReturnPath } from '../lib/return-path';

/** The authorize parameters, spelled as the protocol spells them. */
const AUTHORIZE_PARAMETERS = [
    'client_id',
    'redirect_uri',
    'code_challenge',
    'code_challenge_method',
    'resource',
    'scope',
    'state',
] as const;

/**
 * Refusals with no vetted URI to carry them.
 *
 * An unknown client has no registration to read a redirect URI from, and a
 * mismatched `redirect_uri` is the one the request supplied. Both are shown.
 */
const NON_REDIRECTABLE = new Set(['unknown_client', 'redirect_uri_mismatch']);

/** Content types a browser form can actually arrive as. */
const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data'];

type AuthorizeQuery = RouterInput<AuthRouter, 'getOAuth2Authorize'>['query'];

type DecisionBody = RouterInput<AuthRouter, 'createOAuth2AuthorizationCode'>['body'];

/** One scope, with the sentence the consent screen reads aloud for it. */
export interface OAuth2ConsentScope
{
    name: string;
    description: string;
}

/**
 * Everything a consent screen needs, raw and unescaped.
 *
 * A custom `render` receives this and owns the whole body, so it must echo
 * `fields` and `csrfToken` back as hidden inputs: the POST is refused without
 * the token, and the API re-validates the request from the fields rather than
 * trusting what the GET was once shown.
 *
 * Every string here is caller-supplied. Put each one through {@link escapeHtml}.
 */
export interface OAuth2ConsentView
{
    /** Registered name of the client asking. Unauthenticated input. */
    clientName: string;

    /** Host the code would be sent to — the one fact about the client that is checkable. */
    redirectHost: string;

    scopes: OAuth2ConsentScope[];

    /** RFC 8707 target the token would be good against. */
    resource: string;

    /** Every authorize parameter the request carried, verbatim, to echo as hidden inputs. */
    fields: Record<string, string>;

    /** Value the POST's `csrf` field must carry. */
    csrfToken: string;
}

/**
 * Options for {@link createOAuth2AuthorizeHandlers}
 */
export interface OAuth2AuthorizeHandlerOptions
{
    /**
     * Where to send a visitor with no session, e.g. `/login`
     *
     * The handler appends `?returnUrl=` pointing at this request, so the login
     * lands back on the consent screen with its parameters intact.
     */
    loginPath: string;

    /**
     * Replace the default consent page body
     *
     * Status, headers and the field set stay the handler's; this owns the HTML.
     */
    render?: (view: OAuth2ConsentView) => string;
}

/** The pair a route file re-exports as `export const { GET, POST } = ...`. */
export interface OAuth2AuthorizeHandlers
{
    GET: (request: NextRequest) => Promise<NextResponse>;
    POST: (request: NextRequest) => Promise<NextResponse>;
}

/**
 * Escape a string for interpolation into HTML text or a quoted attribute.
 *
 * Exported because a custom `render` needs the same escaping the default body
 * applies: `client_name` comes from unauthenticated dynamic registration, and
 * `state` is whatever was in the link the browser followed.
 *
 * @param value - Raw string
 * @returns The same string with `& < > " '` replaced by entities
 */
export function escapeHtml(value: string): string
{
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The authorize parameters that are present, and only those.
 *
 * Reading from a fixed list rather than copying the request is what keeps an
 * extra field somebody appended to the form out of the call to the API.
 */
function authorizeFields(read: (name: string) => string | null): Record<string, string>
{
    const fields: Record<string, string> = {};

    for (const name of AUTHORIZE_PARAMETERS)
    {
        const value = read(name);

        if (value)
        {
            fields[name] = value;
        }
    }

    return fields;
}

/** An HTML answer, with the three headers every consent answer carries. */
function screen(status: number, body: string): NextResponse
{
    return new NextResponse(body, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "frame-ancestors 'none'",
            'Cache-Control': 'no-store',
        },
    });
}

/**
 * A refusal screen.
 *
 * The message is one of the fixed set written below — nothing from the request
 * or from the API's error body reaches the page, because both are
 * attacker-supplied in exactly the cases that produce this screen.
 */
function refusalScreen(status: number, heading: string, message: string): NextResponse
{
    return screen(status, [
        '<!DOCTYPE html>',
        '<html lang="en"><head><meta charset="utf-8"><title>Authorization request refused</title></head>',
        `<body><h1>${heading}</h1><p>${message}</p></body></html>`,
    ].join('\n'));
}

function unknownClientScreen(): NextResponse
{
    return refusalScreen(
        400,
        'Unrecognized application',
        'The application that sent you here is not registered with this service, so the request '
        + 'cannot be completed. Nothing was shared.',
    );
}

function redirectMismatchScreen(): NextResponse
{
    return refusalScreen(
        400,
        'Address not recognized',
        'The application asked for the authorization to be returned to an address it never '
        + 'registered. Nothing was shared, and you were not sent there.',
    );
}

function unavailableScreen(): NextResponse
{
    return refusalScreen(
        500,
        'Authorization unavailable',
        'This authorization request could not be checked. Nothing was shared. Please try again.',
    );
}

function noSessionScreen(): NextResponse
{
    return refusalScreen(
        403,
        'Sign-in required',
        'This authorization request needs a signed-in session and yours is not available. Start '
        + 'the request again from the application.',
    );
}

/** A 302 that never caches, which is the only kind this file emits. */
function redirect(url: URL): NextResponse
{
    return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'no-store' } });
}

/** Parse an absolute URL, refusing anything that is not one. */
function safeUrl(value: string): URL | null
{
    try
    {
        return new URL(value);
    }
    catch
    {
        return null;
    }
}

/**
 * Send an unauthenticated visitor to the login screen, or refuse to.
 *
 * The return destination is this request's own path and query — never an
 * absolute URL — and it is still held to `isSafeReturnPath`, because the query
 * is caller-supplied and a destination that leaves the app is the open redirect
 * every return path in this package is checked against.
 */
function loginRedirect(request: NextRequest, loginPath: string): NextResponse
{
    const returnPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;

    if (!isSafeReturnPath(returnPath))
    {
        return refusalScreen(
            400,
            'Malformed authorization request',
            'This authorization request cannot be signed in to. Start it again from the application.',
        );
    }

    const url = new URL(loginPath, request.url);
    url.searchParams.set('returnUrl', returnPath);

    return redirect(url);
}

/** The SPFN error envelope, as an `ApiError.response` carries it. */
interface ErrorEnvelope
{
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
    details?: Record<string, unknown>;
}

/**
 * The refusal's `details`, whichever shape the thrown value arrived in.
 *
 * A registered error class comes back deserialized and carries `details`
 * directly; anything else is an `ApiError` whose `response` holds the envelope.
 */
function detailsOf(thrown: unknown): Record<string, unknown>
{
    const error = thrown as { details?: Record<string, unknown>; response?: ErrorEnvelope } | null;

    return error?.details ?? error?.response?.error?.details ?? error?.response?.details ?? {};
}

/** HTTP status of the refusal — an `ApiError.status`, or an `HttpError.statusCode`. */
function statusOf(thrown: unknown): number
{
    const error = thrown as { status?: unknown; statusCode?: unknown } | null;

    return Number(error?.status ?? error?.statusCode ?? 0);
}

/**
 * The 302 a redirectable refusal earns, or null when it earns a screen.
 *
 * `redirectUri` is read from the API's answer and from nowhere else: it is the
 * value that matched the registration, which is what makes sending a browser
 * there safe. A refusal carrying no such value has no vetted destination, and is
 * shown rather than redirected.
 */
function refusalRedirect(details: Record<string, unknown>): NextResponse | null
{
    const { error, redirectUri, state } = details;

    if (typeof error !== 'string' || NON_REDIRECTABLE.has(error) || typeof redirectUri !== 'string')
    {
        return null;
    }

    const url = safeUrl(redirectUri);

    if (!url)
    {
        return null;
    }

    url.searchParams.set('error', error);

    if (typeof state === 'string')
    {
        url.searchParams.set('state', state);
    }

    return redirect(url);
}

/**
 * Turn an API refusal into the answer it earns.
 *
 * @param thrown - Whatever the typed client threw
 * @param onStaleSession - What a 401 means here: the GET redirects to the login
 *                         once, the POST has no form left to resume and refuses
 */
function answerRefusal(thrown: unknown, onStaleSession: () => NextResponse): NextResponse
{
    const status = statusOf(thrown);

    if (status === 401)
    {
        return onStaleSession();
    }

    const details = detailsOf(thrown);

    if (details.error === 'unknown_client')
    {
        return unknownClientScreen();
    }

    if (details.error === 'redirect_uri_mismatch')
    {
        return redirectMismatchScreen();
    }

    const redirectable = refusalRedirect(details);

    if (redirectable)
    {
        return redirectable;
    }

    // The status and nothing else: the error body was written for a request
    // somebody else composed, and the screen echoes none of it either.
    logger.error('OAuth2 consent request could not be answered', { status });

    return unavailableScreen();
}

/** One hidden input per authorize parameter, values escaped for an attribute. */
function hiddenFields(fields: Record<string, string>, csrfToken: string): string
{
    return [...Object.entries(fields), ['csrf', csrfToken]]
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join('\n        ');
}

/**
 * The default consent page.
 *
 * Deliberately unstyled: an application that wants its own design system passes
 * `render`, and a page shipping CSS of its own would have to be undone first.
 */
function defaultRender(view: OAuth2ConsentView): string
{
    const scopes = view.scopes
        .map(scope => `<li><strong>${escapeHtml(scope.name)}</strong> — ${escapeHtml(scope.description)}</li>`)
        .join('\n        ');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Authorize ${escapeHtml(view.clientName)}</title></head>
<body>
    <h1>Authorize ${escapeHtml(view.clientName)}</h1>
    <p><strong>${escapeHtml(view.clientName)}</strong> is asking to act on your behalf at
        <code>${escapeHtml(view.resource)}</code>. The authorization would be returned to
        <code>${escapeHtml(view.redirectHost)}</code>.</p>
    <h2>It is asking for</h2>
    <ul>
        ${scopes}
    </ul>
    <form method="post">
        ${hiddenFields(view.fields, view.csrfToken)}
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
    </form>
</body>
</html>`;
}

/** The readable CSRF cookie's value, which the form has to echo back. */
async function csrfCookie(): Promise<string | null>
{
    const cookieStore = await cookies();

    return cookieStore.get(sessionCookieNames().csrf)?.value ?? null;
}

/**
 * Draw the consent screen for an authorize request.
 *
 * The API decides whether there is anything to draw; this turns its answer into
 * a page. A session whose readable CSRF cookie is gone is treated as no session:
 * the form it would render could never be submitted, and signing in again is
 * what puts the cookie back.
 */
async function renderConsent(
    request: NextRequest,
    options: OAuth2AuthorizeHandlerOptions,
): Promise<NextResponse>
{
    const csrfToken = await csrfCookie();

    if (!csrfToken)
    {
        return loginRedirect(request, options.loginPath);
    }

    const fields = authorizeFields(name => request.nextUrl.searchParams.get(name));

    // The isomorphic client forwards this request's cookie jar and mirrors the
    // readable CSRF cookie into the header, so the call arrives as this user.
    const described = await authApi.getOAuth2Authorize.call({ query: fields as AuthorizeQuery });
    const render = options.render ?? defaultRender;

    return screen(200, render({ ...described, fields, csrfToken }));
}

/**
 * The form's own CSRF token, checked before the API is called at all.
 *
 * It belongs here rather than after the call: the handler's own call to the API
 * carries a CSRF header it mints itself and would always pass, so a cross-site
 * form POST would otherwise consent on the user's behalf. The comparison is
 * `matchesCsrfToken`, which is constant-time.
 *
 * @returns The refusal, or null when the POST may proceed
 */
async function refuseUnverifiedPost(form: FormData): Promise<NextResponse | null>
{
    const presented = form.get('csrf');
    const expected = await csrfCookie();

    if (!expected || !matchesCsrfToken(expected, typeof presented === 'string' ? presented : null))
    {
        return refusalScreen(
            403,
            'Request could not be verified',
            'This form did not carry a valid token for your session. Start the authorization again '
            + 'from the application.',
        );
    }

    return null;
}

/** Whether the body is a form at all, which is the only thing this POST reads. */
function isFormPost(request: NextRequest): boolean
{
    const contentType = request.headers.get('content-type') ?? '';

    return FORM_CONTENT_TYPES.some(type => contentType.startsWith(type));
}

/**
 * The decision, once the form's own CSRF token has been matched.
 *
 * `approve` is the button that was pressed and nothing else — a body with no
 * `decision` is a denial, the safe reading of a form the user did not finish.
 */
async function recordDecision(fields: Record<string, string>, decision: string | null): Promise<NextResponse>
{
    const body = { ...fields, approve: decision === 'approve' } as DecisionBody;
    const issued = await authApi.createOAuth2AuthorizationCode.call({ body });
    const url = safeUrl(issued.redirectUri);

    if (!url)
    {
        return unavailableScreen();
    }

    url.searchParams.set('code', issued.code);

    if (issued.state !== undefined)
    {
        url.searchParams.set('state', issued.state);
    }

    return redirect(url);
}

/**
 * Create the consent screen's route handlers
 *
 * `GET` renders the screen for an `/oauth/authorize` request and `POST` takes
 * the form it submits. Mount both at the path published as
 * `authorization_endpoint` in the authorization server metadata —
 * `/oauth/authorize` unless `authorizationServer.authorizeUrl` says otherwise.
 *
 * Every answer carries `Cache-Control: no-store`; every page also carries
 * `Content-Security-Policy: frame-ancestors 'none'`, because a consent screen
 * that can be framed is a consent screen that can be clickjacked.
 *
 * @param options - Where to send an unauthenticated visitor, and an optional renderer
 * @returns `{ GET, POST }`, ready to re-export from a route file
 *
 * @example
 * ```typescript
 * // app/oauth/authorize/route.ts
 * import { createOAuth2AuthorizeHandlers } from '@spfn/auth/nextjs/server';
 *
 * export const { GET, POST } = createOAuth2AuthorizeHandlers({ loginPath: '/login' });
 * ```
 */
export function createOAuth2AuthorizeHandlers(
    options: OAuth2AuthorizeHandlerOptions,
): OAuth2AuthorizeHandlers
{
    async function GET(request: NextRequest): Promise<NextResponse>
    {
        if (!await getSession())
        {
            return loginRedirect(request, options.loginPath);
        }

        try
        {
            return await renderConsent(request, options);
        }
        catch (error)
        {
            return answerRefusal(error, () => loginRedirect(request, options.loginPath));
        }
    }

    async function POST(request: NextRequest): Promise<NextResponse>
    {
        if (!await getSession())
        {
            return noSessionScreen();
        }

        if (!isFormPost(request))
        {
            return refusalScreen(
                415,
                'Unsupported request',
                'The consent form is submitted as a form. Start the authorization again from the '
                + 'application.',
            );
        }

        const form = await request.formData();
        const refusal = await refuseUnverifiedPost(form);

        if (refusal)
        {
            return refusal;
        }

        try
        {
            const fields = authorizeFields(name => form.get(name) as string | null);

            return await recordDecision(fields, form.get('decision') as string | null);
        }
        catch (error)
        {
            return answerRefusal(error, noSessionScreen);
        }
    }

    return { GET, POST };
}
