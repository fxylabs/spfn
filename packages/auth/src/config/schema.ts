/**
 * Auth Environment Variable Schema
 *
 * Centralized schema definition for all environment variables used in @spfn/auth.
 * This provides type safety, validation, and documentation for Auth configuration.
 *
 * @module config/schema
 */

import {
    defineEnvSchema,
    envString,
    envNumber,
    envBoolean,
    createSecureSecretParser,
    createPasswordParser,
} from '@spfn/core/env';

/**
 * Auth environment variable schema
 *
 * Defines all Auth environment variables with:
 * - Type information
 * - Default values
 * - Validation rules
 * - Documentation
 *
 * @example
 * ```typescript
 * import { envSchema } from '@spfn/auth/config';
 *
 * // Access schema information
 * console.log(envSchema.SPFN_AUTH_SESSION_SECRET.description);
 * console.log(envSchema.SPFN_AUTH_JWT_EXPIRES_IN.default);
 * ```
 */
export const authEnvSchema = defineEnvSchema({
    // ============================================================================
    // Session Configuration
    // ============================================================================
    SPFN_AUTH_SESSION_SECRET: {
        ...envString({
            description: 'Session encryption secret (minimum 32 characters for AES-256)',
            required: true,
            fallbackKeys: ['SESSION_SECRET'],
            validator: createSecureSecretParser({
                minLength: 32,
                minUniqueChars: 16,
                minEntropy: 3.5,
            }),
            sensitive: true,
            nextjs: true, // Required for Next.js RSC session validation
            examples: [
                'my-super-secret-session-key-at-least-32-chars-long',
                'use-a-cryptographically-secure-random-string-here',
            ],
        }),
    },

    SPFN_AUTH_SESSION_TTL: {
        ...envString({
            description: 'Session TTL (time to live) - supports duration strings like \'7d\', \'12h\', \'45m\'',
            default: '7d',
            required: false,
            nextjs: true, // May be needed for session validation in Next.js RSC
            examples: ['7d', '30d', '12h', '45m', '3600'],
        }),
    },

    // ============================================================================
    // JWT Configuration
    // ============================================================================
    SPFN_AUTH_JWT_SECRET: {
        ...envString({
            description: 'JWT signing secret for server-signed tokens (legacy mode)',
            default: 'dev-secret-key-change-in-production',
            required: false,
            examples: [
                'your-jwt-secret-key-here',
                'use-different-from-session-secret',
            ],
        }),
    },

    SPFN_AUTH_JWT_EXPIRES_IN: {
        ...envString({
            description: 'JWT token expiration time (e.g., \'7d\', \'24h\', \'1h\')',
            default: '7d',
            required: false,
            examples: ['7d', '24h', '1h', '30m'],
        }),
    },

    // ============================================================================
    // Security Configuration
    // ============================================================================
    SPFN_AUTH_COOKIE_SECURE: {
        ...envBoolean({
            description: 'Override cookie Secure flag. Defaults to NODE_ENV === "production". Set to false for HTTP-only environments (e.g. bastion over plain HTTP).',
            required: false,
            nextjs: true,
            examples: [true, false],
        }),
    },

    SPFN_AUTH_CSRF: {
        ...envString({
            description: 'CSRF protection for cookie-session mutations in the Next.js proxy: off | warn | enforce. Unset behaves as "warn" (log what would be refused, allow it through). configureAuth({ csrf: { mode } }) takes precedence.',
            required: false,
            nextjs: true, // The check runs in the Next.js proxy
            examples: ['enforce', 'warn', 'off'],
        }),
    },

    SPFN_AUTH_BCRYPT_SALT_ROUNDS: {
        ...envNumber({
            description: 'Bcrypt salt rounds (cost factor, higher = more secure but slower)',
            default: 12,
            required: false,
            examples: [10, 12, 14],
        }),
        key: 'SPFN_AUTH_BCRYPT_SALT_ROUNDS',
    },

    SPFN_AUTH_VERIFICATION_TOKEN_SECRET: {
        ...envString({
            description: 'Verification token secret for email verification, password reset, etc.',
            required: true,
            examples: [
                'your-verification-token-secret',
                'can-be-different-from-jwt-secret',
            ],
        }),
    },

    SPFN_AUTH_TOKEN_ENCRYPTION_KEYS: {
        ...envString({
            description: 'Backend-only OAuth token encryption keyring. Comma-separated <keyId>:<base64-encoded 32-byte key> entries; the first key encrypts new values and remaining keys decrypt during rotation.',
            required: false,
            sensitive: true,
            examples: [
                'v2:<base64-encoded-32-byte-key>,v1:<previous-base64-encoded-32-byte-key>',
            ],
        }),
    },

    // ============================================================================
    // Admin Account Configuration
    // ============================================================================
    SPFN_AUTH_ADMIN_ACCOUNTS: {
        ...envString({
            description: 'JSON array of admin accounts (recommended for multiple admins)',
            required: false,
            examples: [
                '[{"email":"admin@example.com","password":"secure-pass","role":"admin"}]',
                '[{"email":"super@example.com","password":"pass1","role":"superadmin"},{"email":"admin@example.com","password":"pass2","role":"admin"}]',
            ],
        }),
    },

    SPFN_AUTH_ADMIN_EMAILS: {
        ...envString({
            description: 'Comma-separated list of admin emails (legacy CSV format)',
            required: false,
            examples: [
                'admin@example.com,user@example.com',
                'super@example.com,admin@example.com,user@example.com',
            ],
        }),
    },

    SPFN_AUTH_ADMIN_PASSWORDS: {
        ...envString({
            description: 'Comma-separated list of admin passwords (legacy CSV format)',
            required: false,
            examples: [
                'admin-pass,user-pass',
                'super-pass,admin-pass,user-pass',
            ],
        }),
    },

    SPFN_AUTH_ADMIN_ROLES: {
        ...envString({
            description: 'Comma-separated list of admin roles (legacy CSV format)',
            required: false,
            examples: [
                'admin,user',
                'superadmin,admin,user',
            ],
        }),
    },

    SPFN_AUTH_ADMIN_EMAIL: {
        ...envString({
            description: 'Single admin email (simplest format)',
            required: false,
            examples: ['admin@example.com'],
        }),
    },

    SPFN_AUTH_ADMIN_PASSWORD: {
        ...envString({
            description: 'Single admin password (simplest format)',
            required: false,
            validator: createPasswordParser({
                minLength: 8,
                requireUppercase: true,
                requireLowercase: true,
                requireNumber: true,
                requireSpecial: true,
            }),
            sensitive: true,
            examples: ['SecureAdmin123!'],
        }),
    },

    // ============================================================================
    // Username Configuration
    // ============================================================================
    SPFN_AUTH_RESERVED_USERNAMES: {
        ...envString({
            description: 'Comma-separated list of reserved usernames that cannot be registered',
            required: false,
            default: 'admin,root,system,support,help,moderator,superadmin',
            examples: [
                'admin,root,system,support,help',
                'admin,root,system,support,help,moderator,superadmin,operator',
            ],
        }),
    },

    SPFN_AUTH_USERNAME_MIN_LENGTH: {
        ...envNumber({
            description: 'Minimum username length',
            default: 3,
            required: false,
            examples: [2, 3, 4],
        }),
    },

    SPFN_AUTH_USERNAME_MAX_LENGTH: {
        ...envNumber({
            description: 'Maximum username length',
            default: 30,
            required: false,
            examples: [20, 30, 50],
        }),
    },

    // ============================================================================
    // Verified-email signup
    // ============================================================================
    SPFN_AUTH_SIGNUP_LINK_TTL_MINUTES: {
        ...envNumber({
            description: 'How long an emailed signup confirmation link stays valid. Long enough to survive a mail delay, short enough that a link left in an inbox stops working.',
            default: 30,
            required: false,
            examples: [15, 30, 60],
        }),
    },

    SPFN_AUTH_SIGNUP_SETUP_TTL_MINUTES: {
        ...envNumber({
            description: 'How long the password-setup session opened by a confirmation link stays valid. Covers one sitting at the password form, not an abandoned tab.',
            default: 15,
            required: false,
            examples: [10, 15, 30],
        }),
    },

    SPFN_AUTH_SIGNUP_CONFIRM_PATH: {
        ...envString({
            description: 'App page the emailed confirmation link opens, as a path on {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}. The page reads the token from the query string and posts it to /_auth/signup/email/confirm; it is a page in your app, not an API route.',
            default: '/signup/confirm',
            required: false,
            examples: ['/signup/confirm', '/auth/confirm', '/join/verify'],
        }),
    },

    // ============================================================================
    // Passkeys (WebAuthn)
    // ============================================================================
    SPFN_AUTH_PASSKEY_RP_ID: {
        ...envString({
            description: 'Domain passkeys are bound to — a registrable domain with no protocol and no port. Defaults to the host of {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}. Set it explicitly when the app is served from several hosts that share a domain; every origin below must be that host or a subdomain of it. Changing it orphans every passkey already enrolled.',
            required: false,
            examples: ['example.com', 'app.example.com', 'localhost'],
        }),
    },

    SPFN_AUTH_PASSKEY_RP_NAME: {
        ...envString({
            description: "Name the authenticator's own prompt shows the user. Defaults to the relying party ID.",
            required: false,
            examples: ['Acme', 'Acme Staging'],
        }),
    },

    SPFN_AUTH_PASSKEY_ORIGINS: {
        ...envString({
            description: 'Comma-separated full origins allowed to run a passkey ceremony. Defaults to the origin of {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}. Each must be https (http only for localhost) and must be the relying party ID or a subdomain of it. Checked at boot: a value that breaks either rule refuses to start, because it would otherwise surface as the browser refusing every ceremony.',
            required: false,
            examples: ['https://app.example.com', 'https://app.example.com,https://admin.example.com', 'http://localhost:3000'],
        }),
    },

    SPFN_AUTH_PASSKEY_USER_VERIFICATION: {
        ...envString({
            description: "How hard the authenticator must prove the person is present: 'preferred' or 'required'. 'discouraged' is refused at boot — a passkey is the whole credential here, so an assertion that skipped user verification would sign someone in on an unlocked device alone.",
            default: 'preferred',
            required: false,
            examples: ['preferred', 'required'],
        }),
    },

    SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS: {
        ...envNumber({
            description: 'How long the challenge minted by a passkey options call stays presentable. One ceremony at the authenticator, not an abandoned tab.',
            default: 300,
            required: false,
            examples: [120, 300, 600],
        }),
    },

    SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES: {
        ...envNumber({
            description: 'How recently the calling device key must have been registered for enrolling or revoking a passkey to go through without the current password. Older than this and the request needs `currentPassword`; an account with no password has to sign in again.',
            default: 10,
            required: false,
            examples: [5, 10, 30],
        }),
    },

    // ============================================================================
    // API Configuration
    // ============================================================================
    SPFN_API_URL: {
        ...envString({
            description: 'Internal API URL for server-to-server communication',
            default: 'http://localhost:8790',
            required: false,
            examples: [
                'https://api.example.com',
                'http://localhost:8790',
            ],
        }),
    },

    NEXT_PUBLIC_SPFN_API_URL: {
        ...envString({
            description: 'Public-facing API URL used for browser-facing redirects. Falls back to SPFN_API_URL if not set.',
            required: false,
            examples: [
                'https://api.example.com',
                'http://localhost:8790',
            ],
        }),
    },

    SPFN_APP_URL: {
        ...envString({
            description: 'Next.js application URL (internal). Used for server-to-server communication.',
            default: 'http://localhost:3000',
            required: false,
            examples: [
                'https://app.example.com',
                'http://localhost:3000',
            ],
        }),
    },

    NEXT_PUBLIC_SPFN_APP_URL: {
        ...envString({
            description: 'Public-facing Next.js app URL for browser redirects (e.g. OAuth redirect). Falls back to SPFN_APP_URL if not set.',
            required: false,
            examples: [
                'https://app.example.com',
                'http://localhost:3000',
            ],
        }),
    },

    // ============================================================================
    // OAuth Configuration - Google
    // ============================================================================
    SPFN_AUTH_GOOGLE_CLIENT_ID: {
        ...envString({
            description: 'Google OAuth 2.0 Client ID. When set, Google OAuth routes are automatically enabled.',
            required: false,
            examples: ['123456789-abc123.apps.googleusercontent.com'],
        }),
    },

    SPFN_AUTH_GOOGLE_CLIENT_SECRET: {
        ...envString({
            description: 'Google OAuth 2.0 Client Secret',
            required: false,
            sensitive: true,
            examples: ['GOCSPX-abcdefghijklmnop'],
        }),
    },

    SPFN_AUTH_GOOGLE_SCOPES: {
        ...envString({
            description: 'Comma-separated Google OAuth scopes. Defaults to "email,profile" if not set.',
            required: false,
            examples: [
                'email,profile',
                'email,profile,https://www.googleapis.com/auth/gmail.readonly',
                'email,profile,https://www.googleapis.com/auth/calendar.readonly',
            ],
        }),
    },

    SPFN_AUTH_GOOGLE_REDIRECT_URI: {
        ...envString({
            description: 'Google OAuth callback URL. Defaults to {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}/_auth/oauth/google/callback. The override must stay on the web app origin at this exact path — the CSRF cookie for the callback is host-only and the app rewrites /_auth/:path* to the API, so a callback that lands anywhere else is refused for CSRF. Checked at boot: a value off the web app origin or off the callback path refuses to start. The one case for an override elsewhere is the direct POST /_auth/oauth/start flow on a split deployment (no Next.js interceptor, so its CSRF cookie is on the API host), which also needs SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off.',
            required: false,
            examples: [
                'https://app.example.com/_auth/oauth/google/callback',
                'http://localhost:3000/_auth/oauth/google/callback',
            ],
        }),
    },

    // ============================================================================
    // OAuth Configuration - Kakao
    // ============================================================================
    SPFN_AUTH_KAKAO_CLIENT_ID: {
        ...envString({
            description: 'Kakao Login REST API key. Used as the OAuth client_id.',
            required: false,
            examples: ['your-kakao-rest-api-key'],
        }),
    },

    SPFN_AUTH_KAKAO_CLIENT_SECRET: {
        ...envString({
            description: 'Kakao Login client secret. Required when the Kakao client-secret feature is enabled.',
            required: false,
            sensitive: true,
            examples: ['your-kakao-client-secret'],
        }),
    },

    SPFN_AUTH_KAKAO_ADMIN_KEY: {
        ...envString({
            description: 'Kakao app admin key. Required to verify the User Unlinked webhook (Authorization: KakaoAK header).',
            required: false,
            sensitive: true,
            examples: ['your-kakao-admin-key'],
        }),
    },

    SPFN_AUTH_KAKAO_SCOPES: {
        ...envString({
            description: 'Comma-separated Kakao consent scopes. Defaults to account_email.',
            required: false,
            examples: ['account_email'],
        }),
    },

    SPFN_AUTH_KAKAO_REDIRECT_URI: {
        ...envString({
            description: 'Kakao OAuth callback URL. Defaults to {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}/_auth/oauth/kakao/callback. The override must stay on the web app origin at this exact path — the CSRF cookie for the callback is host-only and the app rewrites /_auth/:path* to the API, so a callback that lands anywhere else is refused for CSRF. Checked at boot: a value off the web app origin or off the callback path refuses to start. The one case for an override elsewhere is the direct POST /_auth/oauth/start flow on a split deployment (no Next.js interceptor, so its CSRF cookie is on the API host), which also needs SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off.',
            required: false,
            examples: ['https://app.example.com/_auth/oauth/kakao/callback'],
        }),
    },

    // ============================================================================
    // OAuth Configuration - Naver
    // ============================================================================
    SPFN_AUTH_NAVER_CLIENT_ID: {
        ...envString({
            description: 'Naver Login OAuth client ID.',
            required: false,
            examples: ['your-naver-client-id'],
        }),
    },

    SPFN_AUTH_NAVER_CLIENT_SECRET: {
        ...envString({
            description: 'Naver Login OAuth client secret.',
            required: false,
            sensitive: true,
            examples: ['your-naver-client-secret'],
        }),
    },

    SPFN_AUTH_NAVER_REDIRECT_URI: {
        ...envString({
            description: 'Naver OAuth callback URL. Defaults to {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}/_auth/oauth/naver/callback. The override must stay on the web app origin at this exact path — the CSRF cookie for the callback is host-only and the app rewrites /_auth/:path* to the API, so a callback that lands anywhere else is refused for CSRF. Checked at boot: a value off the web app origin or off the callback path refuses to start. The one case for an override elsewhere is the direct POST /_auth/oauth/start flow on a split deployment (no Next.js interceptor, so its CSRF cookie is on the API host), which also needs SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off.',
            required: false,
            examples: ['https://app.example.com/_auth/oauth/naver/callback'],
        }),
    },

    // ============================================================================
    // OAuth Configuration - GitHub
    // ============================================================================
    SPFN_AUTH_GITHUB_CLIENT_ID: {
        ...envString({
            description: 'GitHub OAuth app client ID. When set, GitHub OAuth routes are automatically enabled.',
            required: false,
            examples: ['Iv1.abc123def456'],
        }),
    },

    SPFN_AUTH_GITHUB_CLIENT_SECRET: {
        ...envString({
            description: 'GitHub OAuth app client secret.',
            required: false,
            sensitive: true,
            examples: ['your-github-client-secret'],
        }),
    },

    SPFN_AUTH_GITHUB_SCOPES: {
        ...envString({
            description: 'Comma-separated GitHub OAuth scopes. Defaults to "read:user,user:email".',
            required: false,
            examples: ['read:user,user:email'],
        }),
    },

    SPFN_AUTH_GITHUB_REDIRECT_URI: {
        ...envString({
            description: 'GitHub OAuth callback URL. Defaults to {NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}/_auth/oauth/github/callback. The override must stay on the web app origin at this exact path — the CSRF cookie for the callback is host-only and the app rewrites /_auth/:path* to the API, so a callback that lands anywhere else is refused for CSRF. Checked at boot: a value off the web app origin or off the callback path refuses to start. The one case for an override elsewhere is the direct POST /_auth/oauth/start flow on a split deployment (no Next.js interceptor, so its CSRF cookie is on the API host), which also needs SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off.',
            required: false,
            examples: ['https://app.example.com/_auth/oauth/github/callback'],
        }),
    },

    SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK: {
        ...envString({
            description: 'Boot-time check of the four SPFN_AUTH_<PROVIDER>_REDIRECT_URI overrides: each one that is set must sit on the web app origin ({NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}) at /_auth/oauth/<provider>/callback, because the callback CSRF cookie is host-only. "off" is the only value that disables the check — unset, "on" and anything else all run it.',
            required: false,
            examples: ['off'],
        }),
    },

    // ============================================================================
    // Native Social Login (mobile/web id_token verification)
    //
    // 네이티브 SDK가 받은 id_token을 서버가 JWKS로 검증하는 경로 전용 설정.
    // authorization code 교환을 하지 않으므로 client secret이 필요 없다.
    // audience(aud)로 허용할 client id 목록만 지정한다.
    // ============================================================================
    SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS: {
        ...envString({
            description: 'Comma-separated Google client IDs accepted as id_token audience for native sign-in (iOS, Android, web). When set, Google native sign-in is enabled. SPFN_AUTH_GOOGLE_CLIENT_ID is also accepted automatically.',
            required: false,
            examples: [
                '123-ios.apps.googleusercontent.com,123-android.apps.googleusercontent.com',
            ],
        }),
    },

    SPFN_AUTH_APPLE_CLIENT_IDS: {
        ...envString({
            description: 'Comma-separated Apple client IDs accepted as id_token audience for native sign-in (iOS bundle ID, web/Android Services ID). When set, Apple native sign-in is enabled.',
            required: false,
            examples: [
                'com.example.app,com.example.app.service',
            ],
        }),
    },

    SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS: {
        ...envString({
            description: 'Comma-separated Kakao app keys accepted as id_token audience for native sign-in (native app key). SPFN_AUTH_KAKAO_CLIENT_ID (REST API key) is also accepted automatically, so native sign-in is available when either variable is set. Requires OpenID Connect to be enabled in the Kakao developer console.',
            required: false,
            examples: [
                'your-kakao-native-app-key',
            ],
        }),
    },

    SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS: {
        ...envString({
            description: 'Comma-separated Naver client IDs accepted as id_token audience for native sign-in. SPFN_AUTH_NAVER_CLIENT_ID is also accepted automatically, and one Naver application has a single client ID covering web and app environments — set this only when the app uses a separate application.',
            required: false,
            examples: [
                'your-naver-app-client-id',
            ],
        }),
    },

    SPFN_AUTH_OAUTH_SUCCESS_URL: {
        ...envString({
            description: 'OAuth callback page URL. This page should use OAuthCallback component to finalize session.',
            required: false,
            default: '/auth/callback',
            examples: [
                '/auth/callback',
                'https://app.example.com/auth/callback',
            ],
        }),
    },

    SPFN_AUTH_OAUTH_ERROR_URL: {
        ...envString({
            description: 'URL to redirect after OAuth error. Use {error} placeholder for error message.',
            required: false,
            default: '/auth/error?error={error}',
            examples: [
                'https://app.example.com/auth/error?error={error}',
                'http://localhost:3000/auth/error?error={error}',
            ],
        }),
    },
});
