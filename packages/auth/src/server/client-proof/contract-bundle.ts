/**
 * The mobile contract bundle — what spfn-mobile's Swift/Kotlin codegen reads.
 *
 * SPFN primitives owns the contract; this module assembles the bundle so the
 * export is produced here rather than transcribed in the consumer. Two kinds of
 * value go into it:
 *
 * - **Derived.** Operations, wire headers, proof-input fields, replay window,
 *   HTTP statuses and core.time's response shape are read from the modules that
 *   implement them. Changing the server changes the export.
 * - **Declared.** The remaining type shapes, error summaries and prose that
 *   describes canonicalization and admission are written here. No runtime value
 *   carries them. `contract-export.test.ts` runs the real decoders and encoders
 *   against every declaration, so one that stops describing the server fails.
 *
 * @module server/client-proof/contract-bundle
 */
import { createHash } from 'node:crypto';

import {
    CORE_TIME_OPERATION_ID,
    ServerTimeResponseSchema,
} from '@spfn/core/server';

import { KEY_TTL_DAYS } from '../lib/key-policy';
import { KEY_ALGORITHM, KEY_PLATFORM } from '../types';
import { CLIENT_PROOF_CONTENT_TYPE, CLIENT_PROOF_HEADERS } from './admission';
import {
    AUTH_SURFACE_OPERATIONS,
    CONTRACT_OPERATIONS,
    CORE_PREREQUISITE_OPERATIONS,
    IMPORTED_CORE_TIME_CONTRACT,
} from './contract-types';
import {
    CLIENT_PROOF_PROFILE,
    DEFAULT_REPLAY_WINDOW_MILLIS,
    PROOF_INPUT_FIELDS,
    PROOF_INPUT_SEPARATOR,
} from './proof';
import { CLIENT_PROOF_ERROR_CODES, HTTP_STATUS } from './refusal';
import { CLIENT_IDENTITY_HEADERS, CLIENT_KINDS, SERVER_CONTRACT_HEADERS } from './wire-headers';

