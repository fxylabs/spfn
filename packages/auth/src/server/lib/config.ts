/**
 * @spfn/auth - Global Configuration
 *
 * Manages global auth configuration including session TTL
 */

import { env } from '@spfn/auth/config';
import { PasskeyConfigError } from '@spfn/auth/errors';

import type { SocialProvider } from '../types';
import { normalizeOptionalEmail } from '../helpers/email';
import { authLogger } from '../logger';

/**
 * Cookie name suffix derived from the server port, so several local dev
 * instances on the same domain do not overwrite each other's sessions.
 *
 * BREAKING: this read `PORT`, which no longer exists — the framework's port is
 * `SPFN_PORT`, because `PORT` is Next.js's own variable and two processes are
 * started. An app that had `PORT` set gets different cookie names than before
 * and its existing sessions stop resolving; one sign-in fixes it.
 */
function getCookieSuffix(): string
{
    const port = process.env.SPFN_PORT;

    return port ? `_${port}` : '';
}

/**
 * Cookie names used by SPFN Auth
 *
 * Names include a port-based suffix so that multiple dev instances
 * on different ports don't overwrite each other's cookies.
 */
export const COOKIE_NAMES = {
    /** Encrypted session data (userId, privateKey, keyId, algorithm) */
    get SESSION() 
    {
        return `spfn_session${getCookieSuffix()}`; 
    },
    /** Current key ID (for key rotation) */
    get SESSION_KEY_ID() 
    {
        return `spfn_session_key_id${getCookieSuffix()}`; 
    },
    /** Pending OAuth session (privateKey, keyId, algorithm) - temporary during OAuth flow */
    get OAUTH_PENDING()
    {
        return `spfn_oauth_pending${getCookieSuffix()}`;
    },
    /** OAuth CSRF nonce — double-submit against the (encrypted) state.nonce at callback */
    get OAUTH_CSRF()
    {
        return `spfn_oauth_csrf${getCookieSuffix()}`;
    },
    /** Password-setup session for verified-email signup — temporary, single-purpose */
    get SIGNUP_SETUP()
    {
        return `spfn_signup_setup${getCookieSuffix()}`;
    },
    /** CSRF token — the only cookie here the browser can read */
    get CSRF()
    {
        return `spfn_csrf${getCookieSuffix()}`;
    },
};

/**
 * OAuth CSRF 쿠키를 PORT 접미사와 무관하게 전부 수집한다.
 *
 * 쿠키를 심는 쪽은 Next.js 프로세스, 읽는 쪽은 API 프로세스라 분리 배포에서는
 * 두 프로세스의 PORT가 달라 COOKIE_NAMES.OAUTH_CSRF 정확 일치 조회가 빗나간다.
 * nonce 자체가 랜덤값이고 암호화된 state의 nonce와 대조되므로, 접미사가 다른
 * spfn_oauth_csrf* 후보를 모두 대조 대상으로 넘겨도 안전하다.
 */
export function matchOAuthCsrfCookies(
    cookies: Record<string, string>,
): { name: string; value: string }[]
{
    return Object.entries(cookies)
        .filter(([name]) => /^spfn_oauth_csrf(_\d+)?$/.test(name))
        .map(([name, value]) => ({ name, value }));
}

/**
 * Parse duration string to seconds
 *
 * Supports: '30d', '12h', '45m', '3600s', or plain number
 *
 * @example
 * parseDuration('30d')   // 2592000 (30 days in seconds)
 * parseDuration('12h')   // 43200
 * parseDuration('45m')   // 2700
 * parseDuration('3600')  // 3600
 */
