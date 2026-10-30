/**
 * @spfn/auth - OAuth link outcome codes (#154)
 *
 * A link started from a session (`POST /_auth/oauth/:provider/link`) sends the
 * browser back to the page it started on, with `oauthLink=<code>` and
 * `provider=<id>` on the query, so that page can say what happened without a
 * second request. A link whose state cannot be opened — expired, tampered, or
 * finished in another browser — does not know that page, and goes to the OAuth
 * error URL with an `OAuthErrorReason` instead.
 *
 * The module imports nothing: an app page reads the same codes in the client
 * bundle.
 */

/** Every value `oauthLink` can carry. */
export const OAUTH_LINK_OUTCOMES = [
    'linked',
    'cancelled',
    'linked_elsewhere',
    'provider_already_linked',
    'account_unavailable',
    'provider_error',
    'failed',
] as const;

/**
 * How a link ended.
 *
 * - `linked` — the identity is on this account (also when it already was)
 * - `cancelled` — the person declined at the provider
 * - `linked_elsewhere` — the identity belongs to another account; neither changed
 * - `provider_already_linked` — this account already holds another identity of
 *   the provider; unlink it first
 * - `account_unavailable` — the account is disabled, pending deletion, or gone
 * - `provider_error` — the provider reported an error or could not be reached
 * - `failed` — anything else
 */
export type OAuthLinkOutcome = typeof OAUTH_LINK_OUTCOMES[number];

/** Whether a value read off a URL is one of the codes. */
export function isOAuthLinkOutcome(value: unknown): value is OAuthLinkOutcome
{
    return typeof value === 'string' && (OAUTH_LINK_OUTCOMES as readonly string[]).includes(value);
}
