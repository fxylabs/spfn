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
 * Order matters - more specific interceptors first:
 * 1. signupLinkInterceptor - Most specific (verified-email signup only)
 * 2. passwordResetInterceptor - Most specific (password reset only)
 * 3. loginRegisterInterceptor - Specific (login/register/signup password/reset complete)
 * 4. mfaVerifyInterceptor - Right after it, so the 202 it passed through is still
 *    the response body this rule reads (#95)
 * 5. keyRotationInterceptor - Specific (key rotation only)
 * 6. oauthUrlInterceptor - OAuth URL generation (key generation + state injection)
 * 7. generalAuthInterceptor - General (all authenticated requests)
 * 8. sessionBindingInterceptor - Last, so its re-sealed cookie wins over the
 *    general one: response phases run in this order and the later write of a
 *    cookie name is the one the browser keeps.
 */

import { loginRegisterInterceptor } from './login-register';
import { mfaVerifyInterceptor } from './mfa-verify';
import { generalAuthInterceptor } from './general-auth';
import { keyRotationInterceptor } from './key-rotation';
import { oauthUrlInterceptor, oauthFinalizeInterceptor } from './oauth';
import { signupLinkInterceptor } from './signup-link';
import { passwordResetInterceptor } from './password-reset';
import { sessionBindingInterceptor } from './session-binding';

/**
 * All auth interceptors
 *
 * Execution order:
 * 1. signupLinkInterceptor - Handles verified-email signup (setup secret ↔ HttpOnly cookie)
 * 2. passwordResetInterceptor - Handles password reset (setup secret ↔ HttpOnly cookie)
 * 3. loginRegisterInterceptor - Handles login/register/signup password/reset complete/session renew (key generation + session save)
 * 4. mfaVerifyInterceptor - Handles the second-factor step-up (202 → pending cookie, verify → session)
 * 5. keyRotationInterceptor - Handles key rotation (new key generation + session update)
 * 6. oauthUrlInterceptor - Handles OAuth URL requests (key generation + state injection + pending session)
 * 7. oauthFinalizeInterceptor - Handles OAuth finalize (pending session → full session)
 * 8. generalAuthInterceptor - Handles all authenticated requests (session validation + JWT injection + session renewal)
 * 9. sessionBindingInterceptor - Re-seals the session cookie when the binding setting changes
 */
export const authInterceptors = [
    signupLinkInterceptor,
    passwordResetInterceptor,
    loginRegisterInterceptor,
    mfaVerifyInterceptor,
    keyRotationInterceptor,
    oauthUrlInterceptor,
    oauthFinalizeInterceptor,
    generalAuthInterceptor,
    sessionBindingInterceptor,
];

export { loginRegisterInterceptor } from './login-register';
export { mfaVerifyInterceptor } from './mfa-verify';
export { generalAuthInterceptor } from './general-auth';
export { keyRotationInterceptor } from './key-rotation';
export { oauthUrlInterceptor, oauthFinalizeInterceptor } from './oauth';
export { signupLinkInterceptor } from './signup-link';
export { passwordResetInterceptor } from './password-reset';
export { sessionBindingInterceptor, bindingSessionFields } from './session-binding';
export { SESSION_RENEW_PATH_PATTERN } from './session-renew';

// Deprecated: use generalAuthInterceptor instead
export { generalAuthInterceptor as authenticationInterceptor };
