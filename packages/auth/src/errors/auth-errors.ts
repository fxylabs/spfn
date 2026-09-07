/**
 * Authentication & Authorization Error Classes
 *
 * Custom error classes for auth-specific scenarios
 */

import {
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    ConflictError,
    NotFoundError,
    HttpError,
} from '@spfn/core/errors';

/**
 * Invalid Credentials Error (401)
 *
 * Thrown when login credentials are incorrect
 */
export class InvalidCredentialsError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Invalid credentials', details: data.details });
        this.name = 'InvalidCredentialsError';
    }
}

/**
 * Invalid Token Error (401)
 *
 * Thrown when authentication token is invalid or malformed
 */
export class InvalidTokenError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Invalid authentication token', details: data.details });
        this.name = 'InvalidTokenError';
    }
}

/**
 * Invalid Social Token Error (401)
 *
 * Thrown when a social provider id_token fails verification
 * (bad signature, wrong issuer/audience, expired, or nonce mismatch).
 */
export class InvalidSocialTokenError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Invalid social id_token', details: data.details });
        this.name = 'InvalidSocialTokenError';
    }
}

/**
 * Token Expired Error (401)
 *
 * Thrown when authentication token has expired
 */
export class TokenExpiredError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Authentication token has expired', details: data.details });
        this.name = 'TokenExpiredError';
    }
}

/**
 * Key Expired Error (401)
 *
 * Thrown when public key has expired
 */
export class KeyExpiredError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Public key has expired', details: data.details });
        this.name = 'KeyExpiredError';
    }
}

/**
 * Account Disabled Error (403)
 *
 * Thrown when user account is disabled or inactive
 */
export class AccountDisabledError extends ForbiddenError
{
    constructor(data: { status?: string; message?: string; details?: Record<string, any> } = {})
    {
        const status = data.status || 'disabled';
        super({
            message: data.message || `Account is ${status}`,
            details: { status, ...data.details },
        });
        this.name = 'AccountDisabledError';
    }
}

/**
 * Account Pending Deletion Error (403)
 *
 * Thrown on login (password/OAuth/authenticate) when the account is within its
 * deletion grace period. Carries `purgeScheduledAt` so the client can offer a
 * recovery flow instead of a generic "disabled" message.
 */
export class AccountPendingDeletionError extends ForbiddenError
{
    constructor(data: { purgeScheduledAt?: string; message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Account is scheduled for deletion',
            details: { status: 'pending_deletion', purgeScheduledAt: data.purgeScheduledAt, ...data.details },
        });
        this.name = 'AccountPendingDeletionError';
    }
}

/**
 * Deletion Already Requested Error (409)
 *
 * Thrown when requesting deletion for an account that already has a pending
 * deletion request (or has already been purged).
 */
export class DeletionAlreadyRequestedError extends ConflictError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Account deletion has already been requested', details: data.details });
        this.name = 'DeletionAlreadyRequestedError';
    }
}

/**
 * Deletion Not Requested Error (404)
 *
 * Thrown when trying to cancel/purge a deletion for an account that has no
 * pending deletion request.
 */
export class DeletionNotRequestedError extends NotFoundError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'No pending account deletion request found', details: data.details });
        this.name = 'DeletionNotRequestedError';
    }
}

/**
 * Immediate Deletion Not Allowed Error (403)
 *
 * Thrown when a self-service caller requests `immediate: true` but the server
 * has not enabled `deletion.allowSelfImmediate`.
 */
export class ImmediateDeletionNotAllowedError extends ForbiddenError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Immediate self-service deletion is not enabled', details: data.details });
        this.name = 'ImmediateDeletionNotAllowedError';
    }
}

/**
 * Account Already Exists Error (409)
 *
 * Thrown when trying to register with existing email/phone
 */
export class AccountAlreadyExistsError extends ConflictError
{
    constructor(data: { identifier?: string; identifierType?: 'email' | 'phone'; message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Account already exists',
            details: {
                identifier: data.identifier,
                identifierType: data.identifierType,
                ...data.details,
            },
        });
        this.name = 'AccountAlreadyExistsError';
    }
}

/**
 * Registration Rejected Error (403)
 *
 * Thrown by the app-injected beforeRegister hook to reject a registration
 * (age gate, domain restriction, block list, ...)
 */
export class RegistrationRejectedError extends ForbiddenError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Registration rejected', details: data.details });
        this.name = 'RegistrationRejectedError';
    }
}

/**
 * Invalid Verification Code Error (400)
 *
 * Thrown when verification code is invalid, expired, or already used
 */
export class InvalidVerificationCodeError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Invalid verification code', details: data.details });
        this.name = 'InvalidVerificationCodeError';
    }
}

/**
 * Invalid Verification Token Error (400)
 *
 * Thrown when verification token is invalid or expired
 */