export function parseDuration(duration: string | number): number
{
    if (typeof duration === 'number')
    {
        return duration;
    }

    const match = duration.match(/^(\d+)([dhms]?)$/);
    if (!match)
    {
        throw new Error(`Invalid duration format: ${duration}. Use format like '30d', '12h', '45m', '3600s', or plain number.`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';

    switch (unit)
    {
        case 'd':
            return value * 24 * 60 * 60;
        case 'h':
            return value * 60 * 60;
        case 'm':
            return value * 60;
        case 's':
            return value;
        default:
            throw new Error(`Unknown duration unit: ${unit}`);
    }
}

/**
 * Registration channel passed to the beforeRegister hook
 *
 * - credentials: email/phone + password registration
 * - oauth: new-user signup through a social provider (web or native flow)
 * - invitation: invitation acceptance
 */
export type RegisterChannel = 'credentials' | 'oauth' | 'invitation';

/**
 * Context passed to the beforeRegister hook
 *
 * Credentials (password, keys) are intentionally excluded — the hook is a
 * policy gate, not a credential handler.
 */
export interface BeforeRegisterContext
{
    channel: RegisterChannel;
    /** Social provider — only set when channel is 'oauth' */
    provider?: SocialProvider;
    /**
     * Canonical form of the address — trimmed and lower-cased, the same form
     * the account is stored under. A policy keyed on the address (a denylist, a
     * domain allowlist) therefore matches whatever capitalization the person
     * typed, instead of being walked past by `Blocked@Example.com`.
     */
    email?: string;
    /**
     * Whether the email is verified — only set when channel is 'oauth'.
     * OAuth providers may report an unverified (spoofable) email; the created
     * account stores it as null in that case, so email-based policies must
     * check this flag. credentials/invitation emails are already verified.
     */
    emailVerified?: boolean;
    phone?: string;
    /** App-supplied registration metadata (register params / OAuth start params / invitation) */
    metadata?: Record<string, unknown>;
}

/**
 * How the Next.js proxy treats a cookie-authenticated mutation that arrives
 * without a valid CSRF header.
 *
 * - `off`: no check
 * - `warn`: allow it through, log one line per request that would be refused
 * - `enforce`: refuse it with 403
 */
export type CsrfMode = 'off' | 'warn' | 'enforce';

/**
 * CSRF configuration for the Next.js proxy
 */
export interface AuthCsrfConfig
{
    /**
     * @default 'warn' — an existing app gets signal before it gets breakage.
     *          `SPFN_AUTH_CSRF` sets it when this is not; new apps scaffolded by
     *          `spfn init` are given `enforce`.
     */
    mode?: CsrfMode;

    /**
     * Backend paths that skip the check, matched exactly.
     *
     * These are route paths as the backend sees them (`/webhooks/stripe`), not
     * `/api/rpc/...` URLs, with route params already substituted. Intended for
     * endpoints a browser session never calls — webhook receivers and the like.
     * A path listed here is unprotected for cookie callers too, so list only
     * endpoints that carry their own authentication.
     */
    exemptPaths?: string[];
}

/**
 * Auth configuration
 */
export interface AuthConfig
{
    /**
     * Default session TTL in seconds or duration string
     *
     * Supports:
     * - Number: seconds (e.g., 2592000)
     * - String: '30d', '12h', '45m', '3600s'
     *
     * @default 7d (7 days)
     */
    sessionTtl?: string | number;

    /**
     * App-injected validator that runs before a new user row is created,
     * on every registration channel (credentials, oauth, invitation).
     *
     * Throw to reject the registration — RegistrationRejectedError (403) is
     * the recommended error; any HttpError subclass keeps its own status.
     * Runs after built-in checks (verification token, duplicate account),
     * so existing error precedence is unchanged. Not called for admin
     * seeding (initializeAuth) or when linking a social account to an
     * existing user.
     *
     * Runs inside the registration DB transaction on every channel — keep it
     * fast. A slow call (e.g. an external policy API) holds a pooled DB
     * connection open for its full duration on every signup.
     *
     * @example
     * ```typescript
     * configureAuth({
     *     beforeRegister: async ({ channel, metadata }) =>
     *     {
     *         if (channel === 'credentials' && !isOldEnough(metadata?.birthDate))
     *         {
     *             throw new RegistrationRejectedError({ message: 'Age requirement not met' });
     *         }
     *     },
     * });
     * ```
     */
    beforeRegister?: (context: BeforeRegisterContext) => void | Promise<void>;

    /**
     * CSRF protection for cookie-session mutations, enforced in the Next.js proxy.
     *
     * @example
     * ```typescript
     * configureAuth({
     *     csrf: { mode: 'enforce', exemptPaths: ['/webhooks/stripe'] },
     * });
     * ```
     */
    csrf?: AuthCsrfConfig;
}

/**
 * Global auth configuration state
 */
let globalConfig: AuthConfig = {
    sessionTtl: '7d', // Default: 7 days
};

/**
 * Configure global auth settings
 *
 * @param config - Auth configuration
 *
 * @example
 * ```typescript
 * configureAuth({
 *   sessionTtl: '30d',  // 30 days
 * });
 * ```
 */
export function configureAuth(config: AuthConfig): void
{
    globalConfig = {
        ...globalConfig,
        ...config,
    };
}

/**
 * Get current auth configuration
 */
export function getAuthConfig(): AuthConfig
{
    return { ...globalConfig };
}

/**
 * Run the app-injected beforeRegister hook if configured — throws to reject.
 *
 * Single entry point for every registration channel so a new channel cannot
 * forget the configured-check. Callers invoke this right before creating the
 * user row.
 *
 * The address is folded here rather than at each call site, for the same reason
 * the check itself lives here: three channels supply it, and a policy that sees
 * a different spelling depending on which one the person came through is a
 * policy that can be walked past.
 */
export async function runBeforeRegister(context: BeforeRegisterContext): Promise<void>
{
    const { beforeRegister } = globalConfig;

    if (beforeRegister)
    {
        await beforeRegister({ ...context, email: normalizeOptionalEmail(context.email) });
    }
}

/**
 * Get session TTL in seconds
 *
 * Priority:
 * 1. Runtime override (remember parameter)
 * 2. Global config (configureAuth)
 * 3. Environment variable (SPFN_AUTH_SESSION_TTL) - via config module
 * 4. Default (7 days)
 */
export function getSessionTtl(override?: string | number): number
{
    // 1. Runtime override
    if (override !== undefined)
    {
        return parseDuration(override);
    }

    // 2. Global config
    if (globalConfig.sessionTtl !== undefined)
    {
        return parseDuration(globalConfig.sessionTtl);
    }

    // 3. Environment variable (from config module)
    const envTtl = env.SPFN_AUTH_SESSION_TTL;
    if (envTtl)
    {
        return parseDuration(envTtl);
    }

    // 4. Default: 7 days
    return 7 * 24 * 60 * 60;
}

const CSRF_MODES: CsrfMode[] = ['off', 'warn', 'enforce'];

/** The typo notice is a property of the process, not of a request */
let unrecognizedCsrfModeReported = false;

/**
 * Get the CSRF mode
 *
 * Priority:
 * 1. Global config (configureAuth)
 * 2. Environment variable (SPFN_AUTH_CSRF)
 * 3. Default ('warn')
 *
 * An unrecognized value is a typo in the one setting that turns the check on;
 * it resolves to `enforce` and says so, rather than quietly leaving mutations
 * unprotected. It says so once per process: this runs on every mutation, so a
 * per-call error would be pure repetition burying the rest of the log.
 */
export function getCsrfMode(): CsrfMode
{
    const configured = globalConfig.csrf?.mode ?? env.SPFN_AUTH_CSRF;

    if (!configured)
    {
        return 'warn';
    }

    const normalized = String(configured).trim().toLowerCase() as CsrfMode;

    if (!CSRF_MODES.includes(normalized))
    {
        if (!unrecognizedCsrfModeReported)
        {
            unrecognizedCsrfModeReported = true;
            authLogger.interceptor.csrf.error(
                `Unrecognized CSRF mode "${configured}" — expected off | warn | enforce. Enforcing.`,
            );
        }

        return 'enforce';
    }

    return normalized;
}

/**
 * Get the paths exempted from the CSRF check (exact match, backend route paths)
 */
export function getCsrfExemptPaths(): string[]
{
    return globalConfig.csrf?.exemptPaths ?? [];
}

// ============================================================================
// Passkeys (WebAuthn)
// ============================================================================

/**
 * The relying party this deployment presents to authenticators, resolved.
 *
 * `rpId` is the domain a credential is bound to and can never change without
 * orphaning every passkey already enrolled under it. `origins` is the closed set
 * of pages allowed to run a ceremony for that rpId.
 */
export interface PasskeyConfig
{
    /** Domain credentials are bound to — a registrable domain, no protocol, no port. */
    rpId: string;
    /** Name shown by the authenticator's own prompt. */
    rpName: string;
    /** Full origins allowed to run a ceremony, e.g. `https://app.example.com`. */
    origins: string[];
    userVerification: PasskeyUserVerification;
    challengeTtlMs: number;
    recentAuthMs: number;
}

/**
 * How hard the authenticator must work to prove the person is present.
 *
 * `discouraged` is not offered: a passkey here is the whole credential, so an
 * assertion that skipped user verification would sign someone in on possession
 * of an unlocked device alone.
 */
export type PasskeyUserVerification = 'preferred' | 'required';

const PASSKEY_USER_VERIFICATIONS: PasskeyUserVerification[] = ['preferred', 'required'];

type PasskeyEnvSource = Record<string, string | undefined>;

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_RECENT_AUTH_MINUTES = 10;

/**
 * Every variable this resolution reads, with the one schema default filled in.
 *
 * `SPFN_APP_URL` defaults to `http://localhost:3000` in the validated `env`
 * proxy rather than in `process.env`, so reading the raw environment alone would
 * refuse boot for an app that simply never set it.
 */
function passkeyEnvSource(): PasskeyEnvSource
{
    return { ...process.env, SPFN_APP_URL: process.env.SPFN_APP_URL || env.SPFN_APP_URL };
}

/**
 * The app URL every default here is derived from — the same resolution the OAuth
 * callbacks use, so passkeys and OAuth cannot disagree about where the app is.
 */
function passkeyAppUrl(env: PasskeyEnvSource): URL
{
    const configured = env.NEXT_PUBLIC_SPFN_APP_URL || env.SPFN_APP_URL;

    if (!configured)
    {
        throw new PasskeyConfigError({
            message: 'Passkeys need a relying party ID. Set SPFN_AUTH_PASSKEY_RP_ID, or set '
                + 'NEXT_PUBLIC_SPFN_APP_URL / SPFN_APP_URL to the app origin it should be derived from.',
        });
    }

    try
    {
        return new URL(configured);
    }
    catch
    {
        throw new PasskeyConfigError({
            message: `Passkeys cannot derive a relying party ID: "${configured}" is not a URL. `
                + 'Fix NEXT_PUBLIC_SPFN_APP_URL / SPFN_APP_URL, or set SPFN_AUTH_PASSKEY_RP_ID explicitly.',
        });
    }
}

/**
 * `localhost` is the one host a browser treats as a secure context over plain
 * http, so it is the one host allowed an `http://` origin here.
 */
function isLocalhost(hostname: string): boolean
{
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Whether a ceremony run on this host may claim credentials bound to `rpId`. */
function isUnderRpId(hostname: string, rpId: string): boolean
{
    return hostname === rpId || hostname.endsWith(`.${rpId}`);
}

/**
 * One configured origin, checked against the two rules a browser will enforce
 * anyway — better to refuse at boot than to have every ceremony fail with an
 * error that names the browser rather than the env value.
 */
function assertOriginServesRpId(origin: string, rpId: string): void
{
    let url: URL;

    try
    {
        url = new URL(origin);
    }
    catch
    {
        throw new PasskeyConfigError({
            message: `SPFN_AUTH_PASSKEY_ORIGINS contains "${origin}", which is not a URL. `
                + 'List full origins, e.g. https://app.example.com.',
        });
    }

    if (url.protocol !== 'https:' && !isLocalhost(url.hostname))
    {
        throw new PasskeyConfigError({
            message: `Passkey origin "${origin}" is not https. WebAuthn runs only in a secure context, `
                + 'and localhost is the only host a browser treats as one over plain http.',
        });
    }

    if (!isUnderRpId(url.hostname, rpId))
    {
        throw new PasskeyConfigError({
            message: `Passkey origin "${origin}" is not on relying party ID "${rpId}". `
                + 'Each origin must be that host or a subdomain of it, or the browser refuses the ceremony.',
        });
    }
}

function resolveUserVerification(env: PasskeyEnvSource): PasskeyUserVerification
{
    const configured = env.SPFN_AUTH_PASSKEY_USER_VERIFICATION;

    if (!configured)
    {
        return 'preferred';
    }

    const normalized = configured.trim().toLowerCase() as PasskeyUserVerification;

    if (!PASSKEY_USER_VERIFICATIONS.includes(normalized))
    {
        throw new PasskeyConfigError({
            message: `SPFN_AUTH_PASSKEY_USER_VERIFICATION is "${configured}" — expected preferred or required. `
                + 'A passkey is the whole credential here, so an assertion that skipped user verification '
                + 'would sign someone in on an unlocked device alone.',
        });
    }

    return normalized;
}

/** A positive number of the given unit, or the default when unset. */
function resolvePositiveNumber(env: PasskeyEnvSource, variable: string, fallback: number): number
{
    const configured = env[variable];

    if (!configured)
    {
        return fallback;
    }

    const parsed = Number(configured);

    if (!Number.isFinite(parsed) || parsed <= 0)
    {
        throw new PasskeyConfigError({
            message: `${variable} is "${configured}" — expected a positive number.`,
        });
    }

    return parsed;
}

/**
 * Resolve the passkey configuration, refusing anything a ceremony would fail on.
 *
 * Zero-config for a one-origin app: rpId is the app URL's host and the single
 * origin is the app URL's origin. An app on several hosts sets
 * `SPFN_AUTH_PASSKEY_RP_ID` to the registrable domain they share and lists them
 * in `SPFN_AUTH_PASSKEY_ORIGINS`.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws PasskeyConfigError when the configuration cannot be honoured.
 */
export function getPasskeyConfig(env: PasskeyEnvSource = passkeyEnvSource()): PasskeyConfig
{
    const rpId = env.SPFN_AUTH_PASSKEY_RP_ID?.trim() || passkeyAppUrl(env).hostname;
    const configuredOrigins = env.SPFN_AUTH_PASSKEY_ORIGINS
        ?.split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
    const origins = configuredOrigins?.length ? configuredOrigins : [passkeyAppUrl(env).origin];

    for (const origin of origins)
    {
        assertOriginServesRpId(origin, rpId);
    }

    return {
        rpId,
        rpName: env.SPFN_AUTH_PASSKEY_RP_NAME?.trim() || rpId,
        origins,
        userVerification: resolveUserVerification(env),
        challengeTtlMs: resolvePositiveNumber(
            env, 'SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS', DEFAULT_CHALLENGE_TTL_SECONDS,
        ) * 1000,
        recentAuthMs: resolvePositiveNumber(
            env, 'SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES', DEFAULT_RECENT_AUTH_MINUTES,
        ) * 60_000,
    };
}

/** The variables whose presence means an operator configured passkeys on purpose. */
const PASSKEY_VARS = [
    'SPFN_AUTH_PASSKEY_RP_ID',
    'SPFN_AUTH_PASSKEY_RP_NAME',
    'SPFN_AUTH_PASSKEY_ORIGINS',
    'SPFN_AUTH_PASSKEY_USER_VERIFICATION',
    'SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS',
    'SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES',
];

/**
 * Refuse boot on a passkey configuration no ceremony could satisfy.
 *
 * Resolution is the check: everything `getPasskeyConfig` refuses would otherwise
 * surface as the browser rejecting every ceremony, long after the deploy that
 * introduced the drift.
 *
 * The refusal is reserved for a configuration an operator actually wrote, which
 * is the posture `assertOAuthRedirectUris` already takes for the same reason. An
 * app that set no passkey variable at all can still resolve to something
 * unusable — `SPFN_APP_URL=http://192.168.1.5:3000` for mobile development, say,
 * which is neither https nor localhost — and refusing to start over a feature
 * nobody asked for would take that app down to fix something it does not use.
 * It is reported instead, once, and the first ceremony (if there ever is one)
 * fails with the same message.
 *
 * @throws PasskeyConfigError when a passkey variable is set and cannot be honoured
 */
export function assertPasskeyConfig(env: PasskeyEnvSource = passkeyEnvSource()): void
{
    if (PASSKEY_VARS.some(variable => env[variable]))
    {
        getPasskeyConfig(env);

        return;
    }

    try
    {
        getPasskeyConfig(env);
    }
    catch (error)
    {
        authLogger.service.info(
            'Passkeys cannot be served with the configuration derived from the app URL, and no '
            + `SPFN_AUTH_PASSKEY_* variable is set, so boot continues. ${(error as Error).message}`,
        );
    }
}
