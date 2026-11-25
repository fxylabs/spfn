/**
 * @spfn/auth - OAuth error reason codes (#126)
 *
 * Every redirect to the OAuth error page carries `reason=<code>`, a closed set
 * of values an app page branches on, and `error`, the fixed sentence for that
 * code (#489). Nothing on the redirect is text a provider, a request or the
 * application wrote: a URL parameter is writable by anyone, so a reader cannot
 * tell the backend's redirect from a forged link, and reads nothing to display
 * from it.
 *
 * The module imports only the refusal code's shape, which imports nothing: the
 * `OAuthCallback` page flow reads the same codes in the client bundle.
 */

import { SIGN_IN_REFUSAL_CODE } from './sign-in-refusal-code';

/** Every reason the OAuth error redirect can carry. */
export const OAUTH_ERROR_REASONS = [
    'cancelled',
    'expired',
    'invalid_state',
    'no_cookie',
    'provider_error',
    'account_unavailable',
    'pending_deletion',
    'email_unverified',
    'link_only',
    'email_in_use',
    'signup_disabled',
    'provider_already_linked',
    'sign_in_contended',
    'sign_in_refused',
    'failed',
] as const;

/**
 * Why an OAuth sign-in failed.
 *
 * - `cancelled` — the person declined at the provider (`error=access_denied`, or
 *   Apple's `user_cancelled_authorize`)
 * - `expired` — the sign-in took longer than ten minutes
 * - `invalid_state` — the sign-in cannot be confirmed as started in this browser
 * - `no_cookie` — the callback found none of the cookies the start set: the
 *   browser keeps no cookies for the site, or the sign-in began in another
 *   browser (#129)
 * - `provider_error` — the provider reported an error or could not be reached
 * - `account_unavailable` — the account is disabled or gone
 * - `pending_deletion` — the account is within its deletion grace period; the
 *   person cancels the deletion (`POST /_auth/deletion/cancel`, the account's
 *   email or phone plus its password or a verification token sent there) to
 *   sign in — an account with neither an email nor a phone (a provider
 *   sign-in that stored no email) has no cancel path yet (gitea#519)
 * - `email_unverified` — a first sign-in with this provider reported the email
 *   of an existing account, and the provider did not verify it; the person
 *   verifies it with the provider, or signs in to that account and links the
 *   provider from settings
 * - `link_only` — the app made this provider link-only (#157): it can be linked
 *   to a signed-in account from settings, never used to sign in
 * - `email_in_use` — a first sign-in with this provider reported the email of
 *   an existing account and the app set `oauthEmailMatch: 'reject'` (#156); the
 *   person can sign in to that account and link the provider from settings
 * - `signup_disabled` — a first sign-in with this provider would have created
 *   an account, and the app turned sign-up off (`channels.signup: false`)
 * - `provider_already_linked` — a first sign-in with this provider matched an
 *   account by email, and that account already holds another identity of the
 *   same provider; an account holds one per provider
 * - `sign_in_contended` — another first sign-in with the same identity attached
 *   it at the same moment, and running this one again did not settle it; signing
 *   in again does
 * - `sign_in_refused` — the app refused this sign-in in its `signIn.admit`
 *   (`createAuthLifecycle({ signIn })`); nothing was written
 * - `failed` — anything else
 */
export type OAuthErrorReason = typeof OAUTH_ERROR_REASONS[number];

/**
 * The fixed sentence for each reason: the redirect's `error`, and the message
 * `OAuthCallback` gives `onError` and `errorComponent` (#489). A page that wants
 * its own copy looks the reason up in its own table instead.
 */
export const OAUTH_ERROR_MESSAGES: Readonly<Record<OAuthErrorReason, string>> = {
    cancelled: 'The sign-in was cancelled at the provider.',
    expired: 'This sign-in took longer than ten minutes. Start it again.',
    invalid_state: 'This sign-in could not be confirmed as started in this browser. Start it again.',
    no_cookie: 'This browser kept none of the cookies this sign-in set. Allow cookies for this site, or start the sign-in again in the browser where it began.',
    provider_error: 'The sign-in provider could not complete the sign-in. Try again.',
    account_unavailable: 'This account cannot sign in.',
    pending_deletion: 'This account is scheduled for deletion. Cancel the deletion to sign in.',
    email_unverified: 'An account with this email already exists, and the provider has not verified the email. Verify it with the provider, or sign in to the account and link this provider from settings.',
    link_only: 'This provider can only be linked to a signed-in account, not used to sign in.',
    email_in_use: 'An account with this email already exists. Sign in to it and link this provider from settings.',
    signup_disabled: 'This application does not create accounts by sign-up.',
    provider_already_linked: 'This account already has an identity from this provider. Unlink it first.',
    sign_in_contended: 'Another sign-in with this identity was in progress. Sign in again.',
    sign_in_refused: 'Sign-in refused.',
    failed: 'OAuth sign-in could not be completed.',
};

