# @spfn/signing

> **One signer interface. Three places a private key can live. One token format.**
>
> Signs EdDSA and ES256. Verifies those two and RS256.

SPFN signs four different things — client request tokens, session envelopes, one-time SSE
tokens, and now bridge tokens read inside untrusted tenant containers — and until this
package they were signed three different ways, each of which assumed the private key was a
string sitting in the process. That assumption does not survive contact with a cloud KMS.

`@spfn/signing` is the `Signer` interface and the providers behind it. The key may be in
this process, in Google Cloud KMS, or in AWS KMS; the caller's code does not change, and
the token on the wire does not change.

```typescript
import { createSigner, timeClaims } from '@spfn/signing';

const signer = await createSigner({
    provider: 'local',
    kid: 'bridge-2026-08',
    alg: 'EdDSA',                                   // the default; omit it and you get this
    privateKey: { env: 'SPFN_BRIDGE_SIGNING_KEY' },
});

const token = await signer.sign({ sub: tenantId, ...timeClaims({ ttlSec: 300 }) });
```

```typescript
import { verifyJws } from '@spfn/signing/verify';

const result = verifyJws(token, process.env.SPFN_BRIDGE_PUBLIC_KEYS!, { maxAgeSec: 300 });

if (!result.ok)
{
    return deny(result.reason);     // 'expired' | 'bad-signature' | 'unknown-kid' | …
}
```

## Installation

```bash
pnpm add @spfn/signing
```

Nothing else. The KMS SDKs are optional peer dependencies — install one only if you use
that provider:

```bash
pnpm add @google-cloud/kms      # for provider: 'gcp-kms'
pnpm add @aws-sdk/client-kms    # for provider: 'aws-kms'
```

## The two entry points

| Import | Depends on | Use it when |
|---|---|---|
| `@spfn/signing` | `node:crypto`, plus one KMS SDK *if* you name that provider | you issue tokens |
| `@spfn/signing/verify` | `node:crypto`. Nothing else, ever | you check them |

The split is not tidiness. The code that verifies a bridge token runs inside a tenant
container, and every dependency it carries is a dependency that has to be shipped there
and trusted there. `@spfn/signing/verify` is a single file with one import, and a test
copies the built artifact somewhere with no `node_modules` above it and imports it there.

`verifyJws()` never throws on token input. A malformed token is a verdict, not an
exception — an attacker chooses the bytes, so the bytes cannot choose the control flow.

## Providers

| Provider | Key lives in | EdDSA (default) | ES256 | Construction |
|---|---|---|---|---|
| `local` | this process (env var, file, or a `KeyObject`) | yes | yes | synchronous, no I/O beyond the file |
| `gcp-kms` | Cloud KMS | yes — `EC_SIGN_ED25519` | yes — `EC_SIGN_P256_SHA256` | reads the key version's algorithm and public key |
| `aws-kms` | AWS KMS | yes — `ECC_NIST_EDWARDS25519` | yes — `ECC_NIST_P256` | reads the key's algorithm and public key |

**EdDSA (Ed25519) is the default.** It is the shorter key, the shorter signature, and the
signature scheme with no per-signature nonce to get wrong. ES256 stays fully supported and
is the right choice where something downstream only speaks ECDSA.

`sign()` returns a promise on every provider, `local` included. A KMS round trip is a
network call, and an interface that changes shape depending on where the key lives is not
one interface.

On both KMS providers the algorithm is the key's, not the caller's: construction reads the
key and takes the algorithm from its spec. Passing `alg` says what you expected, and a key
that disagrees is an error at construction rather than a surprise at first use.

Both providers also make the response agree with itself. Cloud KMS returns an algorithm
enum beside the PEM, and AWS returns a `KeySpec` beside the SPKI; neither API ties the
label to the key. When they disagree, construction fails and names both — signing with the
label while publishing the key would ask KMS for one algorithm and hand every verifier a
key for the other, and every token would then fail to verify for no visible reason.

### AWS KMS signs the message, not a digest