/**
 * The version this export publishes. A mistake becomes a new version.
 *
 * The line is 0.x on purpose. The contract has one consumer, it is still
 * alpha, and its first export shipped a type spelling the consumer could not
 * parse — a surface that green has not earned a stable major. Under 0.x a
 * breaking change is a minor bump, which is what that correction actually was;
 * publishing it as 1.0.1 called a breaking change a patch.
 *
 * 1.0.0 and 1.0.1 existed briefly and are withdrawn. Neither was consumed.
 *
 * 0.2.0 revises the proof mechanism from HMAC-SHA-256 (a shared key) to ECDSA
 * P-256 (a registered public key) — breaking, hence a minor bump, taken while
 * the consumer count is zero. The proof-input, wire headers, admission order
 * and error codes are unchanged.
 *
 * 0.3.0 exports the existing `/_auth` enrollment surface (register, login,
 * native OAuth, key rotation) as contract operations, introduces the unproven
 * operation class (`authProfile: 'none'`), the `boolean` scalar the enrollment
 * responses need, and the key-TTL metadata. A surface addition under 0.x is a
 * minor bump. The clientProofV1 profile itself is unchanged from 0.2.0.
 *
 * 0.3.1 adds the optional `accessToken` field to `OauthNativeRequest`, which
 * Kakao needs to resolve an email claim its id_token omits. A patch, not a
 * minor: nothing existing changes meaning, a generated consumer that never
 * sends the field still matches the server, and the supported range is
 * unchanged — so a consumer pinned at 0.3.0 stays inside it rather than
 * falling out of a range it is in fact still compatible with.
 *
 * 0.4.0 binds `OauthNativeRequest.nonce` to the key being enrolled: it must be
 * the `fingerprint` of the submitted `publicKey`. The field list is untouched,
 * but a consumer that mints a random nonce is now refused, so this is breaking
 * and the range moves with it. Without the binding a valid id_token is enough
 * to enroll any key — the token is bearer-shaped and travels, while the web
 * OAuth flow keeps its key inside CSRF-bound encrypted state.
 *
 * 0.4.1 adds the key-management operations (list, revoke, revoke-all) and the
 * types they carry. A patch: existing operations and types are untouched, and a
 * consumer generated against 0.4.0 keeps matching the server, so the supported
 * range does not move. All three are POST with their arguments in the body —
 * the proof signs body bytes, which have a canonicalization rule, while a value
 * in the path does not.
 *
 * 0.4.2 gives the REST surface a readable failure: every error response now
 * carries the `{"error":{"code","message","requestId"}}` envelope next to the
 * web fields, and `auth.enroll.oauthNative`'s twelve refusals are listed as
 * codes with their status and retryability. A patch: no request or response
 * type moves, and a consumer generated against 0.4.1 could not read these
 * failures at all — it saw one undecodable body whatever went wrong — so
 * nothing it relies on changes and the supported range stays put.
 *
 * 0.5.0 widens the type grammar so an app contract can describe shapes the auth
 * surface never needed — a floating-point `number`, `map<string,T>`, and a named
 * enum whose declaration carries values instead of fields — and states the date
 * convention rather than adding a date scalar: a moment is an integer of
 * milliseconds since the Unix epoch in a field whose name ends `AtMillis`.
 *
 * Widening the grammar alone would have been a patch. What makes this breaking is
 * that `KeySummary` did not follow the convention: `createdAt`, `lastUsedAt`,
 * `expiresAt` and `revokedAt` were ISO 8601 strings, so the same contract stated
 * one representation and shipped two. They are now `createdAtMillis`,
 * `lastUsedAtMillis`, `expiresAtMillis` and `revokedAtMillis` integers, and
 * `listKeys` returns milliseconds.
 *
 * Taken now because the cost only grows: no generated consumer reads these types
 * yet — spfn-mobile's codegen path is unbuilt — and an exception documented
 * instead of removed would have kept Swift's `ISO8601DateFormatter` rejecting
 * fractional seconds as a live way for the two SDKs to disagree, on exactly
 * these four fields. An app reading `createdAt` from `authApi.listKeys()` must
 * move to `createdAtMillis`.
 *
 * 0.6.0 puts the contract version on the wire. A client states its kind, its own
 * release and the contract version it was generated from; the server answers on
 * every response with the version it serves and the range it accepts. A client
 * that ships separately from the server and states no contract version is
 * refused — until now the disagreement surfaced as an undecodable body, which
 * told the user nothing. None of it enters the proof input.
 *
 * `algorithm` becomes the `KeyAlgorithm` enum in the three requests that carry it
 * and in `KeySummary`. The routes have always constrained it to those values while
 * this contract said `string`, so the contract understated the server; it is
 * breaking because it changes what codegen produces for an existing field.
 *
 * The grammar also stops telling a consumer what to do with a value outside a
 * declared set. That was an instruction to the decoder, and a contract states
 * what the server does — how to survive a list that grows is the client's
 * decision to make. No list here is promised to be closed: an algorithm can be
 * withdrawn for a weakness found after this was written, and a contract that
 * promised otherwise would be promising something it cannot keep.
 *
 * 0.6.1 records when each operation became available: every operation now carries
 * `since`, the contract version it first appeared in, backfilled from this
 * repository's own history, and the optional `deprecatedIn` / `removedIn` that a
 * later version will fill in. Nothing is deprecated today, so both are absent
 * everywhere.
 *
 * A patch: no request or response type moves, no operation is added or taken
 * away, and this contract's policy is `allOrNothing`, so the new fields change no
 * verdict — a client is still admitted or refused by one version for the whole
 * surface. They are here so a deprecation has somewhere to be recorded when the
 * first one happens, and so an app contract, which decides per operation, reads
 * availability in the same shape rather than inventing a second one.
 *
 * 0.7.0 removes the `number` scalar and gives the grammar `decimal<scale>`: the
 * wire value is an integer and what it means is that integer divided by 10 to the
 * scale, so `decimal<2>` carries 1999 for 19.99. Canonical JSON does not move —
 * it already admits signed 64-bit integers only and calls a fraction an error,
 * which is what a `number` field would have had to be written as. The grammar and
 * the encoding had been stating different things, and only the encoding ran.
 *
 * Two rules ride the spelling. The scale is part of the type, so changing it is
 * breaking and takes a version bump, and the field is renamed to carry its new
 * unit rather than be quietly remeasured under the old name — the same reasoning
 * that put `AtMillis` in the name of every moment here. And a generator emits a
 * decimal type — Swift `Decimal`, Kotlin `BigDecimal` — never a binary float, and
 * rejects a value finer than the declared scale at encoding time instead of
 * rounding it, because rounding lets the client decide what a value the server
 * declared exactly is worth.
 *
 * Breaking because a declared scalar is gone. A consumer generated against 0.6.x
 * that meets `decimal<2>` fails at generation time, which is what this grammar's
 * own rule asks for — an unknown spelling is a contract error, not something to
 * guess at. Nothing deployed breaks: no type in this contract used `number`, so
 * the removal has zero usages, and it is taken now because the alternative is
 * carrying a scalar the encoding refuses until something depends on it.
 *
 * 0.8.0 applies to the error envelope the rule 0.6.0 applied to the grammar.
 * `unknownCodePolicy: 'reject'` and the rule beside it told a decoder what to do
 * with a code this bundle does not list, and `additionalFields` told it to ignore
 * the extra top-level fields rather than reject them. The test is whether the
 * server would notice a client doing the opposite, and it would not. Both are
 * replaced by the fact behind them: the server sends codes outside the list, and
 * the body carries fields beside the error object. Breaking, because removing a
 * declaration changes what a generated consumer is built from.
 *
 * 0.9.0 imports core.time as the bodyless, unproven prerequisite a client uses
 * to establish the server epoch before minting its first proof in a process.
 * It also states fail-closed behavior when synchronization is unavailable and
 * pins all four time-admission boundaries. Breaking because operation request
 * types were previously mandatory and every generated call therefore carried a
 * body; the supported range moves so an older generator cannot guess at GET.
 *
 * 0.10.0 puts device-code login in the contract: the five `/_auth/device/*`
 * operations, the types they carry, the `DeviceAuthPollStatus` discriminant and
 * the four device refusals. A phone runs both sides of that flow — it is the
 * natural approver, and it may equally be the device asking to be let in — so
 * all five are exported and not only the approver's three. The operations
 * themselves are additive, the way 0.4.1's key management was.
 *
 * What makes it a minor is `auth.device.deny`. It answers 204 with an empty
 * body, so `responseType` becomes optional exactly as `requestType` did in
 * 0.9.0, and for the same reason: a consumer generated against 0.9.x reads a
 * response type on every operation and would have to guess what deny answers
 * with. The range moves so it is refused CONTRACT_UNSUPPORTED instead of
 * guessing.
 *
 * The poll answer is a union on the wire — still waiting, or the login an
 * approval produced — and this grammar has no union type. It is exported as one
 * type whose `status` is a required enum and whose every other field is
 * optional, which is what the wire actually shows. `deviceAuthorization` states
 * which fields belong to which status, and that a pending answer is a 200 and
 * never a refusal: a client that read pending as an error would stop waiting at
 * the one moment the flow asks it to keep waiting.
 *
 * `platform` becomes the `KeyPlatform` enum wherever it appears — the two device
 * types that carry it and `KeySummary` with them. The routes have only ever
 * accepted the four values `KEY_PLATFORM` lists, and the columns store nothing
 * else, so `string` understated the server in exactly the way `algorithm` did
 * before 0.6.0. It rides this version because it changes what codegen produces
 * for an existing field, which is breaking on its own, and 0.10.0 is where the
 * break already is.
 *
 * 0.10.1 adds `KeyAlgorithmMismatchError` to the REST vocabulary: a key whose
 * SPKI type is not the one its declared algorithm needs is now refused 400 at
 * register, login, rotate and device start instead of being stored and failing
 * at proof verification afterwards. A patch, by the rule 0.4.1 set — the code
 * list is open (`unlistedCodes` says so), so a consumer generated against
 * 0.10.0 already decodes an unlisted code and nothing it generates changes
 * shape. The supported range does not move.
 * 0.11.0 adds `registeredIp` and `registeredUserAgent` to `KeySummary`: what the
 * request that registered a key said about where it came from, captured once and
 * never updated. They are there so a device list can say "this one appeared from
 * there", which is what makes an entry the owner does not recognise recognisable
 * — the same reason `auth.device.registered` now announces a new key at all.
 *
 * Additive optional fields, the way 0.4.1's key management was, so nothing a
 * consumer generated against 0.10.x reads changes shape. It is a minor rather
 * than a patch because the pair are new declared fields on a type in the mobile
 * contract, and under 0.x this contract carries a surface addition of that kind
 * in the minor; the range moves with it, since the range's floor is mechanically
 * the current minor's `.0`.
 *
 * Both values are unauthenticated and display-only. `getClientIp` is spoofable
 * on a request that is not proxy-verified and a `user-agent` is whatever the
 * caller typed, so a generated client should render them and decide nothing by
 * them. A field is absent rather than carrying a placeholder when the
 * registering request resolved neither — the literal string `unknown` is never
 * stored.
 */
export const CONTRACT_VERSION = '0.11.0';
export const CONTRACT_MAJOR = 0;
export const CONTRACT_NAME = 'spfn-mobile-contract';

/**
 * Under 0.x the minor carries breaking changes, so the range stops at 0.11.0.
 *
 * 0.11.0 moves the floor because the minor is where this contract puts a surface
 * addition, and the floor is that minor's `.0` — not because a 0.10.x consumer
 * could not read the two fields `KeySummary` gained, which it would simply not
 * know about. A patch leaves the floor where it is; 0.10.1 did.
 */
export const CONTRACT_SUPPORTED_RANGE = '>=0.11.0 <0.12.0';

/** What spfn-mobile's validator expects an upstream-exported bundle to name. */
export const EXPORT_ORIGIN = 'spfn-primitives-ci-export';

/**
 * Bumped whenever the assembled shape changes, independent of the contract.
 *
 * The bump follows what a reader of this shape can still find. A major when a
 * section or key is removed, renamed, or stops being present on every entry that
 * carried it, so code reading it stops finding what it read; a minor when the
 * shape only grows. 5.0.0 is a major because `typeGrammar` lost
 * `integerVersusNumber`, where 4.1.0 was a minor for availability fields that
 * were purely added.
 *
 * 6.0.0 is a major because `responseType` becomes optional. `auth.device.deny`
 * answers 204 and names none, so code that reads a response type off every
 * operation finds nothing there — an optional key is an absent key to whoever
 * reads it, which is the same reasoning that makes the contract itself 0.10.0
 * rather than 0.9.1. The growth beside it — a `deviceAuthorization` section, more
 * operations, types and errors — would have been a minor on its own, the way
 * 5.1.0 was.
 *
 * 5.1.0 is what that rule was measured against: it made `requestType` optional
 * and called the result a minor. That was this same change under a bump that
 * understated it. A published version is not rewritten, so 5.1.0 stays as it is
 * and the rule is spelled out here instead, so the next one is judged by it.
 */
