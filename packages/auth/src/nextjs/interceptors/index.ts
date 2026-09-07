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
 * 4. keyRotationInterceptor - Specific (key rotation only)
 * 5. oauthUrlInterceptor - OAuth URL generation (key generation + state injection)
 * 6. generalAuthInterceptor - General (all authenticated requests)
 */

import { loginRegisterInterceptor } from './login-register';
import { generalAuthInterceptor } from './general-auth';
import { keyRotationInterceptor } from './key-rotation';
import { oauthUrlInterceptor, oauthFinalizeInterceptor } from './oauth';
import { signupLinkInterceptor } from './signup-link';
import { passwordResetInterceptor } from './password-reset';

/**
 * All auth interceptors
 *
 * Execution order:
 * 1. signupLinkInterceptor - Handles verified-email signup (setup secret ↔ HttpOnly cookie)
 * 2. passwordResetInterceptor - Handles password reset (setup secret ↔ HttpOnly cookie)
 * 3. loginRegisterInterceptor - Handles login/register/signup password/reset complete (key generation + session save)
 * 4. keyRotationInterceptor - Handles key rotation (new key generation + session update)
 * 5. oauthUrlInterceptor - Handles OAuth URL requests (key generation + state injection + pending session)
 * 6. oauthFinalizeInterceptor - Handles OAuth finalize (pending session → full session)
 * 7. generalAuthInterceptor - Handles all authenticated requests (session validation + JWT injection + session renewal)
 */
export const authInterceptors = [
    signupLinkInterceptor,
    passwordResetInterceptor,
    loginRegisterInterceptor,
    keyRotationInterceptor,
    oauthUrlInterceptor,
    oauthFinalizeInterceptor,
    generalAuthInterceptor,
];

export { loginRegisterInterceptor } from './login-register';
export { generalAuthInterceptor } from './general-auth';
export { keyRotationInterceptor } from './key-rotation';
export { oauthUrlInterceptor, oauthFinalizeInterceptor } from './oauth';
export { signupLinkInterceptor } from './signup-link';
export { passwordResetInterceptor } from './password-reset';

// Deprecated: use generalAuthInterceptor instead
export { generalAuthInterceptor as authenticationInterceptor };
