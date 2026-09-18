/**
 * @spfn/auth - TOTP Secret At-Rest Encryption
 *
 * A TOTP secret is a standing credential: anyone holding it can produce this
 * account's second factor forever. It is therefore encrypted at rest with the
 * same rotating keyring the OAuth tokens use (`SPFN_AUTH_TOKEN_ENCRYPTION_KEYS`)
 * and written in the same `enc:v2:<keyId>:<payload>` frame, so one keyring and
 * one rotation drill cover everything this package stores encrypted.
 *
 * What is purpose-scoped is the AES-GCM additional data: `spfn-auth-mfa-totp:v1`
 * and the owner's user id. A ciphertext copied into another account's row — or
 * into an OAuth token column — does not decrypt, so a database write nobody
 * audited cannot move a second factor between people.
 *
 * Two refusals that must never look alike. A wrong code is a 401 the user can
 * fix by looking at their phone; an unset variable or a key id dropped from the
 * keyring is `MfaConfigError`, a 500 an operator has to fix. Answering the
 * second as the first would tell every enrolled user their authenticator broke.
 *
 * Never log a secret, a key, or a ciphertext.
 */

import crypto from 'node:crypto';

import { MfaConfigError } from '@spfn/auth/errors';

import { getEncryptionKeyring, V2_PREFIX, type TokenEncryptionKey } from './oauth/token-cipher';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Domain tag of the additional authenticated data. Bumped if the shape changes. */
const AAD_DOMAIN = 'spfn-auth-mfa-totp:v1';

/** A decrypted secret, and whether the row it came from is on a retired key. */
export interface DecryptedMfaSecret
{
    value: string;
    /** True when the row was written with a grace key; the caller re-encrypts. */
    needsRotation: boolean;
}

/**
 * Bind the ciphertext to its owner.
 *
 * The user id and nothing else: a TOTP row is one per account and never moves,
 * so the account is the whole context, and anything else in here would be a
 * value a legitimate update could change out from under a readable row.
 */
function getAad(userId: number): Buffer
{
    return Buffer.from([AAD_DOMAIN, String(userId)].join('\0'), 'utf8');
}

/**
 * The keyring, or the configuration error that says it is missing.
 *
 * @throws MfaConfigError when `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` is unset
 */
function requireKeyring(): TokenEncryptionKey[]
{
    const keys = getEncryptionKeyring();

    if (keys.length === 0)
    {
        throw new MfaConfigError({
            message: 'Second-factor enrolment needs SPFN_AUTH_TOKEN_ENCRYPTION_KEYS. '
                + 'Set it in .env.server — it is required even for an app with no social login.',
        });
    }

    return keys;
}

/**
 * Encrypt a TOTP secret for one account, with the keyring's active key.
 *
 * @param secret - The base32 secret as the user was shown it
 * @param userId - Owner of the row this ciphertext will be written to
 * @throws MfaConfigError when the keyring is not configured
 */
export function encryptMfaSecret(secret: string, userId: number): string
{
    const activeKey = requireKeyring()[0];
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', activeKey.key, iv);
    cipher.setAAD(getAad(userId));

    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');

    return `${V2_PREFIX}${activeKey.keyId}:${payload}`;
}

/** Split `enc:v2:<keyId>:<payload>` into its two halves. */
function unframe(value: string): { keyId: string; payload: string }
{
    const remainder = value.startsWith(V2_PREFIX) ? value.slice(V2_PREFIX.length) : '';
    const separator = remainder.indexOf(':');

    if (separator <= 0 || separator === remainder.length - 1)
    {
        throw new MfaConfigError({ message: 'Stored second-factor secret is not in the expected format.' });
    }

    return { keyId: remainder.slice(0, separator), payload: remainder.slice(separator + 1) };
}

/**
 * Decrypt a stored TOTP secret for the account it was written for.
 *
 * `needsRotation` is true when the row was sealed with a grace key rather than
 * the active one; the caller re-encrypts the row in place on that read, so a
 * retired key drains as enrolled users sign in instead of on a migration.
 *
 * @param stored - The `secret_enc` column value
 * @param userId - Owner of the row; a mismatch fails the AEAD rather than decrypting
 * @throws MfaConfigError when the keyring cannot open the row
 */
export function decryptMfaSecret(stored: string, userId: number): DecryptedMfaSecret
{
    const { keyId, payload } = unframe(stored);
    const keys = requireKeyring();
    const selected = keys.find(key => key.keyId === keyId);

    if (!selected)
    {
        throw new MfaConfigError({
            message: 'A stored second-factor secret names a key id that is no longer in '
                + 'SPFN_AUTH_TOKEN_ENCRYPTION_KEYS. Restore the retired key; every enrolled '
                + 'user is locked out of their authenticator until you do.',
        });
    }

    return {
        value: openAesGcm(payload, selected.key, getAad(userId)),
        needsRotation: selected.keyId !== keys[0].keyId,
    };
}

/**
 * Open one `iv | tag | ciphertext` payload.
 *
 * A failure here is the AEAD refusing — a tampered row, or one whose owner is
 * not the account asking. It stays an exception rather than a null: nothing
 * downstream has a sensible answer for "the secret is unreadable".
 */
function openAesGcm(payload: string, key: Buffer, aad: Buffer): string
{
    const packed = Buffer.from(payload, 'base64url');

    if (packed.length <= IV_BYTES + TAG_BYTES)
    {
        throw new MfaConfigError({ message: 'Stored second-factor secret is malformed.' });
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.subarray(0, IV_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

    return Buffer.concat([
        decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
    ]).toString('utf8');
}