export const EXPORTER_VERSION = '@spfn/auth/contract-bundle@6.0.0';

/**
 * The scalars the grammar admits.
 *
 * There is no floating-point scalar. A fractional value is `decimal<scale>`, an
 * integer on the wire with its scale declared in the type, because canonical JSON
 * carries signed 64-bit integers only and treats a fraction as an error — a
 * floating-point scalar was a shape the encoding would have refused. `integer`
 * stays separate from it so a count is never given a scale it does not have.
 *
 * There is no date scalar. A moment is an integer of milliseconds since the Unix
 * epoch in a field whose name ends `AtMillis`, which is what every existing type
 * already does.
 */
type ScalarTypeName = 'string' | 'integer' | 'boolean';

/**
 * The scales `decimal<scale>` admits.
 *
 * Scale 0 is `integer` written the long way, so it is not a scale. The ceiling is
 * 18 because 10^18 is the largest power of ten a signed 64-bit integer holds, and
 * the wire value is such an integer — above 18 there is no integer part left to
 * carry.
 *
 * Spelled as a union rather than checked at runtime so an out-of-range scale
 * fails to compile here, where the declaration is written, rather than reaching a
 * consumer's generator as a type it cannot parse.
 */
type DecimalScale =
    | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
    | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;

/**
 * A fixed-point value: the integer on the wire divided by 10 to the scale.
 *
 * Parameterized like `array<T>`, and read by the same parser — a consumer that
 * does not recognise the prefix reads `decimal<2>` as a type named "decimal<2>"
 * and fails at compile time, which is the grammar's rule for an unknown spelling.
 */
type DecimalTypeName = `decimal<${DecimalScale}>`;

/**
 * Declared names a field is allowed to reference — the types in
 * `CONTRACT_TYPES` and the enums in `CONTRACT_ENUMS` that are actually used.
 *
 * Hand-listed rather than derived: the declarations below are what would define
 * it, so deriving it would be circular, and a misspelled name has to fail here
 * rather than reach the consumer as a type it cannot find.
 */
type ReferencedTypeName =
    | 'Item'
    | 'KeySummary'
    | 'KeyAlgorithm'
    | 'KeyPlatform'
    | 'DeviceAuthPollStatus';

type ElementTypeName = ScalarTypeName | DecimalTypeName | ReferencedTypeName;

/**
 * The field-type grammar the consumer's codegen parses.
 *
 * `array<T>` and `map<string,T>` are the only container spellings: spfn-mobile's
 * `FieldType.parse` reads a recognised container prefix as a container and
 * everything else as a named type, so `Item[]` would silently become a type
 * named "Item[]" and fail at compile time rather than at parse time.
 *
 * A map's key is always a string because JSON has no other key type. Spelling it
 * out anyway keeps the consumer from having to assume it.
 *
 * This union is narrower than the grammar it guards: the grammar lets a
 * container hold another container, and the consumer's parser recurses, while
 * here a container holds one element type. Narrower is the safe direction —
 * nothing invalid can be declared — and it widens when a nested container is
 * first needed.
 */
type FieldTypeName =
    | ElementTypeName
    | `array<${ElementTypeName}>`
    | `map<string,${ElementTypeName}>`;

interface FieldDeclaration
{
    name: string;
    type: FieldTypeName;
    optional: boolean;
}

interface TypeDeclaration
{
    name: string;
    fields: FieldDeclaration[];
}

/**
 * A named set of string values, declared by name so a field can reference it the
 * same way it references an object type.
 *
 * The values are the ones the server accepts and sends **now**. A set is not
 * promised to stay as it is: an algorithm can be added, and one can be withdrawn
 * for a weakness found after this was written. What a consumer does when it meets
 * a value it does not know is the consumer's decision — a generated client that
 * cannot survive a grown list is a defect in the generator, not something this
 * contract can prevent by declaring the set closed.
 */
interface EnumDeclaration
{
    name: string;
    values: readonly string[];
}

function required(name: string, type: FieldDeclaration['type']): FieldDeclaration
{
    return { name, type, optional: false };
}

function optional(name: string, type: FieldDeclaration['type']): FieldDeclaration
{
    return { name, type, optional: true };
}

/**
 * Translate the imported core response schema into this bundle's deliberately
 * small type grammar. A core change outside that grammar fails export here
 * rather than leaving auth to publish a plausible but different response.
 */
function coreTimeResponseDeclaration(): TypeDeclaration
{
    if (ServerTimeResponseSchema.type !== 'object'
        || ServerTimeResponseSchema.additionalProperties !== false)
    {
        throw new Error('core.time response must remain a closed object');
    }

    const requiredFields = new Set(ServerTimeResponseSchema.required);
    const fields = Object.entries(ServerTimeResponseSchema.properties).map(([name, schema]) =>
    {
        if (schema.type !== 'integer')
        {
            throw new Error(`core.time response field ${name} is outside the mobile type grammar`);
        }

        return {
            name,
            type: 'integer' as const,
            optional: !requiredFields.has(name),
        };
    });

    return { name: 'ServerTimeResponse', fields };
}

/**
 * The contract types.
 *
 * `ServerTimeResponse` is translated from core's exported TypeBox schema above.
 * The clientProofV1 request types mirror the decoders in `contract-types.ts`
 * and the response types mirror the encoders. Neither reads this table — the
 * conformance vectors are what hold the two in agreement.
 *
 * The `/_auth` surface types mirror the TypeBox route schemas (input body +
 * Next.js interceptor body merged, since a mobile client sends the whole
 * body itself) and the service result interfaces. The optional free-form
 * extension fields (`metadata`, `profile`) are deliberately not declared:
 * they are outside this grammar, the server tolerates their absence, and a
 * consumer generated from this contract never needs to send them.
 */