export class InvalidVerificationTokenError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Invalid or expired verification token', details: data.details });
        this.name = 'InvalidVerificationTokenError';
    }
}

/**
 * Key ID Already Registered Error (409)
 *
 * Thrown when a sign-in submits a keyId that is already taken — the client's own
 * revoked keyId, or a keyId belonging to another user. `keyId` is unique across
 * all users, so either case would collide on insert.
 *
 * The same error covers both cases on purpose: a distinguishable response would
 * let a caller probe whether an arbitrary keyId exists. Revoked stays revoked —
 * the client must generate a fresh keyId and retry.
 */
export class KeyIdAlreadyRegisteredError extends ConflictError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This keyId is already registered. Generate a new keyId and retry.',
            details: data.details,
        });
        this.name = 'KeyIdAlreadyRegisteredError';
    }
}

/**
 * Invalid Key Fingerprint Error (400)
 *
 * Thrown when public key fingerprint doesn't match the public key
 */
export class InvalidKeyFingerprintError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Invalid key fingerprint', details: data.details });
        this.name = 'InvalidKeyFingerprintError';
    }
}

/**
 * Key Algorithm Mismatch Error (400)
 *
 * Thrown when the submitted public key's SPKI type is not the one its declared
 * algorithm needs — a P-256 EC key declared RS256, an RSA key declared ES256, a
 * curve other than P-256 declared ES256, or bytes that are no SPKI key at all.
 *
 * The algorithm is stored beside the key and read back at proof verification;
 * nothing re-derives it from the key material. So a mismatch accepted here
 * surfaces only after the device believes it is enrolled, on every request it
 * then makes. It is refused at registration instead, wherever key material is
 * stored: register, login, rotate, invitation acceptance and device start.
 */
export class KeyAlgorithmMismatchError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Public key type does not match the declared algorithm',
            details: data.details,
        });
        this.name = 'KeyAlgorithmMismatchError';
    }
}

/**
 * Key Not Found Error (404)
 *
 * Thrown when a key operation names a keyId the caller does not own. It says
 * nothing about whether that keyId exists on another account — the repository
 * scopes every lookup by userId, so the answer is only ever "not yours".
 */
export class KeyNotFoundError extends NotFoundError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Key not found', details: data.details });
        this.name = 'KeyNotFoundError';
    }
}

/**
 * Device Auth Not Found Error (404)
 *
 * Thrown when a device-code operation names a code the server cannot act on: one
 * that was never issued, and one whose record has already been consumed.
 *
 * Those two are answered identically on purpose. A consumed record is a login
 * that finished, and saying so would tell whoever holds the code that it was
 * real — which is the difference between guessing at random and knowing a guess
 * landed. Every route that accepts a code is rate limited for the same reason.
 */
export class DeviceAuthNotFoundError extends NotFoundError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({ message: data.message || 'Device authorization not found', details: data.details });
        this.name = 'DeviceAuthNotFoundError';
    }
}

/**
 * Device Auth Expired Error (400)
 *
 * Thrown when a device-code operation names a record whose TTL has run out,
 * whatever state it is in. The waiting device starts again; the approver is told
 * the code on the other screen is stale.
 *
 * 400 rather than 401: on the approve and deny routes the caller's own session is
 * fine, and answering 401 would send a signed-in user to a login screen over a
 * code that simply sat too long.
 */
export class DeviceAuthExpiredError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This device code has expired. Start again on the other device.',
            details: data.details,
        });
        this.name = 'DeviceAuthExpiredError';
    }
}

/**
 * Device Auth Already Handled Error (409)
 *
 * Thrown when an approve, deny or info call names a record that has already been
 * approved or denied. A decision on a device is made once — a second approval
 * would let one code be answered twice, and re-approving a record the owner
 * denied would undo the refusal.
 *
 * This is also what the loser of two concurrent approvals sees, since the
 * transition names the state it moves from and only one call can match it.
 */
export class DeviceAuthAlreadyHandledError extends ConflictError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This device request has already been answered',
            details: data.details,
        });
        this.name = 'DeviceAuthAlreadyHandledError';
    }
}

/**
 * Device Auth Denied Error (403)
 *
 * Thrown when the waiting device polls a record its owner refused. Distinct from
 * a pending answer, and distinct from a code that does not exist: the device
 * asked a person and the person said no, so it should stop polling and say so
 * rather than time out looking like a network fault.
 */
export class DeviceAuthDeniedError extends ForbiddenError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This device request was denied',
            details: data.details,
        });
        this.name = 'DeviceAuthDeniedError';
    }
}

/**
 * Nonce Key Binding Error (400)
 *
 * Thrown when a native id_token sign-in submits a nonce that is not the public
 * key's fingerprint. The nonce is what the provider echoed back inside the
 * id_token, so tying it to the key is what proves the id_token and the key came
 * from the same device — see the native section of the README.
 */
