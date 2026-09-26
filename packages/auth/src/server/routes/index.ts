/**
 * @spfn/auth - Main Router
 *
 * Combines all auth-related routes into a single router
 */

import { defineRouter } from '@spfn/core/route';
import {
    sendVerificationCode,
    verifyCode,
    register,
    requestSignupLink,
    confirmSignupLink,
    completeSignup,
    login,
    startDeviceAuth,
    pollDeviceAuth,
    getDeviceAuthInfo,
    approveDeviceAuth,
    denyDeviceAuth,
    issueDeviceLink,
    redeemDeviceLink,
    getDeviceLinkStatus,
    confirmDeviceLink,
    denyDeviceLink,
    cancelDeviceLink,
    pollDeviceLink,
    logout,
    rotateKey,
    listKeys,
    revokeKey,
    revokeAllKeys,
    changePassword,
    getAuthSession,
    issueOneTimeToken,
} from './auth';
import {
    requestPasswordReset,
    confirmPasswordReset,
    completePasswordReset,
} from './auth/password-reset';
import { confirmRevokeAllLink, consumeRevokeAllLink } from './auth/revoke-all-link';
import {
    mfaTotpEnroll,
    mfaTotpConfirm,
    mfaDisable,
    mfaMarkPasskey,
    mfaRegenerateRecoveryCodes,
    mfaStatus,
    mfaStepUp,
    mfaStepUpOptions,
    mfaVerify,
    mfaVerifyOptions,
} from './auth/mfa';
import {
    setSessionBinding,
    getSessionBinding,
    sessionBindingDisableOptions,
} from './auth/session-binding';
import { sessionRenewOptions, sessionRenewVerify } from './auth/session-renew';
import {
    passkeyRegisterOptions,
    passkeyRegisterVerify,
    passkeyLoginOptions,
    passkeyLoginVerify,
    listPasskeys,
    renamePasskey,
    revokePasskey,
} from './auth/passkeys';
import {
    getInvitation,
    acceptInvitation,
    createInvitation,
    listInvitations,
    cancelInvitation,
    resendInvitation,
    deleteInvitation,
} from './invitations';
import { getUserProfile, updateUserProfile, checkUsername, updateUsername, updateLocale } from './users';
import {
    oauthGoogleStart,
    oauthGoogleCallback,
    oauthStart,
    oauthProviders,
    getGoogleOAuthUrl,
    oauthFinalize,
    oauthProviderStart,
    oauthProviderCallback,
    getProviderOAuthUrl,
    oauthNative,
    oauthUnlinkNotify,
    oauthUnlinkNotifyGet,
} from './oauth';
import {
    listRoles,
    createAdminRole,
    updateAdminRole,
    deleteAdminRole,
    updateUserRole,
} from './admin';
import { requestAccountDeletion, cancelAccountDeletion } from './deletion';
import { issueOpsToken, listOpsTokens, revokeOpsToken } from './ops-tokens';
import {
    registerOAuth2Client,
    listOAuth2Grants,
    revokeOAuth2Grant,
    oauth2AuthorizationServerMetadata,
} from './oauth2';
import { getOAuth2Authorize, createOAuth2AuthorizationCode } from './oauth2/authorize';
import { oauth2Token, oauth2Revoke } from './oauth2/token';

/**
 * Main auth router
 * Exports all authentication-related routes
 *
 * Routes:
 * - Auth: /_auth/codes, /_auth/login, /_auth/logout, etc.
 * - OAuth: /_auth/oauth/google, /_auth/oauth/google/callback, etc.
 * - Invitations: /_auth/invitations/*
 * - Users: /_auth/users/*
 * - Deletion: /_auth/deletion/request, /_auth/deletion/cancel
 * - Admin: /_auth/admin/* (superadmin only)
 * - OAuth 2.1 authorization server: /_auth/oauth2/*, /.well-known/oauth-authorization-server
 */
export const mainAuthRouter = defineRouter({
    // Auth routes
    sendVerificationCode,
    verifyCode,
    register,
    // Verified-email signup routes
    requestSignupLink,
    confirmSignupLink,
    completeSignup,
    // Password reset routes
    requestPasswordReset,
    confirmPasswordReset,
    completePasswordReset,
    login,
    // Device-code login routes
    startDeviceAuth,
    pollDeviceAuth,
    getDeviceAuthInfo,
    approveDeviceAuth,
    denyDeviceAuth,
    // Device link routes
    issueDeviceLink,
    redeemDeviceLink,
    getDeviceLinkStatus,
    confirmDeviceLink,
    denyDeviceLink,
    cancelDeviceLink,
    pollDeviceLink,
    // Passkey routes (WebAuthn)
    passkeyRegisterOptions,
    passkeyRegisterVerify,
    passkeyLoginOptions,
    passkeyLoginVerify,
    listPasskeys,
    renamePasskey,
    revokePasskey,
    // Second factor routes (MFA)
    mfaTotpEnroll,
    mfaTotpConfirm,
    mfaDisable,
    mfaMarkPasskey,
    mfaRegenerateRecoveryCodes,
    mfaStatus,
    mfaStepUp,
    mfaStepUpOptions,
    mfaVerify,
    mfaVerifyOptions,
    logout,
    rotateKey,
    listKeys,
    revokeKey,
    revokeAllKeys,
    // Signed sign-out-everywhere link routes
    confirmRevokeAllLink,
    consumeRevokeAllLink,
    changePassword,
    getAuthSession,
    // Session binding routes (#97)
    setSessionBinding,
    getSessionBinding,
    sessionBindingDisableOptions,
    // Session renewal routes (#97) — public, like the sign-in paths
    sessionRenewOptions,
    sessionRenewVerify,
    // One-Time Token routes
    issueOneTimeToken,
    // Account deletion routes
    requestAccountDeletion,
    cancelAccountDeletion,
    // OAuth routes
    oauthGoogleStart,
    oauthGoogleCallback,
    oauthStart,
    oauthProviders,
    getGoogleOAuthUrl,
    oauthFinalize,
    oauthProviderStart,
    oauthProviderCallback,
    getProviderOAuthUrl,
    oauthNative,
    oauthUnlinkNotify,
    oauthUnlinkNotifyGet,
    // Invitation routes
    getInvitation,
    acceptInvitation,
    createInvitation,
    listInvitations,
    cancelInvitation,
    resendInvitation,
    deleteInvitation,
    // User routes
    getUserProfile,
    updateUserProfile,
    checkUsername,
    updateUsername,
    updateLocale,
    // Admin routes (superadmin only)
    listRoles,
    createAdminRole,
    updateAdminRole,
    deleteAdminRole,
    updateUserRole,
    // Ops token routes (admin only)
    issueOpsToken,
    listOpsTokens,
    revokeOpsToken,
    // OAuth 2.1 authorization server routes (MCP clients).
    // Answer 404 unless the app passed `authorizationServer` to createAuthLifecycle().
    registerOAuth2Client,
    getOAuth2Authorize,
    createOAuth2AuthorizationCode,
    oauth2Token,
    oauth2Revoke,
    listOAuth2Grants,
    revokeOAuth2Grant,
    oauth2AuthorizationServerMetadata,
});

// For backward compatibility
export default mainAuthRouter;
