/**
 * @spfn/auth - Recovery Codes
 *
 * The ten single-use codes an enrolled account is given once, for the day the
 * authenticator is lost. They are written down by a human, so the format is
 * `xxxxx-xxxxx` — ten base32 characters in two readable halves, about fifty bits.
 *
 * Fifty bits is why these are hashed with the **password hasher** rather than
 * with `hashCredential`. That helper states its own precondition: unsalted
 * SHA-256 is right when the input is 32 random bytes, because there is no
 * dictionary to slow down. A transcribable code is short enough that a leaked
 * dump of unsalted hashes falls to an offline sweep, so it gets the work factor
 * a password gets.
 *
 * The cost of that choice is that a presented code cannot be looked up by its
 * hash: verification walks the account's unused codes of the current generation
 * and compares each. Ten bcrypt verifies is the worst case, on a route that is
 * rate limited, for a credential used once in an account's lifetime.
 */

import crypto from 'node:crypto';

import { encodeBase32 } from './totp';
import { hashPassword, verifyPassword } from '../helpers/password';

/** Characters per half. Two halves of five read back accurately over a phone. */
const HALF_LENGTH = 5;

/** How many codes a generation holds. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Mint one code in its display form.
 *
 * Ten base32 characters need fifty bits, so seven random bytes (fifty-six) are
 * encoded and the surplus dropped — taking a prefix of a uniform encoding keeps
 * every character uniform.
 */
function mintRecoveryCode(): string
{
    const encoded = encodeBase32(crypto.randomBytes(7)).slice(0, HALF_LENGTH * 2);

    return `${encoded.slice(0, HALF_LENGTH)}-${encoded.slice(HALF_LENGTH)}`;
}

/**
 * What a submitted code looks like once the user's formatting is removed.
 *
 * Upper-cased, and spaces and dashes dropped: the dash is display punctuation,
 * and base32 has no lower case. A code is compared in this form, so the same
 * code typed three ways verifies three times.
 */
export function normalizeRecoveryCode(input: string): string
{
    return input.replace(/[\s-]/g, '').toUpperCase();
}

/** One minted code: shown to the user once, stored only as the hash. */
export interface MintedRecoveryCode
{
    /** The `xxxxx-xxxxx` form, for the response body and nowhere else. */
    code: string;
    /** What the row carries. */
    hash: string;
}

/**
 * Mint a generation of codes.
 *
 * The plaintext is in the return value because the response body is the one
 * place it may appear; callers must not log, store, or echo it anywhere else.
 */
export async function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): Promise<MintedRecoveryCode[]>
{
    const codes = Array.from({ length: count }, mintRecoveryCode);

    return await Promise.all(codes.map(async code => ({
        code,
        hash: await hashRecoveryCode(code),
    })));
}

/** Hash a code the way a row stores it. */
export function hashRecoveryCode(code: string): Promise<string>
{
    return hashPassword(normalizeRecoveryCode(code));
}

/**
 * Compare a submitted code against one stored hash.
 *
 * A value that normalises to nothing is answered false rather than handed to
 * the hasher, which refuses an empty input — "you sent punctuation" has to come
 * out as the ordinary refusal, not as a 500.
 */
export function matchesRecoveryCode(submitted: string, hash: string): Promise<boolean>
{
    const normalized = normalizeRecoveryCode(submitted);

    return normalized.length === 0 ? Promise.resolve(false) : verifyPassword(normalized, hash);
}
