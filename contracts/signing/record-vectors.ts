/**
 * The generator behind `contracts/signing/vectors.json`.
 *
 * ## What it is for
 *
 * The file it writes is the fixed point other implementations of SPFN's token
 * format check themselves against. For its first six vectors — Ed25519/ES256 ×
 * valid/expired/bad-signature, all canonically encoded — that fixed point held
 * only for the three verdicts they reach. A port could delete its rule for
 * non-canonical base64url, duplicate JSON members, `crit`, the media-type
 * members, `alg: none`, `invalid-claims`, `not-yet-valid`, `too-old` or
 * `no-expiry` and still pass all six. A review proved it by removing them one
 * at a time (issue #166).
 *
 * So there is now one vector per `VerifyFailureReason` and one per rule —
 * including the verify-only ones: RS256, and the `audience`, `issuer` and
 * `issuedWithinSec` options. Beside the tokens sits a `jwks` block of JWK
 * Sets and what `parseJwks()` makes of each, because a JWK Set is
 * configuration and not a token, and its verdict is a key list or a refusal.
 *
 * ## Where the verdicts come from
 *
 * From the reference verifier, never from this file's opinion: every case
 * declares the reason it means to exercise, and `buildVectorFile()` throws
 * rather than writing anything if the verifier disagrees. A rule that changes
 * upstream therefore breaks the recording instead of being quietly re-recorded.
 *
 * The reference is imported from `packages/signing/src`, never from `dist`: a
 * published build lags its sources, and a stale oracle records stale verdicts.
 *
 * ## Determinism
 *
 * Re-running must reproduce the committed file byte for byte, because a
 * regenerate-and-compare that drifts is a test nobody can read. Everything
 * here is therefore fixed: the key material is constants, `verifyAt` is a
 * constant, and every object is built in one member order. RSA PKCS#1 v1.5
 * signatures are deterministic, so the RS256 vectors are as byte-stable as
 * the Ed25519 ones.
 *
 * The one thing that cannot be: ECDSA chooses a fresh nonce per signature, so
 * an ES256 signature is different every time it is produced. Those three
 * signatures are carried over from the committed file when the bytes they sign
 * are unchanged — see `carriedEs256Token()`. They are still put through the
 * verifier like every other vector, so a carried signature that stopped
 * meaning what it claims fails the run.
 *
 * ## Running it
 *
 * The reference sources import each other extensionlessly, which node cannot
 * resolve on its own, so the runner is vitest:
 *
 *     UPDATE_SIGNING_VECTORS=1 pnpm --filter @spfn/signing test vectors
 *
 * `packages/signing/src/vectors.test.ts` calls in here, compares what comes
 * back with the committed file, and writes only under that variable.
 */

import {
    constants,
    createPrivateKey,
    createPublicKey,
    sign,
    type JsonWebKey,
} from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJwks, rsaPublicKeyEntry } from '../../packages/signing/src/jwks';
import { encodeBase64Url } from '../../packages/signing/src/jws';
import { formatPublicKeyEntry, toJwks } from '../../packages/signing/src/keys';
import { LocalSigner } from '../../packages/signing/src/providers/local';
import { verifyJws } from '../../packages/signing/src/verify';
import type {
    SigningAlgorithm,
    SkippedJwk,
    VerifyAlgorithm,
    VerifyFailureReason,
    VerifyKeyEntry,
    VerifyKeySource,
    VerifyOptions,
} from '../../packages/signing/src/types';

/** The file this module owns. */
export const VECTORS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'vectors.json');

/**
 * The instant every vector is judged at.
 *
 * A constant, so `expired` stays expired and `valid` stays valid however long
 * the file lives — and so that nothing here reads the clock.
 */
export const VERIFY_AT = 1_800_000_000_000;

const NOW_SEC = VERIFY_AT / 1000;

const ISSUER = 'spfn-signing-vectors';

/** The issuer and audiences the verify-only vectors are about. */
const EXAMPLE_ISSUER = 'https://issuer.example';
const API_AUDIENCE = 'https://issuer.example/api';
const WEBHOOK_AUDIENCE = 'https://issuer.example/webhook';
const REGISTER_PREFIX = 'https://issuer.example/register/';
const NONCE = '0123456789abcdef0123456789abcdef';

/**
 * The options a vector may carry; the rest of `VerifyOptions` is the caller's.
 *
 * JSON has no regular expressions, so a prefix audience's `rest` is written as
 * the expression's source; `verifyOptions()` turns it back into a `RegExp`.
 */
export interface VectorOptions
{
    clockSkewSec?: number;
    maxAgeSec?: number;
    issuedWithinSec?: number;
    issuer?: string | string[];
    audience?: string | string[] | { prefix: string; rest: string };
}

/** A successful verdict names the `aud` value matched when an audience was required. */
export type Verdict = { ok: true; audience?: string } | { ok: false; reason: VerifyFailureReason };

export interface Vector
{
    name: string;
    /** The rule this vector exists to hold in place. Absent on the frozen six. */
    why?: string;
    /**
     * The key that produced the signature — not what the header claims. Several
     * vectors exist precisely because those two disagree.
     */
    kid: string;
    alg: VerifyAlgorithm;
    token: string;
    /**
     * Verify against the members of `publicJwks` with these kids. Absent on
     * the first twenty, which are verified against the `publicKeys` string.
     */
    kids?: string[];
    options?: VectorOptions;
    expect: Verdict;
}

