/**
 * Keys this package did not issue: RSA public keys and JWK Sets (RFC 7517).
 *
 * The `kid:key` string format stays EdDSA and ES256 only — it is the format of
 * keys this package hands out. A key somebody else publishes arrives as a JWK,
 * one at a time through `rsaPublicKeyEntry()` or as a set through
 * `parseJwks()`, and both hold it to the same rules.
 *
 * A key of a kind this package reads that breaks a rule throws. It is
 * configuration, not a token: a verifier that quietly dropped it would turn an
 * issuer's broken — or substituted — key into an `unknown-kid` nobody can
 * trace. A key of a kind it does not read is skipped, as RFC 7517 §5 asks:
 * an issuer adding an encryption key to its set must not stop verification.
 */

import { createPublicKey, KeyObject, type JsonWebKey } from 'node:crypto';
import { decodeBase64Url, parseJsonObject } from './jws';
import { algorithmOf, toPublicKeyMap } from './keys';
import type {
    ParsedJwks,
    PublicKeySource,
    RsaPublicKeyEntry,
    SkippedJwk,
    VerifyAlgorithm,
    VerifyKeyEntry,
    VerifyKeySource,
} from './types';

/**
 * A JWK Set's kid never passes through the `kid:key` separator, so it may be
 * any printable ASCII: 1–128 characters, no whitespace, no control characters.
 */
const JWK_KID = /^[\x21-\x7e]{1,128}$/;

/** RFC 7518 §3.3 sets the floor; the ceiling bounds what one request can cost. */
const RSA_MIN_BITS = 2048;
const RSA_MAX_BITS = 8192;

/** 65537, the one exponent accepted, and its only canonical JWK spelling. */
const RSA_EXPONENT = 65537n;
const RSA_EXPONENT_JWK = 'AQAB';

/** The members that make an RSA, OKP or EC JWK a private key (RFC 7518 §6). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

/** The one curve each elliptic key type is read for; any other is skipped. */
const CURVES = new Map<unknown, { crv: string; coordinates: string[] }>([
    ['OKP', { crv: 'Ed25519', coordinates: ['x'] }],
    ['EC', { crv: 'P-256', coordinates: ['x', 'y'] }],
]);

const VERIFIED_ALGORITHMS: readonly unknown[] = ['EdDSA', 'ES256', 'RS256'];

const COORDINATE_BYTES = 32;

/** Members that are strings when present at all. */
const STRING_MEMBERS = ['kid', 'crv', 'use', 'alg'];

type Jwk = Record<string, unknown>;

function jwkError(where: string, problem: string): Error
{
    return new Error(`Invalid JWK ${where}: ${problem}`);
}

/**
 * Throw unless `key` is an RSA public key this package will verify with:
 * 2048 to 8192 bits, public exponent 65537.
 *
 * `rsa-pss` keys are refused with the rest — PS256 is another algorithm.
 */
export function assertRsaKey(key: KeyObject, where: string): KeyObject
{
    const details = key.asymmetricKeyDetails;
    const bits = details?.modulusLength ?? 0;

    if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa')
    {
        throw jwkError(where, `expected an RSA public key, got ${key.type} ${key.asymmetricKeyType}`);
    }

    if (bits < RSA_MIN_BITS || bits > RSA_MAX_BITS)
    {
        throw jwkError(where, `the modulus is ${bits} bits, outside ${RSA_MIN_BITS}-${RSA_MAX_BITS}`);
    }

    if (details?.publicExponent !== RSA_EXPONENT)
    {
        throw jwkError(where, 'the public exponent is not 65537');
    }

    return key;
}

/** The algorithm a key verifies. The key decides, never the token. */
export function verifyAlgorithmOf(key: KeyObject): VerifyAlgorithm
{
    return key.asymmetricKeyType === 'rsa' ? 'RS256' : algorithmOf(key);
}

/** One base64url member, canonically decoded, or a throw naming it. */
function member(jwk: Jwk, name: string, where: string): Buffer
{
    const value = jwk[name];
    const bytes = typeof value === 'string' ? decodeBase64Url(value) : null;

    if (!bytes)
    {
        throw jwkError(where, `${name} is missing or not canonical base64url`);
    }

    return bytes;
}

/** `createPublicKey`, its complaint turned into `null` for the caller to name. */
function importJwk(jwk: JsonWebKey): KeyObject | null
{
    try
    {
        return createPublicKey({ key: jwk, format: 'jwk' });
    }
    catch
    {
        return null;
    }
}

