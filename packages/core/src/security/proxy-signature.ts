/**
 * Proxy → Backend request signing (HMAC-SHA256) with key rotation
 *
 * Shared between the Next.js RPC proxy (which signs outbound requests) and the
 * backend proxy-guard middleware (which verifies them). Keeping the canonical
 * string and HMAC logic in one pure module guarantees both sides agree.
 *
 * The signature proves a request passed through a trusted proxy that holds the
 * shared secret. It does NOT authenticate the end user — that is the JWT layer's
 * job — and it cannot stop a client from calling the proxy itself. Its role is to
 * stop direct-to-backend calls that bypass the proxy.
 *
 * Keys are identified by a short keyId so secrets can be rotated without downtime:
 * the proxy signs with the active key and stamps its keyId in a header; the
 * backend keeps a set of accepted keys (current + previous) and selects by keyId.
 * Roll a new key in, let both sides pick it up, switch the proxy to it, then drop
 * the old one after a grace period — no request is ever rejected mid-rotation.
 *
 * @module security/proxy-signature
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// ============================================================================
// Header names
// ============================================================================

export const PROXY_SIGNATURE_HEADER = 'x-spfn-proxy-signature';
export const PROXY_TIMESTAMP_HEADER = 'x-spfn-proxy-timestamp';
export const PROXY_NONCE_HEADER = 'x-spfn-proxy-nonce';
export const PROXY_KEY_ID_HEADER = 'x-spfn-proxy-key-id';
/**
 * The real client IP, forwarded by the proxy. Part of the signed canonical string
 * (version 2), so the backend believes only an address the holder of the proxy key
 * signed: proxy-guard hands it on as the `proxyClientIp` context value.
 */
export const PROXY_CLIENT_IP_HEADER = 'x-spfn-proxy-client-ip';
/** Which canonical string the signature covers. Absent = version 1 (no address). */
export const PROXY_SIGNATURE_VERSION_HEADER = 'x-spfn-proxy-signature-version';
/** The version this proxy signs: the canonical string includes the client address. */
export const PROXY_SIGNATURE_VERSION = '2';

/** keyId used when a raw secret carries no `keyId:` prefix (back-compat). */
export const DEFAULT_KEY_ID = 'default';

// ============================================================================
// Keys
// ============================================================================

/**
 * A signing key: a short identifier plus its secret. Encoded in env as
 * `<keyId>:<secret>` (e.g. `v2:9f3c...`); a bare secret gets `DEFAULT_KEY_ID`.
 */
export interface ProxyKey
{
    keyId: string;
    secret: string;
}

/**
 * Parse one `<keyId>:<secret>` (or bare `<secret>`) string into a ProxyKey.
 * keyId is everything before the FIRST colon; the secret keeps any later colons.
 */
export function parseProxyKey(raw: string): ProxyKey
{
    const idx = raw.indexOf(':');
    if (idx === -1)
    {
        return { keyId: DEFAULT_KEY_ID, secret: raw };
    }

    // A leading colon (':secret') yields an empty keyId; the backend treats an empty
    // keyId header as "missing" and rejects, so normalize it to DEFAULT_KEY_ID.
    return { keyId: raw.slice(0, idx) || DEFAULT_KEY_ID, secret: raw.slice(idx + 1) };
}

/**
 * Build the backend's accepted key set from raw env values. Each input may be a
 * single key or a comma-separated list (for multiple grace keys). Earlier inputs
 * win on keyId collision, so pass the active secret first.
 */
export function parseProxyKeySet(raws: Array<string | undefined | null>): ProxyKey[]
{
    const keys: ProxyKey[] = [];
    const seen = new Set<string>();

    for (const raw of raws)
    {
        if (!raw)
        {
            continue;
        }

        for (const part of raw.split(','))
        {
            const trimmed = part.trim();
            if (!trimmed)
            {
                continue;
            }

            const key = parseProxyKey(trimmed);
            if (!key.secret || seen.has(key.keyId))
            {
                continue;
            }

            seen.add(key.keyId);
            keys.push(key);
        }
    }

    return keys;
}

// ============================================================================
// Types
// ============================================================================

/**
 * The parts of a request that are bound into the signature.
 */
export interface SignatureParts
{
    /** Resolved backend HTTP method (GET/POST/PUT/...) */
    method: string;

    /**
     * Raw (wire) backend path, percent-encoding preserved, leading slash, NO query.
     * Proxy signs its outbound request-target path; the backend reconstructs the
     * SAME bytes from `new URL(c.req.url).pathname` (NOT the decoded `c.req.path`).
     */
    path: string;

    /**
     * Raw (wire) query string including leading `?`, or '' when there is none.
     * Both sides use the verbatim search string so query params are authenticated.
     */
    query: string;

    /** Unix epoch milliseconds, as a string */
    timestamp: string;

    /** Random per-request nonce */
    nonce: string;