/** A JWK Set and what `parseJwks()` makes of it: its keys and its skips, or a refusal. */
export interface JwksVector
{
    name: string;
    why: string;
    set: { keys: Record<string, unknown>[] };
    expect: { kids: string[]; skipped: SkippedJwk[] } | { throws: true };
}

export interface VectorFile
{
    note: string;
    verifyAt: number;
    publicKeys: string;
    /** Every fixture key, RSA included — which the `publicKeys` string cannot carry. */
    publicJwks: { keys: JsonWebKey[] };
    vectors: Vector[];
    jwks: JwksVector[];
}

/** The keys a vector is verified against. */
export function vectorKeys(file: VectorFile, vector: Vector): VerifyKeySource
{
    if (!vector.kids)
    {
        return file.publicKeys;
    }

    return { keys: file.publicJwks.keys.filter((key) => vector.kids!.includes(key.kid as string)) };
}

/** A vector's options as `verifyJws()` takes them, judged at `verifyAt`. */
export function verifyOptions(verifyAt: number, options: VectorOptions = {}): VerifyOptions
{
    const { audience, ...rest } = options;

    if (typeof audience !== 'object' || Array.isArray(audience))
    {
        return { now: verifyAt, ...rest, ...(audience === undefined ? {} : { audience }) };
    }

    return {
        now: verifyAt,
        ...rest,
        audience: { prefix: audience.prefix, rest: new RegExp(audience.rest) },
    };
}

/**
 * Fixed key material, so regenerating produces the same keys.
 *
 * The default algorithm comes first, so an implementation working through the
 * file in order meets Ed25519 before ES256. Test-only throwaway values with no
 * counterpart anywhere; the ES256 scalar starts at 0x01, which keeps it
 * comfortably below the curve order.
 */
const FIXTURE_KEYS = [
    {
        kid: 'vector-ed25519',
        alg: 'EdDSA' as SigningAlgorithm,
        material: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
    },
    {
        kid: 'vector-es256',
        alg: 'ES256' as SigningAlgorithm,
        material: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    },
];

/** A signer over fixed material, loaded the way a deployment would load it. */
function fixtureSigner(kid: string, alg: SigningAlgorithm, material: string): LocalSigner
{
    process.env.SPFN_SIGNING_VECTOR_KEY = encodeBase64Url(Buffer.from(material, 'hex'));

    try
    {
        return new LocalSigner({ kid, alg, privateKey: { env: 'SPFN_SIGNING_VECTOR_KEY' } });
    }
    finally
    {
        delete process.env.SPFN_SIGNING_VECTOR_KEY;
    }
}

const ED = fixtureSigner(FIXTURE_KEYS[0].kid, FIXTURE_KEYS[0].alg, FIXTURE_KEYS[0].material);

const P256 = fixtureSigner(FIXTURE_KEYS[1].kid, FIXTURE_KEYS[1].alg, FIXTURE_KEYS[1].material);

/** A second Ed25519 key: another purpose's, for the cross-purpose vectors. */
const ED_OTHER = fixtureSigner(
    'vector-ed25519-b',
    'EdDSA',
    '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
);

/**
 * A fixed 2048-bit RSA key, PKCS#8 DER in base64url.
 *
 * Test-only and throwaway like the two above, with no counterpart anywhere. It
 * is spelled out rather than derived because RSA key generation cannot be
 * seeded through `node:crypto`. The package never signs RS256; only this
 * generator does, directly through `crypto.sign`.
 */
const RSA_FIXTURE_PKCS8 = [
    'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC0tNFTEbO0gsmi9Tky0LUpHA8QUI69iLCMTfavoNWsyJPZ',
    'DofyXW5b4pedOy4tUqHFUcCk0pvkpx9IGPYsYpiNxAaqOql3IJz580yGrrFiZFa93Zae4hx9auTgGG6qoN6wjDCIg4mFMXTA',
    'buZ9rRvnom7sZ49c3-lNno3SaKwJYupPVHwMDIDHVObIgUtBwW1lMBIdd_PdRF00PCiyjzXjKXifvdQto2c9fFFDT_PcLdEp',
    'VKTz-Ppw727aSYZtdKyT0SFoN3AYvyJkRb8fv9rTnGsO3WM038ZP5jRH_1r8sMrWEiH491Q4A5lR5UMYqzCAEJJrTjJt9zwv',
    'E-GgRc8bAgMBAAECggEAQp-pz2Em6sYPllun_4KwUBxOt3qj7eAwC0KRUVZQgVggHnY7jBGDZzAnKuqPT1l4WDoYdwxJOqed',
    'ImVFmb6uNRJRTMC9CzVEeukHTV6p-rc4vd6tMh32WA0pni-T2affAqNlH2ezs540x9_7bdl9gMzD7bgOxLSvHRV4f1tlFj43',
    '5J7FAEO7Fy4j5G7dnglVyJrRN0v1f_ASEsB9tAL7eWYYrnjkxyozhhmBC16vEEU4qXjDniN5XHtjKh0Ky_iw00JxTawz3sTU',
    'FtQHTYJi_0HH3lJrxT1NWWJz0O2LTaZNedw_Lb0aRhlNJNPcAJ6GtkQot7_UY24Wx6LJsVHt7QKBgQD6pazbD4H06kZ6fiq7',
    'A_pkIj7L9h8_dbNgQR4Mf_2vmMd3b3vz00Re2GRIOOBq5wlZDOC9UYsZpP5qRg_i4lThDaycYNS2PPCnJyX3sDHamvlejSf1',
    'r3aoOhoJQg3zccpL3ucE3NJkjDiHOocmcy1D1NzJiqBWwz_Mvu4U94cPXwKBgQC4kMP9fY75_62ZuH2rNjU5sQnjUVO6LLHj',
    '-VjE-uPfsnd4GDziLhWqjA_OjChX0vcqfZqPOeNYFzn2Ybz1ambiRDvq-jM_6qSFjSANmaw-eGDcakp0gxhIVfOyE_uVcBFN',
    'rnP63KrFcAKzu0FZNRGb5-LYSfiWhCwkO54FncnlxQKBgBWzRlXo781ugw-T4Ms0Ovd0Z49tDaOG4zLQMHPQmPwc9BgJFOg1',
    'QFQd1ADUu8lFm2-UR9jcOHjN6iD1U-bGxaZ-cpVPZNsqR4ORRh49qPNOO4zOF8mTmWhTL3HhwCd1kJglAkdPfv-pjDNZA952',
    'VlLrGPpyABPC78EgPqieDZltAoGBAK8znRkRC5x9_UmjPIg-mR_-0ygal6RvsR58IKw8jfxX6djzCTicDq0q8AZePh3Agiiv',
    'uvyjMxD4W2lrNnixXKEFrOtOP0A5eZvdb8P5UOysUSZrL-qSV4azMPamyXf-Pi7DoA1PVDzAK5B5_Xq1SdX5tfkjnvsi1NRA',
    'U615L6MRAoGBAOvZ7eLH6giMCSv_Zl2plllpgHGSIQbLUWCr_pXqMhdKQOyxUVpVwTl_Xb00dpG_UC_yEQwXFf5LROnS51jK',
    'Sej1ZCPRX9f9ZKY2YLhzA-VUOYPlLfxZ2fz1xC48EMVt8Z7PhIXmS9nfibnE8VcWDMfviR1rqV2-LUbVggEEfoAu',
].join('');

