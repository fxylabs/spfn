/**
 * @spfn/auth - The sign-out-everywhere page (Next.js route handlers)
 *
 * The page the mailed revoke-all link opens. `GET` describes the link and draws
 * the button, `POST` presses it, and neither decides anything: both forward the
 * token to `/_auth/keys/revoke-all/{confirm,consume}`, which answers either what
 * to draw or the same 404 it answers for every token that names nothing.
 *
 * Four rules shape everything below, and each of them is an attack or a mishap
 * that would otherwise work:
 *
 * - **The token is never anywhere but a hidden field and an API body.** Not in a
 *   `Location`, not in a log line, not in the text of the page. It is a bearer
 *   capability, and the request logger records the path of every request.
 * - **There is no session here, so the CSRF token cannot come from one.** The
 *   whole point of the link is an owner on a device they do not trust. `GET`
 *   mints 32 random bytes, sets them in a cookie scoped to this page's path, and
 *   mirrors them into the form; `POST` compares the two. A cross-site form has
 *   neither half.
 * - **Opening the page signs nobody out.** `GET` calls `confirm`, which the API
 *   guarantees changes nothing, so a mail scanner that prefetches the link has
 *   done nothing. `consume` is only ever reached from `POST`.
 * - **Every refusal reads the same.** A 404 from either endpoint means unknown,
 *   expired, spent, superseded or retired, and the screen says none of them:
 *   telling them apart would tell whoever holds a random value that it named
 *   something real.
 */

import { cookies } from 'next/headers.js';
import { NextResponse, type NextRequest } from 'next/server';

import { authApi } from '@spfn/auth';
import { logger } from '@spfn/core/logger';

import { escapeHtml } from './oauth2-authorize-handlers';
import { matchesCsrfToken } from '../server/lib/csrf';

/**
 * Cookie holding the value the form has to echo back.
 *
 * `__Host-`-style in every respect a page path allows: `HttpOnly`, `Secure` off
 * localhost, `SameSite=Strict`, and no `Domain`, so no sibling subdomain can
 * write it. Not the literal `__Host-` prefix, which browsers only honour with
 * `Path=/` — and a path of `/` would send this cookie on every request in the
 * app, which is the opposite of what it is for.
 */
const CSRF_COOKIE = 'spfn_revoke_all_csrf';

/** How long the minted CSRF value stays good, in seconds. */
const CSRF_TTL_SECONDS = 15 * 60;

/** The only content type a browser form arrives as here. */
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/**
 * Everything the page needs at each of its three stages, raw and unescaped.
 *
 * A custom `render` receives this and owns the whole body, so at `confirm` it
 * must echo `fields` and `csrfToken` back as hidden inputs: the POST is refused
 * without the token, and the API re-reads the link from the field rather than
 * trusting what the GET was once shown.
 *
 * `fields` and `csrfToken` are empty at the other two stages — there is no form
 * left to submit once the link has been spent or found invalid.
 *
 * Every string here goes through {@link escapeHtml} before it reaches the page,
 * `fields.token` above all: it is whatever was in the query of a link somebody
 * was sent.
 */
export interface RevokeAllPageView
{
    /** `confirm` draws the button, `done` reports the sign-out, `invalid` refuses. */
    stage: 'confirm' | 'done' | 'invalid';

    /** ISO instant the link stops working. `confirm` only. */
    expiresAt?: string;

    /** Devices the link would sign out. `confirm` only. */
    activeKeyCount?: number;

    /** Devices the link did sign out. `done` only. */
    revokedCount?: number;

    /** The form's hidden inputs — `token` at `confirm`, empty otherwise. */
    fields: Record<string, string>;

    /** Value the POST's `csrf` field must carry. Empty outside `confirm`. */
    csrfToken: string;
}

/**
 * Options for {@link createRevokeAllPageHandlers}
 */
export interface RevokeAllPageHandlerOptions
{
    /**
     * Replace the default page body
     *
     * Status, headers, the cookie and the field set stay the handler's; this
     * owns the HTML, at all three stages.
     */
    render?: (view: RevokeAllPageView) => string;
}

/** The pair a route file re-exports as `export const { GET, POST } = ...`. */
export interface RevokeAllPageHandlers
{
    GET: (request: NextRequest) => Promise<NextResponse>;
    POST: (request: NextRequest) => Promise<NextResponse>;
}

/** An HTML answer, with the three headers every answer from this page carries. */
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
 * or from the API's error body reaches the page, because in every case that
 * produces this screen both are attacker-supplied.
 */
function refusalScreen(status: number, heading: string, message: string): NextResponse
{
    return screen(status, [
        '<!DOCTYPE html>',
        '<html lang="en"><head><meta charset="utf-8"><title>Sign out everywhere</title></head>',
        `<body><h1>${heading}</h1><p>${message}</p></body></html>`,
    ].join('\n'));
}