    /**
     * SHA-256 hex of the raw request body, or empty string when there is no body
     * (GET/HEAD, or multipart uploads which are excluded by design). Bound for ANY
     * non-multipart content-type, not just application/json.
     *
     * Multipart is excluded so the proxy can stream large uploads without buffering
     * them to hash. The signature therefore proves *provenance* (came through the
     * trusted proxy) and binds method/path/query/timestamp for a multipart request,
     * but NOT the body bytes. Two consequences, by design:
     *   - Multipart *content* integrity/validation is the application's job (size,
     *     type, checksum, business rules) — not the transport signature's.
     *   - If you don't trust the proxy→backend hop itself, secure it with TLS/mTLS;
     *     signing a prefix of the stream would be a half-measure (the tail stays
     *     unprotected) and is intentionally not done.
     */
    bodyHash: string;

    /** The `x-spfn-proxy-client-ip` value sent with the request, or '' when absent. */
    clientIp: string;
}

/**
 * Headers produced by signing — ready to set on the outbound fetch.
 */
export interface SignatureHeaders
{
    [PROXY_SIGNATURE_HEADER]: string;
    [PROXY_TIMESTAMP_HEADER]: string;
    [PROXY_NONCE_HEADER]: string;
    [PROXY_KEY_ID_HEADER]: string;
    [PROXY_SIGNATURE_VERSION_HEADER]: string;
}

// ============================================================================
// Canonical string + HMAC
// ============================================================================

/**
 * Build the canonical string that gets signed (version 2). Field order is fixed
 * and each field is newline-separated, so a captured signature cannot be replayed
 * against a different method, path, body or client address.
 */
export function buildCanonicalString(parts: SignatureParts): string
{
    return [
        parts.method.toUpperCase(), parts.path, parts.query, parts.timestamp, parts.nonce, parts.bodyHash, parts.clientIp,
    ].join('\n');
}

/**
 * The version-1 canonical string: no client address. Verified only so a backend
 * upgraded first keeps accepting a not-yet-upgraded proxy; a request signed this
 * way is `web` but its address is ignored.
 *
 * @deprecated Accepted through @spfn/core 0.4.x; removed in 0.5.0, with every
 * `version === 1` branch in `verifyProxyRequest`.
 */
export function buildLegacyCanonicalString(parts: Omit<SignatureParts, 'clientIp'>): string
{
    return [parts.method.toUpperCase(), parts.path, parts.query, parts.timestamp, parts.nonce, parts.bodyHash].join('\n');
}

/**
 * Hash a request body. Accepts a string (proxy side, from JSON.stringify) or a
 * Buffer (backend side, straight from the stream — avoids a bytes→string→bytes
 * round-trip). Returns '' for empty/no body. A utf8 string and its Buffer hash
 * identically, so both sides agree.
 */
export function hashBody(body: string | Buffer | undefined | null): string
{
    if (!body || body.length === 0)
    {
        return '';
    }

    return typeof body === 'string'
        ? createHash('sha256').update(body, 'utf8').digest('hex')
        : createHash('sha256').update(body).digest('hex');
}

/**
 * Compute the HMAC-SHA256 signature (hex) for the given parts.
 */
export function computeSignature(secret: string, parts: SignatureParts): string
{
    return createHmac('sha256', secret).update(buildCanonicalString(parts)).digest('hex');
}

/** @deprecated The version-1 signature; removed in 0.5.0 with `buildLegacyCanonicalString`. */
function computeLegacySignature(secret: string, parts: Omit<SignatureParts, 'clientIp'>): string
{
    return createHmac('sha256', secret).update(buildLegacyCanonicalString(parts)).digest('hex');
}

/**
 * Generate a fresh random nonce (hex).
 */
export function generateNonce(): string
{
    return randomBytes(16).toString('hex');
}

// ============================================================================
// Sign (proxy side)
// ============================================================================

export interface SignInput
{
    /** The active signing key. */
    key: ProxyKey;
    method: string;
    /** Raw (wire) path, leading slash, percent-encoding preserved, NO query. */
    path: string;
    /** Raw (wire) query string including leading `?`, or '' / omitted for none. */
    query?: string;
    /** Raw request body string, if any. Omit for GET / multipart uploads. */
    body?: string | null;
    /** The `x-spfn-proxy-client-ip` value the request carries, if any. */
    clientIp?: string | null;
    /** Override the timestamp (testing). Defaults to Date.now(). */
    timestamp?: string;
    /** Override the nonce (testing). Defaults to a random nonce. */
    nonce?: string;
}

/**
 * Sign an outbound proxy request and return the headers to attach (including the
 * keyId so the backend knows which key to verify against, and the version).
 */