export const CONTRACT_TYPES: readonly TypeDeclaration[] = [
    coreTimeResponseDeclaration(),
    {
        name: 'HandshakeRequest',
        fields: [
            required('clientId', 'string'),
            required('keyId', 'string'),
            required('nonce', 'string'),
            required('issuedAtMillis', 'integer'),
        ],
    },
    {
        name: 'HandshakeResponse',
        fields: [
            required('sessionId', 'string'),
            required('expiresAtMillis', 'integer'),
        ],
    },
    {
        name: 'EchoRequest',
        fields: [
            required('message', 'string'),
            required('sequence', 'integer'),
        ],
    },
    {
        name: 'EchoResponse',
        fields: [
            required('message', 'string'),
            required('sequence', 'integer'),
            required('serverTimeMillis', 'integer'),
        ],
    },
    {
        name: 'ListItemsRequest',
        fields: [
            required('limit', 'integer'),
            optional('cursor', 'string'),
        ],
    },
    {
        name: 'Item',
        fields: [
            required('id', 'string'),
            required('name', 'string'),
            required('updatedAtMillis', 'integer'),
        ],
    },
    {
        name: 'ListItemsResponse',
        fields: [
            required('items', 'array<Item>'),
            optional('nextCursor', 'string'),
        ],
    },
    {
        name: 'RegisterRequest',
        fields: [
            optional('email', 'string'),
            optional('phone', 'string'),
            required('verificationToken', 'string'),
            required('password', 'string'),
            required('publicKey', 'string'),
            required('keyId', 'string'),
            required('fingerprint', 'string'),
            required('algorithm', 'KeyAlgorithm'),
        ],
    },
    {
        name: 'RegisterResponse',
        fields: [
            required('userId', 'string'),
            required('publicId', 'string'),
            optional('email', 'string'),
            optional('phone', 'string'),
        ],
    },
    {
        name: 'LoginRequest',
        fields: [
            optional('email', 'string'),
            optional('phone', 'string'),
            required('password', 'string'),
            required('publicKey', 'string'),
            required('keyId', 'string'),
            required('fingerprint', 'string'),
            required('algorithm', 'KeyAlgorithm'),
            optional('oldKeyId', 'string'),
        ],
    },
    {
        name: 'LoginResponse',
        fields: [
            required('userId', 'string'),
            required('publicId', 'string'),
            optional('email', 'string'),
            optional('phone', 'string'),
            required('passwordChangeRequired', 'boolean'),
        ],
    },
    {
        name: 'OauthNativeRequest',
        fields: [
            required('idToken', 'string'),
            required('nonce', 'string'),
            optional('accessToken', 'string'),
            required('publicKey', 'string'),
            required('keyId', 'string'),
            required('fingerprint', 'string'),
            required('algorithm', 'KeyAlgorithm'),
        ],
    },
    {
        name: 'OauthNativeResponse',
        fields: [
            required('userId', 'string'),
            required('keyId', 'string'),
            required('isNewUser', 'boolean'),
        ],
    },
    {
        name: 'RotateKeyRequest',
        fields: [
            required('publicKey', 'string'),
            required('keyId', 'string'),
            required('fingerprint', 'string'),
            required('algorithm', 'KeyAlgorithm'),
        ],
    },
    {
        name: 'RotateKeyResponse',
        fields: [
            required('success', 'boolean'),
            required('keyId', 'string'),
        ],
    },
    {
        name: 'ListKeysRequest',
        fields: [
            optional('includeRevoked', 'boolean'),
        ],
    },
    {
        name: 'KeySummary',
        fields: [
            required('keyId', 'string'),
            optional('deviceName', 'string'),
            optional('platform', 'KeyPlatform'),
            required('algorithm', 'KeyAlgorithm'),
            required('fingerprintPrefix', 'string'),
            required('createdAtMillis', 'integer'),
            optional('lastUsedAtMillis', 'integer'),
            optional('expiresAtMillis', 'integer'),
            required('isExpired', 'boolean'),
            required('isActive', 'boolean'),
            optional('revokedAtMillis', 'integer'),
            optional('registeredIp', 'string'),
            optional('registeredUserAgent', 'string'),
        ],
    },
    {
        name: 'ListKeysResponse',
        fields: [
            required('keys', 'array<KeySummary>'),
        ],
    },
    {
        name: 'RevokeKeyRequest',
        fields: [
            required('keyId', 'string'),
        ],
    },
    {
        name: 'RevokeKeyResponse',
        fields: [
            required('keyId', 'string'),
            required('selfRevoked', 'boolean'),
        ],
    },
    {
        name: 'RevokeAllKeysRequest',
        fields: [
            optional('includeCurrent', 'boolean'),
        ],
    },
    {
        name: 'RevokeAllKeysResponse',
        fields: [
            required('revokedCount', 'integer'),
            required('currentKeyRevoked', 'boolean'),
        ],
    },
    {
        name: 'StartDeviceAuthRequest',
        fields: [
            required('publicKey', 'string'),
            required('keyId', 'string'),
            required('fingerprint', 'string'),
            optional('algorithm', 'KeyAlgorithm'),
            optional('deviceName', 'string'),
            optional('platform', 'KeyPlatform'),
        ],
    },
    {
        name: 'StartDeviceAuthResponse',
        fields: [
            required('deviceCode', 'string'),
            required('userCode', 'string'),
            required('expiresAtMillis', 'integer'),
            required('intervalMillis', 'integer'),
        ],
    },
    {
        name: 'PollDeviceAuthRequest',
        fields: [
            required('deviceCode', 'string'),
        ],
    },
    /**
     * The poll union, flattened into the one shape this grammar can carry.
     *
     * `status` is the discriminant and the only required field; everything else
     * belongs to one branch and is therefore optional. `intervalMillis` is the
     * pending branch, and the five after it are the approved branch — the same
     * fields `LoginResponse` carries, because an approved poll is the login the
     * approval produced. `deviceAuthorization.pollStatusRule` states the pairing
     * the grammar cannot.
     */
    {
        name: 'PollDeviceAuthResponse',
        fields: [
            required('status', 'DeviceAuthPollStatus'),
            optional('intervalMillis', 'integer'),
            optional('userId', 'string'),
            optional('publicId', 'string'),
            optional('email', 'string'),
            optional('phone', 'string'),
            optional('passwordChangeRequired', 'boolean'),
        ],
    },
    /**
     * Info, approve and deny each declare their own request type although all
     * three carry nothing but `userCode`. An operation's request shape is its
     * own: a field added to one of them later must not appear on the other two
     * by accident, which is what a shared type would do.
     */
    {
        name: 'DeviceAuthInfoRequest',
        fields: [
            required('userCode', 'string'),
        ],
    },
    {
        name: 'DeviceAuthInfoResponse',
        fields: [
            optional('deviceName', 'string'),
            optional('platform', 'KeyPlatform'),
            required('fingerprintPrefix', 'string'),
            required('requestedAtMillis', 'integer'),
            required('expiresAtMillis', 'integer'),
        ],
    },
    {
        name: 'ApproveDeviceAuthRequest',
        fields: [
            required('userCode', 'string'),
        ],
    },
    {
        name: 'DenyDeviceAuthRequest',
        fields: [
            required('userCode', 'string'),
        ],
    },
];

/**
 * The enums this contract declares.
 *
 * `KeyAlgorithm` and `KeyPlatform` are read from the server's own lists rather
 * than transcribed, so a value added or withdrawn there moves this declaration
 * with it. Every route that takes a platform validates it against that same list
 * and every column that stores one is bounded by it, so exporting it as `string`
 * described a wider server than the one that is here.
 *
 * `DeviceAuthPollStatus` has no such list to read: the two answers are literal
 * types in the poll route's response schema and in `PollDeviceAuthResult`, and
 * neither is a runtime value. It is declared here and held to the route's own
 * schema by `contract-export.test.ts`.
 */
export const CONTRACT_ENUMS: readonly EnumDeclaration[] = [
    { name: 'KeyAlgorithm', values: [...KEY_ALGORITHM] },
    { name: 'KeyPlatform', values: [...KEY_PLATFORM] },
    { name: 'DeviceAuthPollStatus', values: ['pending', 'approved'] },
];

/** One line per code describing what it means on the wire. */
const ERROR_SUMMARIES: Record<string, string> = {
    PROOF_INVALID: 'the client proof did not verify',
    PROOF_REPLAYED: 'the nonce was already used inside the replay window',
    PROOF_EXPIRED: 'issuedAtMillis falls outside the replay window',
    SESSION_REVOKED: 'the key or session was revoked',
    PROFILE_REJECTED: 'an auth profile outside the allowlist was named',
    CONTRACT_UNSUPPORTED: 'the request is not the shape this contract describes',
};

