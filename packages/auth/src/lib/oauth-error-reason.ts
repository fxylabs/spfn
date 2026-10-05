/**
 * @spfn/auth - OAuth error reason codes (#126)
 *
 * Every redirect to the OAuth error page carries `reason=<code>` beside the
 * free-text `error`, so an app page can branch on a closed set of values instead
 * of matching prose that a provider or a library wrote.
 *
 * The module imports nothing: the `OAuthCallback` page flow reads the same codes
 * in the client bundle.
 */

/** Every reason the OAuth error redirect can carry. */
export const OAUTH_ERROR_REASONS = [
    'cancelled',
    'expired',
    'invalid_state',
    'provider_error',
    'account_unavailable',
    'failed',
] as const;

/**
 * Why an OAuth sign-in failed.
 *
 * - `cancelled` — the person declined at the provider (`error=access_denied`)
 * - `expired` — the sign-in took longer than ten minutes
 * - `invalid_state` — the sign-in cannot be confirmed as started in this browser
 * - `provider_error` — the provider reported an error or could not be reached
 * - `account_unavailable` — the account is disabled, pending deletion, or gone
 * - `failed` — anything else
 */
export type OAuthErrorReason = typeof OAUTH_ERROR_REASONS[number];

/** Whether a value read off a URL or a body is one of the codes. */
export function isOAuthErrorReason(value: unknown): value is OAuthErrorReason
{
    return typeof value === 'string' && (OAUTH_ERROR_REASONS as readonly string[]).includes(value);
}

/** The reason for a provider's own `error=` parameter (RFC 6749 §4.1.2.1). */
export function providerErrorReason(error: string): OAuthErrorReason
{
    return error === 'access_denied' ? 'cancelled' : 'provider_error';
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
 * Put `reason` on an error URL: into its `{reason}` placeholder when it has one,
 * otherwise as a query parameter, through the URL API so an existing query and a
 * fragment stay where they are. A relative URL comes back relative.
 */
export function withOAuthErrorReason(url: string, reason: OAuthErrorReason): string
{
    if (url.includes('{reason}'))
    {
        return url.replaceAll('{reason}', reason);
    }

    const parsed = new URL(url, 'http://placeholder.invalid');

    parsed.searchParams.set('reason', reason);

    return /^[a-z][a-z\d+.-]*:/i.test(url) ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
