/**
 * What `@spfn/auth/nextjs/client` takes from the rest of the package
 *
 * `nextjs/client` is a build of its own (`tsup.client.config.ts`), for its
 * `'use client'` banner, so it cannot share the main build's chunks: a module it
 * reached by a relative path would be a second copy. It imports these through
 * the package's private `#nextjs/client-shared` instead (`imports` in
 * `package.json`), which is this entry of the main build. Not exported.
 */

export { isSafeReturnPath, toSafeReturnPath } from '../lib/return-path';
export { OAUTH_ERROR_MESSAGES, OAUTH_ERROR_REASONS, callbackQueryReason, isOAuthErrorReason, type OAuthErrorReason } from '../lib/oauth-error-reason';
export { OAUTH_LINK_OUTCOMES, isOAuthLinkOutcome, type OAuthLinkOutcome } from '../lib/oauth-link-outcome';
export { oauthCallbackErrorArguments, runOAuthCallback, type OAuthCallbackErrorArguments } from './components/oauth-callback-flow';
