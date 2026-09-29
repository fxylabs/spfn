/**
 * Public key formats.
 *
 * A verifier is often a plain script inside a container that holds one
 * environment variable, so the wire format is a string a human can paste:
 *
 *     public-keys := entry ("," entry)*
 *     entry       := kid ":" base64url(key)
 *     kid         := [A-Za-z0-9._-]{1,128}
 *     key         := 32 raw bytes            — Ed25519 public key   (EdDSA)
 *                  | 65 bytes, 0x04 || X || Y — SEC1 uncompressed P-256 point (ES256)
 *                  | SPKI DER                 — either algorithm
 *
 * A compressed 33-byte point is refused: it is indistinguishable from a
 * mistyped Ed25519 key by length alone, and `node:crypto` will not import a
 * bare point anyway. Wrap it in SPKI DER if you have one.
 */

import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url } from './jws';
import type { PublicKeyEntry, PublicKeySource, SigningAlgorithm, VerifyKeyEntry } from './types';

/** A `kid` travels in a JWS header and in the entry format, so it takes no `:`. */
const KID = /^[A-Za-z0-9._-]{1,128}$/;

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

const ED25519_RAW_BYTES = 32;
const P256_COORDINATE_BYTES = 32;
const P256_POINT_BYTES = 65;

/** Whether `kid` is one this package will accept, without saying what it is. */
export function isKid(kid: string): boolean
{
    return KID.test(kid);
}

/** Throw unless `kid` is one this package will accept. */
export function assertKid(kid: string): string
{
    if (!isKid(kid))
    {
        throw new Error(
            `Invalid kid ${JSON.stringify(kid)}: expected 1-128 characters from [A-Za-z0-9._-] `
            + '(no ":" — it separates the kid from the key — and no whitespace)',
        );
    }

    return kid;
}

/** The signing algorithm a public or private key implements. */
export function algorithmOf(key: KeyObject): SigningAlgorithm
{
    if (key.asymmetricKeyType === 'ed25519')
    {
        return 'EdDSA';
    }

    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1')
    {
        return 'ES256';
    }

    throw new Error(
        `Unsupported key type ${key.asymmetricKeyType ?? 'unknown'}: `
        + 'this package signs ES256 (P-256) and EdDSA (Ed25519) only',
    );
}

function publicKeyFromBytes(bytes: Buffer): KeyObject
{
    if (bytes.length === ED25519_RAW_BYTES)
    {
        return createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
            format: 'der',
            type: 'spki',
        });
    }

    if (bytes.length === P256_POINT_BYTES && bytes[0] === 0x04)
    {
        return createPublicKey({
            key: Buffer.concat([P256_SPKI_PREFIX, bytes]),
            format: 'der',
            type: 'spki',
        });
    }

    if (bytes[0] === 0x30)
    {
        return createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    }

    throw new Error(
        `Unrecognised public key of ${bytes.length} bytes: expected 32 (Ed25519), `
        + '65 (SEC1 uncompressed P-256) or SPKI DER',
    );
}

/**
 * One JWK coordinate, as the fixed-width bytes RFC 7518 §6.2.1.2 requires.
 *
 * `Buffer.concat` would pad a short coordinate on the *right*, turning a
 * 31-byte `x` into a silently wrong key rather than an error. `node:crypto`
 * pads correctly, so this only ever fires on a JWK from somewhere else — which
 * is exactly when a wrong key would be hardest to trace, and exactly why the
 * decoding is the canonical one rather than `Buffer.from`: a foreign `x` whose
 * last character carries bits no byte uses is still the wrong 32 bytes.
 */
function coordinate(value: string | undefined, name: string, width: number): Buffer
{
    const bytes = value === undefined ? Buffer.alloc(0) : decodeBase64Url(value);

    if (!bytes)
    {
        throw new Error(`Malformed JWK: coordinate ${name} is not canonical base64url`);
    }

    if (bytes.length !== width)
    {
        throw new Error(
            `Malformed JWK: coordinate ${name} is ${bytes.length} bytes, expected ${width}`,
        );
    }

    return bytes;
}