export class NonceKeyBindingError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'nonce must be the fingerprint of the submitted public key',
            details: data.details,
        });
        this.name = 'NonceKeyBindingError';
    }
}

/**
 * Native Sign-In Unsupported Error (400)
 *
 * Thrown when a provider is asked for native id_token sign-in and has no
 * implementation for it — a server configuration fact, not something the user
 * did. A client reading this hides that provider's native button instead of
 * asking the user to try again.
 *
 * Split out of ValidationError because the other native-enrollment refusal
 * (linking to an account whose email the provider never verified) needs a
 * different response from the app, and one code cannot ask for two.
 */
export class NativeSignInUnsupportedError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This provider does not support native id_token sign-in.',
            details: data.details,
        });
        this.name = 'NativeSignInUnsupportedError';
    }
}

/**
 * Invalid Signup Link Error (400)
 *
 * Thrown when an emailed signup confirmation link is unknown, expired, already
 * consumed, or superseded by a newer request for the same address.
 *
 * One error for all four states, on purpose. Distinguishing "expired" from
 * "unknown" tells a caller holding a random token whether it named a real
 * pending signup, which is exactly the enumeration the request step avoids. The
 * specific reason is logged.
 */
export class InvalidSignupLinkError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This signup link is no longer valid. Request a new one.',
            details: data.details,
        });
        this.name = 'InvalidSignupLinkError';
    }
}

/**
 * Invalid Signup Setup Session Error (401)
 *
 * Thrown when the password-setup session backing a verified-email signup is
 * missing, unknown, expired, superseded or already used.
 *
 * One error for every one of those, on purpose: telling a caller which of them
 * applies tells them whether an address is mid-signup, which is the same
 * enumeration the request step is careful not to leak.
 */
export class InvalidSignupSetupSessionError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Password setup session is invalid or has expired. Start the signup again.',
            details: data.details,
        });
        this.name = 'InvalidSignupSetupSessionError';
    }
}

/**
 * Unverified Email Link Error (400)
 *
 * Thrown when a social identity carries an email that already belongs to an
 * account, but the provider never verified it. Linking on an unverified email
 * is account takeover, so the refusal stands and the user is sent to a path
 * that proves the address.
 *
 * This says an account exists for that address. It is not a leak introduced
 * here: the message this replaces already stated the same fact in prose, and
 * the paths that must not disclose account existence (password login, deletion
 * re-auth, verification issuance) answer uniformly and are untouched.
 */
export class UnverifiedEmailLinkError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message
                || 'Cannot link to existing account with unverified email. Please verify your email with the provider first.',
            details: data.details,
        });
        this.name = 'UnverifiedEmailLinkError';
    }
}

/**
 * Verification Token Purpose Mismatch Error (400)
 *
 * Thrown when verification token purpose doesn't match expected purpose
 */
export class VerificationTokenPurposeMismatchError extends ValidationError
{
    constructor(data: { expected?: string; actual?: string; message?: string; details?: Record<string, any> } = {})
    {
        const expected = data.expected || 'unknown';
        const actual = data.actual || 'unknown';
        super({
            message: data.message || `Verification token is for ${actual}, but ${expected} was expected`,
            details: { expected, actual, ...data.details },
        });
        this.name = 'VerificationTokenPurposeMismatchError';
    }
}

/**
 * Verification Token Target Mismatch Error (400)
 *
 * Thrown when verification token target doesn't match provided email/phone
 */
export class VerificationTokenTargetMismatchError extends ValidationError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Verification token does not match provided email/phone',
            details: data.details,
        });
        this.name = 'VerificationTokenTargetMismatchError';
    }
}

/**
 * Reserved Username Error (400)
 *
 * Thrown when trying to use a reserved/prohibited username
 */
export class ReservedUsernameError extends ValidationError
{
    constructor(data: { username?: string; message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This username is reserved',
            details: { username: data.username, ...data.details },
        });
        this.name = 'ReservedUsernameError';
    }
}

/**
 * Username Already Taken Error (409)
 *
 * Thrown when trying to set a username that is already in use
 */
export class UsernameAlreadyTakenError extends ConflictError
{
    constructor(data: { username?: string; message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Username is already taken',
            details: { username: data.username, ...data.details },
        });
        this.name = 'UsernameAlreadyTakenError';
    }
}

/**
 * Insufficient Permissions Error (403)
 *
 * Thrown when user lacks required permissions for the operation
 */
export class InsufficientPermissionsError extends ForbiddenError
{
    constructor(data: { requiredPermissions?: string[]; message?: string; details?: Record<string, any> } = {})
    {
        const requiredPermissions = data.requiredPermissions || [];
        super({
            message: data.message || `Missing required permissions: ${requiredPermissions.join(', ')}`,
            details: { requiredPermissions, ...data.details },
        });
        this.name = 'InsufficientPermissionsError';
    }
}

