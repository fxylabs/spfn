/**
 * Every class in `authErrorRegistry` survives the trip to the app's page (#459)
 *
 * A thrown auth error is serialized by `toJSON()`, travels as JSON with its status
 * as the HTTP status, and is restored by the auth client — `createAuthApi`, the
 * registry it builds — through `ErrorRegistry.deserialize`, which hands the
 * constructor the fields where the body carries them. A constructor that reads a
 * field from anywhere else rebuilds the error without it, and nothing fails: the
 * page just holds less.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | R1 | the fixtures name exactly the registered classes | a class registered later with no fixture, never round-tripped |
 * | R2 | each class, built with every constructor field set, is restored by the auth client as the same class with the same public fields and status | a field the constructor reads from where the body does not carry it: `SignInRefusedError` and `PasswordChangeRefusedError` took `code` and stored it as `details.code`, and came back with `details.code` undefined |
 * | R3 | the stale-premise refusal `assertCanChangeRole` throws in a transaction the app opened is restored as `AuthorityContendedError` (409) | an unregistered subclass travelling under its own name: the client restores it as a generic error |
 * | R4 | each class sends exactly the body keys it sent on `main` | a body key every client sees that no one decided on: `statusCode` serialized by core's `HttpError` for every auth error built on it |
 *
 * Each fixture is typed `Required<…>` of its constructor's argument, so a class
 * that gains a field does not compile here until the fixture sets it.
 *
 * `fixtures/main-body-keys.json` was taken from `main` at d0105b3b: each
 * registered class, built there with this file's fixtures (the two refusals
 * with `code` beside `details`, main's constructor), serialized, and its keys
 * listed in order. `PasswordRuleFailedError` (#458) and `PasskeyHookFailedError`
 * (#493) are not on `main`: each entry is what the class sends when it is first
 * registered, taken the same way.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SerializableError } from '@spfn/core/errors';

import { createAuthApi } from '@/index';
import { authErrorRegistry } from '@/errors';
import * as authErrors from '@/errors/auth-errors';
import { rolesRepository, usersRepository } from '@/server/repositories';
import type { AuthorityRead } from '@/server/repositories/users.repository';
import { assertCanChangeRole } from '@/server/services/permission.service';

import mainBodyKeys from './fixtures/main-body-keys.json';

/** The module's error classes, without the message constant it also exports. */
type Classes = {
    [K in keyof typeof authErrors as (typeof authErrors)[K] extends new (...args: never[]) => SerializableError ? K : never]: (typeof authErrors)[K];
};

/** Every field of each class's constructor argument, none left to its default. */
type Fixtures = { [K in keyof Classes]: Required<NonNullable<ConstructorParameters<Classes[K]>[0]>> };

const DETAILS = { requestRef: 'r-1' };
const PLAIN = { message: 'refused for the round trip', details: DETAILS };

