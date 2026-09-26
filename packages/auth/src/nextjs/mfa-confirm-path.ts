/**
 * Where the second-factor confirm page lives, for both OAuth flows (#107).
 *
 * `createOAuthCallbackHandler` redirects there itself; the callback-page flow
 * learns it from the `oauthFinalize` 202, to which `mfaVerifyInterceptor` adds
 * it. Both run in the Next.js server and both read the value here, so an app
 * sets `SPFN_AUTH_MFA_CONFIRM_PATH` once and the two flows land on the same page.
 */

import { env as authEnv } from '@spfn/auth/config';

import { DEFAULT_MFA_CONFIRM_PATH, toSameOriginPath } from './components/oauth-callback-flow';

/**
 * The override when one is given, else `SPFN_AUTH_MFA_CONFIRM_PATH`, else
 * `/auth/mfa` — reduced to a path, so a full URL cannot take the challenge to
 * another origin.
 */
export function resolveMfaConfirmPath(override?: string): string
{
    return toSameOriginPath(override || authEnv.SPFN_AUTH_MFA_CONFIRM_PATH || DEFAULT_MFA_CONFIRM_PATH);
}
