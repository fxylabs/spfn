/**
 * @spfn/auth - Services Export
 *
 * All business logic services for reusability
 */

// Auth Service
export {
    registerService,
    loginService,
    logoutService,
    changePasswordService,
} from './auth.service';

export type {
    RegisterParams,
    RegisterResult,
    LoginParams,
    LoginResult,
    LogoutParams,
    ChangePasswordParams,
    MfaChallengeHandle,
} from './auth.service';

// Password Rule — the app's own code writing a password through the repository
export { hashNewPassword } from './password-rule.service';

// Verification Service
export {
    sendVerificationCodeService,
    verifyCodeService,
} from './verification.service';

export type {
    SendVerificationCodeParams,
    SendVerificationCodeResult,
    VerifyCodeParams,
    VerifyCodeResult,
} from './verification.service';

// Verified-Email Signup Service
export {
    requestSignupLinkService,
    confirmSignupLinkService,
    completeSignupService,
    isSafeReturnPath,
} from './signup-link.service';

export type {
    RequestSignupLinkParams,
    RequestSignupLinkResult,
    ConfirmSignupLinkParams,
    ConfirmSignupLinkResult,
    CompleteSignupParams,
} from './signup-link.service';

// Password Reset Service
export {
    requestPasswordResetService,
    confirmPasswordResetService,
    completePasswordResetService,
} from './password-reset.service';

export type {
    RequestPasswordResetParams,
    RequestPasswordResetResult,
    ConfirmPasswordResetParams,
    ConfirmPasswordResetResult,
    CompletePasswordResetParams,
} from './password-reset.service';

// Signed sign-out-everywhere link
export {
    createRevokeAllLink,
    describeRevokeAllLink,
    consumeRevokeAllLink,
    purgeRevokeAllTokensService,
} from './revoke-all-link.service';

export type {
    CreateRevokeAllLinkOptions,
    RevokeAllLink,
    RevokeAllLinkDescription,
} from './revoke-all-link.service';

// Device-code Login Service
export {
    startDeviceAuthService,
    getDeviceAuthInfoService,
    approveDeviceAuthService,
    denyDeviceAuthService,
    pollDeviceAuthService,
} from './device-auth.service';

export type {
    StartDeviceAuthParams,
    StartDeviceAuthResult,
    DeviceAuthInfoParams,
    DeviceAuthInfoResult,
    ApproveDeviceAuthParams,
    DenyDeviceAuthParams,
    PollDeviceAuthParams,
    PollDeviceAuthResult,
    DeviceAuthPendingResult,
    DeviceAuthApprovedResult,
} from './device-auth.service';

// Device Link Service
export {
    issueDeviceLinkService,
    redeemDeviceLinkService,
    getDeviceLinkStatusService,
    confirmDeviceLinkService,
    denyDeviceLinkService,
    cancelDeviceLinkService,
    pollDeviceLinkService,
} from './device-link.service';

export type {
    DeviceLinkIssuer,
    IssueDeviceLinkResult,
    RedeemDeviceLinkParams,
    RedeemDeviceLinkResult,
    DeviceLinkParams,
    ConfirmDeviceLinkParams,
    DeviceLinkStatusResult,
    PollDeviceLinkParams,
    DeviceLinkNarrowing,
    DeviceLinkNarrowingEcho,
    DeviceLinkMatch,
    DeviceLinkRedeemDoor,
} from './device-link.service';

// Passkey Service (WebAuthn)
export {
    startPasskeyEnrollmentService,
    finishPasskeyEnrollmentService,
    startPasskeyLoginService,
    finishPasskeyLoginService,
    listPasskeysService,
    renamePasskeyService,
    revokePasskeyService,
    assertRecentAuthentication,
    assertNotLastRecoveryCredential,
    checkPasskeyProof,
} from './passkey.service';

export type {
    StartPasskeyEnrollmentParams,
    FinishPasskeyEnrollmentParams,
    FinishPasskeyEnrollmentResult,
    FinishPasskeyLoginParams,
    RecentAuthenticationParams,
    RenamePasskeyParams,
    RevokePasskeyParams,
    PasskeySummary,
    PasskeyProofParams,
} from './passkey.service';

// Second Factor Service (MFA)
export {
    assertStepUp,
    mfaEnrolledForUser,
    carryStepUpVerification,
    startTotpEnrolmentService,
    confirmTotpEnrolmentService,
    disableMfaService,
    resetSecondFactorService,
    markPasskeySecondFactorService,
    regenerateRecoveryCodesService,
    mfaStatusService,
    startStepUpService,
    stepUpService,
    checkSecondFactorProof,
    openStepUpChallengeService,
    resumeStepUpChallengeService,
    verifyMfaChallengeService,
    startMfaChallengeAssertionService,
    sweepUnconfirmedMfaService,
    sweepMfaChallengesService,
    sweepStaleStepUpsService,
} from './mfa.service';

