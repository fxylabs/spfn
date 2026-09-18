/**
 * TOTP primitive tests.
 *
 * The digits are held to RFC 4226 Appendix D — the published 6-digit HOTP
 * vectors for the 20-byte ASCII seed `12345678901234567890` — rather than to
 * RFC 6238's own table, which is 8 digits across three hash functions and would
 * only ever be reproduced here by its last six characters.
 *
 * Each Appendix D counter is reached through the real clock path: step N is
 * `N * 30` seconds past the epoch, so `verifyTotp` is exercised the way a
 * request exercises it rather than through a private counter argument.
 *
 * No secret or code printed by these tests is a real one.
 */

import { describe, expect, it } from 'vitest';

import {
    TOTP_STEP_SECONDS,
    buildOtpauthUri,
    decodeBase32,
    encodeBase32,
    generateTotpSecret,
    hotp,
    normalizeTotpCode,
    totpStep,
    verifyTotp,
} from '@/server/lib/totp';

/** RFC 4226 Appendix D's seed, the ASCII digits 1..0 twice. */
const SEED = Buffer.from('12345678901234567890', 'utf8');
const SEED_BASE32 = encodeBase32(SEED);

/** RFC 4226 Appendix D, the `HOTP` column: counters 0 through 9. */
const APPENDIX_D = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
];

/** The moment whose step is `counter`. */
function millisForStep(counter: number): number
{
    return counter * TOTP_STEP_SECONDS * 1000;
}

describe('TOTP - RFC 6238 over RFC 4226', () =>
{
    it.each(APPENDIX_D.map((expected, counter) => ({ counter, expected })))(
        'RFC 4226 Appendix D: counter $counter yields the published 6-digit code',
        ({ counter, expected }) =>
        {
            expect(hotp(SEED, counter)).toBe(expected);
        },
    );

    it('verifies each Appendix D code at the moment its step covers', () =>
    {
        for (const [counter, expected] of APPENDIX_D.entries())
        {
            expect(verifyTotp({ secret: SEED_BASE32, code: expected, atMillis: millisForStep(counter) }))
                .toBe(counter);
        }
    });

    it('accepts one step either side and refuses two', () =>
    {
        const now = millisForStep(5);

        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[4], atMillis: now })).toBe(4);
        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[6], atMillis: now })).toBe(6);
        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[3], atMillis: now })).toBeNull();
        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[7], atMillis: now })).toBeNull();
    });

    it('strips the spaces and dashes a person or an autofill adds', () =>
    {
        const now = millisForStep(2);

        expect(normalizeTotpCode(' 359 152 ')).toBe('359152');
        expect(verifyTotp({ secret: SEED_BASE32, code: '359 152', atMillis: now })).toBe(2);
        expect(verifyTotp({ secret: SEED_BASE32, code: '359-152', atMillis: now })).toBe(2);
    });

    it('refuses a step at or below the one already spent', () =>
    {
        const now = millisForStep(5);

        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[5], atMillis: now, lastUsedStep: 5 })).toBeNull();
        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[4], atMillis: now, lastUsedStep: 5 })).toBeNull();
        expect(verifyTotp({ secret: SEED_BASE32, code: APPENDIX_D[6], atMillis: now, lastUsedStep: 5 })).toBe(6);
    });

    it('refuses anything that is not six digits without consulting the secret', () =>
    {
        const now = millisForStep(1);

        expect(verifyTotp({ secret: SEED_BASE32, code: '28708', atMillis: now })).toBeNull();
        expect(verifyTotp({ secret: SEED_BASE32, code: '2870821', atMillis: now })).toBeNull();
        expect(verifyTotp({ secret: SEED_BASE32, code: '', atMillis: now })).toBeNull();
    });

    it('divides time into 30-second steps', () =>
    {
        expect(totpStep(0)).toBe(0);
        expect(totpStep(29_999)).toBe(0);
        expect(totpStep(30_000)).toBe(1);
    });
});

describe('TOTP - base32 and the secret it hands out', () =>
{
    it('encodes RFC 4648 base32 upper-case and unpadded', () =>
    {
        // RFC 4648 section 10's own vectors, with the padding dropped.
        expect(encodeBase32(Buffer.from('f'))).toBe('MY');
        expect(encodeBase32(Buffer.from('fo'))).toBe('MZXQ');
        expect(encodeBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
        expect(encodeBase32(SEED)).not.toMatch(/[=a-z]/);
    });

    it('round-trips bytes, and takes a value back in any case or padding', () =>
    {
        expect(decodeBase32(encodeBase32(SEED))).toEqual(SEED);
        expect(decodeBase32('mzxw6ytboi')).toEqual(Buffer.from('foobar'));
        expect(decodeBase32('MZXW6YTBOI======')).toEqual(Buffer.from('foobar'));
    });

    it('refuses a character outside the alphabet rather than guessing', () =>
    {
        expect(() => decodeBase32('MZXW6YTB01')).toThrow(/base32/);
    });

    it('mints a 32-character secret whose codes verify', () =>
    {
        const secret = generateTotpSecret();

        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(verifyTotp({
            secret,
            code: hotp(decodeBase32(secret), totpStep(millisForStep(9))),
            atMillis: millisForStep(9),
        })).toBe(9);
    });

    it('builds an otpauth URI that names the issuer twice, as the apps expect', () =>
    {
        const uri = new URL(buildOtpauthUri({ issuer: 'Acme Inc', accountName: 'a@b.com', secret: SEED_BASE32 }));

        expect(uri.protocol).toBe('otpauth:');
        expect(uri.host).toBe('totp');
        expect(decodeURIComponent(uri.pathname)).toBe('/Acme Inc:a@b.com');
        expect(uri.searchParams.get('issuer')).toBe('Acme Inc');
        expect(uri.searchParams.get('algorithm')).toBe('SHA1');
        expect(uri.searchParams.get('digits')).toBe('6');
        expect(uri.searchParams.get('period')).toBe('30');
    });
});
