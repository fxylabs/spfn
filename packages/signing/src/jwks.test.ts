import { constants, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseJwks, rsaPublicKeyEntry } from './jwks';
import { encodeBase64Url } from './jws';
import { formatPublicKeyEntry, parsePublicKeys, toJwks } from './keys';
import { equivalentFinalCharacters, testKey } from './test-support';
import type { RsaPublicKeyEntry, VerifyKeyEntry } from './types';
import { verifyJws } from './verify';

/** One RSA key for the whole file: 2048-bit generation is the slow part. */
const RSA = generateKeyPairSync('rsa', { modulusLength: 2048 });

const RSA_ENTRY = rsaPublicKeyEntry('issuer-rsa', RSA.publicKey);

const NOW = 1_800_000_000_000;

const CLAIMS = { sub: 'user', iat: NOW / 1000 - 10, exp: NOW / 1000 + 300 };

function rsaSign(input: Buffer, padding: number = constants.RSA_PKCS1_PADDING): Buffer
{
    return sign('sha256', input, { key: RSA.privateKey, padding });
}

/** A token over `header` and `payload`, signed by `signature(input)`. */
function token(
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    signature: (input: Buffer) => Buffer,
): string
{
    const input = `${encodeBase64Url(JSON.stringify(header))}.`
        + encodeBase64Url(JSON.stringify(payload));

    return `${input}.${encodeBase64Url(signature(Buffer.from(input, 'ascii')))}`;
}

function rsaToken(payload: Record<string, unknown> = CLAIMS): string
{
    return token({ alg: 'RS256', kid: RSA_ENTRY.kid }, payload, (input) => rsaSign(input));
}

/** The JWK of the file's RSA key, as an issuer would publish it. */
function rsaJwk(over: Record<string, unknown> = {}): Record<string, unknown>
{
    return { ...toJwks([RSA_ENTRY]).keys[0], ...over };
}

/** A zero-led RS256 signature and its payload: about one in 256, so search. */
function zeroLedToken(): { payload: Record<string, unknown>; signature: Buffer; head: string }
{
    for (let attempt = 0; ; attempt += 1)
    {
        const payload = { ...CLAIMS, jti: attempt };
        const head = `${encodeBase64Url(JSON.stringify({ alg: 'RS256', kid: RSA_ENTRY.kid }))}.`
            + encodeBase64Url(JSON.stringify(payload));
        const signature = rsaSign(Buffer.from(head, 'ascii'));

        if (signature[0] === 0)
        {
            return { payload, signature, head };
        }
    }
}