/**
 * An RSA JWK's key. `n` is unsigned big-endian with no leading zero byte
 * (RFC 7518 §6.3.1.1) and `e` is exactly `AQAB`: one spelling per key.
 */
function rsaKeyFromJwk(jwk: Jwk, where: string): KeyObject
{
    if (member(jwk, 'n', where)[0] === 0 || jwk.e !== RSA_EXPONENT_JWK)
    {
        throw jwkError(where, 'n has a leading zero byte, or e is not AQAB (65537)');
    }

    const key = importJwk({ kty: 'RSA', n: jwk.n as string, e: RSA_EXPONENT_JWK });

    if (!key)
    {
        throw jwkError(where, 'node:crypto cannot import the key');
    }

    return assertRsaKey(key, where);
}

/** An Ed25519 or P-256 JWK's key: fixed-width coordinates, a point on the curve. */
function curveKeyFromJwk(jwk: Jwk, where: string): KeyObject
{
    const imported: JsonWebKey = { kty: jwk.kty as string, crv: jwk.crv as string };

    for (const name of CURVES.get(jwk.kty)?.coordinates ?? [])
    {
        if (member(jwk, name, where).length !== COORDINATE_BYTES)
        {
            throw jwkError(where, `${name} is not ${COORDINATE_BYTES} bytes`);
        }

        imported[name] = jwk[name];
    }

    const key = importJwk(imported);

    if (!key)
    {
        throw jwkError(where, 'the point is not on the curve');
    }

    return key;
}

/** Throw unless the members this package reads have the types RFC 7517 gives them. */
function assertShape(jwk: unknown, where: string): asserts jwk is Jwk
{
    if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk))
    {
        throw jwkError(where, 'not a JSON object');
    }

    const record = jwk as Jwk;
    const wrong = STRING_MEMBERS.filter((name) => name in record && typeof record[name] !== 'string');
    const ops = record.key_ops;

    if (typeof record.kty !== 'string' || wrong.length > 0)
    {
        throw jwkError(where, `kty is missing, or ${wrong.join(', ')} is not a string`);
    }

    if (ops !== undefined && !(Array.isArray(ops) && ops.every((op) => typeof op === 'string')))
    {
        throw jwkError(where, 'key_ops is not an array of strings');
    }
}

/** Why this package does not read `jwk`, or `null` if it does. */
function skipReason(jwk: Jwk): SkippedJwk['reason'] | null
{
    const curve = CURVES.get(jwk.kty);
    const ops = jwk.key_ops as string[] | undefined;

    if (jwk.kty !== 'RSA' && !curve)
    {
        return 'unknown-kty';
    }

    if (curve && jwk.crv !== curve.crv)
    {
        return 'unknown-curve';
    }

    if ((jwk.use !== undefined && jwk.use !== 'sig') || (ops && !ops.includes('verify')))
    {
        return 'not-for-signing';
    }

    return jwk.alg === undefined || VERIFIED_ALGORITHMS.includes(jwk.alg) ? null : 'unsupported-alg';
}

/**
 * Throw if a key of a kind this package reads carries private material.
 *
 * Checked before a key can be skipped for its `use`, curve or `alg`: a set
 * that publishes a private key is not one to take a public key from either.
 * A key of an unknown `kty` is not judged — its members mean nothing here.
 */
function assertPublicOnly(jwk: Jwk, where: string): void
{
    const known = jwk.kty === 'RSA' || CURVES.has(jwk.kty);
    const found = known ? PRIVATE_MEMBERS.filter((name) => name in jwk) : [];

    if (found.length > 0)
    {
        throw jwkError(where, `carries private key material (${found.join(', ')})`);
    }
}

/** Read one JWK of a kind this package verifies with. */
function readJwk(jwk: Jwk, where: string): VerifyKeyEntry
{
    if (typeof jwk.kid !== 'string' || !JWK_KID.test(jwk.kid))
    {
        throw jwkError(where, 'kid is missing, or is not 1-128 printable ASCII characters');
    }

    const key = jwk.kty === 'RSA' ? rsaKeyFromJwk(jwk, where) : curveKeyFromJwk(jwk, where);
    const alg = verifyAlgorithmOf(key);

    // The key decides the algorithm; a JWK whose `alg` disagrees is a set that
    // says two things, and there is no right one to pick.
    if (jwk.alg !== undefined && jwk.alg !== alg)
    {
        throw jwkError(where, `alg ${jwk.alg} contradicts a ${alg} key`);
    }

    return { kid: jwk.kid, alg, public: key } as VerifyKeyEntry;
}

