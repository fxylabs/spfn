# Signing test vectors

`vectors.json` is what an implementation of SPFN's token format checks itself
against: forty tokens, the public keys that verify them, and the verdict each
one must produce — plus a block of JWK Sets and what a verifier must make of
each. It is **generated output** — do not edit it by hand.

| File | What it is |
|---|---|
| `vectors.json` | The vectors, their public keys, and the expected verdict of each |
| `record-vectors.ts` | The generator that writes it, and the only place the cases are declared |

## Regenerating

```bash
UPDATE_SIGNING_VECTORS=1 pnpm --filter @spfn/signing test vectors
```

`record-vectors.ts` imports the verifier from `packages/signing/src`, never
from `dist` — a published build lags its sources, and a stale oracle records
stale verdicts. Those sources import each other extensionlessly, which node
cannot resolve on its own, so vitest is the runner:
`packages/signing/src/vectors.test.ts` calls the generator, compares what comes
back with the committed file, and writes only under that variable.

Every case declares the reason it means to exercise, and the generator refuses
to write anything if the verifier disagrees with even one of them. A rule that
changes upstream therefore breaks the recording rather than being quietly
re-recorded, which is the whole point: the verdicts in this file are the
verifier's and never the generator's opinion of what they should be.

## The vectors

`kid` and `alg` name the key that produced the signature, not what the header
claims — eight of these vectors exist precisely because those two disagree.
Vectors that need a policy to reach their rule carry their own `options`;
everything else is judged with the defaults at `verifyAt`.

Vectors 1–20 are verified against `publicKeys`, the `kid:key` string. Vectors
21–40 carry `kids`, and are verified against the members of `publicJwks` with
those kids — `publicJwks` is every fixture key as a JWK Set, including the RSA
key the string format cannot carry. A prefix audience is written
`{ "prefix": …, "rest": "<regular expression source>" }`; the expression is
compiled from that source. A successful verdict under an `audience` option
records the `aud` value it matched as `audience`.