const fixtures: Fixtures = {
    InvalidCredentialsError: PLAIN,
    InvalidTokenError: PLAIN,
    InvalidSocialTokenError: PLAIN,
    TokenExpiredError: PLAIN,
    KeyExpiredError: PLAIN,
    KeyRevokedError: PLAIN,
    AccountNotFoundError: PLAIN,
    AccountDisabledError: { status: 'suspended', message: 'held', details: DETAILS },
    AccountPendingDeletionError: { purgeScheduledAt: '2026-12-01T00:00:00.000Z', message: 'leaving', details: DETAILS },
    DeletionAlreadyRequestedError: PLAIN,
    DeletionNotRequestedError: PLAIN,
    ImmediateDeletionNotAllowedError: PLAIN,
    PurgeHookFailedError: { requestId: 9, hookErrorClass: 'PostgresError', hookErrorCode: '23505' },
    AccountAlreadyExistsError: { identifier: 'a@example.com', identifierType: 'email', message: 'taken', details: DETAILS },
    RegistrationRejectedError: PLAIN,
    SignInRefusedError: { message: 'refused', details: { ...DETAILS, code: 'LOCKED' } },
    PasswordChangeRefusedError: { message: 'refused', details: { ...DETAILS, code: 'TEMPORARY_PASSWORD_EXPIRED' } },
    PasswordChangeHookFailedError: { hook: 'admit', userId: 3, hookErrorClass: 'PostgresError', hookErrorCode: '23505' },
    PasskeyHookFailedError: { hook: 'revoked', path: 'reset', userId: 3, hookErrorClass: 'PostgresError', hookErrorCode: '23505' },
    PasswordRuleFailedError: { channel: 'register', hookErrorClass: 'PostgresError', hookErrorCode: '23505' },
    InvalidVerificationCodeError: PLAIN,
    InvalidVerificationTokenError: PLAIN,
    KeyIdAlreadyRegisteredError: PLAIN,
    InvalidKeyFingerprintError: PLAIN,
    KeyAlgorithmMismatchError: PLAIN,
    KeyNotFoundError: PLAIN,
    RevokeAllLinkError: PLAIN,
    InvitationNotFoundError: PLAIN,
    InvitationNoLongerValidError: PLAIN,
    InvitationChangedError: PLAIN,
    ConfigOwnedMappingError: PLAIN,
    ConfigOwnedRoleError: PLAIN,
    RoleInUseError: PLAIN,
    AuthorityContendedError: PLAIN,
    DeviceAuthNotFoundError: PLAIN,
    DeviceAuthExpiredError: PLAIN,
    DeviceAuthAlreadyHandledError: PLAIN,
    DeviceAuthDeniedError: PLAIN,
    DeviceLinkNotFoundError: PLAIN,
    DeviceLinkExpiredError: PLAIN,
    DeviceLinkNotRedeemedError: PLAIN,
    DeviceLinkAlreadyHandledError: PLAIN,
    DeviceLinkWrongMatchError: PLAIN,
    DeviceLinkDeniedError: PLAIN,
    NonceKeyBindingError: PLAIN,
    NativeSignInUnsupportedError: PLAIN,
    InvalidSignupLinkError: PLAIN,
    InvalidSignupSetupSessionError: PLAIN,
    PasswordResetLinkError: PLAIN,
    PasswordResetSessionError: PLAIN,
    UnverifiedEmailLinkError: PLAIN,
    OAuthStateExpiredError: PLAIN,
    OAuthStateInvalidError: PLAIN,
    OAuthCookieMissingError: PLAIN,
    OAuthProviderError: PLAIN,
    OAuthAccountNotFoundError: PLAIN,
    VerificationTokenPurposeMismatchError: { expected: 'registration', actual: 'password_reset', message: 'wrong purpose', details: DETAILS },
    VerificationTokenTargetMismatchError: PLAIN,
    ReservedUsernameError: { username: 'admin', message: 'reserved', details: DETAILS },
    UsernameAlreadyTakenError: { username: 'ada', message: 'taken', details: DETAILS },
    InsufficientPermissionsError: { requiredPermissions: ['user:delete'], message: 'missing', details: DETAILS },
    InsufficientRoleError: { requiredRoles: ['admin'], message: 'missing', details: DETAILS },
    RoleEmailDomainNotAllowedError: { roleName: 'admin', reason: 'domain', message: 'not here', details: DETAILS },
    PasskeyChallengeError: PLAIN,
    PasskeyVerificationError: PLAIN,
    PasskeyNotFoundError: PLAIN,
    PasskeyAlreadyRegisteredError: PLAIN,
    RecentAuthenticationRequiredError: PLAIN,
    OAuthProviderAlreadyLinkedError: PLAIN,
    OAuthSignInContendedError: PLAIN,
    OAuthLinkNotFoundError: PLAIN,
    OAuthLinkCredentialUnsupportedError: PLAIN,
    DeferredCredentialUnsupportedError: PLAIN,
    OAuthProviderLinkOnlyError: PLAIN,
    SignupDisabledError: PLAIN,
    ChannelDisabledError: PLAIN,
    OAuthEmailInUseError: PLAIN,
    LastRecoveryCredentialError: PLAIN,
    SessionRenewalRequiredError: PLAIN,
    SessionRenewalRefusedError: PLAIN,
    SessionContextChangedError: PLAIN,
    SessionBindingUnavailableError: PLAIN,
    SessionResealFailedError: PLAIN,
    SessionSealFailedError: PLAIN,
    SessionDecisionMissingError: PLAIN,
    PasskeyConfigError: PLAIN,
    RbacSyncBusyError: PLAIN,
    OAuth2UnknownClientError: PLAIN,
    OAuth2RedirectUriMismatchError: PLAIN,
    OAuth2AuthorizeRedirectError: { error: 'access_denied', redirectUri: 'https://client.test/cb', state: 's-1', iss: 'https://app.test', message: 'refused', details: DETAILS },
    OAuth2GrantNotFoundError: PLAIN,
    MfaAlreadyEnrolledError: PLAIN,
    MfaNotEnrolledError: PLAIN,
    MfaVerificationFailedError: PLAIN,
    SecondFactorLockedError: { message: 'locked', retryAfter: 60, details: DETAILS },
    PasskeyUserVerificationRequiredError: PLAIN,
    StepUpRequiredError: PLAIN,
    PasskeyProofRequiredError: PLAIN,
    SecondFactorEnrolmentRequiredError: PLAIN,
    PasswordChangeRequiredError: PLAIN,
    SecondFactorMethodDisabledError: PLAIN,
    SecondFactorRequiredError: PLAIN,
    SessionPendingMismatchError: PLAIN,
    SessionPendingExpiredError: PLAIN,
    MfaConfigError: PLAIN,
    UserSettingNotDeclaredError: PLAIN,
    AccountBusyError: PLAIN,
};