/** Anything that turns signing input into a JOSE signature under a kid. */
interface VectorSigner
{
    kid: string;
    alg: VerifyAlgorithm;
    signRaw(input: Buffer): Promise<Buffer>;
}

const RSA_PRIVATE = createPrivateKey({
    key: Buffer.from(RSA_FIXTURE_PKCS8, 'base64url'),
    format: 'der',
    type: 'pkcs8',
});

const RSA: VectorSigner = {
    kid: 'vector-rs256',
    alg: 'RS256',
    signRaw: async (input) =>
        sign('sha256', input, { key: RSA_PRIVATE, padding: constants.RSA_PKCS1_PADDING }),
};

/** Every fixture key, as the JWK Set `publicJwks` records. */
async function fixtureEntries(): Promise<VerifyKeyEntry[]>
{
    return [
        await ED.publicKey(),
        await P256.publicKey(),
        await ED_OTHER.publicKey(),
        rsaPublicKeyEntry(RSA.kid, createPublicKey(RSA_PRIVATE)),
    ];
}

/** Flip one bit of the signature: the same token, signed by nobody. */
function flipSignatureByte(token: string): string
{
    const [head, body, signature] = token.split('.');
    const bytes = Buffer.from(signature, 'base64url');

    bytes[0] ^= 0x01;

    return `${head}.${body}.${encodeBase64Url(bytes)}`;
}

/** The RFC 4648 §5 alphabet, in value order. */
export const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Spare bits in a segment's final character, by the segment's length mod 4.
 *
 * Four base64url characters carry three bytes exactly, so a segment whose
 * length is a multiple of four has no spare bits at all. A short last group
 * does: two characters carry one byte and leave four bits over, three carry
 * two bytes and leave two. Those spare bits are always the LOW bits of the
 * final character, which is why flipping bit 0 is enough for either width.
 */
const SPARE_BITS_BY_REMAINDER: Record<number, number> = { 2: 4, 3: 2 };

/**
 * Respell the last character of the signature segment.
 *
 * A 64-byte signature ends in a two-character group carrying one byte, so the
 * final character's low four bits encode nothing. Flipping the lowest of them
 * leaves the decoded bytes identical and the text different — which is the
 * whole problem: sixteen strings would otherwise be the same token.
 *
 * Flipping rather than advancing, because advancing runs off the end of the
 * alphabet at `_` (value 63) and hands back `undefined`. A flip of a spare bit
 * is its own inverse and lands inside the alphabet from every one of the 64
 * characters, so this is total for any signature that has a respelling at all.
 */
export function respellSignature(token: string): string
{
    const [head, body, signature] = token.split('.');

    if (!SPARE_BITS_BY_REMAINDER[signature.length % 4])
    {
        throw new Error(
            `respellSignature: a ${signature.length}-character segment spends every bit it has, `
            + 'so it has exactly one spelling and nothing to respell',
        );
    }

    const last = BASE64URL_ALPHABET.indexOf(signature.slice(-1));

    return `${head}.${body}.${signature.slice(0, -1)}${BASE64URL_ALPHABET[last ^ 1]}`;
}

interface Case
{
    name: string;
    why?: string;
    signer: VectorSigner;
    /** The protected header as TEXT: half of these are shapes `JSON.stringify` cannot make. */
    header: string;
    /** The payload as TEXT, for the same reason. */
    payload: string;
    /** Rewrite the finished token — the only way to express a signature that is not one. */
    mangle?: (token: string) => string;
    kids?: string[];
    options?: VectorOptions;
    expect: Verdict;
}

