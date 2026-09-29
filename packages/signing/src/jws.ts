/**
 * JWS compact serialization (RFC 7515) — the only token shape this package
 * produces or accepts.
 *
 * `header.payload.signature`, each segment base64url with no padding. The
 * signature covers the exact `header.payload` bytes that arrived on the wire;
 * nothing here re-serializes JSON before checking it.
 */

import type {
    JwsPayload,
    ProviderName,
    PublicKeyEntry,
    RawSigner,
    SignOptions,
    Signer,
    SigningAlgorithm,
} from './types';

/**
 * base64url, strictly: the RFC 4648 §5 alphabet, no padding.
 *
 * `Buffer.from(text, 'base64url')` accepts padding, `+`, `/` and outright
 * junk by silently skipping what it cannot read, so two different strings
 * decode to the same bytes and a token can be mutated without invalidating
 * it. Everything is matched against this before it reaches Buffer.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The four characters RFC 8259 §2 allows between JSON tokens. */
const WHITESPACE = /[ \t\n\r]/;

/** A parsed header, before its `alg` has been checked against a key. */
export interface ParsedHeader
{
    alg: string;
    kid: string;
    typ?: string;
    cty?: string;
    [member: string]: unknown;
}

/** A token split into its parts, with the bytes the signature covers. */
export interface ParsedJws
{
    header: ParsedHeader;
    payload: JwsPayload;
    signature: Buffer;
    /** The exact `header.payload` ASCII bytes received. */
    signingInput: Buffer;
}

export function encodeBase64Url(data: Buffer | string): string
{
    return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
        .toString('base64url');
}

/**
 * Decode one canonical base64url segment, or `null` if it is not one.
 *
 * The alphabet check is not enough on its own. The final character of a
 * segment carries bits that no whole byte uses, and `Buffer` ignores them, so
 * sixteen different strings decode to the same 64-byte signature and four to
 * the same 32-byte key. Re-encoding and comparing is what makes the encoding
 * one-to-one — and a token that can be rewritten without invalidating it is
 * not a token you can key a one-time-use set on.
 */
export function decodeBase64Url(text: string): Buffer | null
{
    // A base64 group is 2, 3 or 4 characters; a remainder of 1 encodes nothing.
    if (!BASE64URL.test(text) || text.length % 4 === 1)
    {
        return null;
    }

    const bytes = Buffer.from(text, 'base64url');

    return encodeBase64Url(bytes) === text ? bytes : null;
}

/** The index just past the closing quote of the string literal at `start`. */
function endOfString(json: string, start: number): number
{
    let index = start + 1;

    while (json[index] !== '"')
    {
        index += json[index] === '\\' ? 2 : 1;
    }

    return index + 1;
}

/** Whether the string that ended at `index` is a member name and not a value. */
function isMemberName(json: string, index: number): boolean
{
    while (WHITESPACE.test(json[index]))
    {
        index += 1;
    }

    return json[index] === ':';
}

/** Add one member name; `false` if the object already had it. */
function addName(names: Set<string>, literal: string): boolean
{
    const name = JSON.parse(literal) as string;

    if (names.has(name))
    {
        return false;
    }

    names.add(name);

    return true;
}

/**
 * Whether `json` has an object with two members of the same name, at any depth.
 *
 * RFC 8259 §4 leaves duplicate members undefined, and `JSON.parse` silently
 * keeps the last one — so `{"alg":"EdDSA","alg":"none"}` is one header to this
 * package and another to anything else that reads the same bytes. There is no
 * right answer to pick, so the token is `malformed`.
 *
 * The scan walks the text because the parsed value has already thrown the
 * evidence away, and it only has to be right about strings: everything else is
 * a delimiter, and a `"a":1,"a":2` *inside* a string is data, not two members.
 * Names are compared after unescaping, so `"a"` and `"\u0061"` are the same
 * member — they are the same string, and a parser that disagreed would be the
 * disagreement this exists to prevent.
 *
 * `json` must already have parsed: the scan trusts the brackets and the quotes.
 */