/** The raw bytes `formatPublicKeyEntry()` writes for a key. */
export function rawPublicKey(key: KeyObject): Buffer
{
    const jwk = key.export({ format: 'jwk' });

    if (algorithmOf(key) === 'EdDSA')
    {
        return coordinate(jwk.x, 'x', ED25519_RAW_BYTES);
    }

    return Buffer.concat([
        Buffer.from([0x04]),
        coordinate(jwk.x, 'x', P256_COORDINATE_BYTES),
        coordinate(jwk.y, 'y', P256_COORDINATE_BYTES),
    ], P256_POINT_BYTES);
}

/**
 * A key's JWK, exactly as `node:crypto` exports it.
 *
 * `kid` and `alg` are deliberately absent: this is the key, and a JWK Set
 * is where the addressing belongs. See `toJwks()`.
 */
export function publicKeyToJwk(key: KeyObject): JsonWebKey
{
    return key.export({ format: 'jwk' });
}

/** A JWK Set — every key with its `kid` and `alg`, ready to publish. */
export function toJwks(entries: Iterable<VerifyKeyEntry>): { keys: JsonWebKey[] }
{
    const keys = [...entries].map((entry) => ({
        ...publicKeyToJwk(entry.public),
        kid: entry.kid,
        alg: entry.alg,
        use: 'sig',
    }));

    return { keys };
}

/** Parse one `kid:base64url(key)` entry. Throws — this is trusted config. */
export function parsePublicKeyEntry(text: string): PublicKeyEntry
{
    // The kid is everything before the *last* colon, so a kid that wrongly
    // contains one is reported as a bad kid rather than as a bad key.
    const separator = text.lastIndexOf(':');

    if (separator < 0)
    {
        throw new Error('Invalid public key entry: expected "kid:base64url(key)"');
    }

    const kid = assertKid(text.slice(0, separator));
    const bytes = decodeBase64Url(text.slice(separator + 1));

    if (!bytes)
    {
        throw new Error(
            `Invalid public key for kid ${kid}: the key is not canonical unpadded base64url`,
        );
    }

    const key = publicKeyFromBytes(bytes);

    return { kid, alg: algorithmOf(key), public: key };
}

/** Format one entry back into `kid:base64url(key)`. */
export function formatPublicKeyEntry(entry: PublicKeyEntry): string
{
    return `${assertKid(entry.kid)}:${encodeBase64Url(rawPublicKey(entry.public))}`;
}

/** Parse a comma-separated list of entries into a map keyed by `kid`. */
export function parsePublicKeys(text: string): Map<string, PublicKeyEntry>
{
    const keys = new Map<string, PublicKeyEntry>();

    for (const part of text.split(','))
    {
        const trimmed = part.trim();
        if (trimmed.length === 0)
        {
            continue;
        }

        const entry = parsePublicKeyEntry(trimmed);

        if (keys.has(entry.kid))
        {
            throw new Error(`Duplicate kid ${entry.kid} in the public key list`);
        }

        keys.set(entry.kid, entry);
    }

    if (keys.size === 0)
    {
        throw new Error('No public keys given');
    }

    return keys;
}

/** Format entries into the comma-separated list `parsePublicKeys()` reads. */
export function formatPublicKeys(entries: Iterable<PublicKeyEntry>): string
{
    return [...entries].map(formatPublicKeyEntry).join(',');
}

/** Normalise whatever a caller passed as keys into a map keyed by `kid`. */
export function toPublicKeyMap(source: PublicKeySource): ReadonlyMap<string, PublicKeyEntry>
{
    if (typeof source === 'string')
    {
        return parsePublicKeys(source);
    }

    if (source instanceof Map)
    {
        return source;
    }

    const entries = Symbol.iterator in source
        ? source as readonly PublicKeyEntry[]
        : [source as PublicKeyEntry];

    return new Map(entries.map((entry) => [entry.kid, entry]));
}