export function signProxyRequest(input: SignInput): SignatureHeaders
{
    const timestamp = input.timestamp ?? String(Date.now());
    const nonce = input.nonce ?? generateNonce();
    const signature = computeSignature(input.key.secret, {
        method: input.method,
        path: input.path,
        query: input.query ?? '',
        timestamp,
        nonce,
        bodyHash: hashBody(input.body),
        clientIp: input.clientIp ?? '',
    });

    return {
        [PROXY_SIGNATURE_HEADER]: signature,
        [PROXY_TIMESTAMP_HEADER]: timestamp,
        [PROXY_NONCE_HEADER]: nonce,
        [PROXY_KEY_ID_HEADER]: input.key.keyId,
        [PROXY_SIGNATURE_VERSION_HEADER]: PROXY_SIGNATURE_VERSION,
    };
}

// ============================================================================
// Verify (backend side)
// ============================================================================

export type VerifyFailureReason =
    | 'missing-headers'
    | 'stale-timestamp'
    | 'bad-timestamp'
    | 'unknown-key'
    | 'unknown-version'
    | 'signature-mismatch';

// ('body-read-error' / 'origin-not-allowed' / 'nonce-replay' are guard-level
//  reasons carried separately by the middleware, not produced by verify itself.)

export interface VerifyResult
{
    valid: boolean;
    reason?: VerifyFailureReason;
    /** The verified nonce, for optional replay tracking by the caller. */
    nonce?: string;
    /** The keyId the request was verified against (for logging/metrics). */
    keyId?: string;
    /**
     * The signature version. Only on version 2 does the signature cover the client
     * address; a version-1 request's address is the caller's own.
     */
    version?: 1 | 2;
}

export interface VerifyInput
{
    /** Accepted keys (active + grace). Selected by the request's keyId header. */
    keys: ProxyKey[];
    method: string;
    /** Raw (wire) path from `new URL(c.req.url).pathname` — NOT decoded `c.req.path`. */
    path: string;
    /** Raw (wire) query string from `new URL(c.req.url).search`, or '' for none. */
    query?: string;
    /** Raw request body (string or Buffer) as received, if any. */
    body?: string | Buffer | null;
    signature: string | null | undefined;
    timestamp: string | null | undefined;
    nonce: string | null | undefined;
    keyId: string | null | undefined;
    /** The `x-spfn-proxy-signature-version` header; absent = version 1. */
    version?: string | null;
    /** The `x-spfn-proxy-client-ip` header, or absent. */
    clientIp?: string | null;
    /** Allowed clock skew / replay window in ms. Default 30s. */
    windowMs?: number;
    /** Current time (testing). Defaults to Date.now(). */
    now?: number;
}

/**
 * Constant-time hex string comparison. Returns false on any length diff.
 *
 * Buffer.from(_, 'hex') does NOT throw on invalid hex — it silently truncates at
 * the first bad char — so a malformed signature yields a shorter buffer that the
 * length check rejects. No try/catch needed.
 */
export function safeEqualHex(a: string, b: string): boolean
{
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');

    if (bufA.length === 0 || bufA.length !== bufB.length)
    {
        return false;
    }

    return timingSafeEqual(bufA, bufB);
}

/**
 * Verify an inbound request's proxy signature against the accepted key set.
 *
 * Checks, in order: headers present, version known, timestamp within window
 * (replay guard), keyId known, and HMAC match. Nonce-level replay rejection is left
 * to the caller (optional, Redis-backed) since not every deployment has a shared store.
 */
export function verifyProxyRequest(input: VerifyInput): VerifyResult
{
    const { signature, timestamp, nonce, keyId } = input;

    if (!signature || !timestamp || !nonce || !keyId)
    {
        return { valid: false, reason: 'missing-headers' };
    }

    const version = signatureVersion(input.version);
    if (!version)
    {
        return { valid: false, reason: 'unknown-version' };
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts))
    {
        return { valid: false, reason: 'bad-timestamp' };
    }

    const now = input.now ?? Date.now();
    const windowMs = input.windowMs ?? 30_000;
    if (Math.abs(now - ts) > windowMs)
    {
        return { valid: false, reason: 'stale-timestamp' };
    }

    const key = input.keys.find(k => k.keyId === keyId);
    if (!key)
    {
        return { valid: false, reason: 'unknown-key' };
    }

    const parts = {
        method: input.method,
        path: input.path,
        query: input.query ?? '',
        timestamp,
        nonce,
        bodyHash: hashBody(input.body),
    };
    const expected = version === 2
        ? computeSignature(key.secret, { ...parts, clientIp: input.clientIp ?? '' })
        : computeLegacySignature(key.secret, parts);

    if (!safeEqualHex(signature, expected))
    {
        return { valid: false, reason: 'signature-mismatch' };
    }

    return { valid: true, nonce, keyId, version };
}

/**
 * The version a request declares: 2, or 1 when the header is absent or says 1.
 *
 * Version 1 is accepted through @spfn/core 0.4.x only. In 0.5.0 this answers 2 or
 * `undefined` (refused), and `computeLegacySignature` / `buildLegacyCanonicalString`
 * go with it.
 */
function signatureVersion(header: string | null | undefined): 1 | 2 | undefined
{
    if (header === PROXY_SIGNATURE_VERSION)
    {
        return 2;
    }

    return !header || header === '1' ? 1 : undefined;
}