function hasDuplicateMember(json: string): boolean
{
    // One entry per open container: the names seen so far, or `null` for an
    // array, which has no names to collide.
    const open: (Set<string> | null)[] = [];
    let index = 0;

    while (index < json.length)
    {
        const character = json[index];

        if (character === '{' || character === '[')
        {
            open.push(character === '{' ? new Set() : null);
            index += 1;
        }
        else if (character === '}' || character === ']')
        {
            open.pop();
            index += 1;
        }
        else if (character === '"')
        {
            const end = endOfString(json, index);
            const names = open[open.length - 1];

            if (names && isMemberName(json, end) && !addName(names, json.slice(index, end)))
            {
                return true;
            }

            index = end;
        }
        else
        {
            index += 1;
        }
    }

    return false;
}

function decodeJsonObject(segment: string): Record<string, unknown> | null
{
    const bytes = decodeBase64Url(segment);

    return bytes && parseJsonObject(bytes.toString('utf8'));
}

/**
 * Parse JSON text that must be one object with no duplicate member at any
 * depth, or return `null`.
 *
 * The rule tokens are held to, offered to anything else read off the wire —
 * a JWK Set with two `n` members is two keys to two readers.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null
{
    let value: unknown;

    try
    {
        value = JSON.parse(text);
    }
    catch
    {
        return null;
    }

    const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);

    return isObject && !hasDuplicateMember(text) ? value as Record<string, unknown> : null;
}

/** Header members RFC 7515 defines as media types, and so as strings. */
const MEDIA_TYPE_MEMBERS = ['typ', 'cty'];

function readHeader(segment: string): ParsedHeader | null
{
    const header = decodeJsonObject(segment);

    if (!header || typeof header.alg !== 'string' || typeof header.kid !== 'string')
    {
        return null;
    }

    // `crit` names extensions a verifier must understand. This one understands
    // none, so RFC 7515 §4.1.11 says it must reject the token rather than guess.
    if ('crit' in header)
    {
        return null;
    }

    // `typ` and `cty` are media types (RFC 7515 §4.1.9-10), so a present one is
    // a string or it is nothing. Letting `typ: {}` through hands every caller
    // that compares `header.typ` a value its own type says it cannot be.
    if (MEDIA_TYPE_MEMBERS.some((member) => member in header && typeof header[member] !== 'string'))
    {
        return null;
    }

    return header as ParsedHeader;
}

/**
 * Split a compact token into header, payload, signature and signing input.
 *
 * Returns `null` for anything that is not a well-formed JWS. Never throws:
 * the input is untrusted, and the caller has not authenticated it yet — a
 * successful parse says nothing about whether the token is genuine.
 */
export function parseCompact(token: unknown): ParsedJws | null
{
    if (typeof token !== 'string')
    {
        return null;
    }

    const segments = token.split('.');
    if (segments.length !== 3)
    {
        return null;
    }

    const [headerSegment, payloadSegment, signatureSegment] = segments;
    const header = readHeader(headerSegment);
    const payload = header && decodeJsonObject(payloadSegment);
    const signature = payload && decodeBase64Url(signatureSegment);

    if (!header || !payload || !signature || signature.length === 0)
    {
        return null;
    }

    return {
        header,
        payload,
        signature,
        signingInput: Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii'),
    };
}

/**
 * Header members this package's own verifier refuses.
 *
 * Emitting one produces a token that is `malformed` the moment anyone checks
 * it, which is a bug worth finding at the signer rather than at the verifier.
 */
const REJECTED_HEADER_MEMBERS = ['crit'];

function protectedHeader(signer: RawSigner, options: SignOptions | undefined): Record<string, unknown>
{
    const header: Record<string, unknown> = { ...options?.header };
    const refused = REJECTED_HEADER_MEMBERS.filter((member) => member in header);

    if (refused.length > 0)
    {
        throw new Error(
            `signCompact: the protected header may not carry ${refused.join(', ')} — `
            + 'this package implements no extensions, so its verifier rejects such a token '
            + '(RFC 7515 §4.1.11)',
        );
    }

    // The key decides the algorithm and names itself; a caller cannot dispute it.
    header.alg = signer.alg;
    header.kid = signer.kid;

    if (options?.typ !== undefined)
    {
        header.typ = options.typ;
    }

    return header;
}

