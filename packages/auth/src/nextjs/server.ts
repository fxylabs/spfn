import 'server-only';

export { RequireAuth } from './guards/require-auth';
export type { RequireAuthProps } from './guards/require-auth';

export { RequireRole } from './guards/require-role';
export type { RequireRoleProps } from './guards/require-role';

export { RequirePermission } from './guards/require-permission';
export type { RequirePermissionProps } from './guards/require-permission';

export { getAuthSessionData, getUserRole, getUserPermissions, hasAnyRole, hasAnyPermission } from './guards/auth-utils';

// Session helpers
export {
    saveSession,
    getSession,
    clearSession,
    // Pending session (OAuth)
    sealPendingSession,
    unsealPendingSession,
    getPendingSession,
    clearPendingSession,
    type SessionData,
    type PublicSession,
    type SaveSessionOptions,
    type PendingSessionData,
} from './session-helpers';

// Cookie names — an app that empties the session jar must never spell them
export {
    sessionCookieNames,
    clearSessionCookies,
    type SessionCookieNames,
} from './cookie-names';

// OAuth handlers
export {
    createOAuthCallbackHandler,
    type OAuthCallbackOptions,
} from './oauth-handlers';

// The OAuth 2.1 consent screen — the one half of the authorization server that
// has to live on the web app, because that is where the session cookie is
export {
    createOAuth2AuthorizeHandlers,
    escapeHtml,
    type OAuth2AuthorizeHandlerOptions,
    type OAuth2AuthorizeHandlers,
    type OAuth2ConsentScope,
    type OAuth2ConsentView,
} from './oauth2-authorize-handlers';

// The sign-out-everywhere page — the mailed link opens a page in the app, and
// the page has no session to lean on, which is the whole point of the link
export {
    createRevokeAllPageHandlers,
    type RevokeAllPageHandlerOptions,
    type RevokeAllPageHandlers,
    type RevokeAllPageView,
} from './revoke-all-page-handlers';

// The rule every return destination is held to — validate before calling
// getGoogleOAuthUrl rather than writing a second rule per screen.
export { isSafeReturnPath } from '../lib/return-path';
