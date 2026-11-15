/**
 * @spfn/auth - Password Helpers
 *
 * Password hashing and verification using bcrypt (@node-rs/bcrypt).
 *
 * Uses the native (Rust/napi) implementation, which runs the CPU-bound key
 * derivation on the libuv threadpool instead of the main event loop — so
 * concurrent logins run in parallel and don't head-of-line-block other requests.
 * For very high concurrent-login load, raise UV_THREADPOOL_SIZE toward the core
 * count (default pool is 4).
 *
 * bcrypt reads at most 72 bytes of its input and ignores the rest, and a
 * character can be up to four UTF-8 bytes: a 60-character Korean password used
 * to be decided by its first 24 characters. New hashes are therefore
 * `bcrypt(base64(sha256(password)))` — 44 ASCII bytes whatever the password,
 * no NUL byte — stored behind `PREHASHED_PASSWORD_PREFIX`. A hash without the
 * prefix is a legacy one, `bcrypt(password)` (standard `$2*$`, including the
 * bcryptjs hashes this package once wrote): it still verifies the legacy way,
 * and a successful sign-in replaces it (`isLegacyPasswordHash`) — when the
 * verification proved the whole password (`legacyHashProvesWholePassword`).
 *
 * Security:
 * - Adaptive hashing (configurable rounds, default 12)
 * - Automatic salt generation (per-password)
 * - Constant-time comparison (timing attack protection)
 * - Rainbow table protection
 */

import { createHash } from 'node:crypto';
import * as bcrypt from '@node-rs/bcrypt';
import { env } from '@spfn/auth/config';
import { createPasswordParser } from '@spfn/core/env';

/**
 * What a pre-hashed password hash starts with. Every bcrypt string starts with
 * `$2`, so no legacy hash can carry it.
 */
export const PREHASHED_PASSWORD_PREFIX = '$spfn-sha256$';

/**
 * The one decision about a stored hash's format: legacy `bcrypt(password)`, or
 * the pre-hashed format `hashPassword` writes.
 */
export function isLegacyPasswordHash(hash: string): boolean
{
    return !hash.startsWith(PREHASHED_PASSWORD_PREFIX);
}

/**
 * The longest password a legacy hash proves whole: bcrypt hashes its key plus
 * the key's NUL terminator, cut at 72 bytes. Up to 71 bytes the terminator is
 * inside the cut and fixes the length; at 72 it is cut off, so the hash of any
 * longer password sharing those 72 bytes verifies them.
 */
const LEGACY_WHOLE_PASSWORD_MAX_BYTES = 71;

/**
 * Whether a legacy hash that verified `password` proved all of it: only up to
 * 71 bytes (UTF-8), with bcrypt's NUL terminator still inside its 72-byte cut.
 * A password of 72 bytes or more verified against one proves its first 72
 * bytes — every password sharing them verifies alike — so it must not be
 * re-encoded as the account's password: that would replace the owner's
 * password with whichever variant signed in.
 */
export function legacyHashProvesWholePassword(password: string): boolean
{
    return Buffer.byteLength(password, 'utf8') <= LEGACY_WHOLE_PASSWORD_MAX_BYTES;
}

/**
 * The bcrypt input for a password: base64 of its SHA-256 digest, 44 ASCII bytes
 * for any password, so every character of it counts.
 */
function prehashPassword(password: string): string
{
    return createHash('sha256').update(password, 'utf8').digest('base64');
}

/**
 * Hash a plain text password
 *
 * Algorithm:
 * 1. SHA-256 the UTF-8 password and base64 the digest (44 bytes, under bcrypt's 72)
 * 2. bcrypt that with a random salt (2^rounds iterations)
 * 3. Return `$spfn-sha256$` + `$2b$rounds$[salt][hash]`
 *
 * Salt rounds are configured via SPFN_AUTH_BCRYPT_SALT_ROUNDS (native timings):
 * - 12 rounds: ~200ms (default — OWASP-aligned, off the event loop)
 * - 10 rounds: ~55ms (faster, lower work factor)
 * - 14 rounds: ~800ms (very secure, heavy)
 *
 * @param password - Plain text password to hash
 * @returns Pre-hashed bcrypt hash string (includes salt)
 * @throws Error if password is empty or invalid
 *
 * @example
 * ```typescript
 * const hash = await hashPassword('mySecurePassword123');
 * // Returns: "$spfn-sha256$$2b$12$…"
 * ```
 */
