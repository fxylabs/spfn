/**
 * @spfn/auth - Time-based One-Time Passwords (RFC 6238)
 *
 * The second factor an authenticator app produces: HMAC-SHA1 over a 30-second
 * counter, truncated to six digits, accepted one step either side of now.
 *
 * Implemented here rather than taken from a dependency because it is forty lines
 * of standard library and the alternative is a transitive package on the path
 * every sign-in walks. The numbers are pinned to RFC 4226 Appendix D in
 * `src/__tests__/unit/totp.test.ts`, so the implementation is held to the
 * published vectors rather than to itself.
 *
 * A secret is 20 bytes, handed to the user as RFC 4648 base32 — upper case and
 * unpadded, which is what every authenticator app's scanner and manual-entry
 * field expect. Nothing here logs a secret or a code.
 */

import crypto from 'node:crypto';

/** RFC 4648 base32 alphabet. Upper case, and `=` padding is never emitted. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Seconds per counter step. RFC 6238's default, and what every app assumes. */
export const TOTP_STEP_SECONDS = 30;

/** Digits in a code. Six, which is what the apps show. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of now are accepted.
 *
 * One step is ±30 seconds, which covers an unsynchronised phone clock and the
 * seconds a person spends typing. Two would double the guessing surface for no
 * case anybody actually hits.
 */
export const TOTP_DRIFT_STEPS = 1;

/** Bytes of secret. RFC 4226 asks for at least 16; 20 is the SHA-1 block half. */
const SECRET_BYTES = 20;

/**
 * Encode bytes as RFC 4648 base32, upper case and unpadded.
 *
 * Unpadded on purpose: the padding is what authenticator apps most often choke
 * on when a secret is typed in by hand, and it carries no information.
 */
export function encodeBase32(bytes: Buffer): string
{
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of bytes)
    {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5)
        {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    return bits > 0 ? output + BASE32_ALPHABET[(value << (5 - bits)) & 31] : output;
}

/**
 * Decode RFC 4648 base32 back to bytes.
 *
 * Case-insensitive and padding-tolerant, because the value may have made a
 * round trip through a person. A character outside the alphabet is refused —
 * it is a typo in a secret, not something to guess at.
 *
 * @throws Error when the text is not base32
 */
export function decodeBase32(text: string): Buffer
{
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];

    for (const character of text.replace(/=+$/, '').toUpperCase())
    {
        const index = BASE32_ALPHABET.indexOf(character);

        if (index < 0)
        {
            throw new Error('Value is not RFC 4648 base32');
        }

        value = (value << 5) | index;
        bits += 5;

        if (bits >= 8)
        {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }

    return Buffer.from(bytes);
}

/** Mint a fresh 20-byte secret, in the base32 form the user is shown. */
export function generateTotpSecret(): string
{
    return encodeBase32(crypto.randomBytes(SECRET_BYTES));
}

/**
 * What a submitted code looks like once the user's formatting is removed.
 *
 * Authenticator apps display `123 456`, people paste `123-456`, and a browser
 * autofill sometimes adds a trailing space. All three are the same code, so the
 * refusal must not depend on which one arrived.
 */
export function normalizeTotpCode(input: string): string
{
    return input.replace(/[\s-]/g, '');
}

/** The counter step a moment falls in. */
export function totpStep(atMillis: number): number
{
    return Math.floor(atMillis / 1000 / TOTP_STEP_SECONDS);
}

/**
 * RFC 4226 HOTP: the six digits for one counter value.
 *
 * @param secret - Shared secret, as bytes
 * @param counter - Step number, used as the 8-byte big-endian message
 */
export function hotp(secret: Buffer, counter: number): string
{
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));

    const digest = crypto.createHmac('sha1', secret).update(message).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = digest.readUInt32BE(offset) & 0x7fffffff;

    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export interface VerifyTotpParams
{
    /** The shared secret, base32 as it was handed to the user. */
    secret: string;
    /** Whatever the user submitted, before normalisation. */
    code: string;
    /** Moment to judge against. Defaults to now; tests pin it. */
    atMillis?: number;
    /**
     * The newest step this account has already spent, if any.
     *
     * Per account rather than per device, which is what makes a code single-use:
     * a code read off the screen and replayed within its 30 seconds is refused.
     * The cost is that two devices signing in inside one step see the second
     * refused — the client retries on the next step.
     */
    lastUsedStep?: number | null;
}

/**
 * Check a submitted code, and say which step it was.
 *
 * @returns the step the code belongs to, or null if no accepted step matches
 */
export function verifyTotp(params: VerifyTotpParams): number | null
{
    const code = normalizeTotpCode(params.code);

    if (code.length !== TOTP_DIGITS)
    {
        return null;
    }

    const secret = decodeBase32(params.secret);
    const current = totpStep(params.atMillis ?? Date.now());

    for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset += 1)
    {
        const step = current + offset;
        // A negative step exists only for a clock inside the first 30 seconds of
        // 1970, and `hotp` has no counter to write for it.
        const spent = step < 0 || (params.lastUsedStep != null && step <= params.lastUsedStep);

        if (!spent && crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code)))
        {
            return step;
        }
    }

    return null;
}

export interface OtpauthUriParams
{
    /** Name of the deployment, shown as the account's folder in the app. */
    issuer: string;
    /** How the user recognises this account — their email, usually. */
    accountName: string;
    /** The base32 secret. */
    secret: string;
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * Both the label and the `issuer` parameter carry the issuer, which is what the
 * apps expect: the label is what old scanners read and the parameter is what
 * current ones prefer.
 */
export function buildOtpauthUri(params: OtpauthUriParams): string
{
    const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.accountName)}`;
    const query = new URLSearchParams({
        secret: params.secret,
        issuer: params.issuer,
        algorithm: 'SHA1',
        digits: String(TOTP_DIGITS),
        period: String(TOTP_STEP_SECONDS),
    });

    return `otpauth://totp/${label}?${query.toString()}`;
}