/** Whether a value read off a URL or a body is one of the codes. */
export function isOAuthErrorReason(value: unknown): value is OAuthErrorReason
{
    return typeof value === 'string' && (OAUTH_ERROR_REASONS as readonly string[]).includes(value);
}

/**
 * The reason for a provider's own `error=` parameter (RFC 6749 §4.1.2.1).
 * Apple reports a declined sign-in with its own `user_cancelled_authorize`.
 */
export function providerErrorReason(error: string): 'cancelled' | 'provider_error'
{
    return error === 'access_denied' || error === 'user_cancelled_authorize' ? 'cancelled' : 'provider_error';
}

/**
 * The reason for an `?error=` a callback seam received: the backend's own
 * `reason` when it sent a valid one, else the provider's `error` code.
 */
export function callbackQueryReason(reason: string | null, error: string): OAuthErrorReason
{
    return isOAuthErrorReason(reason) ? reason : providerErrorReason(error);
}

/**
 * The application's refusal code for an error redirect: kept only beside
 * `sign_in_refused` and only in the shape `signIn.admit` must answer
 * (`SIGN_IN_REFUSAL_CODE`), `undefined` otherwise (#489).
 *
 * A forged link can put anything in `refusalCode`. A value outside that shape
 * — a sentence, markup, an address — is no code an application issued, so it
 * is dropped rather than passed on: what reaches a page is at most an
 * identifier it looks up in its own table, never text to show.
 */
export function oauthRefusalCode(reason: OAuthErrorReason, refusalCode: unknown): string | undefined
{
    return reason === 'sign_in_refused' && typeof refusalCode === 'string' && SIGN_IN_REFUSAL_CODE.test(refusalCode)
        ? refusalCode
        : undefined;
}

/**
 * Put `reason` on an error URL: into its `{reason}` placeholder when it has one,
 * otherwise appended as `reason=<code>` before any `#fragment`, after `&` when
 * the URL already has a query and `?` when it does not.
 *
 * Textually, never through a URL parser: the URL is the operator's template, and
 * a parse would rewrite it — a protocol-relative `//host/path` lost its host, and
 * `%20` came back as `+`. The code is one of a closed set and needs no encoding.
 */
export function withOAuthErrorReason(url: string, reason: OAuthErrorReason): string
{
    return withTemplateParameter(url, 'reason', reason);
}

/**
 * Put the application's refusal code on an error URL the way `reason` is put
 * (#489): into `{refusalCode}`, else appended as `refusalCode=<code>`. Without
 * one a `{refusalCode}` placeholder is emptied and nothing is appended. The code
 * is held to `SIGN_IN_REFUSAL_CODE` (`oauthRefusalCode`), whose characters need
 * no encoding.
 *
 * Not `code`: the template this package once documented,
 * `/auth/error?error={error}&code={reason}`, gives `code` the reason, and a
 * second `code` would make the refusal code unreachable by `get('code')`.
 */
export function withOAuthRefusalCode(url: string, refusalCode: string | undefined): string
{
    return refusalCode === undefined
        ? url.replaceAll('{refusalCode}', '')
        : withTemplateParameter(url, 'refusalCode', refusalCode);
}

/** `value` into the template's `{name}`, else appended as `name=value` before any fragment. */
function withTemplateParameter(url: string, name: string, value: string): string
{
    if (url.includes(`{${name}}`))
    {
        return url.replaceAll(`{${name}}`, value);
    }

    const hashAt = url.indexOf('#');
    const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
    const separator = beforeHash.includes('?') ? '&' : '?';

    return `${beforeHash}${separator}${name}=${value}${hashAt === -1 ? '' : url.slice(hashAt)}`;
}
