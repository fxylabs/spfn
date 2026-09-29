/**
 * @spfn/signing — shared types.
 *
 * Everything else in the package imports from here, and nothing here imports
 * anything else: the module graph stays acyclic and the verify-only entry
 * point keeps its promise of `node:crypto` and nothing more.
 */

import type { KeyObject } from 'node:crypto';

/**
 * The algorithms this package signs and verifies.
 *
 * `EdDSA` (Ed25519) is the default; `ES256` (ECDSA P-256) is the alternative.
 * Every provider signs both — `local`, Cloud KMS and AWS KMS all have an
 * Ed25519 key spec.
 */
export type SigningAlgorithm = 'ES256' | 'EdDSA';

/**
 * The algorithms this package verifies: the two it signs, and `RS256`.
 *
 * RS256 is verify-only. It is here for tokens somebody else signed — an OIDC
 * issuer publishing a JWK Set — and never for tokens this package issues.
 */
export type VerifyAlgorithm = SigningAlgorithm | 'RS256';

/** Names of the key providers `createSigner()` understands. */
export type ProviderName = 'local' | 'gcp-kms' | 'aws-kms';

/**
 * A JWS protected header (RFC 7515 §4).
 *
 * `kid` is required: the key it names decides the algorithm, and `alg` is
 * only ever checked for equality against that decision.
 */
export interface JwsHeader<A extends VerifyAlgorithm = SigningAlgorithm>
{
    alg: A;
    kid: string;
    typ?: string;
    [claim: string]: unknown;
}

/** A JSON payload. Claims are the caller's business; this package adds none. */
export type JwsPayload = Record<string, unknown>;

/** One public key, addressable by `kid`. */
export interface PublicKeyEntry
{
    kid: string;
    alg: SigningAlgorithm;
    /** The key itself, as `node:crypto` sees it. */
    public: KeyObject;
    /** Which provider holds the matching private key, when it is known. */
    provider?: ProviderName;
}

/** Anything `verifyJws()` accepts in place of a prepared key map. */
export type PublicKeySource =
    | string
    | PublicKeyEntry
    | readonly PublicKeyEntry[]
    | ReadonlyMap<string, PublicKeyEntry>;

/**
 * One RSA public key, for verifying RS256.
 *
 * Built by `rsaPublicKeyEntry()` or `parseJwks()`, which hold it to the RSA
 * key rules: 2048 to 8192 bits, public exponent 65537.
 */
export interface RsaPublicKeyEntry
{
    kid: string;
    alg: 'RS256';
    public: KeyObject;
}

/** A key `verifyJws()` can check a signature with. */
export type VerifyKeyEntry = PublicKeyEntry | RsaPublicKeyEntry;

/** A JWK Set (RFC 7517 §5), as an issuer publishes it. */
export interface JwkSet
{
    keys: readonly Record<string, unknown>[];
}

/** Every key source, RSA keys and JWK Sets included. */
export type VerifyKeySource =
    | PublicKeySource
    | VerifyKeyEntry
    | readonly VerifyKeyEntry[]
    | ReadonlyMap<string, VerifyKeyEntry>
    | JwkSet;

/** A JWK that `parseJwks()` passed over, and why. */
export interface SkippedJwk
{
    /** Its position in the set's `keys`. */
    index: number;
    kid?: string;
    reason: 'unknown-kty' | 'unknown-curve' | 'not-for-signing' | 'unsupported-alg';
}

export interface ParsedJwks
{
    keys: ReadonlyMap<string, VerifyKeyEntry>;
    skipped: readonly SkippedJwk[];
}

/**
 * Why a token was rejected.
 *
 * - `malformed` — not three canonical base64url segments, or the header is not
 *   a JWS header with a `kid`, or the payload is not a JSON object. Nothing
 *   about it says it was ever meant to be your token.
 * - `invalid-claims` — the signature is yours and the shape is right, but a
 *   time claim is present and is not a finite number, or `iat` is after
 *   `exp`. This one is your issuer's bug, and it is a separate reason from
 *   `malformed` so that a dashboard can tell "someone else's traffic" from
 *   "we are minting broken tokens".
 * - `unknown-kid` — the header names a key the verifier does not hold.
 * - `alg-mismatch` — the header's `alg` is not the algorithm of that key.
 * - `bad-signature` — the signature does not verify over the received bytes.
 * - `expired` / `not-yet-valid` — `exp` / `nbf`, allowing for clock skew.
 *   Under `maxAgeSec` an `iat` in the future is `not-yet-valid` too.
 * - `too-old` — the token's own lifetime (`exp - iat`) exceeds `maxAgeSec`.
 * - `no-expiry` — `maxAgeSec` was set and the token omits `exp` or `iat`, so
 *   its lifetime cannot be computed and the policy cannot be met. The same
 *   under `issuedWithinSec` for a token without `iat`.
 * - `wrong-audience` / `no-audience` — `audience` was set and no `aud` value
 *   matches it, or the token has no `aud` (or an empty array of them).
 * - `wrong-issuer` / `no-issuer` — `issuer` was set and `iss` is not one of
 *   the issuers given, or the token has no `iss`.
 */