/**
 * No refusal is retryable without changing the request.
 *
 * An auth-family code clears after a fresh handshake, which is a different
 * request, so replaying the same bytes never helps.
 */
const RETRYABLE = false;

interface RestSurfaceError
{
    code: string;
    httpStatus: number;
    retryable: boolean;
    summary: string;
}

/**
 * Every way `auth.enroll.oauthNative` and the device-code operations refuse, as
 * codes a consumer can switch on.
 *
 * "Every way" includes the app's own `beforeRegister` check: what that check
 * decides is the app's business, but the response it produces is the
 * framework's — a fixed class name at a fixed status. Leaving it out would hand
 * every app that uses the hook an undecodable refusal.
 *
 * The codes are the server's own error class names rather than a second
 * vocabulary invented for mobile: two vocabularies would have to be kept in
 * step, and the mapping between them is exactly the place a wrong answer
 * hides.
 *
 * Only these operations' codes are listed. The `error` envelope now reaches
 * every REST operation, but a code list is a promise, and a promise about
 * routes whose failure paths have not been enumerated one by one would be a
 * guess. That the server sends codes outside this list is stated as
 * `unlistedCodes`; what a decoder does when it meets one is the decoder's
 * decision.
 *
 * The device-code operations add four codes and reuse the rest. Their other
 * refusals are already here — a malformed body is `ValidationError`, a key whose
 * fingerprint does not hold together is `InvalidKeyFingerprintError`, an account
 * that cannot open a session is `AccountDisabledError` or
 * `AccountPendingDeletionError`, a keyId already taken is
 * `KeyIdAlreadyRegisteredError`, and every one of the five routes is rate
 * limited — so a code is listed once and names the same failure wherever it
 * appears.
 */
const REST_SURFACE_ERRORS: readonly RestSurfaceError[] = [
    {
        code: 'ValidationError',
        httpStatus: 400,
        retryable: false,
        summary: 'the request body is not the shape the operation declares',
    },
    {
        code: 'NativeSignInUnsupportedError',
        httpStatus: 400,
        retryable: false,
        summary: 'this provider has no native id_token sign-in — a server configuration fact, not a user error',
    },
    {
        code: 'NonceKeyBindingError',
        httpStatus: 400,
        retryable: false,
        summary: 'the nonce is not the fingerprint of the submitted public key',
    },
    {
        code: 'InvalidKeyFingerprintError',
        httpStatus: 400,
        retryable: false,
        summary: 'the fingerprint is not the hash of the submitted public key',
    },
    {
        code: 'KeyAlgorithmMismatchError',
        httpStatus: 400,
        retryable: false,
        summary: 'the public key\'s type does not match the declared algorithm',
    },
    {
        code: 'UnverifiedEmailLinkError',
        httpStatus: 400,
        retryable: false,
        summary: 'that email already has an account and the provider never verified it, so linking is refused',
    },
    {
        code: 'InvalidSocialTokenError',
        httpStatus: 401,
        retryable: false,
        summary: 'the id_token failed signature, issuer, audience, expiry, nonce or subject verification',
    },
    {
        code: 'AccountDisabledError',
        httpStatus: 403,
        retryable: false,
        summary: 'the account cannot open a session in its current status',
    },
    {
        code: 'AccountPendingDeletionError',
        httpStatus: 403,
        retryable: false,
        summary: 'the account is scheduled for deletion and must be restored before it can sign in',
    },
    {
        code: 'RegistrationRejectedError',
        httpStatus: 403,
        retryable: false,
        summary:
            'the app refused this sign-up in its own beforeRegister check — reached only when the identity would '
            + 'create a new account, never when it links to an existing one',
    },
    {
        code: 'KeyIdAlreadyRegisteredError',
        httpStatus: 409,
        retryable: false,
        summary: 'that keyId is taken or was revoked — generate a fresh keyId and retry',
    },
    {
        code: 'TooManyRequestsError',
        httpStatus: 429,
        retryable: true,
        summary: 'the rate limit for this endpoint was exceeded; the same request succeeds after the window',
    },
    {
        code: 'Error',
        httpStatus: 500,
        retryable: false,
        summary: 'the server failed for a reason it does not describe to the client',
    },
    {
        code: 'DeviceAuthExpiredError',
        httpStatus: 400,
        retryable: false,
        summary:
            'the device code passed its TTL, whatever state it was in — the waiting device starts again, and the '
            + 'approver is told the code on the other screen is stale',
    },
    {
        code: 'DeviceAuthDeniedError',
        httpStatus: 403,
        retryable: false,
        summary: 'the account owner refused this device; the waiting device stops polling instead of timing out',
    },
    {
        code: 'DeviceAuthNotFoundError',
        httpStatus: 404,
        retryable: false,
        summary:
            'the code names no record this operation can act on — never issued, or already spent. The two answer '
            + 'alike on purpose, so a guess that landed cannot be told from one that did not',
    },
    {
        code: 'DeviceAuthAlreadyHandledError',
        httpStatus: 409,
        retryable: false,
        summary:
            'the request was already approved or denied, and a decision on a device is made once; it is also what '
            + 'the loser of two concurrent approvals is told',
    },
];

export interface MobileContractBundle
{
    [key: string]: unknown;
}