| # | Vector | Verdict | The rule it holds in place |
|---|---|---|---|
| 1 | `ed25519-valid` | `ok` | the anchor: a well-formed token on the default algorithm |
| 2 | `ed25519-expired` | `expired` | `exp` in the past, beyond the skew |
| 3 | `ed25519-bad-signature` | `bad-signature` | one flipped bit in a signature that is otherwise this key's |
| 4 | `es256-valid` | `ok` | the anchor on the other algorithm |
| 5 | `es256-expired` | `expired` | as 2, on ES256 |
| 6 | `es256-bad-signature` | `bad-signature` | as 3, on ES256 |
| 7 | `non-canonical-base64url` | `malformed` | the last character of a segment carries bits no byte uses, so sixteen strings decode to the same 64 bytes; a token that can be rewritten without invalidating it cannot key a one-time-use set |
| 8 | `duplicate-header-member` | `malformed` | RFC 8259 §4 leaves duplicate members undefined and `JSON.parse` keeps the last, so this header is `EdDSA` to one reader and `none` to another |
| 9 | `duplicate-payload-member` | `malformed` | the same scan on the payload, which a port that only checked the header would let through |
| 10 | `crit-present` | `malformed` | `crit` names extensions a verifier must understand; this one implements none, so RFC 7515 §4.1.11 says refuse rather than guess |
| 11 | `typ-not-string` | `malformed` | `typ` is a media type (RFC 7515 §4.1.9); `typ: 5` hands every caller a value its own type says cannot be there |
| 12 | `cty-not-string` | `malformed` | the same rule for `cty` (RFC 7515 §4.1.10) |
| 13 | `alg-none` | `alg-mismatch` | `alg` is only ever compared to the **key's** algorithm, so `none` is a mismatch and never an invitation to skip the check |
| 14 | `alg-not-the-keys` | `alg-mismatch` | the same comparison with a real algorithm: an ES256 header over the Ed25519 key |
| 15 | `unknown-kid` | `unknown-kid` | the header names a key the verifier does not hold — a verdict of its own, not a bad signature |
| 16 | `iat-after-exp` | `invalid-claims` | a token that expired before it was issued: no clock makes both claims true |
| 17 | `non-finite-claim` | `invalid-claims` | `exp: 1e999` parses to `Infinity`; treating a present-but-unusable `exp` as "no expiry given" turns a typo into an immortal token |
| 18 | `not-yet-valid` | `not-yet-valid` | `nbf` an hour ahead, well beyond the default 30 seconds of skew |
| 19 | `too-old` (`maxAgeSec: 300`) | `too-old` | a token that granted itself a longer life than the caller allows |
| 20 | `no-expiry` (`maxAgeSec: 300`) | `no-expiry` | under `maxAgeSec` a missing `exp` leaves the lifetime uncomputable, so it is a refusal and not an exemption |
| 21 | `rs256-valid` | `ok` | the anchor for RSA keys |
| 22 | `rs256-expired` | `expired` | the same clock rules on RSA |
| 23 | `rs256-bad-signature` | `bad-signature` | one flipped bit |
| 24 | `rs256-header-on-ed25519-key` | `alg-mismatch` | an Ed25519 key does not verify RS256 |
| 25 | `ed25519-header-on-rsa-key` | `alg-mismatch` | an RSA key verifies RS256 and nothing else |
| 26 | `rs256-short-signature` | `bad-signature` | a valid signature with its leading zero byte stripped: a signature must be exactly the modulus length, or one token has two encodings |
| 27 | `audience-wrong` (`audience`) | `wrong-audience` | `aud` is compared exactly |
| 28 | `audience-missing` (`audience`) | `no-audience` | a missing `aud` is not an exemption |
| 29 | `audience-in-array` (`audience`) | `ok`, `audience` | RFC 7519 lets `aud` be an array; one member matching is enough |
| 30 | `issuer-wrong` (`issuer`) | `wrong-issuer` | the same rule for `iss` |
| 31 | `issuer-missing` (`issuer`) | `no-issuer` | a missing `iss` is not an exemption |
| 32 | `issued-too-long-ago` (`issuedWithinSec: 300`) | `too-old` | inside its own lifetime, but issued earlier than the caller accepts |
| 33 | `cross-purpose` (one purpose's kid) | `unknown-kid` | a verifier holding one purpose's keys does not hold another's |
| 34 | `cross-purpose-same-key` (`audience`) | `wrong-audience` | if one key served two purposes, `aud` still keeps their tokens apart |
| 35 | `audience-prefix-ok` (`{ prefix, rest: ^[0-9a-f]{32}$ }`) | `ok`, `audience` | the anchor for a per-request audience |
| 36 | `audience-prefix-other-path` | `wrong-audience` | a well-formed remainder after a different path |
| 37 | `audience-prefix-empty-rest` (`rest: ^[0-9a-f]*$`) | `wrong-audience` | an empty remainder is refused whatever `rest` accepts |
| 38 | `audience-prefix-rest-mismatch` | `wrong-audience` | a remainder of the wrong shape |
| 39 | `audience-prefix-extra-path` | `wrong-audience` | `rest` must match the whole remainder |
| 40 | `audience-prefix-missing` | `no-audience` | a missing `aud` is not an exemption under a prefix either |

### JWK Sets

The `jwks` block holds JWK Sets rather than tokens: a set is configuration, and
its verdict is the kids read and the keys skipped (`{ kids, skipped }`), or a
refusal of the whole set (`{ throws: true }`). A key of a kind the verifier
does not read is skipped; a key of a kind it reads that is broken refuses the
set.

| Set | Expected | The rule it holds in place |
|---|---|---|
| `jwks-one-of-each` | three keys | RSA, OKP Ed25519 and EC P-256 are read |
| `jwks-unknown-kty` | three keys, two skipped | an unknown `kty` (`oct`) and an unknown curve (`X25519`) are skipped, not refused |
| `jwks-use-enc` | one key, one skipped | `use` other than `sig` |
| `jwks-key-ops-without-verify` | one key, one skipped | `key_ops` without `verify` |
| `jwks-unsupported-alg` | one key, one skipped | an `alg` the verifier does not implement (`RS384`) |
| `jwks-weak-rsa` | throws | a 1024-bit modulus |
| `jwks-rsa-exponent-3` | throws | an exponent other than 65537 |
| `jwks-non-canonical-n` | throws | `n` respelled in its unused bits |
| `jwks-missing-kid` | throws | a read key with no kid |
| `jwks-duplicate-kid` | throws | two read keys with one kid |
| `jwks-nothing-usable` | throws | nothing left after skipping |
| `jwks-alg-contradicts-key` | throws | `kty: RSA` with `alg: ES256` |
| `jwks-private-member` | throws | private key material in a published set |
| `jwks-certificate-only` | throws | a key given only as a certificate thumbprint |

Every member of `VerifyFailureReason` appears at least once. The list
`vectors.test.ts` checks against is not typed out by hand — it is the keys of a
`Record<VerifyFailureReason, true>`, which stops compiling as soon as the union
grows. A new reason therefore fails `pnpm type-check` until it is named there,
and then fails the test until it has a vector of its own.

## What is not here

A vector is one token judged at one fixed instant, so three of the verifier's
behaviours cannot be expressed as one and stay verifier tests in
`packages/signing/src/jws.test.ts` rather than being forced into this file:

- **`now` defaulting to the system clock.** Every vector is judged at
  `verifyAt`, because a file whose verdicts depend on the day it is replayed is
  not a fixed point.
- **A token that is not a string.** `verifyJws(42, keys)` is `malformed`, and a
  JSON `token` member cannot be `42` and still be a token.
- **Key configuration that throws.** A malformed public-key string is the
  deployment's bug, not a verdict about a token, so there is nothing to record.

## Stability

The key material behind these vectors is three fixed 32-byte constants and one
fixed 2048-bit RSA key in `record-vectors.ts`. They are throwaway values used
for nothing else, which is why the private halves are reproducible and are not
stored here. The RSA key is spelled out as PKCS#8 because `node:crypto` cannot
seed RSA key generation.

`verifyAt` is the instant every vector is judged at, so `expired` stays expired
and `valid` stays valid however long this file lives.

Vectors 1–6 are **frozen**. Downstream repositories hold a byte copy of them as
a fixture, refreshed by copying this file again and reading the diff, so a
token that changed here would be a diff nobody could review. New vectors and
blocks are only ever appended, so that diff stays readable. They carry no `why` member for the same reason: an
added member is a changed byte. `vectors.test.ts` pins all six tokens and the
public keys, out of line, so a change to them fails rather than regenerates.

ECDSA chooses a fresh nonce for each signature, so vectors 4–6 are not
reproducible byte for byte. The generator carries their committed signatures
over whenever the header and payload it built are unchanged, which is what
makes a re-run produce an identical file; the carried signatures still go
through the verifier alongside every other vector, so one that stopped meaning
what its vector claims fails the run rather than being carried past it. For
`es256-bad-signature` that verifier pass proves less than it looks: any wrong
signature over those bytes is `bad-signature`, so what actually holds vector 6's
exact signature in place is the frozen-token pin in `vectors.test.ts` and
nothing else. Everything else is Ed25519 or RSA PKCS#1 v1.5, both of which sign
the same bytes the same way every time.

## Shipping

`vectors.json` is not in the `@spfn/signing` tarball: the package's `files` is
`dist`, `README.md` and `LICENSE`, and this directory is above the package root
where npm cannot reach it anyway. A downstream consumes these vectors by
copying the file out of this repository, not by installing the package.
