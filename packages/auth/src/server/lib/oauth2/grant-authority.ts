/**
 * OAuth 2.1 grant authority
 *
 * What a client may do now is the grant's to say, and nothing else's. A token
 * row records the scopes it was issued with, but only as a ceiling: the grant
 * the user can see and change is what decides, so narrowing it narrows every
 * token already out. Whether the grant is live at all — not revoked, not past
 * its `expiresAt` — is the repository's `isLiveGrant` / `liveGrant`; what a token
 * under a live grant authorizes is this file's one expression, asked at
 * verification and at refresh.
 */

import type { OAuth2Grant } from '../../entities/oauth2-grants';

/**
 * What a token authorizes now: the scopes it was issued with that the grant
 * still holds. Empty means nothing, and every caller refuses it. A refresh's
 * explicit `scope` may only narrow this further.
 */
export function effectiveScopes(tokenScopes: string[], grant: OAuth2Grant): string[]
{
    return tokenScopes.filter(scope => grant.scopes.includes(scope));
}
