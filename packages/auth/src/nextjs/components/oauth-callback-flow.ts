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
 * seals the pending cookie from that answer, and the page moves on to the confirm
 * path the same way `createOAuthCallbackHandler` does.
 *
 * Nothing here writes to a console, and a failure message never carries the
 * challenge: it is the one value on this page that can finish someone's sign-in.
 */

import { toSafeReturnPath } from '../../lib/return-path';

/** Where the second-factor page lives when nothing says otherwise — the server default. */
export const DEFAULT_MFA_CONFIRM_PATH = '/auth/mfa';

/** The message every failed finalize falls back to. */
const FINALIZE_FAILED = 'Failed to finalize OAuth';

export type CallbackOutcome =
    | { kind: 'navigate'; to: string; userId?: string }
    | { kind: 'error'; message: string };

type CallbackInput =
    | { kind: 'error'; message: string }
    | { kind: 'mfa'; mfaChallenge: string; returnUrl: string }
    | { kind: 'session'; userId: string; keyId: string; returnUrl: string };

export interface CallbackOptions
{
    /** Where the RPC proxy is mounted, `/api/rpc` by default. */
    apiBasePath: string;

    /** The confirm page; must match `SPFN_AUTH_MFA_CONFIRM_PATH` on the server. */
    mfaPath: string;

    fetch: typeof fetch;
}

/**
 * Which of the three shapes the callback query is.
 *
 * `?error=` wins over everything, and a challenge wins over a `userId`/`keyId`
 * pair — the order `createOAuthCallbackHandler` reads them in.
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
        return { kind: 'error', message: error };
    }

    if (mfaChallenge)
    {
        return { kind: 'mfa', mfaChallenge, returnUrl };
    }

    if (!userId || !keyId)
    {
        return { kind: 'error', message: 'Missing required parameters' };
    }

    return { kind: 'session', userId, keyId, returnUrl };
}

/**
 * The confirm page URL: `?challenge=` and `?returnUrl=`, the names `mfaRedirect`
 * in `oauth-handlers.ts` uses.
 *
 * Resolved against a placeholder origin and reduced to path and query, so
 * whatever `mfaPath` holds the challenge stays on this origin.
 */
export function mfaConfirmUrl(mfaPath: string, challenge: string, returnUrl: string): string
{
    const target = new URL(mfaPath, 'http://confirm.invalid');

    target.searchParams.set('challenge', challenge);
    target.searchParams.set('returnUrl', toSafeReturnPath(returnUrl));

    return `${target.pathname}${target.search}`;
}

/**
 * Run the callback: read the query, call `oauthFinalize`, and say where to go.
 *
 * Never throws — a network failure is an error outcome like any other.
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
    catch (error)
    {
        return { kind: 'error', message: error instanceof Error ? error.message : 'OAuth failed' };
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
        return { kind: 'error', message: await failureMessage(response) };
    }

    const data = await response.json();

    return { kind: 'navigate', to: toSafeReturnPath(data.returnUrl || input.returnUrl), userId: input.userId };
}

/**
 * Hand the challenge to `oauthFinalize` and go to the confirm page on its 202.
 *
 * Only a 202 moves on: that is the answer the interceptor bakes the pending
 * cookie from, and without the cookie the confirm page could only fail.
 */
async function finishWithChallenge(
    input: Extract<CallbackInput, { kind: 'mfa' }>,
    options: CallbackOptions,
): Promise<CallbackOutcome>
{
    const response = await postFinalize(options, { mfaChallenge: input.mfaChallenge, returnUrl: input.returnUrl });

    if (response.status !== 202)
    {
        return { kind: 'error', message: withoutSecret(await failureMessage(response), input.mfaChallenge) };
    }

    const data = await response.json().catch(() => ({}));

    return { kind: 'navigate', to: mfaConfirmUrl(options.mfaPath, input.mfaChallenge, data.returnUrl || input.returnUrl) };
}

async function postFinalize(options: CallbackOptions, body: Record<string, string>): Promise<Response>
{
    return await options.fetch(`${options.apiBasePath}/oauthFinalize`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ body }),
    });
}

async function failureMessage(response: Response): Promise<string>
{
    const data = await response.json().catch(() => ({}));

    return typeof data.message === 'string' && data.message ? data.message : FINALIZE_FAILED;
}

/** A server message that echoes the challenge is replaced, not passed on to `onError`. */
function withoutSecret(message: string, secret: string): string
{
    return message.includes(secret) ? FINALIZE_FAILED : message;
}
