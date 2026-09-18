/**
 * @spfn/auth - Social Token At-Rest Encryption
 *
 * OAuth access/refresh tokens are encrypted with a backend-only rotating keyring.
 * The active key is the first entry in SPFN_AUTH_TOKEN_ENCRYPTION_KEYS; remaining
 * keys are decrypt-only grace keys. Ciphertext is bound to its provider account
 * and token type with AES-GCM additional authenticated data (AAD).
 *
 * v2 format: enc:v2:<keyId>:<base64url(iv | authTag | ciphertext)>
 * v1 format: enc:v1:<base64(iv | authTag | ciphertext)> (legacy session-secret key)
 *
 * Never include token or key material in logs or error messages.
 */

import crypto from 'node:crypto';

import { env } from '../../../config';
import { type SocialProvider } from '../../types';

const V1_PREFIX = 'enc:v1:';

/**
 * Framing prefix of the current at-rest format: `enc:v2:<keyId>:<payload>`.
 *
 * Exported because the MFA secret cipher writes the same frame over the same
 * keyring (`lib/mfa-cipher.ts`) — one format for everything this package
 * encrypts at rest, rather than a second one nobody would remember to rotate.
 */
export const V2_PREFIX = 'enc:v2:';
const ENCRYPTED_PREFIX = 'enc:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type OAuthTokenType = 'access' | 'refresh';

export interface OAuthTokenContext
{
    provider: SocialProvider;
    providerUserId: string;
    tokenType: OAuthTokenType;
}

export interface DecryptedOAuthToken
{
    value: string;
    /** True for plaintext, v1, or ciphertext encrypted with a non-active v2 key. */
    needsRotation: boolean;
}

export interface OAuthTokenCipher
{
    encrypt(value: string, context: OAuthTokenContext): Promise<string>;
    decrypt(value: string, context: OAuthTokenContext): Promise<DecryptedOAuthToken>;
}

export interface TokenEncryptionKey
{
    keyId: string;
    key: Buffer;
}

/**
 * Parse `<keyId>:<base64-encoded 32-byte key>` entries. The first entry is active.
 *
 * Empty when the variable is unset — whether that is a configuration error is
 * the caller's to decide, and the two callers answer it differently: an OAuth
 * token refuses outright, while an MFA secret raises `MfaConfigError` so the
 * refusal cannot be mistaken for a wrong code.
 *
 * @throws Error when an entry is present but malformed
 */
export function getEncryptionKeyring(): TokenEncryptionKey[]
{
    const raw = env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    if (!raw)
    {
        return [];
    }

    const keys: TokenEncryptionKey[] = [];
    const seen = new Set<string>();

    for (const entry of raw.split(','))
    {
        const trimmed = entry.trim();
        const separator = trimmed.indexOf(':');

        if (separator <= 0 || separator === trimmed.length - 1)
        {
            throw new Error('Invalid SPFN_AUTH_TOKEN_ENCRYPTION_KEYS entry; expected <keyId>:<base64-key>');
        }

        const keyId = trimmed.slice(0, separator);
        const encoded = trimmed.slice(separator + 1);

        if (!KEY_ID_PATTERN.test(keyId))
        {
            throw new Error('Invalid token encryption key ID; use 1-64 letters, digits, dot, underscore, or hyphen');
        }

        if (seen.has(keyId))
        {
            throw new Error('Duplicate token encryption key ID');
        }

        // Buffer.from(base64) is permissive, so reject non-canonical input first.
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)
        {
            throw new Error('Invalid token encryption key encoding; expected canonical base64');
        }

        const key = Buffer.from(encoded, 'base64');
        if (key.length !== KEY_BYTES || key.toString('base64') !== encoded)
        {
            throw new Error('Invalid token encryption key length; expected exactly 32 bytes');
        }

        seen.add(keyId);
        keys.push({ keyId, key });
    }

    return keys;
}

