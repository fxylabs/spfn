/**
 * TypeBox Schemas - Single Source of Truth
 *
 * All validation schemas, types, and runtime constants are defined here.
 * Other modules import from this file to ensure consistency.
 */

import { Type, Static } from '@sinclair/typebox';
import { EMAIL_PATTERN, PHONE_PATTERN } from '@spfn/auth';
import { KEY_DEVICE_NAME_MAX_LENGTH, KEY_PLATFORM, SESSION_BINDINGS } from '../types';

// ============================================================================
// Basic Schemas
// ============================================================================

export const EmailSchema = Type.String({
    pattern: EMAIL_PATTERN,
    description: 'Email address',
});

export const PhoneSchema = Type.String({
    pattern: PHONE_PATTERN,
    description: 'Phone number in E.164 format (e.g., +821012345678)',
});

/**
 * Optional device labels a client may send when registering a key.
 *
 * Display only: the key list uses them to tell one device from another, and
 * nothing is authorized or refused by either value, so a client that lies about
 * them gains nothing. Both are omitted by every key registered before they
 * existed, hence optional rather than defaulted.
 */
export const DeviceNameSchema = Type.String({
    maxLength: KEY_DEVICE_NAME_MAX_LENGTH,
    description: `Device label shown in the key list (max ${KEY_DEVICE_NAME_MAX_LENGTH} chars)`,
});

export const PlatformSchema = Type.Union(
    KEY_PLATFORM.map(platform => Type.Literal(platform)),
    { description: 'Platform the key lives on' },
);

/**
 * Key material as a device sends it, bounded.
 *
 * The bounds exist for the one route that takes this material from a caller who
 * has not authenticated and cannot: `POST /_auth/device/start` persists what it
 * is given, and a correctly fingerprinted megabyte of base64 would sit in
 * `device_authorizations` until something swept it — and nothing sweeps it.
 *
 * The numbers are what real key material measures, with room to spare. The
 * package's own generators produce SPKI DER in base64: 124 characters for
 * ES256 (P-256), 392 for RS256 (RSA-2048). An RSA-4096 key would be 736, an
 * RSA-8192 key about 1400, and the same 4096-bit key PEM-armoured about 800 —
 * so 2048 admits every shape of key anyone could reasonably present, while a
 * megabyte is refused three orders of magnitude before it reaches a row.
 *
 * `keyId` is a UUID (36) everywhere this package generates one; 64 leaves room
 * for a client that prefixes or namespaces its own. `fingerprint` is SHA-256
 * hex, exactly 64, and nothing else can ever verify against the public key —
 * 128 is the length a longer digest would need, and no more.
 */
export const PublicKeySchema = Type.String({
    maxLength: 2048,
    description: 'Client public key, SPKI DER in base64',
});

export const KeyIdSchema = Type.String({
    maxLength: 64,
    description: 'Key identifier',
});

export const FingerprintSchema = Type.String({
    maxLength: 128,
    description: 'SHA-256 hex fingerprint of the public key',
});

/**
 * The code a person reads off the waiting device and types on their own.
 *
 * Loose on purpose: 8 characters plus an optional dash is what is shown, but the
 * server folds whitespace, dashes and lower case away before looking anything up,
 * so refusing those spellings here would refuse a code that is on screen. The
 * bounds exist to stop an unbounded string reaching the database, not to spell
 * out the format — `USER_CODE_ALPHABET` is the only thing that can match a row.
 */
export const UserCodeSchema = Type.String({
    minLength: 8,
    maxLength: 16,
    description: 'Device user code as displayed, e.g. WXYZ-2345. Dashes, spaces and case are ignored.',
});

/**
 * What `POST /_auth/device/poll` answers with.
 *
 * A union, because the two answers are different kinds of thing rather than one
 * shape with optional fields: pending says "ask again in this long", approved is
 * a completed login carrying exactly what `/_auth/login` returns. `status` is the
 * discriminant, so a generated client narrows on it instead of testing which
 * fields happen to be present.
 *
 * The mobile contract has no union type, so it exports this as one object with
 * `status` required and every branch field optional — see
 * `deviceAuthorization.pollStatusRule` in the bundle. `intervalMillis` is an
 * integer for the same reason: that grammar carries no floating-point scalar,
 * and a count of milliseconds never needed one.
 *
 * That integer is a promise two things keep, because nothing validates a response
 * against this schema on the way out. `configureDeviceAuth` refuses an interval
 * that is not a whole number of milliseconds, so the only value this branch can
 * carry is one; and `contract-export.test.ts` reads this schema to check the
 * exported declaration, so writing `Type.Number` here fails the suite instead of
 * publishing an integer the server does not send.
 */
export const DeviceAuthPollResponseSchema = Type.Union([
    Type.Object({
        status: Type.Literal('pending'),
        intervalMillis: Type.Integer({ description: 'Milliseconds to wait before polling again' }),
    }),
    Type.Object({
        status: Type.Literal('approved'),
        // The `LoginResult` discriminant, carried because the approved branch is
        // a `LoginResult` spread whole (#95). Always false here: a device-code
        // approval is the owner saying yes on a device that is already signed
        // in, which is itself a second factor, so this channel never steps up
        // and never carries a challenge.
        mfaRequired: Type.Boolean(),
        userId: Type.String(),
        publicId: Type.String(),
        email: Type.Optional(Type.String()),
        phone: Type.Optional(Type.String()),
        passwordChangeRequired: Type.Boolean(),
        // The approved branch is a `LoginResult` spread whole, so it carries the
        // binding fields a sign-in can carry (#97). In practice it never does: a
        // waiting device polls the backend directly, and a key is bound only on a
        // request that reached it through the trusted Next.js proxy. Declared
        // anyway, because the branch is whatever the login answered and the two
        // must not be able to drift apart.
        sessionBinding: Type.Optional(Type.Union(SESSION_BINDINGS.map(mode => Type.Literal(mode)))),
        keyExpiresAtMillis: Type.Optional(Type.Integer()),
    }),
], {
    description: 'Pending, or the login the approval produced',
});

export const PasswordSchema = Type.String({
    minLength: 8,
    maxLength: 72,
    description: 'User password (8–72 characters). bcrypt silently ignores bytes past 72, so longer inputs are rejected rather than truncated.',
});

// ============================================================================
// Verification Target Type
// ============================================================================

export const TargetTypeSchema = Type.Union([
    Type.Literal('email'),
    Type.Literal('phone'),
], {
    description: 'Type of target (email or phone)',
});

export type VerificationTargetType = Static<typeof TargetTypeSchema>;

export const VERIFICATION_TARGET_TYPES = ['email', 'phone'] as const;

// ============================================================================
// Verification Purpose
// ============================================================================

export const VerificationPurposeSchema = Type.Union([
    Type.Literal('registration'),
    Type.Literal('login'),
    Type.Literal('password_reset'),
    Type.Literal('email_change'),
    Type.Literal('phone_change'),
    Type.Literal('account_deletion'),
], {
    description: 'Purpose of verification',
});

export type VerificationPurpose = Static<typeof VerificationPurposeSchema>;

export const VERIFICATION_PURPOSES = ['registration', 'login', 'password_reset', 'email_change', 'phone_change', 'account_deletion'] as const;