function missingTokenScreen(): NextResponse
{
    return refusalScreen(
        400,
        'Incomplete link',
        'This address is missing the part that identifies the request. Open the link from your '
        + 'email again, in full.',
    );
}

function unavailableScreen(): NextResponse
{
    return refusalScreen(
        500,
        'Sign-out unavailable',
        'This link could not be checked. Nothing was changed. Please try again.',
    );
}

function unverifiedScreen(): NextResponse
{
    return refusalScreen(
        403,
        'Request could not be verified',
        'This form did not carry the token the page set for it. Open the link from your email '
        + 'again and press the button on the page it opens.',
    );
}

function unsupportedScreen(): NextResponse
{
    return refusalScreen(
        415,
        'Unsupported request',
        'This page is answered for a browser form. Open the link from your email again.',
    );
}

/** One hidden input per field, values escaped for an attribute. */
function hiddenFields(fields: Record<string, string>, csrfToken: string): string
{
    return [...Object.entries(fields), ['csrf', csrfToken]]
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join('\n        ');
}

/** The confirm stage: what the link would do, and the one button that does it. */
function confirmBody(view: RevokeAllPageView): string
{
    return `<h1>Sign out everywhere</h1>
    <p>This will sign out <strong>${view.activeKeyCount}</strong> signed-in device(s), including
        this one. You will need to sign in again afterwards.</p>
    <p>The link stops working at <time datetime="${escapeHtml(view.expiresAt ?? '')}"
        >${escapeHtml(view.expiresAt ?? '')}</time>.</p>
    <form method="post">
        ${hiddenFields(view.fields, view.csrfToken)}
        <button type="submit">Sign out every device</button>
    </form>`;
}

/** The done stage, and the invalid stage that says nothing about why. */
function stageBody(view: RevokeAllPageView): string
{
    if (view.stage === 'confirm')
    {
        return confirmBody(view);
    }

    if (view.stage === 'done')
    {
        return `<h1>Signed out</h1>
    <p>${view.revokedCount} device(s) signed out. Sign in again to carry on.</p>`;
    }

    return `<h1>Link no longer valid</h1>
    <p>This link cannot be used. Ask for a new one, and open the most recent email you were sent.</p>`;
}

/**
 * The default page, at whichever stage it was reached.
 *
 * Deliberately unstyled: an application that wants its own design system passes
 * `render`, and a page shipping CSS of its own would have to be undone first.
 * The token is in the form and nowhere in the text — the stages say what
 * happened, never which link it happened to.
 */
