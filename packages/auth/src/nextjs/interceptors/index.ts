/**
 * Auth Interceptors for Next.js Proxy
 *
 * Automatically registers interceptors for authentication flow
 *
 * Every rule whose path and method match runs, as a chain in this order — they
 * do not compete for a single match. Two of them share /_auth/signup/password on
 * purpose: signupLinkInterceptor supplies the setup secret and
 * loginRegisterInterceptor supplies the device key.
 *
 * No rule writes a cookie. Each proposes what it learned about the session
 * (`establish`, `clear`, `refresh`) or a pending cookie it needs, and
 * `sessionDecisionInterceptor` — first in the list, so its response phase runs
 * after every other rule's — decides once per response and writes the whole
 * set. The order below no longer decides which session the browser keeps.
 *
 * Order:
 * 0. sessionDecisionInterceptor - Decides and writes the cookies, around all the others
 * 1. signupLinkInterceptor - Most specific (verified-email signup only)
 * 2. passwordResetInterceptor - Most specific (password reset only)
 * 3. loginRegisterInterceptor - Specific (login/register/signup password/reset complete)
 * 4. mfaVerifyInterceptor - Right after it, so the 202 it passed through is still
 *    the response body this rule reads (#95)
 * 5. deviceLoginInterceptor - Specific (device link redeem/web and poll,
 *    device-code start/web and poll)
 * 6. keyRotationInterceptor - Specific (key rotation only)
 * 7. oauthUrlInterceptor - OAuth URL generation (key generation + state injection)
 * 8. generalAuthInterceptor - General (all authenticated requests)
 * 9. sessionBindingInterceptor - Re-seals the session when the binding setting changes
 */

import { sessionDecisionInterceptor } from './session-decision';
import { loginRegisterInterceptor } from './login-register';
import { mfaVerifyInterceptor } from './mfa-verify';
import { deviceLoginInterceptor } from './device-login';
import { generalAuthInterceptor } from './general-auth';
import { keyRotationInterceptor } from './key-rotation';
import { oauthUrlInterceptor, oauthFinalizeInterceptor, oauthLinkInterceptor } from './oauth';
import { signupLinkInterceptor } from './signup-link';
import { passwordResetInterceptor } from './password-reset';
import { sessionBindingInterceptor } from './session-binding';

/**
 * All auth interceptors
 *
 * Execution order:
 * 0. sessionDecisionInterceptor - Decides the session once per response and writes every cookie
 * 1. signupLinkInterceptor - Handles verified-email signup (setup secret ↔ HttpOnly cookie)
 * 2. passwordResetInterceptor - Handles password reset (setup secret ↔ HttpOnly cookie)
 * 3. loginRegisterInterceptor - Handles login/register/signup password/reset complete/session renew (key generation + session)
 * 4. mfaVerifyInterceptor - Handles the second-factor step-up (202 → pending cookie, verify → session)
 * 5. deviceLoginInterceptor - Handles a browser as the new device (redeem/web, start/web → key + pending cookie, approved poll → session)
 * 6. keyRotationInterceptor - Handles key rotation (new key generation + session)
 * 7. oauthUrlInterceptor - Handles OAuth URL requests (key generation + state injection + pending session)
 * 8. oauthFinalizeInterceptor - Handles OAuth finalize (pending session → full session)
 * 9. oauthLinkInterceptor - Handles a signed-in link start (returnUrl check + CSRF nonce injection + CSRF cookie)
 * 10. generalAuthInterceptor - Handles all authenticated requests (session validation + JWT injection + what the answer means for the session)
 * 11. sessionBindingInterceptor - Re-seals the session when the binding setting changes
 */
export const authInterceptors = [
    sessionDecisionInterceptor,
    signupLinkInterceptor,
    passwordResetInterceptor,
    loginRegisterInterceptor,
    mfaVerifyInterceptor,
    deviceLoginInterceptor,
    keyRotationInterceptor,
    oauthUrlInterceptor,
    oauthFinalizeInterceptor,
    oauthLinkInterceptor,
    generalAuthInterceptor,
    sessionBindingInterceptor,
];

export { loginRegisterInterceptor } from './login-register';
export { mfaVerifyInterceptor } from './mfa-verify';
export { deviceLoginInterceptor } from './device-login';
export { generalAuthInterceptor } from './general-auth';
export { keyRotationInterceptor } from './key-rotation';
export { oauthUrlInterceptor, oauthFinalizeInterceptor, oauthLinkInterceptor } from './oauth';
export { signupLinkInterceptor } from './signup-link';
export { passwordResetInterceptor } from './password-reset';
export { sessionBindingInterceptor, bindingSessionFields } from './session-binding';
export { SESSION_RENEW_PATH_PATTERN } from './session-renew';
export { sessionDecisionInterceptor } from './session-decision';

// Deprecated: use generalAuthInterceptor instead
export { generalAuthInterceptor as authenticationInterceptor };