function header(signer: VectorSigner, over: Record<string, unknown> = {}): string
{
    return JSON.stringify({ alg: signer.alg, kid: signer.kid, ...over });
}

/** The anchor payload every new vector differs from by exactly one thing. */
function claims(over: Record<string, unknown> = {}): string
{
    return JSON.stringify({
        iss: ISSUER,
        sub: 'vector',
        iat: NOW_SEC - 1000,
        exp: NOW_SEC + 300,
        ...over,
    });
}

/**
 * The six vectors this file started life with, reproduced exactly.
 *
 * Their bytes are frozen: downstream repositories keep a byte copy of them as
 * a fixture and refresh it by copying this file again and reading the diff. A token that changed here
 * would be a diff nobody could review and a port nobody could trust. They
 * carry no `why` for the same reason — an added member is a changed byte.
 * Their rules are in `README.md` with everyone else's.
 */
function frozenCases(): Case[]
{
    const valid = JSON.stringify({ iss: ISSUER, sub: 'vector', iat: 1_799_999_000, exp: 4_102_444_800 });
    const expired = JSON.stringify({ iss: ISSUER, sub: 'vector', iat: 1_700_000_000, exp: 1_700_000_300 });

    return [ED, P256].flatMap((signer) =>
    {
        const label = signer.alg === 'ES256' ? 'es256' : 'ed25519';

        return [
            {
                name: `${label}-valid`,
                signer,
                header: header(signer),
                payload: valid,
                expect: { ok: true } as Verdict,
            },
            {
                name: `${label}-expired`,
                signer,
                header: header(signer),
                payload: expired,
                expect: { ok: false, reason: 'expired' } as Verdict,
            },
            {
                name: `${label}-bad-signature`,
                signer,
                header: header(signer),
                payload: valid,
                mangle: flipSignatureByte,
                expect: { ok: false, reason: 'bad-signature' } as Verdict,
            },
        ];
    });
}

/**
 * One vector per rule the six do not reach.
 *
 * All Ed25519: the rules are the verifier's and not the curve's, and Ed25519
 * signs the same bytes the same way every time, which is what lets the file be
 * compared rather than merely replayed.
 */
function ruleCases(): Case[]
{
    return [
        {
            name: 'non-canonical-base64url',
            why: 'the last character of the signature segment carries bits no byte uses, so sixteen '
                + 'strings decode to the same 64 bytes; a token that can be rewritten without '
                + 'invalidating it cannot key a one-time-use set',
            signer: ED,
            header: header(ED),
            payload: claims(),
            mangle: respellSignature,
            expect: { ok: false, reason: 'malformed' },
        },
        {
            name: 'duplicate-header-member',
            why: 'RFC 8259 §4 leaves duplicate members undefined and JSON.parse keeps the last, so '
                + 'this header is EdDSA to one reader and "none" to another',
            signer: ED,
            header: `{"alg":"${ED.alg}","kid":"${ED.kid}","alg":"none"}`,
            payload: claims(),
            expect: { ok: false, reason: 'malformed' },
        },
        {
            name: 'duplicate-payload-member',
            why: 'the same scan on the payload, which a port that only checked the header would '
                + 'let through: two `sub` claims is two answers to "who"',
            signer: ED,
            header: header(ED),
            payload: `{"iss":"${ISSUER}","sub":"vector","sub":"somebody-else",`
                + `"iat":${NOW_SEC - 1000},"exp":${NOW_SEC + 300}}`,
            expect: { ok: false, reason: 'malformed' },
        },
        {
            name: 'crit-present',
            why: '`crit` names extensions a verifier must understand; this one implements none, so '
                + 'RFC 7515 §4.1.11 says refuse rather than guess',
            signer: ED,
            header: header(ED, { crit: ['exp'] }),
            payload: claims(),
            expect: { ok: false, reason: 'malformed' },
        },
        {
            name: 'typ-not-string',
            why: 'RFC 7515 §4.1.9 makes `typ` a media type; `typ: 5` hands every caller that '
                + 'compares it a value its own type says cannot be there',
            signer: ED,
            header: header(ED, { typ: 5 }),
            payload: claims(),
            expect: { ok: false, reason: 'malformed' },
        },
        {
            name: 'cty-not-string',
            why: 'the same rule for `cty` (RFC 7515 §4.1.10)',
            signer: ED,
            header: header(ED, { cty: {} }),
            payload: claims(),
            expect: { ok: false, reason: 'malformed' },
        },
        {
            name: 'alg-none',
            why: '`alg` is only ever compared to the KEY\'s algorithm, so "none" is a mismatch and '
                + 'never an invitation to skip the signature check',
            signer: ED,
            header: header(ED, { alg: 'none' }),
            payload: claims(),
            expect: { ok: false, reason: 'alg-mismatch' },
        },
        {
            name: 'alg-not-the-keys',
            why: 'the same comparison with a real algorithm: an ES256 header over the Ed25519 key '
                + 'is refused before any signature is checked',
            signer: ED,
            header: header(ED, { alg: 'ES256' }),
            payload: claims(),
            expect: { ok: false, reason: 'alg-mismatch' },
        },
        {
            name: 'unknown-kid',
            why: 'the header names a key this verifier does not hold, which is a verdict of its '
                + 'own and not a bad signature',
            signer: ED,
            header: header(ED, { kid: 'vector-absent' }),
            payload: claims(),
            expect: { ok: false, reason: 'unknown-kid' },
        },
        {
            name: 'iat-after-exp',
            why: 'a token that expired before it was issued: no clock makes both claims true, so '
                + 'it is the issuer\'s bug and not an expiry',
            signer: ED,
            header: header(ED),
            payload: claims({ iat: NOW_SEC, exp: NOW_SEC - 300 }),
            expect: { ok: false, reason: 'invalid-claims' },
        },
        {
            name: 'non-finite-claim',
            why: '`1e999` parses to Infinity; treating a present-but-unusable `exp` as "no expiry '
                + 'given" turns a typo into an immortal token',
            signer: ED,
            header: header(ED),
            payload: `{"iss":"${ISSUER}","sub":"vector","iat":${NOW_SEC - 1000},"exp":1e999}`,
            expect: { ok: false, reason: 'invalid-claims' },
        },
        {
            name: 'not-yet-valid',
            why: '`nbf` an hour ahead, well beyond the default 30 seconds of skew',
            signer: ED,
            header: header(ED),
            payload: claims({ nbf: NOW_SEC + 3600 }),
            expect: { ok: false, reason: 'not-yet-valid' },
        },
        {
            name: 'too-old',
            why: 'a token that granted itself a longer life than the caller allows. Only reachable '
                + 'under `maxAgeSec`, which is why the vector carries its own options',
            signer: ED,
            header: header(ED),
            payload: claims({ exp: NOW_SEC + 86_400 }),
            options: { maxAgeSec: 300 },
            expect: { ok: false, reason: 'too-old' },
        },
        {
            name: 'no-expiry',
            why: 'under `maxAgeSec` a missing `exp` leaves the lifetime uncomputable, so it is a '
                + 'refusal and not an exemption',
            signer: ED,
            header: header(ED),
            payload: `{"iss":"${ISSUER}","sub":"vector","iat":${NOW_SEC - 1000}}`,
            options: { maxAgeSec: 300 },
            expect: { ok: false, reason: 'no-expiry' },
        },
    ];
}