function requireTokenKeys(): TokenEncryptionKey[]
{
    const keys = getEncryptionKeyring();
    if (keys.length === 0)
    {
        throw new Error(
            'OAuth token encryption is not configured. Set SPFN_AUTH_TOKEN_ENCRYPTION_KEYS in .env.server.',
        );
    }

    return keys;
}

function getAad(context: OAuthTokenContext): Buffer
{
    return Buffer.from([
        'spfn-auth-social-token:v2',
        context.provider,
        context.providerUserId,
        context.tokenType,
    ].join('\0'), 'utf8');
}

function unpackCiphertext(payload: string, encoding: BufferEncoding): {
    iv: Buffer;
    tag: Buffer;
    ciphertext: Buffer;
}
{
    const packed = Buffer.from(payload, encoding);
    if (packed.length <= IV_BYTES + TAG_BYTES)
    {
        throw new Error('Malformed encrypted token payload');
    }

    return {
        iv: packed.subarray(0, IV_BYTES),
        tag: packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
        ciphertext: packed.subarray(IV_BYTES + TAG_BYTES),
    };
}

function decryptAesGcm(
    payload: string,
    encoding: BufferEncoding,
    key: Buffer,
    aad?: Buffer,
): string
{
    const { iv, tag, ciphertext } = unpackCiphertext(payload, encoding);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad)
    {
        decipher.setAAD(aad);
    }
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Legacy v1 key derivation retained only so existing rows can be upgraded. */
function getLegacyV1Key(): Buffer
{
    return crypto
        .createHash('sha256')
        .update(`social-token:${env.SPFN_AUTH_SESSION_SECRET}`)
        .digest();
}

export class EnvironmentKeyringTokenCipher implements OAuthTokenCipher
{
    async encrypt(value: string, context: OAuthTokenContext): Promise<string>
    {
        const activeKey = requireTokenKeys()[0];
        const iv = crypto.randomBytes(IV_BYTES);
        const cipher = crypto.createCipheriv('aes-256-gcm', activeKey.key, iv);
        cipher.setAAD(getAad(context));

        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        const payload = Buffer.concat([iv, tag, ciphertext]).toString('base64url');

        return `${V2_PREFIX}${activeKey.keyId}:${payload}`;
    }

    async decrypt(value: string, context: OAuthTokenContext): Promise<DecryptedOAuthToken>
    {
        if (value.startsWith(V2_PREFIX))
        {
            const remainder = value.slice(V2_PREFIX.length);
            const separator = remainder.indexOf(':');
            if (separator <= 0 || separator === remainder.length - 1)
            {
                throw new Error('Malformed v2 encrypted token');
            }

            const keyId = remainder.slice(0, separator);
            const payload = remainder.slice(separator + 1);
            const keys = requireTokenKeys();
            const selected = keys.find(key => key.keyId === keyId);
            if (!selected)
            {
                throw new Error('Encrypted token references an unavailable key ID');
            }

            return {
                value: decryptAesGcm(payload, 'base64url', selected.key, getAad(context)),
                needsRotation: selected.keyId !== keys[0].keyId,
            };
        }

        if (value.startsWith(V1_PREFIX))
        {
            return {
                value: decryptAesGcm(value.slice(V1_PREFIX.length), 'base64', getLegacyV1Key()),
                needsRotation: true,
            };
        }

        if (value.startsWith(ENCRYPTED_PREFIX))
        {
            throw new Error('Unsupported encrypted token version');
        }

        return { value, needsRotation: true };
    }
}

let configuredCipher: OAuthTokenCipher = new EnvironmentKeyringTokenCipher();

/** Configure an external/KMS-backed cipher before the auth server starts. */
export function configureOAuthTokenCipher(cipher: OAuthTokenCipher): void
{
    configuredCipher = cipher;
}

export function encryptToken(value: string, context: OAuthTokenContext): Promise<string>
{
    return configuredCipher.encrypt(value, context);
}

export function decryptToken(value: string, context: OAuthTokenContext): Promise<DecryptedOAuthToken>
{
    return configuredCipher.decrypt(value, context);
}

export function isEncrypted(value: string): boolean
{
    return value.startsWith(ENCRYPTED_PREFIX);
}