export async function hashPassword(password: string): Promise<string>
{
    if (!password || password.length === 0)
    {
        throw new Error('Password cannot be empty');
    }

    return PREHASHED_PASSWORD_PREFIX + await bcrypt.hash(prehashPassword(password), env.SPFN_AUTH_BCRYPT_SALT_ROUNDS);
}

/**
 * Verify a password against a stored hash of either format
 *
 * Uses constant-time comparison to prevent timing attacks
 * Automatically extracts salt from hash for verification
 *
 * @param password - Plain text password to verify
 * @param hash - Stored hash: from hashPassword, or a legacy bcrypt string
 * @returns True if password matches hash
 * @throws Error if inputs are invalid
 *
 * @example
 * ```typescript
 * const isValid = await verifyPassword(
 *     'mySecurePassword123',
 *     '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
 * );
 * // Returns: true
 * ```
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean>
{
    if (!password || password.length === 0)
    {
        throw new Error('Password cannot be empty');
    }

    if (!hash || hash.length === 0)
    {
        throw new Error('Hash cannot be empty');
    }

    return isLegacyPasswordHash(hash)
        ? bcrypt.verify(password, hash)
        : bcrypt.verify(prehashPassword(password), hash.slice(PREHASHED_PASSWORD_PREFIX.length));
}

/**
 * Dummy bcrypt hash for timing equalization.
 *
 * A credential check for a non-existent account (or one with no passwordHash to
 * compare against) should still spend roughly the same time as a real bcrypt
 * verify — otherwise skipping the hash leaks account existence/state via
 * response timing (user enumeration). Callers verify the supplied password
 * against this dummy hash on the "no real hash to check" branch. Computed once
 * at the configured cost and in the format `hashPassword` writes (matches new
 * users' hashes) and reused.
 *
 * Shared by `loginService` (auth.service.ts) and `cancelAccountDeletionService`
 * (account-deletion.service.ts) — kept here rather than in either service to
 * avoid a circular import between the two (they already import from each other
 * for `getPendingDeletionInfo`).
 */
let dummyHashPromise: Promise<string> | null = null;
export function getDummyPasswordHash(): Promise<string>
{
    if (!dummyHashPromise)
    {
        dummyHashPromise = hashPassword('spfn-nonexistent-account-timing-equalizer');
    }

    return dummyHashPromise;
}

/**
 * Password strength validator (uses core validator internally)
 *
 * Uses @spfn/core/env/validator for consistent validation logic.
 */
const passwordValidator = createPasswordParser({
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
});

/**
 * Validate password strength
 *
 * Requirements:
 * - Minimum 8 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 *
 * @param password - Password to validate
 * @returns Validation result with error messages
 *
 * @example
 * ```typescript
 * const result = validatePasswordStrength('weak');
 * // Returns: { valid: false, errors: ['Too short', 'Missing uppercase', ...] }
 *
 * const result = validatePasswordStrength('SecurePass123!');
 * // Returns: { valid: true, errors: [] }
 * ```
 */
export function validatePasswordStrength(password: string): {
    valid: boolean;
    errors: string[];
}
{
    try
    {
        passwordValidator(password);

        return {
            valid: true,
            errors: [],
        };
    }
    catch (error)
    {
        const message = error instanceof Error ? error.message : String(error);

        // Parse error message from validator
        // Format: "Password validation failed: error1, error2, error3"
        const errorMatch = message.match(/Password validation failed: (.+)/);

        if (errorMatch)
        {
            const errors = errorMatch[1].split(', ').map((err) =>
            {
                // Convert core validator messages to legacy format
                return err
                    .replace(/^Must be at least (\d+) characters$/, 'Password must be at least $1 characters')
                    .replace(/^Must contain at least one uppercase letter$/, 'Password must contain at least one uppercase letter')
                    .replace(/^Must contain at least one lowercase letter$/, 'Password must contain at least one lowercase letter')
                    .replace(/^Must contain at least one number$/, 'Password must contain at least one number')
                    .replace(/^Must contain at least one special character$/, 'Password must contain at least one special character');
            });

            return {
                valid: false,
                errors,
            };
        }

        // Fallback for unexpected error format
        return {
            valid: false,
            errors: [message],
        };
    }
}
