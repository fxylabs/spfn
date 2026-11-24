/**
 * What the OAuth callback page does, without React.
 *
 * `OAuthCallback` renders; this decides. The split exists so every row of the
 * callback's case table runs in node against a stubbed `fetch` — the package's
 * test environment has no DOM.
 *
 * The backend callback lands on the page with one of three shapes: `?error=`,
 * `?userId=&keyId=` for a finished sign-in, or `?mfaChallenge=` when the account
 * has a second factor and this device is new to it (#95). The last one is not a
 * session yet: `oauth/finalize` answers it with a 202, `mfaVerifyInterceptor`
 * seals the pending cookie from that answer and adds the confirm path to it, and
 * the page moves on to that path — the one `createOAuthCallbackHandler` uses.
 *
 * Nothing here writes to a console, and a failure message never carries the
 * challenge: it is the one value on this page that can finish someone's sign-in.
 */

import { CSRF_HEADER, csrfHeaderValue, documentCookieEntries } from '@spfn/core/nextjs';
import { isSafeReturnPath, toSafeReturnPath } from '../../lib/return-path';
import {
    OAUTH_ERROR_MESSAGES,
    callbackQueryReason,
    isOAuthErrorReason,
    oauthErrorCode,
    type OAuthErrorReason,
} from '../../lib/oauth-error-reason';

/** Where the second-factor page lives when nothing says otherwise. */
export const DEFAULT_MFA_CONFIRM_PATH = '/auth/mfa';

/**
 * Where the page goes next, or why it cannot.
 *
 * An error carries `reason` (#126): the backend's code when the query brought
 * one (else the provider's `error` read as `cancelled` or `provider_error`),
 * `expired`, `invalid_state` or `no_cookie` (#129) for the finalize refusals the
 * proxy names, and `failed` for anything else — so an app page can branch on it.
 * `message` is the fixed sentence for that reason, never text off the URL or a
 * server body (#489). `code` is the app's `signIn.admit` refusal code, present
 * only on `sign_in_refused` when the query carried one in its shape.
 */
export type CallbackOutcome =
    | { kind: 'navigate'; to: string; userId?: string }
    | OAuthCallbackError;

/** A failed callback: the reason, its fixed sentence, and the app's refusal code when there is one. */
type OAuthCallbackError = { kind: 'error'; message: string; reason: OAuthErrorReason; code?: string };

type CallbackInput =
    | OAuthCallbackError
    | { kind: 'mfa'; mfaChallenge: string; keyId: string | null; returnUrl: string }
    | { kind: 'session'; userId: string; keyId: string; returnUrl: string };

export interface CallbackOptions
{
    /** Where the RPC proxy is mounted, `/api/rpc` by default. */
    apiBasePath: string;

    /**
     * An override for the confirm page. Without it the page goes where the
     * server's 202 says (`SPFN_AUTH_MFA_CONFIRM_PATH`), then to `/auth/mfa`.
     */
    mfaPath?: string;

    fetch: typeof fetch;
}

/** The error outcome for `reason`: its fixed sentence, and the code when one was carried. */
function callbackError(reason: OAuthErrorReason, code?: string): OAuthCallbackError
{
    return { kind: 'error', message: OAUTH_ERROR_MESSAGES[reason], reason, ...(code === undefined ? {} : { code }) };
}

/**
 * Which of the three shapes the callback query is.
 *
 * `?error=` wins over everything, and a challenge wins over a `userId`/`keyId`
 * pair — the order `createOAuthCallbackHandler` reads them in. The `error`
 * text is read as a provider's code only, never as a message: anyone can put
 * one on this page's URL (#489).
 */
export function readCallbackInput(search: string): CallbackInput
{
    const params = new URLSearchParams(search);
    const error = params.get('error');
    const mfaChallenge = params.get('mfaChallenge');
    const userId = params.get('userId');
    const keyId = params.get('keyId');
    const returnUrl = toSafeReturnPath(params.get('returnUrl'));

    if (error)
    {
        const reason = callbackQueryReason(params.get('reason'), error);

        return callbackError(reason, oauthErrorCode(reason, params.get('code')));
    }

    if (mfaChallenge)
    {
        return { kind: 'mfa', mfaChallenge, keyId, returnUrl };
    }

    if (!userId || !keyId)
    {
        return callbackError('failed');
    }

    return { kind: 'session', userId, keyId, returnUrl };
}

/**
 * A configured page, reduced to its path and query.
 *
 * Resolved against a placeholder origin, so whatever the value holds — a full
 * URL, a protocol-relative `//host` — what comes out stays on this origin. A
 * pathname can still begin with `//` after normalisation (`/.//host`), which a
 * second parse reads as another host, so the result must pass `isSafeReturnPath`
 * or the default confirm page is used. So is a value that names only a host
 * (`/\host`, whose path is `/`): it names no page.
 */