/** The JSON object `set` is, or holds as text with no duplicate member. */
function setObject(set: unknown): Jwk
{
    const object = typeof set === 'string' ? parseJsonObject(set) : set;

    if (typeof object !== 'object' || object === null || !Array.isArray((object as Jwk).keys))
    {
        throw new Error(
            'Invalid JWK Set: expected an object with a "keys" array '
            + '(as text: one JSON object, no duplicate member at any depth)',
        );
    }

    return object as Jwk;
}

/**
 * Read a JWK Set into the keys `verifyJws()` takes.
 *
 * `set` is the parsed object or the JSON text as fetched. Pass the text when
 * you have it: an object has already lost any duplicate member, and a key
 * with two `n` members is two keys to two readers.
 *
 * Skipped, and listed in `skipped`: an unknown `kty` or curve, a `use` other
 * than `sig`, `key_ops` without `verify`, an `alg` this package does not
 * verify. Thrown, refusing the whole set: a broken key of a kind this package
 * reads — private members, a missing or duplicate kid, non-canonical
 * base64url, a weak RSA key, an `alg` the key contradicts — and a set with no
 * usable key left.
 */
export function parseJwks(set: unknown): ParsedJwks
{
    const jwks = setObject(set).keys as unknown[];
    const keys = new Map<string, VerifyKeyEntry>();
    const skipped: SkippedJwk[] = [];

    jwks.forEach((jwk, index) =>
    {
        const where = `at keys[${index}]`;

        assertShape(jwk, where);
        assertPublicOnly(jwk, where);

        const reason = skipReason(jwk);

        if (reason)
        {
            skipped.push(jwk.kid === undefined
                ? { index, reason }
                : { index, kid: jwk.kid as string, reason });

            return;
        }

        const entry = readJwk(jwk, where);

        if (keys.has(entry.kid))
        {
            throw jwkError(where, `duplicate kid ${JSON.stringify(entry.kid)}`);
        }

        keys.set(entry.kid, entry);
    });

    if (keys.size === 0)
    {
        throw new Error(
            `Invalid JWK Set: no key to verify with among ${jwks.length} `
            + `(skipped: ${skipped.map((skip) => skip.reason).join(', ') || 'none'})`,
        );
    }

    return { keys, skipped };
}

/**
 * One RSA public key as a verifier entry, from a `KeyObject` or an RSA JWK.
 *
 * Throws under 2048 bits, over 8192, for an exponent other than 65537, and
 * for a JWK that carries private members or an `alg` other than `RS256`.
 */
export function rsaPublicKeyEntry(kid: string, key: KeyObject | JsonWebKey): RsaPublicKeyEntry
{
    const where = `for kid ${JSON.stringify(kid)}`;

    if (!JWK_KID.test(kid))
    {
        throw jwkError(where, 'the kid is not 1-128 printable ASCII characters');
    }

    if (key instanceof KeyObject)
    {
        return { kid, alg: 'RS256', public: assertRsaKey(key, where) };
    }

    const jwk: unknown = { ...key, kid };

    assertShape(jwk, where);
    assertPublicOnly(jwk, where);

    const reason = jwk.kty === 'RSA' ? skipReason(jwk) : 'unknown-kty';

    if (reason)
    {
        throw jwkError(where, `not an RSA key to verify RS256 with (${reason})`);
    }

    return readJwk(jwk, where) as RsaPublicKeyEntry;
}

function isJwkSet(source: VerifyKeySource): source is { keys: readonly Jwk[] }
{
    return typeof source === 'object' && 'keys' in source && Array.isArray(source.keys);
}

/**
 * Normalise every key source into a map keyed by `kid`.
 *
 * A JWK Set is parsed on every call — parse it once with `parseJwks()` and
 * pass `keys`. An RSA key handed over directly is held to the RSA rules here,
 * and so is an entry that labels an RSA key with another algorithm.
 */
export function toVerifyKeyMap(source: VerifyKeySource): ReadonlyMap<string, VerifyKeyEntry>
{
    if (isJwkSet(source))
    {
        return parseJwks(source).keys;
    }

    const keys = toPublicKeyMap(source as PublicKeySource) as ReadonlyMap<string, VerifyKeyEntry>;

    for (const entry of keys.values())
    {
        const where = `for kid ${JSON.stringify(entry.kid)}`;

        if (entry.alg !== 'RS256' && entry.public?.asymmetricKeyType === 'rsa')
        {
            throw jwkError(where, `an RSA key is labelled ${entry.alg}; it verifies RS256 only`);
        }

        if (entry.alg === 'RS256')
        {
            assertRsaKey(entry.public, where);
        }
    }

    return keys;
}
