/**
 * @spfn/auth - Link Flow Credentials
 *
 * The bearer credentials of the two link flows — the emailed link token and the
 * password-setup secret — are minted and hashed the same way, and are now minted
 * in two places each (the request, for a setup session; the `auth.link-mail`
 * worker, for a link). One definition rather than a copy per flow, so "never
 * store the secret" is one rule and not four.
 */

import crypto from 'crypto';

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