/** Assembles the bundle. Pure — same inputs, same object, every time. */
export function buildMobileContractBundle(): MobileContractBundle
{
    return {
        bundleKind: 'UPSTREAM_EXPORT',
        origin: EXPORT_ORIGIN,
        originStatement:
            'Generated from the route and contract definitions in SPFN primitives '
            + '(packages/auth/src/server/client-proof) and published from that repository. '
            + 'This file is generated output: edit the source modules and re-export, never this file.',
        contractName: CONTRACT_NAME,
        contractMajor: CONTRACT_MAJOR,
        contractVersion: CONTRACT_VERSION,
        supportedRange: CONTRACT_SUPPORTED_RANGE,
        exporterVersion: EXPORTER_VERSION,
        authProfiles: {
            allowed: [CLIENT_PROOF_PROFILE],
            unknownProfilePolicy: 'reject',
            mixingWithinSession: 'prohibited',
        },
        operationAuthClasses: {
            none:
                'the unproven class: the operation is accepted with neither proof headers nor a session header, '
                + 'because it is called before any proof can be minted (clock synchronization, enrollment, login, '
                + 'and the two device-code operations a device with no key on file calls)',
            [CLIENT_PROOF_PROFILE]:
                'the operation is admitted by the clientProofV1 admission order; requiresSession states whether '
                + 'the session header travels',
            rule:
                'an operation whose authProfile is not none refuses an unproven call exactly as it refuses any '
                + 'failed admission; nothing is downgraded to anonymous handling',
        },
        operationAvailability: {
            since:
                'the contract version the operation first appeared in. Every operation carries one, and it is '
                + 'never rewritten: it is a fact about this contract\'s history',
            deprecatedIn:
                'the contract version that marked the operation deprecated, absent until one does. A deprecated '
                + 'operation is still served — the mark opens the grace period, it does not end the operation',
            removedIn:
                'the contract version that removed the operation. A removed operation leaves this list, so no '
                + 'entry carries it today; it is the field a removal is recorded in when the first one happens',
            ordering:
                'since <= deprecatedIn < removedIn, and removedIn never appears without deprecatedIn: an '
                + 'operation is marked in one version and taken away in a later one, never both at once',
            verdictRule:
                'under this contract\'s allOrNothing policy these three fields decide nothing. One contract '
                + 'version passes or refuses this whole surface, so availability here is description a reader '
                + 'and a changelog use, not an input the server compares against. A contract whose policy is '
                + 'perOperation reads the same fields as a verdict input',
            procedure:
                'a removal is mark then wait then remove: deprecatedIn in one version, the operation still '
                + 'served, removedIn in a later one. Nothing is removed in the version that first deprecates it',
        },
        keyPolicy: {
            ttlDays: KEY_TTL_DAYS,
            rotationOperation: 'auth.keys.rotate',
            rule:
                'a registered public key expires ttlDays after registration; an expired or revoked key is refused '
                + 'at the revocation step (SESSION_REVOKED, non-disclosing), so the client rotates its key via the '
                + 'rotation operation before the TTL runs out',
        },
        clockSynchronization: {
            appliesTo: CLIENT_PROOF_PROFILE,
            operation: CORE_TIME_OPERATION_ID,
            source: {
                package: '@spfn/core',
                routeContractSince: IMPORTED_CORE_TIME_CONTRACT.sourceSince,
            },
            phase: 'before minting the first proof in each client process',
            epochField: 'serverTimeMillis',
            requestBody: 'none',
            responseBody: 'the ServerTimeResponse type as plain JSON',
            unavailableBehavior: 'failClosed',
            fallbackClock: 'prohibited',
            failureRule:
                'when core.time is unavailable or its response cannot be decoded, the client does not mint or send '
                + 'a proof; it never silently falls back to an unsynchronized device wall clock',
            persistenceRule:
                'the synchronization requirement is process-local; this contract specifies no persistent offset, '
                + 'retry sleep, or device-specific margin',
            admissionBoundaries: [
                { serverNowMinusIssuedAtMillis: 0, outcome: 'accept' },
                { serverNowMinusIssuedAtMillis: -1, outcome: 'PROOF_EXPIRED' },
                { serverNowMinusIssuedAtMillis: DEFAULT_REPLAY_WINDOW_MILLIS, outcome: 'accept' },
                { serverNowMinusIssuedAtMillis: DEFAULT_REPLAY_WINDOW_MILLIS + 1, outcome: 'PROOF_EXPIRED' },
            ],
        },
        nativeEnrollment: {
            appliesTo: 'auth.oauth.native',
            nonceRule:
                'the nonce sent with a native id_token must be the fingerprint field of the same request, which '
                + 'is the SHA-256 of the DER bytes of publicKey in lowercase hex; the server refuses the call '
                + 'when the two differ or when the fingerprint is not that key\'s hash',
            appleVariant:
                'Apple hashes the nonce it receives, so the client puts sha256hex(fingerprint) in Apple\'s '
                + 'authorization request while still sending the raw fingerprint as nonce; every other provider '
                + 'carries the raw value both ways',
            rationale:
                'an id_token is bearer-shaped and travels, so verifying it alone lets whoever holds one enroll '
                + 'any key on that account; deriving the nonce from the key means a stolen id_token carries the '
                + 'victim\'s fingerprint and cannot be paired with the attacker\'s key',
        },
        deviceAuthorization: {
            appliesTo: 'the auth.device.* operations',
            flow:
                'a device with no key on file parks its public key with start, shows the userCode it gets back and '
                + 'polls; the account owner reads that code on a device that is already signed in, checks with info '
                + 'that the device described is the one in front of them, and calls approve or deny. The next poll '
                + 'registers the parked key',
            unprovenOperations:
                'start and poll are the unproven class. The device calling them has no registered key yet — '
                + 'obtaining one is what the flow is for — so no proof can exist to sign them with. The deviceCode '
                + 'start returned is what stands in for a credential on poll, and it is returned once',
            algorithmDefaultRule:
                'algorithm is the one optional field of StartDeviceAuthRequest, and an omitted one is ES256: the '
                + 'parked key is stored as ES256 and the poll registers it as ES256. A device holding a key of any '
                + 'other algorithm states it here, because the value is fixed when the key is parked and no later '
                + 'request in this flow can correct it',
            approverOperations:
                'info, approve and deny are proven calls from a device that is already signed in, on the same '
                + 'clientProofV1 terms as the key operations. approve is the one of the three that binds an '
                + 'account: it reads the approving user from the admitted caller and never from the request body, '
                + 'because that call is the entire authorization. info and deny bind nobody — info describes the '
                + 'waiting device to any admitted caller holding the code, and deny records the refusal without '
                + 'recording who refused',
            pollStatusRule:
                'PollDeviceAuthResponse is one object with a discriminant, because this grammar has no union type. '
                + 'status is always present and every other field belongs to one branch, so every other field is '
                + 'optional: status "pending" carries intervalMillis and nothing else, and status "approved" '
                + 'carries userId, publicId, passwordChangeRequired and the optional email and phone — the fields '
                + 'LoginResponse carries, because an approved poll is the login the approval produced. Read the '
                + 'branch from status, never from which fields happen to be present',
            pendingRule:
                'a pending answer is a 200 carrying status "pending", not a refusal, and none of the error codes '
                + 'stands for it. It is the answer to "has anyone decided yet", so the client waits intervalMillis '
                + 'and asks again. Every other answer is an error response, and an error response ends the wait '
                + 'unless its entry under errors marks it retryable — TooManyRequestsError is the only one that '
                + 'does today, and it means the device polled faster than the limit allows, so it resumes after '
                + 'the window rather than treating the code as answered. DeviceAuthDeniedError, '
                + 'DeviceAuthExpiredError and DeviceAuthNotFoundError are the device-code outcomes among the ones '
                + 'that end it, and they are not the whole set: this operation also answers ValidationError, the '
                + 'account and key refusals raised when the approved branch turns the approval into a login, and '
                + 'codes this bundle does not list. A client that kept polling on an answer it did not recognise '
                + 'would wait out a code that will never move',
            userCodeRule:
                'the userCode is what a person reads off one screen and types on another; the server folds case, '
                + 'spaces and dashes away before looking it up, so a client may send it as displayed',
            denyResponseRule:
                'deny answers 204 with an empty body and therefore declares no responseType, the way core.time '
                + 'declares no requestType',
        },
        restOperations: {
            appliesTo:
                'every operation whose path starts with /_auth. The server also answers two /_auth routes that '
                + 'are not operations of this contract and are not reachable from a generated client — the '
                + 'sign-out-everywhere link confirm and consume, which a browser posts to from a page in the app '
                + 'with no session and no proof',
            requestBody:
                'plain JSON of the request type, validated server-side; canonical-JSON encoding is required only '
                + 'when the call is proven (the proof binds the canonical bytes)',
            responseBody:
                'the response type as plain JSON, with no envelope around it. An operation that declares no '
                + 'responseType answers 204 with an empty body and there is nothing to decode',
            errorEnvelope:
                'the same {"error":{"code","message","requestId"}} envelope every operation uses, carried '
                + 'alongside the SPFN web fields (__type and the error class\'s own public fields) in one body: '
                + 'the web client restores an error class from __type while a generated client reads error.code '
                + 'and ignores the rest. The codes are the server error class names listed under errors with '
                + 'surface "rest", not the six clientProofV1 refusal codes — those reach only proven calls',
            pathTemplate:
                'a {name} segment is a path parameter the client substitutes before signing or sending; '
                + '{provider} is the social provider id (google, apple, kakao, naver)',
            policy:
                'rate limits and other route policies are server posture, not contract surface: this bundle '
                + 'states wire shapes only',
        },
        canonicalJson: {
            algorithm: 'SPFN-CANON-JSON-1',
            objectKeyOrder: 'ascending by UTF-8 byte sequence',
            whitespace: 'none',
            numbers: 'signed 64-bit integers only; a fractional or non-finite number is a canonicalization error',
            stringEscapes:
                'quotation mark and reverse solidus escaped; C0 controls use \\b \\f \\n \\r \\t where defined '
                + 'and \\u00XX otherwise; every other scalar is emitted literally',
            encoding: 'UTF-8',
        },
        clientProofV1: {
            profile: CLIENT_PROOF_PROFILE,
            proofInput: {
                algorithm: 'SPFN-PROOF-INPUT-1',
                separator: PROOF_INPUT_SEPARATOR,
                fields: [...PROOF_INPUT_FIELDS],
                fieldRules:
                    'no field value may contain a C0 control character; a value that does is a proof-input error, '
                    + 'because the separator would otherwise be ambiguous',
                bodySha256:
                    'lowercase base16 SHA-256 of the canonical JSON request body; the literal string of 64 zero '
                    + 'characters when an operation has no body',
            },
            digest: 'SHA-256',
            signature: {
                algorithm: 'ECDSA P-256 with SHA-256',
                encoding: 'raw r||s, two 32-byte big-endian integers, 64 bytes total, base16-lower (128 hex characters)',
                derRule:
                    'a DER-encoded signature is rejected on the wire; a platform signer that emits DER converts to '
                    + 'raw r||s before sending',
                lowS:
                    'low-S normalization is not required; uniqueness is owned by the nonce and replay window, so '
                    + 'signature malleability cannot replay a request',
                publicKey: 'SPKI DER, base64; x-spfn-key-id names a registered public key',
            },
            proofEncoding: 'base16-lower',
            replayWindowMillis: DEFAULT_REPLAY_WINDOW_MILLIS,
            clientIdRule:
                "clientId identifies the key owner; the REST surface refuses a proof whose clientId is not the key's "
                + 'owner id, with the same PROOF_INVALID a failed signature answers',
            replayRule:
                'a (clientId, nonce) pair is accepted at most once inside the replay window; a repeat is PROOF_REPLAYED',
            revocationRule:
                'a revoked keyId is rejected before the proof is verified; the outcome is SESSION_REVOKED and never '
                + 'PROOF_INVALID, so revocation is not inferable from a proof failure',
            admissionOrder: ['revocation', 'session', 'expiry', 'replay', 'proof'],
            nonceRule: 'a nonce is spent only when the request is admitted; a refused request leaves it unused',
        },
        wireMapping: {
            requestContentType: CLIENT_PROOF_CONTENT_TYPE,
            headers: { ...CLIENT_PROOF_HEADERS },
            headerOrder: Object.keys(CLIENT_PROOF_HEADERS),
            contentTypeRule:
                'the content-type header is present exactly when the request carries a body, and the body is always '
                + 'the canonical JSON of the request type',
            sessionRule: `requiresSession operations carry ${CLIENT_PROOF_HEADERS.session}; the handshake never does`,
            clientIdentity: {
                headers: { ...CLIENT_IDENTITY_HEADERS },
                kinds: [...CLIENT_KINDS],
                appliesTo:
                    'every operation, proven or not — enrollment and login are where a stale client is met first, '
                    + 'and they carry no proof',
                kindRule:
                    'ios and android ship independently of the server and state the contract version they were '
                    + 'generated from; web does not, because a browser bundle is deployed with the server that '
                    + 'serves it and has no second version to reconcile',
                versionRule:
                    'the client version is the client\'s own release — a store version for an app, a build for a '
                    + 'browser bundle. It is unauthenticated and nothing is authorized by it',
                refusalRule:
                    'an ios or android client that states no contract version, or one outside the range in the '
                    + 'response headers, is refused CONTRACT_UNSUPPORTED; a request naming no kind is not a '
                    + 'deployed client and passes',
                proofRule:
                    'none of these headers enters the proof input: they are diagnostic, and PROOF_INPUT_FIELDS is '
                    + 'unchanged from 0.5.0',
            },
            serverAnnouncement: {
                headers: { ...SERVER_CONTRACT_HEADERS },
                appliesTo: 'every response, including a refusal',
                rule:
                    'the server states the contract version it serves and the range it accepts. It states no more '
                    + 'than that: comparing those against its own version and deciding what a user should be told '
                    + 'is the client\'s judgment, made in the client',
            },
        },
        compatibilityPolicy: {
            policy: 'allOrNothing',
            rule:
                'one contract version is this whole surface\'s pass or refusal. Partial compatibility in an auth '
                + 'primitive would mean admitting a client that agrees about some of the admission sequence and '
                + 'not the rest',
            contrast:
                'an app contract generated from SPFN routes uses perOperation instead, where availability is '
                + 'recorded per operation and the verdict narrows to the operations a client actually calls. The '
                + 'two share this bundle format, so the policy is stated rather than inferred',
            availability:
                'the since, deprecatedIn and removedIn fields on each operation, described under '
                + 'operationAvailability, are recorded here as well. Under allOrNothing they are descriptive: '
                + 'they are history, not a verdict input. Recording them regardless is what lets a deprecation '
                + 'be announced at all, and is the same shape a perOperation contract decides from',
        },
        typeGrammar: {
            scalars: ['string', 'integer', 'boolean'],
            decimal:
                'decimal<scale>, where scale is an integer from 1 to 18. The value on the wire is an integer and '
                + 'what it means is that integer divided by 10 to the scale, so decimal<2> carries 1999 for 19.99. '
                + 'There is no floating-point scalar: canonical JSON admits signed 64-bit integers only and treats '
                + 'a fraction as an error. Scale 0 is integer written the long way and is not a valid scale, and 18 '
                + 'is the ceiling because 10^18 is the largest power of ten a signed 64-bit integer holds — above '
                + 'it no integer part is left to carry. This is the only decimal spelling.',
            decimalScaleRule:
                'the scale is part of the type. Changing it is a breaking change and takes a version bump, and the '
                + 'field is renamed to carry its new unit rather than be remeasured under the same name — the same '
                + 'reason every moment in this contract is named AtMillis. A consumer that kept reading the old '
                + 'name would otherwise decode the same field at a scale nobody told it had moved.',
            decimalGeneratorRule:
                'a generator emits a decimal type — Swift Decimal, Kotlin BigDecimal — and never a binary float. A '
                + 'value finer than the declared scale is rejected at encoding time and never rounded: rounding '
                + 'would let the client decide what a value the server declared exactly is worth, and it would do '
                + 'so silently.',
            array: 'array<T>, where T is itself a field type. This is the only array spelling.',
            map:
                'map<string,T>, where T is itself a field type. The key is always string because JSON has no other '
                + 'key type. This is the only map spelling.',
            named: 'any other value names one of the types or enums below',
            enumRule:
                'a name listed in "enums" is a set of string values rather than an object: its declaration carries '
                + 'values instead of fields. The values are the ones the server accepts and sends now; no set is '
                + 'promised to stay as it is, since a value can be added and one can be withdrawn for a weakness '
                + 'found later. What a consumer does with a value outside the set is the consumer\'s decision',
            dateConvention:
                'there is no date type. A moment in time is an integer of milliseconds since the Unix epoch and its '
                + 'field name ends in AtMillis — issuedAtMillis, expiresAtMillis, createdAtMillis. A second '
                + 'representation would leave a consumer choosing between two spellings of the same value.',
            dateConventionExceptions: 'none — every moment in this contract is an AtMillis integer',
            rule:
                'a field type outside this grammar is a contract error, not something to guess at: a consumer that '
                + 'does not recognise a container or decimal spelling reads it as a type name and fails at compile '
                + 'time',
        },
        types: CONTRACT_TYPES.map((type) => ({
            name: type.name,
            fields: type.fields.map((field) => ({ ...field })),
        })),
        enums: CONTRACT_ENUMS.map((declaration) => ({
            name: declaration.name,
            values: [...declaration.values],
        })),
        operations: [
            ...CORE_PREREQUISITE_OPERATIONS,
            ...CONTRACT_OPERATIONS,
            ...AUTH_SURFACE_OPERATIONS,
        ].map((operation) => ({ ...operation })),
        errorEnvelope: {
            shape: '{"error":{"code":<string>,"message":<string>,"requestId":<string>}}',
            additionalFields:
                'the body carries further top-level fields beside the error object — __type, message, and the '
                + 'error class\'s own public fields. Only error.code classifies the failure',
            unlistedCodes:
                'the server sends codes this list does not carry. Only the operations enumerated here have had '
                + 'their failure paths listed one by one, and every code is a server error class name rather '
                + 'than a value minted for this contract',
        },
        errors: [
            ...CLIENT_PROOF_ERROR_CODES.map((code) => ({
                code,
                httpStatus: HTTP_STATUS[code],
                retryable: RETRYABLE,
                summary: ERROR_SUMMARIES[code],
                surface: 'clientProofV1',
            })),
            ...REST_SURFACE_ERRORS.map((error) => ({ ...error, surface: 'rest' })),
        ],
        notes: [
            'This bundle contains no secret, no real key and no production endpoint. Paths are shapes, not deployed routes.',
            'It is generated output. Edit packages/auth/src/server/client-proof and re-run the export; never edit this file.',
            'The single authority for this contract is SPFN primitives.',
        ],
    };
}