/** The error the auth client throws for `thrown`, answered with its body and status. */
async function restored(thrown: SerializableError): Promise<SerializableError>
{
    const answer = new Response(JSON.stringify(thrown), {
        status: thrown.statusCode,
        headers: { 'content-type': 'application/json' },
    });

    return await createAuthApi({ fetch: async () => answer })
        .getAuthSession.call({})
        .then(() => null, (error: SerializableError) => error) as SerializableError;
}

/** The public fields a page reads: the body's, and the status. */
function publicFields(error: SerializableError): Record<string, unknown>
{
    return { ...error.toJSON(), statusCode: error.statusCode };
}

describe('authErrorRegistry round trip (#459)', () =>
{
    it('R1: the fixtures name exactly the registered classes', () =>
    {
        expect(Object.keys(fixtures).sort()).toEqual(authErrorRegistry.getRegisteredTypes().sort());
    });

    it.each(Object.keys(fixtures) as Array<keyof Classes>)('R2: %s is restored with its public fields', async (name) =>
    {
        const ErrorClass = authErrors[name] as new (data: unknown) => SerializableError;
        const thrown = new ErrorClass(fixtures[name]);
        const error = await restored(thrown);

        expect(error.constructor).toBe(ErrorClass);
        expect(publicFields(error)).toStrictEqual(publicFields(thrown));
    });

    it.each(Object.keys(fixtures) as Array<keyof Classes>)('R4: %s sends the body keys it sent on main', (name) =>
    {
        const ErrorClass = authErrors[name] as new (data: unknown) => SerializableError;

        expect(Object.keys(JSON.parse(JSON.stringify(new ErrorClass(fixtures[name])))))
            .toEqual(mainBodyKeys[name]);
    });
});

describe('a refusal thrown as an internal subclass (#459)', () =>
{
    afterEach(() => vi.restoreAllMocks());

    /** The caller, read with an active role: their second read, after the role was given them. */
    const promoted = {
        user: { id: 1, email: 'caller@example.com', status: 'active' },
        role: { id: 2, name: 'admin', displayName: 'Admin', priority: 80, isActive: true },
        rolePermissions: [],
        grants: [],
        grantExpiries: [],
        revokes: [],
    } as unknown as AuthorityRead;

    it('R3: the stale premise assertCanChangeRole throws is restored as AuthorityContendedError (409)', async () =>
    {
        vi.spyOn(usersRepository, 'findAuthorityOnPrimary').mockResolvedValueOnce(null).mockResolvedValueOnce(promoted);
        vi.spyOn(rolesRepository, 'lockInIdOrder').mockResolvedValue([]);
        const thrown = await assertCanChangeRole(1, { targetUserCurrentRole: null, newRole: null })
            .then(() => null, (error: SerializableError) => error);
        const error = await restored(thrown!);

        expect(error).toBeInstanceOf(authErrors.AuthorityContendedError);
        expect(error.statusCode).toBe(409);
    });
});
