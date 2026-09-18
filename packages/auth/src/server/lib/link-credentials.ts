/**
 * @spfn/auth - Link Flow Credentials
 *
 * The bearer credentials of the link flows — the emailed link token and the
 * password-setup secret — are minted and hashed the same way, and are minted in
 * more than one place each (the request, for a setup session; the
 * `auth.link-mail` worker, for a link; `createRevokeAllLink`, for the
 * sign-out-everywhere link the app mails itself). One definition rather than a
 * copy per flow, so "never store the secret" is one rule and not four.
 *
 * The URL every one of those links points at is built here too, for the same
 * reason: the rule that a link opens a page in the app and never an API route
 * is one rule.
 */

import crypto from 'crypto';

import { env } from '@spfn/auth/config';

/**
 * Bytes of entropy in a link token or a setup secret.
 *
 * 32 bytes is why neither credential carries an attempt counter the way a
 * six-digit code does: there is nothing to brute force. Rate limits on these
 * flows bound request volume and mail sending, not guessing.
 */
const CREDENTIAL_BYTES = 32;

/**
 * Mint a bearer credential and the value stored for it.
 *
 * The secret is returned once, to be emailed or set as a cookie, and is then
 * unrecoverable — only `hash` reaches the database.
 */
export function mintCredential(): { secret: string; hash: string }
{
    const secret = crypto.randomBytes(CREDENTIAL_BYTES).toString('base64url');

    return { secret, hash: hashCredential(secret) };
}

/**
 * Hash a presented credential the same way it was stored.
 *
 * SHA-256 without a salt or a work factor, deliberately: the input is 32 random
 * bytes rather than a human-chosen secret, so there is no dictionary to slow
 * down, and lookup has to be a plain equality match on an indexed column.
 */
export function hashCredential(secret: string): string
{
    return crypto.createHash('sha256').update(secret).digest('base64url');
}

/**
 * Absolute URL of an app page a link opens.
 *
 * The page is in the app, not in this package — the token travels in its query
 * string and the page posts it back to the confirm route. This package answers
 * JSON and serves no HTML, so there is nowhere else for the link to point.
 *
 * @param path - Page path within the app, from the flow's `*_CONFIRM_PATH`
 * @param token - The plaintext credential, encoded into the query string
 */
export function buildConfirmUrl(path: string, token: string): string
{
    const appUrl = (env.NEXT_PUBLIC_SPFN_APP_URL || env.SPFN_APP_URL || '').replace(/\/$/, '');

    return `${appUrl}${path}?token=${encodeURIComponent(token)}`;
}