Both algorithms are sent with `MessageType: RAW`, which is what caps a signing input at
4 KiB. For ES256 that keeps the SHA-256 on the server side; for Ed25519 it is not a choice
at all — `ED25519_SHA_512` is PureEdDSA, which signs the message itself. The pre-hashed
`ED25519_PH_SHA_512` is a **different algorithm** producing a different signature, and this
package does not use it. An `ED25519_SHA_512` signature comes back as 64 raw bytes and is
already JOSE's form; only ECDSA's DER needs converting.

### sops, Secret Manager and Vault are not providers

They are *delivery*. Each one puts a value into an environment variable or a file before
the process starts, and `local` reads it from there. Nothing in this package decrypts
anything at runtime, holds a secret-manager client, or refreshes a lease. A provider is a
place a *private key* lives and signs; a secret manager is a place a *value* is stored.

```yaml
# sops-encrypted, decrypted by your deployment, never by this package
SPFN_BRIDGE_SIGNING_KEY: <base64url of the 32-byte seed>
```

## Key formats

A verifier is often a plain script with one environment variable, so the public key format
is a string a person can paste:

```
public-keys := entry ("," entry)*
entry       := kid ":" base64url(key)
kid         := [A-Za-z0-9._-]{1,128}
key         := 32 raw bytes             — Ed25519 public key       (EdDSA)
             | 65 bytes, 0x04 || X || Y — SEC1 uncompressed P-256  (ES256)
             | SPKI DER                 — either algorithm
```

```
bridge-2026-07:BFFcPW6545a5BNP-yn9U_c0…,bridge-2026-08:Kay64UG8yvCyLhqU000LxzY…
```

base64url is strict and **canonical**: no padding, no `+`, no `/`, and the unused bits in
the final character must be zero. `Buffer.from(text, 'base64url')` silently skips what it
cannot read and ignores those bits, which would let four different strings decode to the
same 32-byte key and sixteen to the same 64-byte signature. So every segment is matched
against the alphabet, decoded, re-encoded, and compared to what arrived — the encoding is
one-to-one or the input is refused.

A 33-byte compressed point is **refused**. By length alone it is indistinguishable from a
mistyped Ed25519 key, and `node:crypto` will not import a bare point anyway. Wrap it in
SPKI DER.

Private key material for `local` may be a PKCS#8 PEM, PKCS#8 DER, or 32 raw bytes — an
Ed25519 seed or a P-256 private scalar. The scalar is the reason `alg` is worth stating
rather than deriving: 32 bytes is both, and only you know which. Omitted, it is `EdDSA`,
and a key that turns out to be the other one is an error at construction.

## Tokens

JWS compact serialization (RFC 7515): `header.payload.signature`.