/**
 * No major in the filename while the line is 0.x: under 0.x the minor is what
 * breaks, so `v0` would name nothing useful. The version lives in the bundle
 * and the pin is the digest.
 */
export const BUNDLE_FILENAME = 'spfn-mobile-contract.json';
export const PROVENANCE_FILENAME = 'upstream-provenance.json';
export const REPOSITORY = 'git.superfunction.xyz/superfunction/primitives';
export const BUNDLE_REPO_PATH = `contracts/mobile/${BUNDLE_FILENAME}`;

/**
 * The evidence spfn-mobile's validator requires before a lock may claim an
 * upstream export.
 *
 * `source.commit` is absent by construction: a file cannot carry the SHA of the
 * commit that contains it. The exporter states everything else and the consumer
 * records which commit it read.
 */
export function buildExportProvenance(bundleSha256: string): Record<string, unknown>
{
    return {
        evidenceVersion: 1,
        origin: EXPORT_ORIGIN,
        exportedByUpstreamCI: true,
        exporterVersion: EXPORTER_VERSION,
        statement:
            'This contract bundle was generated from the route and contract definitions in SPFN primitives '
            + '(packages/auth/src/server/client-proof) by packages/auth/scripts/export-mobile-contract.ts. '
            + 'It was not transcribed from any consumer.',
        source: {
            repository: REPOSITORY,
            bundlePath: BUNDLE_REPO_PATH,
            commit: 'RECORDED_BY_CONSUMER',
            commitRule:
                'The consumer sets its own lock source.commit to the exact primitives commit it read this '
                + 'bundle from. A file cannot carry its own commit SHA.',
        },
        contract: {
            name: CONTRACT_NAME,
            version: CONTRACT_VERSION,
            major: CONTRACT_MAJOR,
            supportedRange: CONTRACT_SUPPORTED_RANGE,
            bundleSha256,
        },
        verification: {
            digest: `shasum -a 256 ${BUNDLE_REPO_PATH}`,
            regenerate: 'pnpm --filter @spfn/auth export:mobile-contract',
            enforcedBy: [
                'packages/auth/src/server/client-proof/__tests__/contract-export.test.ts',
                '.github/workflows/verify-mobile-contract.yml',
            ],
            rule:
                'The committed bundle must be byte-identical to what the exporter produces. The test above '
                + 'regenerates and compares, so an edited bundle fails the suite rather than shipping.',
        },
        notes: [
            'The bundle carries no secret, no real key and no production endpoint.',
            'A published contract version and digest are never modified. A mistake becomes a new version.',
        ],
    };
}