/**
 * A payload whose RS256 signature starts with a zero byte, and that signature.
 *
 * Found rather than hard-coded, and deterministic because PKCS#1 v1.5 is: the
 * search over `jti` lands on the same value every run. About one signature in
 * 256 starts with zero, so the search is short.
 */
async function zeroLedRsaPayload(): Promise<string>
{
    for (let attempt = 0; ; attempt += 1)
    {
        const payload = claims({ jti: `short-${attempt}` });
        const input = `${encodeBase64Url(header(RSA))}.${encodeBase64Url(payload)}`;

        if ((await RSA.signRaw(Buffer.from(input, 'ascii')))[0] === 0)
        {
            return payload;
        }
    }
}

/** Drop the signature's leading zero byte — the same number, one byte shorter. */
function stripLeadingZero(token: string): string
{
    const [head, body, signature] = token.split('.');
    const bytes = Buffer.from(signature, 'base64url');

    if (bytes[0] !== 0)
    {
        throw new Error('stripLeadingZero: the signature does not start with a zero byte');
    }

    return `${head}.${body}.${encodeBase64Url(bytes.subarray(1))}`;
}

/** Every kid in `publicJwks` but the other purpose's. */
const ALL_KIDS = ['vector-ed25519', 'vector-es256', 'vector-rs256'];

/**
 * RS256: verify-only, and still under the rule that the key decides the
 * algorithm — in both directions.
 */
async function rsaCases(): Promise<Case[]>
{
    return [
        {
            name: 'rs256-valid',
            why: 'the anchor for RSA keys, which reach a verifier through a JWK Set and never the '
                + '`kid:key` string',
            signer: RSA,
            header: header(RSA),
            payload: claims(),
            kids: ALL_KIDS,
            expect: { ok: true },
        },
        {
            name: 'rs256-expired',
            why: 'the same clock rules on RSA as on the curves',
            signer: RSA,
            header: header(RSA),
            payload: claims({ iat: 1_700_000_000, exp: 1_700_000_300 }),
            kids: ALL_KIDS,
            expect: { ok: false, reason: 'expired' },
        },
        {
            name: 'rs256-bad-signature',
            why: 'one flipped bit in a signature that is otherwise this key\'s',
            signer: RSA,
            header: header(RSA),
            payload: claims(),
            mangle: flipSignatureByte,
            kids: ALL_KIDS,
            expect: { ok: false, reason: 'bad-signature' },
        },
        {
            name: 'rs256-header-on-ed25519-key',
            why: 'an RS256 header naming the Ed25519 key: the key decides the algorithm, so this is '
                + 'refused before any signature is checked',
            signer: RSA,
            header: header(RSA, { kid: ED.kid }),
            payload: claims(),
            kids: ALL_KIDS,
            expect: { ok: false, reason: 'alg-mismatch' },
        },
        {
            name: 'ed25519-header-on-rsa-key',
            why: 'the other direction: an RSA key verifies RS256 and nothing else',
            signer: ED,
            header: header(ED, { kid: RSA.kid }),
            payload: claims(),
            kids: ALL_KIDS,
            expect: { ok: false, reason: 'alg-mismatch' },
        },
        {
            name: 'rs256-short-signature',
            why: 'a valid signature with its leading zero byte stripped: the same integer, one byte '
                + 'short of the modulus. A signature must be exactly the modulus length, or one '
                + 'token has two encodings',
            signer: RSA,
            header: header(RSA),
            payload: await zeroLedRsaPayload(),
            mangle: stripLeadingZero,
            kids: ALL_KIDS,
            expect: { ok: false, reason: 'bad-signature' },
        },
    ];
}