export type {
    AssertStepUpParams,
    ConfirmTotpParams,
    ConfirmTotpResult,
    MarkPasskeyParams,
    MfaStatus,
    OpenStepUpChallengeParams,
    PresentedSecondFactor,
    SecondFactorProof,
    SecondFactorPurpose,
    StepUpParams,
    TotpEnrolmentResult,
    VerifyMfaChallengeParams,
    VerifyMfaChallengeResult,
} from './mfa.service';

// Second-factor policy, applied to an account
export {
    isEnrolledUnderPolicy,
    secondFactorEnrolmentFields,
    keySecondFactorEnrolmentFields,
    assertSecondFactorAdmits,
    assertNotLastListedFactor,
} from './second-factor-policy.service';

export type { SecondFactorEnrolmentFields } from './second-factor-policy.service';

// Key Service
export {
    registerPublicKeyService,
    rotateKeyService,
    revokeKeyService,
    listKeysService,
    revokeAllKeysService,
    registeredBinding,
    KEY_FINGERPRINT_PREFIX_LENGTH,
} from './key.service';

export type {
    RegisterPublicKeyParams,
    RegisterPublicKeyResult,
    RotateKeyParams,
    RotateKeyResult,
    RevokeKeyParams,
    RevokeAllKeysParams,
    RevokeAllKeysResult,
    KeySummary,
    KeyNarrowing,
} from './key.service';

// User Service
export {
    getUserByIdService,
    getUserByEmailService,
    getUserByPhoneService,
    updateLastLoginService,
    updateUserService,
    setAccountStatus,
    checkUsernameAvailableService,
    updateUsernameService,
} from './user.service';

export type { AccountStatusTransition, AccountStatusChange } from './user.service';

// RBAC Service
export {
    initializeAuth,
} from './rbac.service';

// Stored email normalization (startup backfill)
export { normalizeStoredEmails } from './email-normalization.service';
export type { EmailNormalizationResult } from './email-normalization.service';

// Permission Service
export {
    getUserPermissions,
    getUsersPermissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    getUserRole,
    getStoredUserRole,
    hasRole,
    hasAnyRole,
    resolveAuthority,
    resolveAuthorities,
    roleChangeRefusal,
    assertCanChangeRole,
    assertCanChangeAuthority,
    runJudgedTransaction,
    changeUserRole,
    grantUserPermission,
    revokeUserPermission,
    assertRoleMayBeDeactivated,
} from './permission.service';
export type {
    Authority,
    AuthorityRole,
    RoleChange,
    RoleChangeRefusal,
    AuthorityChange,
    AuthorityChangeRefusal,
    UserPermissionOptions,
} from './permission.service';

// Role Email-Domain Policy
export {
    findUserWithEffectiveRole,
    findUserWithEffectiveRoleOnPrimary,
    resolveRoleInForce,
    listRoleEmailDomainViolations,
    demoteRoleEmailDomainViolations,
    assertRoleEmailDomainPolicy,
} from './role-email-domain.service';
export type { RoleEmailDomainViolation, UserWithEffectiveRole } from './role-email-domain.service';

// Role Service
export {
    createRole,
    updateRole,
    deleteRole,
    addPermissionToRole,
    removePermissionFromRole,
    setRolePermissions,
    getAllRoles,
    getRoleByName,
    getRolePermissions,
} from './role.service';

// Invitation Service
export {
    createInvitation,
    getInvitationByToken,
    getInvitationWithDetails,
    describeInvitation,
    validateInvitation,
    acceptInvitation,
    listInvitations,
    cancelInvitation,
    deleteInvitation,
    expireOldInvitations,
    resendInvitation,
    type IssuedInvitation,
} from './invitation.service';

// Auth Session Service (new)
export { getAuthSessionService } from './auth-session.service';

// One-Time Token Service
export {
    issueOneTimeTokenService,
    redeemOneTimeTokenService,
    verifyOneTimeTokenService,
} from './one-time-token.service';

export type {
    IssueOneTimeTokenResult,
} from './one-time-token.service';

// User Profile Service (new)
export { getUserProfileService, updateUserProfileService, updateLocaleService, reconcileProfileFields } from './user-profile.service';
export type { UpdateProfileParams } from './user-profile.service';

// User Settings Service (per-person settings declared in code, #161)
export {
    getUserSetting,
    setUserSetting,
    listUserSettings,
    resetUserSetting,
    reconcileUserSettings,
} from './user-settings.service';

// OAuth Service
export {
    oauthStartService,
    signInAuthorizationUrl,
    oauthCallbackService,
    matchOAuthCallbackCsrf,
    matchOAuthLinkCsrf,
    buildOAuthErrorUrl,
    oauthErrorReason,
    oauthFailureUrl,
    isOAuthProviderEnabled,
    requireEnabledProvider,
    requireSignInProvider,
    getEnabledOAuthProviders,
    getGoogleAccessToken,
    oauthUnlinkNotifyService,
} from './oauth.service';

export type {
    OAuthStartParams,
    OAuthStartResult,
    OAuthCallbackParams,
    OAuthCallbackResult,
    UnlinkNotifyResult,
} from './oauth.service';