/**
 * The bundle as the bytes that get committed and digested.
 *
 * A value short enough to fit on one line stays on one line: it keeps field
 * declarations and short lists readable, and it is what makes the emitted text
 * stable across runs. Everything else is indented two spaces.
 */
export function serializeMobileContractBundle(bundle: MobileContractBundle): string
{
    return `${render(bundle, 0)}\n`;
}

/** Both files of the export, and the digest the consumer pins. */
export function renderMobileContractExport(): { bundle: string; provenance: string; bundleSha256: string }
{
    const bundle = serializeMobileContractBundle(buildMobileContractBundle());
    const bundleSha256 = createHash('sha256').update(bundle, 'utf8').digest('hex');
    const provenance = `${JSON.stringify(buildExportProvenance(bundleSha256), null, 2)}\n`;

    return { bundle, provenance, bundleSha256 };
}

const MAX_INLINE_WIDTH = 100;

function render(value: unknown, depth: number): string
{
    const inline = JSON.stringify(value);
    if (inline === undefined)
    {
        throw new Error('the contract bundle carries a value JSON cannot represent');
    }
    const pad = '  '.repeat(depth);
    if (inline.length + pad.length <= MAX_INLINE_WIDTH || typeof value !== 'object' || value === null)
    {
        return spaced(inline);
    }

    const inner = '  '.repeat(depth + 1);
    if (Array.isArray(value))
    {
        const items = value.map((item) => `${inner}${render(item, depth + 1)}`);

        return `[\n${items.join(',\n')}\n${pad}]`;
    }

    const members = Object.entries(value as Record<string, unknown>)
        .map(([key, member]) => `${inner}${JSON.stringify(key)}: ${render(member, depth + 1)}`);

    return `{\n${members.join(',\n')}\n${pad}}`;
}

/** `{"a":1}` → `{ "a": 1 }` — the inline form used inside the indented one. */
function spaced(inline: string): string
{
    if (!inline.startsWith('{') && !inline.startsWith('['))
    {
        return inline;
    }
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of inline)
    {
        if (escaped)
        {
            out += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && inString)
        {
            out += ch;
            escaped = true;
            continue;
        }
        if (ch === '"')
        {
            inString = !inString;
            out += ch;
            continue;
        }
        if (inString)
        {
            out += ch;
            continue;
        }
        out += separatorFor(ch);
    }

    return out;
}

function separatorFor(ch: string): string
{
    if (ch === ':' || ch === ',')
    {
        return `${ch} `;
    }
    if (ch === '{')
    {
        return '{ ';
    }
    if (ch === '}')
    {
        return ' }';
    }

    return ch;
}