- `alg` is `EdDSA` or `ES256` for a token this package signs, and may also be `RS256` for
  one it only verifies ([RSA keys](#rsa-keys)). Nothing else, and `none` is simply an
  `alg` no key has.
- `kid` is **required** in the protected header.
- `typ` and `cty` are optional, and each is a string when present — a header
  that carries either as a number or an object is `malformed`.
- A duplicate JSON member, in the header or the payload, at any depth, is
  `malformed`. RFC 8259 leaves them undefined and `JSON.parse` keeps the last
  one, so `{"kid":"a","kid":"b"}` reads as one token here and another
  elsewhere. Names are compared unescaped, so `"a"` and `"\u0061"` are the
  same member.
- `crit` is rejected: this verifier implements no extensions, so RFC 7515 §4.1.11 says it
  must refuse rather than guess. `sign()` refuses to *write* one for the same reason — a
  token your own verifier calls `malformed` is a bug to catch at the signer.
- The payload is yours. `timeClaims()` and `withTimeClaims()` will build `iat` / `exp` /
  `nbf` for you; nothing requires you to use them.
- ES256 signatures are JOSE `r || s`, 64 bytes, on every provider — never DER.
  The DER a KMS returns is parsed strictly on the way in: exact lengths, no
  trailing bytes, minimally encoded non-negative integers, nothing wider than
  the curve. There is one encoding of a signature, so there is one token.

### The algorithm comes from the key, not the token

`kid` selects the key. That key's algorithm is the algorithm. The header's `alg` is then
checked for *equality* with it and used for nothing else. This is what makes algorithm
confusion — including `alg: "none"` — a `alg-mismatch` rather than a decision. The same
holds across key families: an `RS256` header naming an Ed25519 key, or an `EdDSA` header
naming an RSA key, is `alg-mismatch` before any signature is looked at.

### Verification

```typescript
verifyJws(token, keys, {
    now?, clockSkewSec = 30, maxAgeSec?,
    issuedWithinSec?, issuer?, audience?,
})
```

`keys` is the `kid:key,…` string, a `PublicKeyEntry`, an array of them, a `Map`, a
`KeyRing`'s `publicKeys()`, or — for keys you did not issue — an `RsaPublicKeyEntry`, a JWK
Set, or the `keys` of a parsed one.

| `reason` | Means |
|---|---|
| `malformed` | not three canonical base64url segments, or no JSON header with a `kid`, or a `crit` header, or a payload that is not a JSON object |
| `invalid-claims` | the signature is yours, but a time claim is present and is not a finite number, or `iat` is after `exp` |
| `unknown-kid` | the header names a key this verifier does not hold |
| `alg-mismatch` | the header's `alg` is not that key's algorithm |
| `bad-signature` | the signature does not verify over the bytes received |
| `expired` | `exp` is in the past by more than the skew |
| `not-yet-valid` | `nbf` is in the future by more than the skew, or — under `maxAgeSec` — so is `iat` |
| `too-old` | the token granted itself a longer life (`exp - iat`) than `maxAgeSec` |
| `no-expiry` | `maxAgeSec` was set and the token omits `exp` or `iat`; or `issuedWithinSec` was set and it omits `iat` |
| `wrong-issuer` | `issuer` was set and `iss` is not one of the issuers given |
| `no-issuer` | `issuer` was set and the token has no `iss` |
| `wrong-audience` | `audience` was set and no `aud` value matches it |
| `no-audience` | `audience` was set and the token has no `aud`, or an empty array of them |

With `issuedWithinSec`, `issuer` and `audience` all unset, `iss` and `aud` are never read
and every verdict is what it was before those options existed.

`maxAgeSec` bounds how long a token is *accepted*: at most that many seconds of life,
starting no later than now. It needs **both** `exp` and `iat` to say so, and it checks
three things, each of which is a way around the other two:

- `iat` is not in the future — `not-yet-valid`. Bounding only `exp - iat` would let a
  sixty-second token dated thirty years ahead through today *and* thirty years from now,
  because a forward-dated token carries its acceptance window with it.
- `exp` does not precede `iat` — `invalid-claims`.
- `exp - iat` is at most `maxAgeSec` — `too-old`.

A token missing either claim is refused rather than exempted (`no-expiry`): a caller sets
the option because a token of unbounded life is not acceptable here, and a policy that
silently skips itself is not one.

`exp`, `nbf` and `iat` must be finite numbers when they are present at all. `exp:
"1800000000"` is `invalid-claims`, not "no expiry given" — a separate reason from
`malformed` because a signature-valid token with a broken claim is your issuer's bug, and
three bytes of garbage is somebody else's traffic. The clock is read before the policy, so
a token that is simply dead reports `expired` rather than `no-expiry`.

The signature is checked over the exact `header.payload` bytes that arrived. The payload is
never re-serialized first, so a token stays valid regardless of how a JSON library would
have ordered its keys — and a re-serialized payload with the original signature is
correctly rejected.

**There is no size limit here.** A 1 MiB payload signs and verifies. If you read tokens off
a network, cap the length before you call — that is a decision to make on purpose, not one
to inherit.

### Issuer, audience and issue date

These three run **after** every check above, in this order: `issuedWithinSec`, `issuer`,
`audience`. Setting them never changes why a token is refused — it only refuses some tokens
that would otherwise have been accepted.

- `issuer: string | string[]` — `iss` must be one of these. Missing is `no-issuer`, a
  different string is `wrong-issuer`, a non-string is `invalid-claims`.
- `audience: string | string[] | { prefix, rest }` — `aud` may be a string or an array of
  strings (RFC 7519 §4.1.3); one value matching is enough, and the successful verdict
  carries it as `audience`. Missing or an empty array is `no-audience`, no match is
  `wrong-audience`, and `aud` that is neither a string nor an array of strings is
  `invalid-claims` — one non-string member is enough.
- `issuedWithinSec: number` — `iat` no more than that many seconds ago, plus the skew:
  `too-old` beyond it, `no-expiry` without `iat`. A token with a lifetime of an hour can
  still be required to have been issued within the last five minutes, which `maxAgeSec`
  cannot say. An `iat` further ahead than the skew is `not-yet-valid`, for the reason
  `maxAgeSec` refuses one: a forward-dated token carries its acceptance window with it.

An empty list, an empty string, or a negative `issuedWithinSec` is a configuration error and
throws, as bad keys do.

### Per-request audiences

Some audiences carry a value that differs per request — a callback URL that ends in a
one-time nonce, say. They cannot be compared exactly, so `audience` also takes a prefix and
a pattern for what follows it:

```typescript
const result = verifyJws(token, keys, {
    audience: { prefix: 'https://issuer.example/register/', rest: /^[0-9a-f]{32}$/ },
});

if (result.ok)
{
    const nonce = result.audience!.slice('https://issuer.example/register/'.length);
}
```

- `rest` must be anchored: its source starts with `^` and ends with an unescaped `$`, and
  it may carry no flag but `u` or `v`. Anything else throws on every call. An
  unanchored pattern would let `…/register/<nonce>/../report` through because it merely
  *contains* a match.
- `rest` is also evaluated as `^(?:rest)$`, so a top-level alternation (`^a|b$`) cannot
  slip out of its anchors.
- An empty remainder is `wrong-audience` whatever `rest` accepts.
- The prefix is compared as a string. End it at a boundary — `/`, `:` — or let `rest`
  draw one: `https://issuer.example/a` is also a prefix of `https://issuer.example/ab…`.
- `rest` is yours, and it runs on every request against attacker-chosen text. Keep it a
  character class and a length; a pattern that backtracks catastrophically is a denial of
  service this package cannot see.

**If you keep a replay store, spend the nonce only after every other check has passed** —
signature, time claims, issuer, audience, and your own. A request refused for any other
reason must not burn a nonce the legitimate caller still holds, and `verifyJws()` returning
`ok` is the earliest point at which spending it is safe.

## Verifying tokens you did not sign

An OIDC issuer publishes its public keys as a JWK Set and signs with RS256. This package
verifies those tokens with the same verifier and the same verdicts; what it does not do is
fetch the set. There is no HTTP here — fetching, caching and refreshing the set is the
caller's.

```typescript
import { parseJwks, verifyJws } from '@spfn/signing/verify';

const { keys, skipped } = parseJwks(await response.text());    // once per fetch, not per token

const result = verifyJws(token, keys, {
    issuer: 'https://issuer.example',
    audience: 'https://api.example',
    issuedWithinSec: 300,
});
```

**Never accept a token you did not sign without `issuer` and `audience`.** Every client of
that issuer holds a token its keys verify; the audience is what says the token was meant
for you.

`verifyJws()` also accepts the JWK Set object itself, and parses it on every call — every
key imported again for every token. Parse it once per fetch with `parseJwks()` and reuse
`.keys`. Pass `.keys`, not what `parseJwks()` returns: that object is not a key source, and
`verifyJws()` throws on it.

### RSA keys

Verify only. This package never signs RS256: an RSA signature is four times the size of an
Ed25519 one for no gain on tokens you issue, and a signer that can produce three algorithms
is three algorithms to rotate. RSA is here because issuers you do not control use it.

| Rule | Value | Why |
|---|---|---|
| Modulus | 2048–8192 bits | the floor is RFC 7518 §3.3; the ceiling bounds what one request costs |
| Exponent | 65537 (`AQAB`) only | every mainstream issuer uses it, and small exponents have a history of forgeries |
| Padding | PKCS#1 v1.5 only | that is RS256; PSS is `PS256`, another algorithm, and is not accepted |
| Signature length | exactly the modulus length | a signature with its leading zero bytes stripped is the same number — accepting it would give one token two encodings. Nothing is left-padded |

An RSA key reaches the verifier through a JWK Set or through
`rsaPublicKeyEntry(kid, keyObjectOrJwk)`. The `kid:key` string format does **not** take
RSA keys and still refuses them: it is the format of keys this package hands out.

An RSA key decides its algorithm like any other. It verifies `RS256` and nothing else, and
an entry that labels an RSA key `EdDSA` or `ES256` throws. Every hand-built entry is held to
the same rule: its `alg` must be the algorithm its key verifies, so an `rsa-pss`, P-384 or
secp256k1 key throws whatever it is labelled, and so does an entry with no string `kid` or
no `KeyObject`.

### JWK Sets

`parseJwks(set)` takes the set as JSON text or as a parsed object and returns
`{ keys, skipped }`. Pass the text when you have it: duplicate members are refused as they
are in a token, and a parsed object has already lost them.

| Input | Result |
|---|---|
| `kty` `RSA`, `OKP` with `Ed25519`, `EC` with `P-256` | read |
| an unknown `kty` (`oct`, anything new), an unknown curve (`X25519`, `Ed448`, `P-384`) | skipped |
| `use` other than `sig`, or `key_ops` without `verify` | skipped |
| an `alg` this package does not verify (`RS384`, `PS256`, …) | skipped |
| an `alg` the key contradicts (`kty: RSA` with `alg: ES256`) | throws |
| a read key without a `kid`, or two with the same one | throws |
| broken material: non-canonical base64url, `n` with a leading zero byte, `e` other than `AQAB`, a weak RSA key, a point off the curve | throws |
| private members (`d`, `p`, `q`, …) on a key of a kind this package reads | throws |
| a key given only as a certificate (`x5c`, `x5t`) | throws — `n` and `e` are what is read |
| no usable key left after skipping | throws |
| more than 64 keys, or JSON text over 64 KiB | throws |

Unknown kinds are skipped because RFC 7517 §5 asks for exactly that, and because issuers
add new kinds of key to their sets: an encryption key appearing next to yours must not stop
your verification. A skipped key verifies nothing — its tokens are `unknown-kid` — so
skipping costs no safety.

A broken key of a kind this package reads refuses the whole set, because it is not someone
else's kind of key: it is a broken or substituted one. Dropping it quietly would turn it
into an `unknown-kid` nobody can trace. Treat the throw as "this fetch is bad" and keep the
set you had.

A JWK Set's `kid` is any 1–128 printable ASCII characters without whitespace — wider than
the string format's, since it never passes through the `kid:key` separator.

## Purposes

An application usually issues more than one kind of token. `definePurposes()` declares them,
and keeps each one's tokens out of every other one's verifier: each purpose owns its keys
(every kid starts with its `kidPrefix` and a dash) and its audience (every token it signs
carries it, and its verifier requires it).

```typescript
import { definePurposes } from '@spfn/signing';

const purposes = definePurposes({
    api: { kidPrefix: 'api', audience: 'https://issuer.example/api', maxTtlSec: 300 },
    webhook: {
        kidPrefix: 'whk',
        audience: 'https://issuer.example/webhook',
        scoped: true,                   // aud = `${audience}:${scope}`
        maxTtlSec: 60,
        typ: 'webhook+jwt',
    },
});

// kid:alg:provider:ref, separated by commas or newlines
const loaded = await purposes.load({
    api: 'api-2026-09:EdDSA:gcp-kms:projects/p/locations/l/keyRings/r/cryptoKeys/api/cryptoKeyVersions/3',
    webhook: process.env.WEBHOOK_SIGNING_KEYS!,   // whk-2026-09:EdDSA:local:<base64url PKCS#8>
});

const token = await loaded.signer('api').sign({ sub: userId });          // aud, iat, exp written
const check = loaded.verifier('webhook', { scope: 'tenant-7' });         // its keys, its aud, its TTL
```

- `load()` throws when one public key appears twice — in two purposes, or twice in one —
  when a kid lacks its purpose's prefix, when a purpose holds more than `maxKeys` (default 2:
  one rotation in flight), and when a KMS key is not the algorithm its line names. Two
  purposes sharing a `kidPrefix` or an audience are refused by `definePurposes()` itself.
- A purpose's signer writes `aud`, `iat` and `exp`, refuses claims that carry any of them,
  and refuses a `ttlSec` above `maxTtlSec`.
- `verifier()` pins the purpose's keys, its audience, and `maxAgeSec: maxTtlSec`.
  `purposeVerifier(spec, keys)` in `@spfn/signing/verify` builds the same thing where only
  the verifier runs.
- `exclude: [kid]` on `publicKeys()`, `jwks()` and `verifier()` takes a retired key out.
  Which keys are retired, and which kid signs (`signer(name, { kid })`), is the caller's to
  remember — there is no storage here.
- No error message quotes a key configuration line: a `local` line carries a private key.

## Rotation

A `KeyRing` holds up to `maxKeys` public keys (default 2) and knows which one signs. Both
`keys` and `publicKeys()` hand out a copy — a real one, not a `ReadonlyMap` type a cast
would walk through — so the ordering below is the only way the set changes. The order is the whole design:

```
add  →  switch  →  wait(maxTokenTtl)  →  remove
```

Skip `add` and verifiers reject tokens from a key they have not been told about. Skip
`wait` and you strand every token the old key signed that has not expired yet. Both are
outages, so `KeyRing` refuses to remove the current key and `rotate()` will not run the
steps out of order.

```typescript
import { generateLocalKeyPair, KeyRing, rotate } from '@spfn/signing';

const ring = KeyRing.fromPublicKeysString(process.env.SPFN_BRIDGE_PUBLIC_KEYS!);
let plan = {
    incoming: { kid: 'bridge-2026-09', alg: 'EdDSA', public: newPublicKey },
    outgoing: 'bridge-2026-08',
    maxTokenTtlSec: 300,
};

// Once per deployment step; persist `plan` in between.
({ plan } = rotate(ring, plan));

// Hand this to every verifier.
process.env.SPFN_BRIDGE_PUBLIC_KEYS = ring.toPublicKeysString();
```

`shouldRotate(createdAt, rotationDays)` answers whether a key is old enough to replace, and
warns seven days out. `@spfn/auth` keeps its own `shouldRotateKey`, which answers the same
question: six lines of date arithmetic are not worth a runtime dependency between two
published packages, and the ordering constraint that would come with one.

## Test vectors

`contracts/signing/vectors.json` holds forty tokens — valid, expired and corrupted for each
algorithm, EdDSA first, then one per rule, RS256 and the issuer and audience options — with
the public keys that verify them and the verdict each must produce, and a block of JWK Sets
with what `parseJwks()` makes of each. It is
generated from fixed key material by `src/vectors.test.ts`, which also re-runs the
generation on every test run and compares. Regenerate with:

```bash
UPDATE_SIGNING_VECTORS=1 pnpm --filter @spfn/signing test
```

ECDSA picks a fresh nonce per signature, so an ES256 token is never byte-stable; the
comparison covers the keys, headers and payloads, and the committed tokens are checked by
verifying them. Ed25519 and RSA PKCS#1 v1.5 signatures are deterministic, so every other
vector is compared byte for byte.

## Migrating `@spfn/auth`'s client tokens

`generateClientToken()` in `@spfn/auth` signs an ES256 JWT with `jsonwebtoken` from a
base64 DER private key. It maps onto this package directly — a `LocalSigner` with an
explicit `alg: 'ES256'`, the DER as its key material, and `timeClaims({ ttlSec })` for the
`exp` it currently spells `expiresIn` — with two differences to work through first:

1. `jsonwebtoken` writes `typ: 'JWT'` and sets `iss` by default. Both are expressible here
   (`sign(payload, { typ: 'JWT' })` and an `iss` claim), but they have to be written down
   rather than inherited.
2. Client tokens today carry no `kid`, and this package requires one. Existing clients
   need a rollout that accepts both shapes before the old one is dropped.

That migration is **not** part of this package's first release, and nothing in `@spfn/auth`
changed for it.

## API

### `@spfn/signing`

- `createSigner(config)` — `{ provider: 'local' | 'gcp-kms' | 'aws-kms', … }` → `Promise<Signer>`.
  This is the only way to reach the KMS providers: their modules are loaded on demand, so
  a `local`-only process never parses them, let alone imports an SDK.
- `LocalSigner` — the local provider directly, when a promise buys you nothing
- `generateLocalKeyPair(alg?)` — a fresh key pair; Ed25519 unless you say otherwise
- `KeyRing`, `rotate()`, `rotationStage()`, `shouldRotate()`
- `timeClaims()`, `withTimeClaims()`, `signCompact()`, `CompactSigner`
- `derSignatureToJose()` — DER `SEQUENCE { r, s }` → JOSE `r || s`
- `definePurposes(specs)` → `{ names, spec(), parseKeyConfig(), load() }`; `load(config)` →
  `{ signer(), publicKeys(), jwks(), verifier() }`
- everything below

### `@spfn/signing/verify`

- `verifyJws(token, keys, options?)` → `{ ok: true, header, payload, audience? } | { ok: false, reason }`
- `parseJwks(set)` → `{ keys, skipped }`; `rsaPublicKeyEntry(kid, keyObjectOrJwk)`
- `purposeVerifier(spec, keys, { scope?, clockSkewSec? })` → `(token, now?) => VerifyResult`
- `parseCompact(token)` → the parts and the signed bytes, or `null`
- `parsePublicKeys()`, `parsePublicKeyEntry()`, `formatPublicKeys()`, `formatPublicKeyEntry()`
- `publicKeyToJwk()`, `toJwks()`, `rawPublicKey()`, `algorithmOf()`
- `encodeBase64Url()`, `decodeBase64Url()` — strict, unpadded

## Requirements

Node ≥ 20.19. The constraint is `require(esm)`. This package ships ESM only, and
`scripts/check-exports-require.mjs` requires every subpath to declare a `require` condition
so a CommonJS consumer — `spfn dev` loads `server.config.ts` through tsx's CJS register —
can resolve it. Both conditions point at the same ESM file, and `require()`-ing ESM is what
Node supports from 20.19. Nothing in the cryptography needs a recent Node: Ed25519 and
`dsaEncoding: 'ieee-p1363'`, which is how ES256 signatures come out in JOSE form without a
WebCrypto detour, have both been there since Node 12.

`engines` says `>=20.0.0`, which is the floor for the package's *code*; 20.19 is the floor
for the `require()` interop the repository tests. Node 20 left maintenance on 2026-04-30,
so 22 is the line to be on.

## Changelog

### 0.1.0-alpha.2

Added: RS256 verification, JWK Set input (`parseJwks()`, `rsaPublicKeyEntry()`), the
`issuer`, `audience` and `issuedWithinSec` options, and purposes.

**Changed behaviour.** Default-option verdicts on well-formed key sources are unchanged.
Mislabelled hand-built entries now throw at configuration:

- An entry whose `alg` is not the algorithm its key verifies throws when `verifyJws()` reads
  it. In 0.1.0-alpha.1, `{ kid, alg: 'EdDSA', public: <RSA key> }` in a `Map` or an array
  verified an RSA PKCS#1 v1.5 signature under an `EdDSA` header as `ok: true`; it now
  throws. So do entries holding a key this package does not verify (`rsa-pss`, P-384,
  secp256k1), whatever their label.
- An entry without a string `kid` or a `KeyObject` `public` throws — for instance the
  result of `parseJwks()` passed where its `.keys` belongs.

**Types.**

- `verifyJws()` has two overloads: a `PublicKeySource` gives `VerifyResult` (EdDSA or ES256
  headers), any other `VerifyKeySource` gives `VerifyResult<VerifyAlgorithm>` (RS256
  included). `ReturnType<typeof verifyJws>` takes the last overload, so it is now the wide
  type; name `VerifyResult` directly if you want the narrow one. The overloads stay in this
  order because TypeScript picks the first that matches: with the wide one first, a call
  with a `PublicKeySource` would resolve to the wide result too.
- `VerifyFailureReason` gained `wrong-audience`, `no-audience`, `wrong-issuer` and
  `no-issuer`. They are returned only when the matching option is set, but an exhaustive
  `switch` over the type must handle them.

## License

MIT