/**
 * The opt-in options. Each vector differs from `claims()` by the one thing its
 * rule is about, and every one is a token that is `ok` without the option.
 */
function issuerCases(): Case[]
{
    return [
        {
            name: 'audience-wrong',
            why: '`aud` is compared exactly: a value the expected one is a prefix of is a different '
                + 'audience',
            signer: ED,
            header: header(ED),
            payload: claims({ aud: `${API_AUDIENCE}s` }),
            kids: ALL_KIDS,
            options: { audience: API_AUDIENCE },
            expect: { ok: false, reason: 'wrong-audience' },
        },
        {
            name: 'audience-missing',
            why: 'a caller that requires an audience is not satisfied by a token that names none',
            signer: ED,
            header: header(ED),
            payload: claims(),
            kids: ALL_KIDS,
            options: { audience: API_AUDIENCE },
            expect: { ok: false, reason: 'no-audience' },
        },
        {
            name: 'audience-in-array',
            why: 'RFC 7519 §4.1.3 lets `aud` be an array; one member matching is enough, and the '
                + 'verdict names which',
            signer: ED,
            header: header(ED),
            payload: claims({ aud: [WEBHOOK_AUDIENCE, API_AUDIENCE] }),
            kids: ALL_KIDS,
            options: { audience: API_AUDIENCE },
            expect: { ok: true, audience: API_AUDIENCE },
        },
        {
            name: 'issuer-wrong',
            why: 'the same rule for `iss`',
            signer: ED,
            header: header(ED),
            payload: claims(),
            kids: ALL_KIDS,
            options: { issuer: EXAMPLE_ISSUER },
            expect: { ok: false, reason: 'wrong-issuer' },
        },
        {
            name: 'issuer-missing',
            why: 'a missing `iss` is not an exemption from `issuer`',
            signer: ED,
            header: header(ED),
            payload: `{"sub":"vector","iat":${NOW_SEC - 1000},"exp":${NOW_SEC + 300}}`,
            kids: ALL_KIDS,
            options: { issuer: EXAMPLE_ISSUER },
            expect: { ok: false, reason: 'no-issuer' },
        },
        {
            name: 'issued-too-long-ago',
            why: 'still inside its own lifetime, but issued earlier than the caller accepts: '
                + '`issuedWithinSec` bounds the issue date, not the expiry',
            signer: ED,
            header: header(ED),
            payload: claims(),
            kids: ALL_KIDS,
            options: { issuedWithinSec: 300 },
            expect: { ok: false, reason: 'too-old' },
        },
        {
            name: 'cross-purpose',
            why: 'a verifier holding one purpose\'s keys does not hold another\'s, so a token of '
                + 'the other purpose names a key it does not have',
            signer: ED_OTHER,
            header: header(ED_OTHER),
            payload: claims({ aud: WEBHOOK_AUDIENCE }),
            kids: ['vector-ed25519'],
            options: { audience: API_AUDIENCE },
            expect: { ok: false, reason: 'unknown-kid' },
        },
        {
            name: 'cross-purpose-same-key',
            why: 'if one key did serve two purposes, `aud` still keeps their tokens apart',
            signer: ED,
            header: header(ED),
            payload: claims({ aud: WEBHOOK_AUDIENCE }),
            kids: ALL_KIDS,
            options: { audience: API_AUDIENCE },
            expect: { ok: false, reason: 'wrong-audience' },
        },
    ];
}

/** The pattern the prefix vectors require of the remainder: 32 lowercase hex digits. */
const HEX_REST = '^[0-9a-f]{32}$';

/** One prefix-audience vector: everything but `aud`, `rest` and the verdict is shared. */
function prefixCase(
    item: Pick<Case, 'name' | 'why' | 'expect'> & { aud?: string; rest?: string },
): Case
{
    return {
        name: item.name,
        why: item.why,
        signer: ED,
        header: header(ED),
        payload: claims(item.aud === undefined ? {} : { aud: item.aud }),
        kids: ALL_KIDS,
        options: { audience: { prefix: REGISTER_PREFIX, rest: item.rest ?? HEX_REST } },
        expect: item.expect,
    };
}

/** `audience: { prefix, rest }` — an audience that carries a per-request value. */
function prefixCases(): Case[]
{
    return [
        prefixCase({
            name: 'audience-prefix-ok',
            why: 'the anchor: the prefix, then a remainder that matches `rest` in full. The verdict '
                + 'carries the whole value, so the caller reads the remainder from it',
            aud: `${REGISTER_PREFIX}${NONCE}`,
            expect: { ok: true, audience: `${REGISTER_PREFIX}${NONCE}` },
        }),
        prefixCase({
            name: 'audience-prefix-other-path',
            why: 'a well-formed remainder after a different path is a different audience',
            aud: `https://issuer.example/report/${NONCE}`,
            expect: { ok: false, reason: 'wrong-audience' },
        }),
        prefixCase({
            name: 'audience-prefix-empty-rest',
            why: 'the prefix alone, under a `rest` that accepts the empty string: an empty '
                + 'remainder is refused whatever `rest` says',
            aud: REGISTER_PREFIX,
            rest: '^[0-9a-f]*$',
            expect: { ok: false, reason: 'wrong-audience' },
        }),
        prefixCase({
            name: 'audience-prefix-rest-mismatch',
            why: 'a remainder of the wrong shape — base64 with `+`, `/` and padding where hex is '
                + 'expected',
            aud: `${REGISTER_PREFIX}ASNFZ4mrze8BI0Vn+/==`,
            expect: { ok: false, reason: 'wrong-audience' },
        }),
        prefixCase({
            name: 'audience-prefix-extra-path',
            why: 'a matching value followed by more path: `rest` must match the whole remainder, '
                + 'which is what its anchors are for',
            aud: `${REGISTER_PREFIX}${NONCE}/x`,
            expect: { ok: false, reason: 'wrong-audience' },
        }),
        prefixCase({
            name: 'audience-prefix-missing',
            why: 'no `aud` is not an exemption under a prefix either',
            expect: { ok: false, reason: 'no-audience' },
        }),
    ];
}