export function toSameOriginPath(value: string): string
{
    const target = new URL(value, 'http://confirm.invalid');
    const path = `${target.pathname}${target.search}`;

    return path !== '/' && isSafeReturnPath(path) ? path : DEFAULT_MFA_CONFIRM_PATH;
}

/**
 * The confirm page URL: `?challenge=` and `?returnUrl=`, the names `mfaRedirect`
 * in `oauth-handlers.ts` uses. Whatever `mfaPath` holds, the challenge stays on
 * this origin.
 */
export function mfaConfirmUrl(mfaPath: string, challenge: string, returnUrl: string): string
{
    const target = new URL(toSameOriginPath(mfaPath), 'http://confirm.invalid');

    target.searchParams.set('challenge', challenge);
    target.searchParams.set('returnUrl', toSafeReturnPath(returnUrl));

    return `${target.pathname}${target.search}`;
}

/**
 * Run the callback: read the query, call `oauthFinalize`, and say where to go.
 *
 * Never throws — a network failure is an error outcome like any other, with a
 * fixed sentence, never the caught error's text.
 */
export async function runOAuthCallback(search: string, options: CallbackOptions): Promise<CallbackOutcome>
{
    const input = readCallbackInput(search);

    if (input.kind === 'error')
    {
        return input;
    }

    try
    {
        return input.kind === 'mfa'
            ? await finishWithChallenge(input, options)
            : await finishWithSession(input, options);
    }
    catch
    {
        // A caught error's text — a fetch failure's, a client library's — is not
        // client-safe; the page gets the fixed sentence (#382)
        return callbackError('failed');
    }
}

async function finishWithSession(
    input: Extract<CallbackInput, { kind: 'session' }>,
    options: CallbackOptions,
): Promise<CallbackOutcome>
{
    const response = await postFinalize(options, { userId: input.userId, keyId: input.keyId, returnUrl: input.returnUrl });

    if (!response.ok)
    {
        return callbackError(await failureReasonOf(response));
    }

    const data = await response.json();

    return { kind: 'navigate', to: toSafeReturnPath(data.returnUrl || input.returnUrl), userId: input.userId };
}

/**
 * Hand the challenge to `oauthFinalize` and go to the confirm page on its 202.
 *
 * Only a 202 moves on: that is the answer the interceptor bakes the pending
 * cookie from, and without the cookie the confirm page could only fail. The
 * page is the `mfaPath` override, else the `mfaPath` the proxy put on the 202
 * from `SPFN_AUTH_MFA_CONFIRM_PATH`, else `/auth/mfa`.
 */
async function finishWithChallenge(
    input: Extract<CallbackInput, { kind: 'mfa' }>,
    options: CallbackOptions,
): Promise<CallbackOutcome>
{
    // The keyId names which in-flight start's pending cookie the proxy bakes
    // the second-factor cookie from (#126).
    const response = await postFinalize(options, {
        mfaChallenge: input.mfaChallenge,
        ...(input.keyId ? { keyId: input.keyId } : {}),
        returnUrl: input.returnUrl,
    });

    if (response.status !== 202)
    {
        return callbackError(await failureReasonOf(response));
    }

    const data = await response.json().catch(() => ({}));

    const mfaPath = options.mfaPath || (typeof data.mfaPath === 'string' && data.mfaPath) || DEFAULT_MFA_CONFIRM_PATH;

    return { kind: 'navigate', to: mfaConfirmUrl(mfaPath, input.mfaChallenge, data.returnUrl || input.returnUrl) };
}

/**
 * Post the callback's answer to `oauthFinalize`.
 *
 * The readable CSRF cookie is mirrored into its header the way the RPC client
 * does for every other call. A browser that is already signed in holds one, and
 * under `SPFN_AUTH_CSRF=enforce` the proxy refuses that session's finalize
 * without it — signing in again, or as another account, would stop at a 403. No
 * cookie, no header: a browser with no session has nothing to check.
 */
async function postFinalize(options: CallbackOptions, body: Record<string, string>): Promise<Response>
{
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const csrf = csrfHeaderValue(documentCookieEntries());

    if (csrf)
    {
        headers[CSRF_HEADER] = csrf;
    }

    return await options.fetch(`${options.apiBasePath}/oauthFinalize`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ body }),
    });
}

/** The reason the proxy named for its refusal (`failed` when none). */
async function failureReasonOf(response: Response): Promise<OAuthErrorReason>
{
    const data = await response.json().catch(() => ({}));

    return isOAuthErrorReason(data.reason) ? data.reason : 'failed';
}