/**
 * Serialize and sign `payload` as a compact JWS.
 *
 * Shared by every provider — a provider only supplies `signRaw()`.
 */
export async function signCompact(
    signer: RawSigner,
    payload: JwsPayload,
    options?: SignOptions,
): Promise<string>
{
    const head = encodeBase64Url(JSON.stringify(protectedHeader(signer, options)));
    const body = encodeBase64Url(JSON.stringify(payload));
    const signature = await signer.signRaw(Buffer.from(`${head}.${body}`, 'ascii'));

    return `${head}.${body}.${encodeBase64Url(signature)}`;
}

/** Coordinate size of the JOSE signature for each algorithm, in bytes. */
const JOSE_SIGNATURE_BYTES: Record<SigningAlgorithm, number> = {
    ES256: 64,
    EdDSA: 64,
};

/** Every complaint names where the scan stopped, so a bad byte can be found. */
function derError(problem: string, offset: number): Error
{
    return new Error(`Malformed ECDSA DER signature at offset ${offset}: ${problem}`);
}

/**
 * Read one DER length byte.
 *
 * Short form only. A P-256 signature is at most 72 bytes, every length in it
 * fits in seven bits, and DER requires the shortest encoding anyway — so a
 * long-form length is a second spelling of a number that already had one, and
 * a second spelling is a second signature for the same token.
 */
function readDerLength(der: Buffer, offset: number, what: string): number
{
    const length = der[offset];

    if (length === undefined || length > 0x7f)
    {
        throw derError(`${what} length is missing or not in DER short form`, offset);
    }

    return length;
}

/**
 * Read one DER INTEGER and return its magnitude — the bytes JOSE wants.
 *
 * DER integers are signed and minimally encoded, and both rules matter here:
 * a coordinate with a high top bit carries one leading `0x00` sign byte, and
 * exactly one. Anything else — a redundant `0x00`, a negative value, a
 * magnitude wider than the curve — is a re-encoding of a signature that
 * already had a canonical form, and accepting it makes one signature into
 * many. The one-time-use set downstream is keyed on the token, so a signature
 * that can be rewritten is a token that can be replayed.
 */
function readDerInteger(der: Buffer, offset: number, width: number): { value: Buffer; next: number }
{
    if (der[offset] !== 0x02)
    {
        throw derError('expected an INTEGER', offset);
    }

    const length = readDerLength(der, offset + 1, 'INTEGER');
    const next = offset + 2 + length;

    if (length === 0 || next > der.length)
    {
        throw derError(`INTEGER of ${length} bytes does not fit the signature`, offset + 1);
    }

    const value = der.subarray(offset + 2, next);

    if (value[0] & 0x80)
    {
        throw derError('INTEGER is negative', offset + 2);
    }

    if (value.length > 1 && value[0] === 0x00 && !(value[1] & 0x80))
    {
        throw derError('INTEGER has a redundant leading 0x00', offset + 2);
    }

    const magnitude = value.length > 1 && value[0] === 0x00 ? value.subarray(1) : value;

    if (magnitude.length > width)
    {
        throw derError(
            `coordinate too large: ${magnitude.length} bytes for a ${width}-byte curve`,
            offset + 2,
        );
    }

    return { value: magnitude, next };
}

/** A coordinate left-padded to the curve's width, as JOSE requires. */
function toFixedWidth(value: Buffer, width: number): Buffer
{
    return Buffer.concat([Buffer.alloc(width - value.length), value], width);
}