export type VerifyFailureReason =
    | 'malformed'
    | 'invalid-claims'
    | 'unknown-kid'
    | 'alg-mismatch'
    | 'bad-signature'
    | 'expired'
    | 'not-yet-valid'
    | 'too-old'
    | 'no-expiry'
    | 'wrong-audience'
    | 'no-audience'
    | 'wrong-issuer'
    | 'no-issuer';

/**
 * The result of verifying a token. `verifyJws()` never throws instead.
 *
 * `audience` is present exactly when an `audience` option was given: it is
 * the one `aud` value that matched, so a caller never has to search an array
 * `aud` again to find it.
 */
export type VerifyResult<A extends VerifyAlgorithm = SigningAlgorithm> =
    | { ok: true; header: JwsHeader<A>; payload: JwsPayload; audience?: string }
    | { ok: false; reason: VerifyFailureReason };

/**
 * An audience that differs per request: a fixed `prefix`, then a remainder
 * that must match `rest` in full.
 *
 * `rest` must be anchored — its source starts with `^` and ends with `$` —
 * and may not carry the `g`, `y` or `m` flags. It is also evaluated as
 * `^(?:rest)$`, so a top-level alternation cannot slip out of the anchors.
 * The expression itself is yours: a pattern that backtracks catastrophically
 * does so on every request, so keep it a plain character class and a length.
 */
export interface AudiencePrefix
{
    prefix: string;
    rest: RegExp;
}

export interface VerifyOptions
{
    /** Epoch milliseconds to evaluate the time claims against. Default: now. */
    now?: number;
    /** Tolerance applied to `exp` and `nbf`. Default: 30 seconds. */
    clockSkewSec?: number;
    /**
     * Bound how long a token is accepted: at most this many seconds of life,
     * starting no later than now.
     *
     * Three things are required of the token, and each closes a way around
     * the other two: `iat` must not be in the future (`not-yet-valid`, or a
     * forward-dated token carries its own acceptance window with it), `exp`
     * must not precede `iat` (`invalid-claims`), and `exp - iat` must be at
     * most `maxAgeSec` (`too-old`). Both claims are needed to say any of
     * that, so a token without them is `no-expiry` rather than exempt.
     */
    maxAgeSec?: number;
    /**
     * Accept only a token issued within this many seconds of now (plus the
     * skew): `iat` older than that is `too-old`, and a token without `iat`
     * is `no-expiry`. An `iat` further in the future than the skew is
     * `not-yet-valid` — a forward-dated token would otherwise carry its own
     * window with it.
     */
    issuedWithinSec?: number;
    /**
     * Require an `aud` value — `aud` may be a string or an array of strings —
     * equal to this one, one of these, or matching this prefix and remainder.
     */
    audience?: string | readonly string[] | AudiencePrefix;
    /** Require `iss` to be this issuer, or one of these. */
    issuer?: string | readonly string[];
}

/**
 * One kind of token an application issues.
 *
 * A purpose owns its keys — every kid starts with `kidPrefix` and a dash —
 * and its audience, which every token it signs carries and every verifier it
 * builds requires. The two together keep one purpose's tokens out of another
 * purpose's verifier: a foreign kid is `unknown-kid`, and a foreign `aud` is
 * `wrong-audience` even if a key were ever shared.
 */
export interface PurposeSpec
{
    /** Two to eight lowercase letters. A kid of this purpose is `<kidPrefix>-…`. */
    kidPrefix: string;
    /** The `aud` every token of this purpose carries. */
    audience: string;
    /** When set, `aud` is `<audience>:<scope>` and signer and verifier name the scope. */
    scoped?: boolean;
    /** The longest life a token of this purpose may have; the verifier's `maxAgeSec`. */
    maxTtlSec: number;
    /** `typ` for the protected header. Written by the signer; not checked by the verifier. */
    typ?: string;
    /** How many keys the purpose may hold at once. Default: 2 — one rotation in flight. */
    maxKeys?: number;
}

export interface SignOptions
{
    /** `typ` for the protected header. Omitted from the header when unset. */
    typ?: string;
    /** Extra protected header members. `alg` and `kid` may not be overridden. */
    header?: Record<string, unknown>;
}

/**
 * A signer holds one key and turns a payload into a compact JWS.
 *
 * `sign()` is asynchronous on every provider, including `local`: a KMS round
 * trip is a network call, and one interface that changes shape per provider
 * is not one interface.
 */
export interface Signer
{
    readonly kid: string;
    readonly alg: SigningAlgorithm;
    readonly provider: ProviderName;

    /** Sign `payload` and return the compact serialization. */
    sign(payload: JwsPayload, options?: SignOptions): Promise<string>;

    /** The public half, for handing to a verifier. */
    publicKey(): Promise<PublicKeyEntry>;
}

/**
 * What a provider actually implements. The compact serialization is shared;
 * a provider only has to turn signing-input bytes into a JOSE signature.
 */
export interface RawSigner
{
    readonly kid: string;
    readonly alg: SigningAlgorithm;
    readonly provider: ProviderName;

    /**
     * Sign the exact bytes given.
     *
     * The result is a JOSE signature: for `ES256` that is `r || s`, 64 bytes,
     * never DER — the conversion belongs to the provider that produced DER.
     */
    signRaw(input: Buffer): Promise<Buffer>;

    publicKey(): Promise<PublicKeyEntry>;
}
