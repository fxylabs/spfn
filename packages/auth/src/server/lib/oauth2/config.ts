/**
 * OAuth 2.1 Authorization Server Configuration
 *
 * Singleton config, mirroring `lib/device-auth-config.ts`: a mutable
 * module-level value, set once from `createAuthLifecycle()` and read at request
 * time.
 *
 * Unlike the device-auth block this one has no defaults to fall back on, and
 * that is the feature: an application that does not pass `authorizationServer`
 * is not running an authorization server, and every route under
 * `/_auth/oauth2/*` answers 404 for it. Nothing here can be derived — the scope
 * names are the application's vocabulary, and inventing a set would publish
 * scopes in the metadata document that nothing honours.
 */

import { authLogger } from '../../logger';

/**
 * Everything the authorization server needs, resolved.
 *
 * `issuer` and `authorizeUrl` are absolute; the defaults are derived here, once,
 * rather than at each use — the metadata document publishes them and a client
 * that read one value must not meet another on the next request.
 */
export interface AuthorizationServerConfig
{
    /** Origin the tokens are issued by, no path. `SPFN_API_URL` by default. */
    issuer: string;

    /**
     * Where `issuer` came from — the option name or the variable name — so the
     * boot refusal can tell an operator which one to edit.
     */
    issuerSource: string;

    /** Consent screen, on the web app: `${appUrl}/oauth/authorize` by default. */
    authorizeUrl: string;

    /** Scope name to the one-line description the consent screen shows. */
    scopes: Record<string, string>;

    /** What an authorize request with no `scope` asks for. All of them by default. */
    defaultScopes: string[];

    /** `https://` origins a client may register a redirect URI on. Loopback needs no entry. */
    allowedRedirectOrigins: string[];

    accessTokenTtlMs: number;
    refreshTokenTtlMs: number;
    codeTtlMs: number;
}

/** Options as an application writes them. Everything but `scopes` has a default. */
export interface AuthorizationServerOptions
{
    issuer?: string;
    authorizeUrl?: string;
    scopes: Record<string, string>;
    defaultScopes?: string[];
    allowedRedirectOrigins?: string[];
    accessTokenTtlMs?: number;
    refreshTokenTtlMs?: number;
    codeTtlMs?: number;
}

/** Eight hours. Long enough for a working session, short enough to matter. */
export const DEFAULT_ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/** Thirty days. The CLI is expected to be reconnected about that often. */
export const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sixty seconds — the code travels from a browser redirect to a local listener. */
export const DEFAULT_CODE_TTL_MS = 60 * 1000;

/** Path the consent screen is served at on the web app. */
export const AUTHORIZE_PATH = '/oauth/authorize';

let config: AuthorizationServerConfig | null = null;

/** The API origin every default is derived from, and the boot check's subject. */
export function resolveIssuerSource(
    env: Record<string, string | undefined> = process.env,
): { value: string | undefined; variable: string }
{
    return { value: env.SPFN_API_URL, variable: 'SPFN_API_URL' };
}

function resolveAuthorizeUrl(env: Record<string, string | undefined>): string
{
    const appUrl = env.NEXT_PUBLIC_SPFN_APP_URL || env.SPFN_APP_URL || 'http://localhost:3000';

    return new URL(AUTHORIZE_PATH, appUrl).toString();
}

/**
 * Resolve the authorization server config, or clear it when the application
 * passed none. Called synchronously from `createAuthLifecycle()` for the reason
 * `configureDeviceAuth` is: nothing may serve a request under half a config.
 *
 * The issuer is NOT validated or canonicalised here —
 * `assertAuthorizationServerIssuer` does both, from `afterInfrastructure`, where
 * a throw exits the process instead of leaving a server listening without
 * routes. See `lifecycle.ts`.
 */
export function configureAuthorizationServer(
    options?: AuthorizationServerOptions,
    env: Record<string, string | undefined> = process.env,
): void
{
    if (!options)
    {
        config = null;

        return;
    }

    const scopeNames = Object.keys(options.scopes ?? {});

    if (scopeNames.length === 0)
    {
        throw new Error(
            'authorizationServer.scopes must name at least one scope. The names are published in '
            + '/.well-known/oauth-authorization-server and shown on the consent screen, so there is '
            + 'nothing to derive them from.',
        );
    }

    config = {
        issuer: options.issuer ?? resolveIssuerSource(env).value ?? '',
        issuerSource: options.issuer ? 'authorizationServer.issuer' : resolveIssuerSource(env).variable,
        authorizeUrl: options.authorizeUrl ?? resolveAuthorizeUrl(env),
        scopes: { ...options.scopes },
        defaultScopes: options.defaultScopes ?? scopeNames,
        allowedRedirectOrigins: options.allowedRedirectOrigins ?? [],
        accessTokenTtlMs: options.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS,
        refreshTokenTtlMs: options.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS,
        codeTtlMs: options.codeTtlMs ?? DEFAULT_CODE_TTL_MS,
    };

    assertKnownDefaultScopes(config);
}