/**
 * Convert an ECDSA signature from DER (`SEQUENCE { r INTEGER, s INTEGER }`)
 * to the JOSE fixed-width `r || s`.
 *
 * KMS backends return DER; JOSE forbids it. The parse is strict rather than
 * tolerant — the lengths must account for every byte, and no byte may follow
 * the SEQUENCE — because this converter is the last place a KMS response is
 * still bytes. What it lets through becomes the signature on a token, and a
 * signature with more than one spelling is one this package cannot promise to
 * have seen only once.
 */
export function derSignatureToJose(der: Buffer, coordinateBytes = 32): Buffer
{
    if (der[0] !== 0x30)
    {
        throw derError('expected a SEQUENCE', 0);
    }

    const length = readDerLength(der, 1, 'SEQUENCE');

    if (der.length !== 2 + length)
    {
        throw derError(`SEQUENCE declares ${length} bytes and ${der.length - 2} follow`, 1);
    }

    const r = readDerInteger(der, 2, coordinateBytes);
    const s = readDerInteger(der, r.next, coordinateBytes);

    if (s.next !== der.length)
    {
        throw derError('trailing bytes after the second INTEGER', s.next);
    }

    return Buffer.concat(
        [toFixedWidth(r.value, coordinateBytes), toFixedWidth(s.value, coordinateBytes)],
        coordinateBytes * 2,
    );
}

/** The JOSE signature length an algorithm must produce. */
export function joseSignatureBytes(alg: SigningAlgorithm): number
{
    return JOSE_SIGNATURE_BYTES[alg];
}

/**
 * Check an Ed25519 signature and return it unchanged.
 *
 * PureEdDSA already produces JOSE's form — 64 raw bytes, `R || S` — so there
 * is nothing to convert and only the length is in doubt. `who` prefixes the
 * error so the backend that returned the wrong number of bytes is named.
 */
export function joseEdDsaSignature(signature: Buffer, who: string): Buffer
{
    const expected = joseSignatureBytes('EdDSA');

    if (signature.length !== expected)
    {
        throw new Error(
            `${who}: expected a ${expected}-byte Ed25519 signature, got ${signature.length}`,
        );
    }

    return signature;
}

export interface TimeClaimOptions
{
    /** Seconds until `exp`. Omit to issue a token with no expiry. */
    ttlSec?: number;
    /** Seconds until `nbf`. Omit to leave the token valid immediately. */
    notBeforeSec?: number;
    /** Epoch milliseconds to compute the claims from. Default: now. */
    now?: number;
}

/**
 * The `iat` / `exp` / `nbf` claims for a token issued now.
 *
 * Offered, not imposed: the payload is the caller's, and nothing in this
 * package requires these claims to be present.
 */
export function timeClaims(options: TimeClaimOptions = {}): { iat: number; exp?: number; nbf?: number }
{
    const iat = Math.floor((options.now ?? Date.now()) / 1000);
    const claims: { iat: number; exp?: number; nbf?: number } = { iat };

    if (options.ttlSec !== undefined)
    {
        claims.exp = iat + options.ttlSec;
    }

    if (options.notBeforeSec !== undefined)
    {
        claims.nbf = iat + options.notBeforeSec;
    }

    return claims;
}

/** `payload` with the time claims merged in; the payload's own claims win. */
export function withTimeClaims(payload: JwsPayload, options: TimeClaimOptions = {}): JwsPayload
{
    return { ...timeClaims(options), ...payload };
}

/**
 * The half of a signer that is the same everywhere.
 *
 * A provider supplies a `kid`, an algorithm and `signRaw()`; the compact
 * serialization, the protected header and the JOSE encoding are shared.
 */
export abstract class CompactSigner implements Signer, RawSigner
{
    abstract readonly kid: string;

    abstract readonly alg: SigningAlgorithm;

    abstract readonly provider: ProviderName;

    abstract signRaw(input: Buffer): Promise<Buffer>;

    abstract publicKey(): Promise<PublicKeyEntry>;

    sign(payload: JwsPayload, options?: SignOptions): Promise<string>
    {
        return signCompact(this, payload, options);
    }
}