/**
 * Insufficient Role Error (403)
 *
 * Thrown when user lacks required role for the operation
 */
export class InsufficientRoleError extends ForbiddenError
{
    constructor(data: { requiredRoles?: string[]; message?: string; details?: Record<string, any> } = {})
    {
        const requiredRoles = data.requiredRoles || [];
        super({
            message: data.message || `Required roles: ${requiredRoles.join(', ')}`,
            details: { requiredRoles, ...data.details },
        });
        this.name = 'InsufficientRoleError';
    }
}

/**
 * Passkey Challenge Error (401)
 *
 * Thrown when the challenge a WebAuthn ceremony presents is unknown, expired,
 * already spent, minted for the other ceremony, or minted for another account.
 *
 * One error for all five, on purpose. Telling a caller which applies tells them
 * whether a challenge they did not mint exists and what it was for, and the
 * remedy is the same in every case: start the ceremony again.
 */
export class PasskeyChallengeError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This passkey challenge is no longer valid. Try again.',
            details: data.details,
        });
        this.name = 'PasskeyChallengeError';
    }
}

/**
 * Passkey Verification Error (401)
 *
 * Thrown when an assertion or attestation does not verify: wrong origin, wrong
 * rpId, a bad signature, a regressed signature counter — or, on login, a
 * credential that is unknown or has been revoked.
 *
 * Those last two share this error with the cryptographic failures deliberately.
 * A distinct "no such passkey" would answer, to anyone holding a credential id,
 * whether it is enrolled here — and a revoked credential answering differently
 * from an unknown one would say the account once had it.
 */
export class PasskeyVerificationError extends UnauthorizedError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Passkey verification failed.',
            details: data.details,
        });
        this.name = 'PasskeyVerificationError';
    }
}

/**
 * Passkey Not Found Error (404)
 *
 * Thrown when a management operation names a passkey the caller does not own,
 * or one already revoked. Every lookup is owner-scoped, so the answer is only
 * ever "not yours" and says nothing about other accounts.
 */
export class PasskeyNotFoundError extends NotFoundError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Passkey not found',
            details: data.details,
        });
        this.name = 'PasskeyNotFoundError';
    }
}

/**
 * Passkey Already Registered Error (409)
 *
 * Thrown when the credential presented for enrollment is already on file for
 * some account — including one that revoked it. A credential id is reserved for
 * good once used, so this is also the answer to re-enrolling one's own revoked
 * passkey.
 */
export class PasskeyAlreadyRegisteredError extends ConflictError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'This passkey is already registered',
            details: data.details,
        });
        this.name = 'PasskeyAlreadyRegisteredError';
    }
}

/**
 * Recent Authentication Required Error (403)
 *
 * Thrown when enrolling or revoking a passkey from a session that proved itself
 * too long ago and carried no password. Clients branch on `code` to know to
 * prompt for the password rather than to show a generic refusal, so the code is
 * a stable field rather than a message they would have to match on.
 */
export class RecentAuthenticationRequiredError extends ForbiddenError
{
    readonly code = 'RECENT_AUTH_REQUIRED';

    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Confirm it is you before changing passkeys. Sign in again or send your current password.',
            details: data.details,
        });
        this.name = 'RecentAuthenticationRequiredError';
    }
}

/**
 * Last Recovery Credential Error (409)
 *
 * Thrown when revoking a passkey would leave the account with no way back in:
 * no other live passkey, no password, and no linked social account. There is no
 * password reset in this package, so that state is not recoverable by support
 * either — the refusal is the only thing standing between the owner and a
 * locked account.
 *
 * Clients branch on `code` to offer "set a password first" instead of a generic
 * refusal.
 */
export class LastRecoveryCredentialError extends ConflictError
{
    readonly code = 'LAST_RECOVERY_CREDENTIAL';

    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message
                || 'This is the only way you can sign in. Set a password or link a social account before removing it.',
            details: data.details,
        });
        this.name = 'LastRecoveryCredentialError';
    }
}

/**
 * Passkey Config Error (500)
 *
 * Thrown at boot when the passkey relying-party configuration cannot be honoured
 * — an origin that is not https outside localhost, an origin off the rpId, an
 * unsupported user-verification value.
 *
 * A refusal at boot rather than at the first ceremony: every one of these makes
 * every passkey operation fail, and the drift is between environments, so the
 * deploy that introduces it is where it has to surface.
 */
export class PasskeyConfigError extends HttpError
{
    constructor(data: { message: string; details?: Record<string, any> })
    {
        super({
            message: data.message,
            statusCode: 500,
            details: data.details,
        });
        this.name = 'PasskeyConfigError';
    }
}