function assertKnownDefaultScopes(resolved: AuthorizationServerConfig): void
{
    const unknown = resolved.defaultScopes.filter(scope => !(scope in resolved.scopes));

    if (unknown.length > 0)
    {
        throw new Error(
            `authorizationServer.defaultScopes names ${unknown.join(', ')}, which authorizationServer.scopes `
            + 'does not describe. An authorize request with no scope would ask for something no consent '
            + 'screen can explain.',
        );
    }
}

/**
 * The resolved config, or null when this application runs no authorization
 * server. Every route under `/_auth/oauth2/*` reads it and answers 404 on null.
 */
export function getAuthorizationServerConfig(): AuthorizationServerConfig | null
{
    return config;
}

/**
 * `localhost`, `127.0.0.1` and `[::1]` — the hosts a browser treats as a secure
 * context over plain http, which is why the issuer may be `http://` on them and
 * nowhere else. `URL.hostname` normalises every IPv6 spelling to `[::1]`.
 */
export function isLoopbackHostname(hostname: string): boolean
{
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Refuse boot on an issuer no client could use, and reduce the one that passes
 * to the single form this server publishes.
 *
 * `.well-known/*` lives at an origin's root, so an issuer carrying a path has no
 * place to publish its metadata and every discovery request 404s. An issuer that
 * is neither https nor loopback http means tokens crossing the network in the
 * clear. Both are configuration drift between environments, so the deploy that
 * introduces them is where they have to surface — the posture, the place and the
 * voice of `assertOAuthRedirectUris`, one door down.
 *
 * Silent when no authorization server is configured: an application that does
 * not run one must boot exactly as it did before this feature existed.
 *
 * @throws When the resolved issuer cannot be honoured. The message names the
 *         variable or the option the value came from.
 */
export function assertAuthorizationServerIssuer(): void
{
    const resolved = getAuthorizationServerConfig();

    if (!resolved)
    {
        return;
    }

    resolved.issuer = canonicalIssuer(resolved.issuer, resolved.issuerSource);

    authLogger.service.info(
        `OAuth 2.1 authorization server enabled. issuer=${resolved.issuer}, `
        + `authorization_endpoint=${resolved.authorizeUrl}, scopes=${Object.keys(resolved.scopes).join(' ')}.`,
    );
}

/**
 * The value an operator wrote, reduced to what the metadata document carries.
 *
 * `URL.origin` is the reduction: a trailing slash, a default port and a path the
 * parser resolved away all disappear, and what is left is the exact string
 * `@spfn/mcp` derives for `authorization_servers`. RFC 8414 §3.3 has a client
 * compare the `issuer` it reads against the identifier it put in the well-known
 * path, so two documents naming one server differently is a client that refuses
 * the metadata — and `SPFN_API_URL` is written with a trailing slash as often as
 * without one.
 */
function canonicalIssuer(issuer: string, source: string): string
{
    let url: URL;

    try
    {
        url = new URL(issuer);
    }
    catch
    {
        throw new Error(
            `${source} must be an absolute URL for the OAuth 2.1 authorization server to issue tokens `
            + `under; it is "${issuer}".`,
        );
    }

    assertIssuerIdentifiesOneOrigin(url, issuer, source);
    assertIssuerTransportIsSafe(url, issuer, source);

    return url.origin;
}

/** The two ways a URL names something other than exactly one origin. */
function assertIssuerIdentifiesOneOrigin(url: URL, issuer: string, source: string): void
{
    // The value is not echoed here, alone among these messages: whatever stands
    // where the password does is a password.
    if (url.username !== '' || url.password !== '')
    {
        throw new Error(
            `${source} must not carry a username or a password for the OAuth 2.1 authorization `
            + 'server. Credentials in an issuer are dropped by every client that compares one, so '
            + 'the identifier published in the metadata would not be the value configured here.',
        );
    }

    if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    {
        throw new Error(
            `${source} must be an origin with no path for the OAuth 2.1 authorization server; it is `
            + `"${issuer}". /.well-known/oauth-authorization-server is served at an origin's root, so an `
            + 'issuer carrying a path publishes its metadata nowhere a client will look.',
        );
    }
}

/** https, or http on a host a browser treats as a secure context anyway. */
function assertIssuerTransportIsSafe(url: URL, issuer: string, source: string): void
{
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname)))
    {
        throw new Error(
            `${source} must be https, or http on localhost / 127.0.0.1 / [::1] for development; it is `
            + `"${issuer}". Anything else carries access tokens over the network in the clear.`,
        );
    }
}
