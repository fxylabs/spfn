/**
 * TOTP secret at-rest encryption tests.
 *
 * Secrets and key material must never be printed by these tests; the fixtures
 * below are constant buffers with no meaning outside this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MfaConfigError } from '@spfn/auth/errors';
import { decryptMfaSecret, encryptMfaSecret } from '@/server/lib/mfa-cipher';

const ACTIVE_KEY = Buffer.alloc(32, 3).toString('base64');
const GRACE_KEY = Buffer.alloc(32, 4).toString('base64');
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const OWNER = 41;
const STRANGER = 42;

describe('MFA secret cipher - the OAuth keyring, a purpose of its own', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', `active:${ACTIVE_KEY},grace:${GRACE_KEY}`);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('seals under the active key id and restores the value', () =>
    {
        const sealed = encryptMfaSecret(SECRET, OWNER);

        expect(sealed.startsWith('enc:v2:active:')).toBe(true);
        expect(sealed).not.toContain(SECRET);
        expect(decryptMfaSecret(sealed, OWNER)).toEqual({ value: SECRET, needsRotation: false });
    });

    it('opens a row written by a grace key and asks for it to be rewritten', () =>
    {
        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', `grace:${GRACE_KEY}`);
        const sealed = encryptMfaSecret(SECRET, OWNER);

        // The retired key moves behind the new active one, exactly as a rotation
        // leaves it.
        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', `active:${ACTIVE_KEY},grace:${GRACE_KEY}`);

        expect(decryptMfaSecret(sealed, OWNER)).toEqual({ value: SECRET, needsRotation: true });

        const rewritten = encryptMfaSecret(SECRET, OWNER);

        expect(decryptMfaSecret(rewritten, OWNER).needsRotation).toBe(false);
    });

    it('refuses a row moved to another account', () =>
    {
        const sealed = encryptMfaSecret(SECRET, OWNER);

        expect(() => decryptMfaSecret(sealed, STRANGER)).toThrow();
        expect(decryptMfaSecret(sealed, OWNER).value).toBe(SECRET);
    });

    it('answers a key id dropped from the keyring as configuration, not as a wrong code', () =>
    {
        const sealed = encryptMfaSecret(SECRET, OWNER);

        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', `grace:${GRACE_KEY}`);

        expect(() => decryptMfaSecret(sealed, OWNER)).toThrow(MfaConfigError);
    });

    it('answers an unset keyring as configuration, on both directions', () =>
    {
        const sealed = encryptMfaSecret(SECRET, OWNER);

        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', '');

        expect(() => encryptMfaSecret(SECRET, OWNER)).toThrow(MfaConfigError);
        expect(() => decryptMfaSecret(sealed, OWNER)).toThrow(MfaConfigError);
    });

    it('refuses a stored value that is not the v2 frame', () =>
    {
        expect(() => decryptMfaSecret(SECRET, OWNER)).toThrow(MfaConfigError);
        expect(() => decryptMfaSecret('enc:v2:active:', OWNER)).toThrow(MfaConfigError);
        expect(() => decryptMfaSecret('enc:v2:active:AAAA', OWNER)).toThrow(MfaConfigError);
    });

    it('does not open an OAuth-token ciphertext, whatever the keyring says', async () =>
    {
        const { encryptToken } = await import('@/server/lib/oauth/token-cipher');
        const sealed = await encryptToken(SECRET, {
            provider: 'google',
            providerUserId: String(OWNER),
            tokenType: 'access',
        });

        expect(() => decryptMfaSecret(sealed, OWNER)).toThrow();
    });
});
