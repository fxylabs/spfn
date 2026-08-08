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
    login,
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
 */
export const mainAuthRouter = defineRouter({
    // Auth routes
    sendVerificationCode,
    verifyCode,
    register,
    login,
    logout,
    rotateKey,
    listKeys,
    revokeKey,
    revokeAllKeys,
    changePassword,
    getAuthSession,
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
});

// For backward compatibility
export default mainAuthRouter;