describe('RS256 verification', () =>
{
    it('S1: an RSA key verifies an RS256 token, from an entry, a Map or a JWK Set', () =>
    {
        const jwks = { keys: [rsaJwk()] };

        expect(verifyJws(rsaToken(), [RSA_ENTRY], { now: NOW }))
            .toMatchObject({ ok: true, header: { alg: 'RS256' } });
        expect(verifyJws(rsaToken(), parseJwks(jwks).keys, { now: NOW }).ok).toBe(true);
        expect(verifyJws(rsaToken(), jwks, { now: NOW }).ok).toBe(true);
    });

    it('S2: the key decides — RS256, HS256, none against an Ed25519 key, EdDSA against RSA', async () =>
    {
        const { entry } = await testKey('ed', 'EdDSA');
        const keys = [entry, RSA_ENTRY];

        for (const alg of ['RS256', 'HS256', 'none'])
        {
            const forged = token({ alg, kid: 'ed' }, CLAIMS, (input) => rsaSign(input));

            expect(verifyJws(forged, keys, { now: NOW }), alg)
                .toEqual({ ok: false, reason: 'alg-mismatch' });
        }

        const edDsaOverRsa = token(
            { alg: 'EdDSA', kid: RSA_ENTRY.kid },
            CLAIMS,
            () => Buffer.alloc(64, 1),
        );

        expect(verifyJws(edDsaOverRsa, keys))
            .toEqual({ ok: false, reason: 'alg-mismatch' });
    });

    it('S3: a signature shorter or longer than the modulus is refused, never padded or trimmed', () =>
    {
        const { signature, head } = zeroLedToken();
        const verdict = (bytes: Buffer): unknown =>
            verifyJws(`${head}.${encodeBase64Url(bytes)}`, [RSA_ENTRY], { now: NOW });

        expect(verdict(signature)).toMatchObject({ ok: true });
        expect(verdict(signature.subarray(1))).toEqual({ ok: false, reason: 'bad-signature' });
        expect(verdict(Buffer.concat([Buffer.alloc(1), signature])))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('S4: PKCS#1 v1.5 only — a PSS signature is not RS256', () =>
    {
        const pss = token(
            { alg: 'RS256', kid: RSA_ENTRY.kid },
            CLAIMS,
            (input) => rsaSign(input, constants.RSA_PKCS1_PSS_PADDING),
        );

        expect(verifyJws(pss, [RSA_ENTRY], { now: NOW }))
            .toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('S5: the kid:key string still refuses an RSA key', () =>
    {
        const spki = RSA.publicKey.export({ format: 'der', type: 'spki' });

        expect(() => parsePublicKeys(`issuer-rsa:${encodeBase64Url(spki)}`))
            .toThrow(/ES256 \(P-256\) and EdDSA/);
        expect(() => formatPublicKeyEntry(RSA_ENTRY as never)).toThrow();
    });

    it('S6: a hand-built entry is held to the RSA rules, and cannot relabel any key', () =>
    {
        const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
        const pss = generateKeyPairSync('rsa-pss', { modulusLength: 2048 }).publicKey;
        const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey;
        const secp256k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey;
        const ed25519 = generateKeyPairSync('ed25519').publicKey;
        const mislabelled: [VerifyKeyEntry['alg'], KeyObject, RegExp][] = [
            ['EdDSA', RSA.publicKey, /RS256 key is labelled EdDSA/],
            ['ES256', RSA.publicKey, /RS256 key is labelled ES256/],
            ['ES256', pss, /Unsupported key type rsa-pss/],
            ['EdDSA', pss, /Unsupported key type rsa-pss/],
            ['ES256', p384, /Unsupported key type ec/],
            ['ES256', secp256k1, /Unsupported key type ec/],
            ['ES256', ed25519, /EdDSA key is labelled ES256/],
            ['RS256', ed25519, /EdDSA key is labelled RS256/],
        ];

        expect(() => verifyJws(rsaToken(), [{ kid: 'weak', alg: 'RS256', public: weak }]))
            .toThrow(/1024 bits/);

        for (const [alg, key, error] of mislabelled)
        {
            const entry = { kid: 'x', alg, public: key } as VerifyKeyEntry;

            expect(() => verifyJws(rsaToken(), [entry]), `${alg} ${key.asymmetricKeyType}`).toThrow(error);
            expect(() => verifyJws(rsaToken(), new Map([['x', entry]]))).toThrow(error);
        }
    });

    it('S10: an entry without a string kid or a KeyObject is a configuration error', () =>
    {
        const parsed = parseJwks(toJwks([RSA_ENTRY]));
        const broken = [
            parsed,
            { kid: 1, alg: 'RS256', public: RSA.publicKey },
            { kid: 'a', alg: 'RS256', public: rsaJwk() },
            { kid: 'a', alg: 'RS256' },
        ];

        for (const source of broken)
        {
            expect(() => verifyJws(rsaToken(), source as never)).toThrow(/parseJwks\(set\)\.keys/);
        }

        expect(verifyJws(rsaToken(), parsed.keys, { now: NOW })).toMatchObject({ ok: true });
    });
});

describe('rsaPublicKeyEntry', () =>
{
    it('S7: accepts 2048-8192 bits with e = 65537, from a KeyObject or a JWK', () =>
    {
        expect(rsaPublicKeyEntry('a', RSA.publicKey)).toMatchObject({ kid: 'a', alg: 'RS256' });
        expect(rsaPublicKeyEntry('b', rsaJwk({ kid: undefined }) as never).public.equals(RSA.publicKey))
            .toBe(true);
    });

    it('S8: refuses a weak, oversized, low-exponent, PSS or private key', () =>
    {
        const oversized = encodeBase64Url(
            Buffer.concat([Buffer.from([0x80]), Buffer.alloc(1024, 0xff)]),
        );
        const lowExponent = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 })
            .publicKey;
        const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
        const pss: KeyObject = generateKeyPairSync('rsa-pss', { modulusLength: 2048 }).publicKey;

        expect(() => rsaPublicKeyEntry('a', weak)).toThrow(/1024 bits/);
        expect(() => rsaPublicKeyEntry('a', { kty: 'RSA', n: oversized, e: 'AQAB' }))
            .toThrow(/8200 bits/);
        expect(() => rsaPublicKeyEntry('a', lowExponent)).toThrow(/exponent/);
        expect(() => rsaPublicKeyEntry('a', pss)).toThrow(/rsa-pss/);
        expect(() => rsaPublicKeyEntry('a', RSA.privateKey)).toThrow(/private/);
        expect(() => rsaPublicKeyEntry('a', RSA.privateKey.export({ format: 'jwk' })))
            .toThrow(/private key material/);
    });

    it('S9: refuses a JWK that is not for RS256 signatures', () =>
    {
        expect(() => rsaPublicKeyEntry('a', rsaJwk({ alg: 'ES256' }) as never)).toThrow(/contradicts/);
        expect(() => rsaPublicKeyEntry('a', rsaJwk({ alg: 'PS256' }) as never))
            .toThrow(/unsupported-alg/);
        expect(() => rsaPublicKeyEntry('a', rsaJwk({ use: 'enc' }) as never)).toThrow(/not-for-signing/);
        expect(() => rsaPublicKeyEntry('a b', RSA.publicKey)).toThrow(/printable ASCII/);
    });
});

describe('parseJwks', () =>
{
    it('W1: round-trips what toJwks publishes, for every algorithm', async () =>
    {
        const entries = [
            (await testKey('ed', 'EdDSA')).entry,
            (await testKey('es', 'ES256')).entry,
            RSA_ENTRY,
        ];
        const parsed = parseJwks(toJwks(entries));

        expect([...parsed.keys.values()].map((entry) => [entry.kid, entry.alg]))
            .toEqual([['ed', 'EdDSA'], ['es', 'ES256'], ['issuer-rsa', 'RS256']]);
        expect(parsed.keys.get('issuer-rsa')!.public.equals(RSA.publicKey)).toBe(true);
        expect(parsed.skipped).toEqual([]);
    });

    it('W2: reads JSON text, and refuses a duplicate member at any depth as a token would be', () =>
    {
        const text = JSON.stringify({ keys: [rsaJwk()] });
        const n = rsaJwk().n as string;

        expect(parseJwks(text).keys.has('issuer-rsa')).toBe(true);
        expect(() => parseJwks(text.replace('"kty":"RSA"', `"n":"${n}","kty":"RSA"`)))
            .toThrow(/duplicate member/);
        expect(() => parseJwks(`{"keys":[],"keys":${JSON.stringify([rsaJwk()])}}`))
            .toThrow(/duplicate member/);
        expect(() => parseJwks('not json')).toThrow(/Invalid JWK Set/);
        expect(() => parseJwks({ keys: 'no' })).toThrow(/Invalid JWK Set/);
    });

    it('W3: refuses non-canonical key material: a respelled or zero-led n, a padded e', () =>
    {
        const n = rsaJwk().n as string;
        const respelled = `${n.slice(0, -1)}${equivalentFinalCharacters(n)[0]}`;

        expect(() => parseJwks({ keys: [rsaJwk({ n: respelled })] })).toThrow(/canonical/);
        expect(() => parseJwks({ keys: [rsaJwk({ n: `AA${n}` })] })).toThrow(/leading zero/);
        expect(() => parseJwks({ keys: [rsaJwk({ e: 'AAEAAQ' })] })).toThrow(/AQAB/);
    });

    it('W4: refuses a curve key off the curve or of the wrong width', async () =>
    {
        const es = toJwks([(await testKey('es', 'ES256')).entry]).keys[0] as Record<string, unknown>;

        expect(() => parseJwks({ keys: [{ ...es, y: es.x }] })).toThrow(/not on the curve/);
        expect(() => parseJwks({ keys: [{ ...es, x: encodeBase64Url(Buffer.alloc(31, 7)) }] }))
            .toThrow(/32 bytes/);
    });

    it('W5: refuses members of the wrong type, a bad kid, and a kid of 129 characters', () =>
    {
        expect(() => parseJwks({ keys: [rsaJwk({ use: 1 })] })).toThrow(/not a string/);
        expect(() => parseJwks({ keys: [rsaJwk({ key_ops: 'verify' })] })).toThrow(/key_ops/);
        expect(() => parseJwks({ keys: [rsaJwk({ kty: undefined })] })).toThrow(/kty is missing/);
        expect(() => parseJwks({ keys: [rsaJwk({ kid: 'has space' })] })).toThrow(/kid/);
        expect(() => parseJwks({ keys: [rsaJwk({ kid: 'k'.repeat(129) })] })).toThrow(/kid/);
        expect(parseJwks({ keys: [rsaJwk({ kid: 'k'.repeat(128) })] }).keys.size).toBe(1);
        expect(() => parseJwks({ keys: [null] })).toThrow(/not a JSON object/);
    });

    it('W6: refuses private material on a known kty, but only skips an unknown kty carrying k', () =>
    {
        const edPrivate = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });

        expect(() => parseJwks({ keys: [{ ...edPrivate, kid: 'ed' }] }))
            .toThrow(/private key material \(d\)/);
        expect(() => parseJwks({ keys: [rsaJwk({ use: 'enc', p: 'AQ' }), rsaJwk({ kid: 'b' })] }))
            .toThrow(/private/);
        expect(parseJwks({ keys: [{ kty: 'oct', k: 'c2VjcmV0' }, rsaJwk()] }).skipped)
            .toEqual([{ index: 0, reason: 'unknown-kty' }]);
    });

    it('W7: ignores certificate members beside n and e, and refuses a certificate alone', () =>
    {
        const x5t = encodeBase64Url(Buffer.alloc(20));

        expect(parseJwks({ keys: [rsaJwk({ x5t, x5c: ['MIIB'] })] }).keys.has('issuer-rsa')).toBe(true);
        expect(() => parseJwks({ keys: [{ kty: 'RSA', kid: 'cert', x5t, x5c: ['MIIB'] }] }))
            .toThrow(/n is missing/);
    });

    it('W8: a kty named like an Object.prototype member is just an unknown kty', () =>
    {
        expect(parseJwks({ keys: [{ kty: 'constructor', kid: 'x' }, rsaJwk()] }).skipped)
            .toEqual([{ index: 0, kid: 'x', reason: 'unknown-kty' }]);
    });

    it('W9: a key skipped for its use does not collide with a read key of the same kid', () =>
    {
        const parsed = parseJwks({ keys: [rsaJwk({ use: 'enc' }), rsaJwk()] });

        expect((parsed.keys.get('issuer-rsa') as RsaPublicKeyEntry).alg).toBe('RS256');
        expect(parsed.skipped).toEqual([{ index: 0, kid: 'issuer-rsa', reason: 'not-for-signing' }]);
    });

    it('W10: refuses a set of more than 64 keys or 64 KiB of text', () =>
    {
        const keys = (count: number): Record<string, unknown>[] => Array.from(
            { length: count },
            (_, index) => rsaJwk({ kid: `k${index}` }),
        );
        const padded = (bytes: number): string =>
        {
            const text = JSON.stringify({ keys: [rsaJwk()], pad: '' });

            return text.replace('"pad":""', `"pad":"${'x'.repeat(bytes - text.length)}"`);
        };

        expect(parseJwks({ keys: keys(64) }).keys.size).toBe(64);
        expect(() => parseJwks({ keys: keys(65) })).toThrow(/more than 64 keys/);
        expect(() => parseJwks(JSON.stringify({ keys: keys(65) }))).toThrow(/more than 64 keys/);
        expect(parseJwks(padded(64 * 1024)).keys.size).toBe(1);
        expect(() => parseJwks(padded(64 * 1024 + 1))).toThrow(/65537 bytes of text/);
        expect(() => verifyJws(rsaToken(), { keys: keys(65) } as never)).toThrow(/more than 64 keys/);
    });
});