async function signCase(item: Case): Promise<string>
{
    const head = `${encodeBase64Url(item.header)}.${encodeBase64Url(item.payload)}`;
    const signature = await item.signer.signRaw(Buffer.from(head, 'ascii'));
    const token = `${head}.${encodeBase64Url(signature)}`;

    return item.mangle ? item.mangle(token) : token;
}

/** The committed tokens, by vector name, or nothing if the file is not there yet. */
function committedTokens(): Map<string, string>
{
    try
    {
        const file = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')) as VectorFile;

        return new Map(file.vectors.map((vector) => [vector.name, vector.token]));
    }
    catch
    {
        return new Map();
    }
}

/**
 * Keep the committed ES256 signature when it signs the bytes we just built.
 *
 * ECDSA's nonce is random, so re-signing produces a different token every run
 * and the file would never compare equal to itself. What is compared instead
 * is everything the generator does control — the header and payload segments —
 * and the carried signature is checked by the verifier alongside every other
 * vector. A signature that no longer means what its vector claims fails the
 * run; it does not get carried past it.
 */
function carriedEs256Token(item: Case, fresh: string, committed: Map<string, string>): string
{
    const kept = committed.get(item.name);
    const signedBytes = fresh.split('.').slice(0, 2).join('.');

    if (item.signer.alg !== 'ES256' || !kept?.startsWith(`${signedBytes}.`))
    {
        return fresh;
    }

    return kept;
}

function toVector(item: Case, token: string): Vector
{
    return {
        name: item.name,
        why: item.why,
        kid: item.signer.kid,
        alg: item.signer.alg,
        token,
        kids: item.kids,
        options: item.options,
        expect: item.expect,
    };
}

function verdictOf(verdict: Verdict | ReturnType<typeof verifyJws>): string
{
    if (!verdict.ok)
    {
        return verdict.reason;
    }

    return verdict.audience === undefined ? 'ok' : `ok (audience ${verdict.audience})`;
}

/** Every vector whose recorded verdict is not the one the verifier gives it. */
function disagreements(file: VectorFile): string[]
{
    return file.vectors.flatMap((vector) =>
    {
        const verdict = verifyJws(
            vector.token,
            vectorKeys(file, vector),
            verifyOptions(VERIFY_AT, vector.options),
        );

        return verdictOf(verdict) === verdictOf(vector.expect)
            ? []
            : [`${vector.name}: means to record ${verdictOf(vector.expect)}, `
                + `the reference verifier says ${verdictOf(verdict)}`];
    });
}

/** A JWK Set that `parseJwks()` must read into these kids, skipping these. */
function readCase(
    name: string,
    why: string,
    keys: Record<string, unknown>[],
    kids: string[],
    skipped: SkippedJwk[] = [],
): JwksVector
{
    return { name, why, set: { keys: keys.map(withoutUndefined) }, expect: { kids, skipped } };
}

/** A JWK Set that `parseJwks()` must refuse whole. */
function refusedCase(name: string, why: string, keys: Record<string, unknown>[]): JwksVector
{
    return { name, why, set: { keys: keys.map(withoutUndefined) }, expect: { throws: true } };
}

/**
 * The JWK Set block: which keys `parseJwks()` reads, which it skips, and which
 * sets it refuses whole.
 *
 * A key of a kind the verifier does not read is skipped (RFC 7517 §5 says to
 * ignore it); a key of a kind it reads that is broken refuses the set.
 */