// OAuth Link Service (#154)
export {
    startOAuthLinkService,
    oauthLinkCallbackService,
    oauthLinkResultUrl,
    unlinkOAuthService,
} from './oauth-link.service';

export type {
    StartOAuthLinkParams,
    OAuthLinkCallbackParams,
    UnlinkOAuthParams,
} from './oauth-link.service';

// Native Social Login Service
export {
    oauthNativeService,
} from './oauth-native.service';

export type {
    OAuthNativeParams,
    OAuthNativeResult,
} from './oauth-native.service';

// Account Deletion Service
export {
    requestAccountDeletionService,
    cancelAccountDeletionService,
    purgeUserService,
    sweepDuePurges,
    getPendingDeletionInfo,
} from './account-deletion.service';

export type {
    RequestAccountDeletionParams,
    RequestAccountDeletionResult,
    CancelAccountDeletionParams,
    CancelAccountDeletionResult,
    PurgeUserResult,
    SweepDuePurgesResult,
    PendingDeletionInfo,
} from './account-deletion.service';

// =============================================================================
// Email & SMS - DEPRECATED: Use @spfn/notification instead
// =============================================================================
// Email and SMS functionality has been moved to @spfn/notification package.
// Please use the following imports instead:
//
//   import { sendEmail, sendSMS } from '@spfn/notification/server';
//
// The @spfn/notification package provides:
// - Multi-channel support (Email, SMS, Slack, Push)
// - Template system with variable substitution
// - Multiple provider support (AWS SES, SNS, SendGrid, Twilio, etc.)
// =============================================================================

// Ops Token Service (CLI-first ops surface)
export {
    issueOpsTokenService,
    verifyOpsTokenService,
    revokeOpsTokenService,
    listOpsTokensService,
    isOpsToken,
    OPS_TOKEN_PREFIX,
    OPS_TOKEN_ISSUE_PERMISSION,
} from './ops-token.service';

export type {
    VerifiedOpsToken,
    IssuedOpsToken,
    OpsTokenIssuer,
    OpsTokenRevoker,
} from './ops-token.service';

// =============================================================================
// OAuth 2.1 authorization server (the server we run, for MCP clients)
// =============================================================================
// `oauth2` throughout: `oauth` next door is the social-login client this package
// is on the other side of. Nothing is shared between them.

export {
    registerOAuth2ClientService,
    purgeStaleOAuth2ClientsService,
    MAX_UNGRANTED_CLIENTS_PER_IP,
    STALE_CLIENT_MAX_AGE_MS,
    SUPPORTED_GRANT_TYPES,
    SUPPORTED_RESPONSE_TYPES,
} from './oauth2-client.service';

export type {
    OAuth2RegisterRequest,
    OAuth2RegisteredClient,
    OAuth2RegisterRefusal,
    OAuth2RegisterResult,
} from './oauth2-client.service';

export {
    describeOAuth2AuthorizeRequestService,
    approveOAuth2AuthorizeService,
    denyOAuth2AuthorizeService,
} from './oauth2-authorize.service';

export type {
    OAuth2AuthorizeParams,
    OAuth2ConsentView,
    OAuth2ScopeDescription,
    OAuth2AuthorizationCodeIssued,
} from './oauth2-authorize.service';

export {
    oauth2TokenService,
    revokeOAuth2TokenService,
} from './oauth2-token.service';

export type {
    OAuth2TokenRequest,
    OAuth2TokenResponse,
    OAuth2TokenRefusal,
    OAuth2TokenResult,
} from './oauth2-token.service';

export {
    listOAuth2GrantsService,
    revokeOAuth2GrantService,
    revokeAllOAuth2GrantsForUser,
} from './oauth2-grant.service';

export type { OAuth2GrantSummary } from './oauth2-grant.service';

// The one export an application wires up by hand — `@spfn/mcp`'s
// `validateToken`. Exported from the same entry as `isOpsToken`.
export { verifyAccessToken } from './oauth2-access-token.service';
export type { VerifiedOAuth2AccessToken } from './oauth2-access-token.service';

// Admission — the one answer to "may this person be let in now"
export { admitPrincipal, admitsAccount, authContextFor, admitsForRenewal, signingKeyOf } from './admission.service';
export type {
    Admission,
    AdmissionRefusal,
    AdmitPrincipalParams,
    AuthScheme,
    Principal,
    PrincipalCredential,
} from './admission.service';

// Session binding (#97) — the opt-in that gives a web session a short-lived key
// only a passkey assertion can renew.
export {
    getSessionBindingService,
    keySessionBindingService,
    enableSessionBindingService,
    disableSessionBindingService,
    startSessionBindingDisableService,
    startPasskeyProofService,
    resetSessionBindingService,
} from './session-binding.service';

export type {
    SessionBindingResult,
    SessionBindingParams,
    DisableSessionBindingParams,
} from './session-binding.service';

// Session renewal (#97) — the public two-step ceremony a bound session runs when
// its key has run out.
export {
    startSessionRenewService,
    finishSessionRenewService,
} from './session-renew.service';

export type {
    StartSessionRenewParams,
    FinishSessionRenewParams,
} from './session-renew.service';