function defaultRender(view: RevokeAllPageView): string
{
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign out everywhere</title></head>
<body>
    ${stageBody(view)}
</body>
</html>`;
}

/** The view every stage but `confirm` is drawn from: no form, so no form fields. */
function stageView(stage: 'done' | 'invalid', revokedCount?: number): RevokeAllPageView
{
    return { stage, revokedCount, fields: {}, csrfToken: '' };
}

/** HTTP status of the refusal — an `ApiError.status`, or an `HttpError.statusCode`. */
function statusOf(thrown: unknown): number
{
    const error = thrown as { status?: unknown; statusCode?: unknown } | null;

    return Number(error?.status ?? error?.statusCode ?? 0);
}

/**
 * Turn an API refusal into the answer it earns.
 *
 * The 404 is every reason a link can fail and is shown as one screen. Anything
 * else is this deployment's problem rather than the visitor's, and is logged as
 * a status and nothing else: the error body was written about a token, and a
 * token belongs in no log.
 */
function answerRefusal(thrown: unknown, render: (view: RevokeAllPageView) => string): NextResponse
{
    if (statusOf(thrown) === 404)
    {
        return screen(404, render(stageView('invalid')));
    }

    logger.error('Revoke-all link could not be answered', { status: statusOf(thrown) });

    return unavailableScreen();
}

/** 32 random bytes as hex — a value only the browser that was served it holds. */
function mintCsrfToken(): string
{
    return Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Scope the minted CSRF cookie to this page and nothing else.
 *
 * The path is the page's own, so the cookie is not sent with any other request
 * the app makes, and `SameSite=Strict` keeps it off requests another site
 * caused. Fifteen minutes is long enough to read the page and shorter than the
 * link itself.
 */
function setCsrfCookie(response: NextResponse, csrfToken: string, path: string): NextResponse
{
    response.cookies.set(CSRF_COOKIE, csrfToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path,
        maxAge: CSRF_TTL_SECONDS,
    });

    return response;
}

/** Expire the cookie once its form has been submitted, so it is good for one POST. */
function clearCsrfCookie(response: NextResponse, path: string): NextResponse
{
    response.cookies.delete({ name: CSRF_COOKIE, path });

    return response;
}

/**
 * Draw the button, having asked the API what pressing it would do.
 *
 * `confirm` is the only call this handler makes, and it changes nothing — the
 * page is safe to prefetch, which a mail scanner will do.
 */
async function renderConfirm(
    request: NextRequest,
    token: string,
    render: (view: RevokeAllPageView) => string,
): Promise<NextResponse>
{
    const described = await authApi.confirmRevokeAllLink.call({ body: { token } });
    const csrfToken = mintCsrfToken();

    const response = screen(200, render({
        stage: 'confirm',
        expiresAt: described.expiresAt,
        activeKeyCount: described.activeKeyCount,
        fields: { token },
        csrfToken,
    }));

    return setCsrfCookie(response, csrfToken, request.nextUrl.pathname);
}

/**
 * The form's own CSRF token, checked before the API is called at all.
 *
 * It belongs here rather than after the call: the token in the form is the whole
 * credential, so a cross-site POST that could reach `consume` would sign an
 * account out on the strength of a link the attacker already read somewhere.
 * They cannot read this cookie, and `matchesCsrfToken` compares in constant time.
 *
 * @returns The refusal, or null when the POST may proceed
 */
async function refuseUnverifiedPost(form: FormData): Promise<NextResponse | null>
{
    const presented = form.get('csrf');
    const expected = (await cookies()).get(CSRF_COOKIE)?.value;

    if (!expected || !matchesCsrfToken(expected, typeof presented === 'string' ? presented : null))
    {
        return unverifiedScreen();
    }

    return null;
}

/** Whether the body is the form this POST reads, which is the only thing it reads. */
function isFormPost(request: NextRequest): boolean
{
    return (request.headers.get('content-type') ?? '').startsWith(FORM_CONTENT_TYPE);
}

/**
 * Press the button.
 *
 * The token comes from the form's hidden field and the count from the answer;
 * every other field the body carried is ignored, because the API is told the one
 * thing it asks for.
 */
async function consume(token: string, render: (view: RevokeAllPageView) => string): Promise<NextResponse>
{
    const { revokedCount } = await authApi.consumeRevokeAllLink.call({ body: { token } });

    return screen(200, render(stageView('done', revokedCount)));
}

/**
 * Create the sign-out-everywhere page's route handlers
 *
 * `GET` draws the page the mailed link opens and `POST` takes the form it
 * submits. Mount both at `SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH` —
 * `/account/revoke-all` unless that variable says otherwise — which is the path
 * `createRevokeAllLink` builds its URL on.
 *
 * There is no session on this page and none is wanted: an owner who no longer
 * trusts the device in front of them is exactly who the link is for. What stands
 * in for the session is the token in the query, and what stands in for a
 * session-derived CSRF token is a random value `GET` sets in a path-scoped
 * cookie and mirrors into the form.
 *
 * Every answer carries `Cache-Control: no-store` and
 * `Content-Security-Policy: frame-ancestors 'none'`: a page whose one button
 * signs out every device is a page worth clickjacking, and a copy of it in a
 * shared cache is a copy of the token.
 *
 * @param options - An optional renderer; the defaults need nothing else
 * @returns `{ GET, POST }`, ready to re-export from a route file
 *
 * @example
 * ```typescript
 * // app/account/revoke-all/route.ts
 * import { createRevokeAllPageHandlers } from '@spfn/auth/nextjs/server';
 *
 * export const { GET, POST } = createRevokeAllPageHandlers();
 * ```
 */
export function createRevokeAllPageHandlers(
    options: RevokeAllPageHandlerOptions = {},
): RevokeAllPageHandlers
{
    const render = options.render ?? defaultRender;

    async function GET(request: NextRequest): Promise<NextResponse>
    {
        const token = request.nextUrl.searchParams.get('token');

        if (!token)
        {
            return missingTokenScreen();
        }

        try
        {
            return await renderConfirm(request, token, render);
        }
        catch (error)
        {
            return answerRefusal(error, render);
        }
    }

    async function POST(request: NextRequest): Promise<NextResponse>
    {
        if (!isFormPost(request))
        {
            return unsupportedScreen();
        }

        const form = await request.formData();
        const refusal = await refuseUnverifiedPost(form);

        if (refusal)
        {
            return refusal;
        }

        const path = request.nextUrl.pathname;
        const token = form.get('token');

        if (typeof token !== 'string' || !token)
        {
            return clearCsrfCookie(missingTokenScreen(), path);
        }

        try
        {
            return clearCsrfCookie(await consume(token, render), path);
        }
        catch (error)
        {
            return clearCsrfCookie(answerRefusal(error, render), path);
        }
    }

    return { GET, POST };
}