function jwksCases(publicJwks: { keys: JsonWebKey[] }): JwksVector[]
{
    const [ed, es, , rsa] = publicJwks.keys as Record<string, unknown>[];
    const n = rsa.n as string;
    const oct = { kty: 'oct', kid: 'vector-oct', k: encodeBase64Url('not a key this verifier reads') };
    const x25519 = { kty: 'OKP', crv: 'X25519', kid: 'vector-x25519', x: ed.x };
    const skippedRsa = (reason: SkippedJwk['reason']): SkippedJwk[] =>
        [{ index: 0, kid: 'vector-rs256', reason }];
    const all = ['vector-rs256', 'vector-ed25519', 'vector-es256'];

    return [
        readCase('jwks-one-of-each', 'one key of each kind the verifier reads', [rsa, ed, es], all),
        readCase(
            'jwks-unknown-kty',
            'an unknown `kty` and an unknown curve are skipped, not refused: an issuer adding a key '
                + 'of a new kind must not stop verification',
            [rsa, ed, es, oct, x25519],
            all,
            [
                { index: 3, kid: 'vector-oct', reason: 'unknown-kty' },
                { index: 4, kid: 'vector-x25519', reason: 'unknown-curve' },
            ],
        ),
        readCase(
            'jwks-use-enc',
            'a key published for encryption verifies nothing',
            [{ ...rsa, use: 'enc' }, ed],
            ['vector-ed25519'],
            skippedRsa('not-for-signing'),
        ),
        readCase(
            'jwks-key-ops-without-verify',
            'the same through `key_ops`',
            [{ ...rsa, use: undefined, key_ops: ['encrypt'] }, ed],
            ['vector-ed25519'],
            skippedRsa('not-for-signing'),
        ),
        readCase(
            'jwks-unsupported-alg',
            'an `alg` this verifier does not implement — RS384 — is skipped',
            [{ ...rsa, alg: 'RS384' }, ed],
            ['vector-ed25519'],
            skippedRsa('unsupported-alg'),
        ),
        refusedCase('jwks-weak-rsa', 'a 1024-bit modulus, under the 2048 bits RFC 7518 §3.3 requires',
            [{ ...rsa, n: encodeBase64Url(Buffer.from(n, 'base64url').subarray(0, 128)) }, ed]),
        refusedCase('jwks-rsa-exponent-3', 'an exponent other than 65537', [{ ...rsa, e: 'Aw' }, ed]),
        refusedCase('jwks-non-canonical-n', '`n` respelled in its unused low bits: the same bytes under '
            + 'another string', [{ ...rsa, n: respellSegment(n) }, ed]),
        refusedCase('jwks-missing-kid', 'a key the verifier reads, with no kid to select it by',
            [{ ...rsa, kid: undefined }, ed]),
        refusedCase('jwks-duplicate-kid', 'two keys under one kid: which one verifies is a coin toss',
            [ed, { ...es, kid: 'vector-ed25519' }]),
        refusedCase('jwks-nothing-usable', 'every key skipped leaves a set that verifies nothing',
            [oct, { ...rsa, use: 'enc' }]),
        refusedCase('jwks-alg-contradicts-key', 'an RSA key labelled ES256 says two things about it',
            [{ ...rsa, alg: 'ES256' }, ed]),
        refusedCase('jwks-private-member', 'a published set carrying private key material',
            [{ ...ed, d: encodeBase64Url(Buffer.alloc(32, 1)) }, es]),
        refusedCase('jwks-certificate-only', 'an RSA key given only as a certificate thumbprint: the '
            + 'verifier reads `n` and `e`, not certificates',
        [{ kty: 'RSA', kid: 'vector-x5t', use: 'sig', x5t: encodeBase64Url(Buffer.alloc(20)) }, ed]),
    ];
}

/** A JSON object as it would be written: members set to `undefined` are absent. */
function withoutUndefined(jwk: Record<string, unknown>): Record<string, unknown>
{
    return Object.fromEntries(Object.entries(jwk).filter(([, value]) => value !== undefined));
}

/** Respell a base64url segment's last character in the bits no byte uses. */
function respellSegment(segment: string): string
{
    return respellSignature(`h.b.${segment}`).split('.')[2];
}

function parsedAs(set: JwksVector['set']): string
{
    try
    {
        const parsed = parseJwks(set);

        return JSON.stringify({ kids: [...parsed.keys.keys()], skipped: parsed.skipped });
    }
    catch
    {
        return JSON.stringify({ throws: true });
    }
}

/** Every JWK Set case whose recorded outcome is not what `parseJwks()` does. */
function jwksDisagreements(cases: JwksVector[]): string[]
{
    return cases.flatMap((item) => (parsedAs(item.set) === JSON.stringify(item.expect)
        ? []
        : [`${item.name}: means to record ${JSON.stringify(item.expect)}, `
            + `parseJwks says ${parsedAs(item.set)}`]));
}

const NOTE = 'Generated by contracts/signing/record-vectors.ts from packages/signing/src '
    + '(never dist). Regenerate with UPDATE_SIGNING_VECTORS=1 '
    + 'pnpm --filter @spfn/signing test vectors.';

/**
 * Build the whole file in memory.
 *
 * Throws rather than returning a file whose verdicts are this module's belief:
 * the point of the exercise is that they are the verifier's.
 */
export async function buildVectorFile(): Promise<VectorFile>
{
    const committed = committedTokens();
    const cases = [
        ...frozenCases(),
        ...ruleCases(),
        ...await rsaCases(),
        ...issuerCases(),
        ...prefixCases(),
    ];
    const vectors: Vector[] = [];

    for (const item of cases)
    {
        vectors.push(toVector(item, carriedEs256Token(item, await signCase(item), committed)));
    }

    const publicKeys = [await ED.publicKey(), await P256.publicKey()]
        .map(formatPublicKeyEntry)
        .join(',');
    const publicJwks = toJwks(await fixtureEntries());
    const jwks = jwksCases(publicJwks);
    const file = { note: NOTE, verifyAt: VERIFY_AT, publicKeys, publicJwks, vectors, jwks };
    const disagreed = [...disagreements(file), ...jwksDisagreements(file.jwks)];

    if (disagreed.length > 0)
    {
        throw new Error(
            `contracts/signing/vectors.json was not written — every vector must exercise the rule `
            + `it names:\n${disagreed.join('\n')}`,
        );
    }

    return file;
}

/** The file's exact text. Four-space JSON with a trailing newline, as committed. */
export function serializeVectorFile(file: VectorFile): string
{
    return `${JSON.stringify(file, null, 4)}\n`;
}

/** Build and write. The only thing in here that touches the working tree. */
export async function writeVectorFile(): Promise<VectorFile>
{
    const file = await buildVectorFile();

    writeFileSync(VECTORS_FILE, serializeVectorFile(file));

    return file;
}
