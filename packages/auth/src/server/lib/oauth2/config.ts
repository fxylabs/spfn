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
import { resolveAppUrl } from '../app-url';
import { optionKeys, readEntries, readList, readOptions } from '@spfn/core/options';

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
    defaultScopes: readonly string[];

    /** `https://` origins a client may register a redirect URI on. Loopback needs no entry. */
    allowedRedirectOrigins: readonly string[];

    accessTokenTtlMs: number;
    refreshTokenTtlMs: number;
    codeTtlMs: number;

    /**
     * How long a grant lives from its creation, however often it is refreshed.
     * Written onto each grant as `expiresAt` when it is created, so a change
     * applies to grants created afterwards and never revives a lapsed one.
     */
    grantLifetimeMs: number;
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
    grantLifetimeMs?: number;
}

/** Eight hours. Long enough for a working session, short enough to matter. */
export const DEFAULT_ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Thirty days without a refresh. Each rotation starts a new thirty days, so this
 * bounds how long an idle client keeps its connection, not how long a busy one
 * does — that is `DEFAULT_GRANT_LIFETIME_MS`.
 */
export const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 180 days from the consent, whatever the client does in between. Past it the
 * grant authorizes nothing — refresh and verification both refuse — and the
 * user is asked to consent again, which creates a new grant.
 */
export const DEFAULT_GRANT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

/** Sixty seconds — the code travels from a browser redirect to a local listener. */
export const DEFAULT_CODE_TTL_MS = 60 * 1000;

/** Path the consent screen is served at on the web app. */
export const AUTHORIZE_PATH = '/oauth/authorize';

const AUTHORIZATION_SERVER_OPTIONS = optionKeys<AuthorizationServerOptions>({
    issuer: true,
    authorizeUrl: true,
    scopes: true,
    defaultScopes: true,
    allowedRedirectOrigins: true,
    accessTokenTtlMs: true,
    refreshTokenTtlMs: true,
    codeTtlMs: true,
    grantLifetimeMs: true,
});

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
    return new URL(AUTHORIZE_PATH, resolveAppUrl(env)).toString();
}

/**
 * Resolve the authorization server config, or clear it when the application
 * passed none. Called synchronously from `createAuthLifecycle()` for the reason
 * `configureDeviceAuth` is: nothing may serve a request under half a config.
 *
 * The issuer is reduced to the form this server publishes here, where every
 * other default is resolved, so the config is publishable in exactly one state
 * whether or not a lifecycle hook has run. It is not *validated* here: a value
 * this cannot reduce is stored as the operator wrote it and refused by
 * `assertAuthorizationServerIssuer` from `afterInfrastructure`, beside the
 * other boot refusals. See `lifecycle.ts`.
 *
 * `options` is read once, by `readOptions`, `scopes` — a map keyed by the
 * application's scope names — once, by `readEntries`, and `defaultScopes` and
 * `allowedRedirectOrigins` each once, by `readList`, into a copy; only those
 * snapshots are checked and stored (#477).
 *
 * @throws When `options` or `scopes` is not a plain object, `options` carries
 *         a name that is not an option, `scopes` is empty, `defaultScopes` names an unknown scope or
 *         `grantLifetimeMs` is not a positive whole number of milliseconds, and
 *         when `authorizeUrl` is not given and neither `NEXT_PUBLIC_SPFN_APP_URL`
 *         nor `SPFN_APP_URL` is set to derive it from.
 */
export function configureAuthorizationServer(
    options?: AuthorizationServerOptions,
    env: Record<string, string | undefined> = process.env,
): void
{
    if (options === undefined)
    {
        config = null;

        return;
    }

    const read = readOptions<AuthorizationServerOptions>('authorizationServer', options, AUTHORIZATION_SERVER_OPTIONS);
    const scopes = read.scopes === undefined ? {} : readEntries<string>('authorizationServer.scopes', read.scopes, 'naming each scope');
    const scopeNames = Object.keys(scopes);

    if (scopeNames.length === 0)
    {
        throw new Error(
            'authorizationServer.scopes must name at least one scope. The names are published in '
            + '/.well-known/oauth-authorization-server and shown on the consent screen, so there is '
            + 'nothing to derive them from.',
        );
    }

    const issuer = read.issuer === undefined ? resolveIssuerSource(env) : { value: read.issuer, variable: 'authorizationServer.issuer' };
    const resolved: AuthorizationServerConfig = {
        issuer: canonicalIssuer(issuer.value ?? ''),
        issuerSource: issuer.variable,
        authorizeUrl: read.authorizeUrl ?? resolveAuthorizeUrl(env),
        scopes,
        defaultScopes: read.defaultScopes === undefined
            ? scopeNames
            : readList<string>('authorizationServer.defaultScopes', read.defaultScopes, 'of scope names'),
        allowedRedirectOrigins: read.allowedRedirectOrigins === undefined
            ? []
            : readList<string>('authorizationServer.allowedRedirectOrigins', read.allowedRedirectOrigins, 'of https origins'),
        accessTokenTtlMs: read.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS,
        refreshTokenTtlMs: read.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS,
        codeTtlMs: read.codeTtlMs ?? DEFAULT_CODE_TTL_MS,
        grantLifetimeMs: read.grantLifetimeMs ?? DEFAULT_GRANT_LIFETIME_MS,
    };

    // Validated before it is stored: a refused configuration must leave nothing
    // behind for a request to be served under.
    assertKnownDefaultScopes(resolved);
    assertGrantLifetime(resolved.grantLifetimeMs);

    config = resolved;
}

/**
 * A positive whole number of milliseconds. Zero, a negative, a fraction or
 * `Infinity` would each mean either that no grant ever works or that none ever
 * ends, and neither is a lifetime anybody meant to configure.
 */
function assertGrantLifetime(grantLifetimeMs: number): void
{
    if (!Number.isSafeInteger(grantLifetimeMs) || grantLifetimeMs <= 0)
    {
        throw new Error(
            `authorizationServer.grantLifetimeMs must be a positive whole number of milliseconds; it is `
            + `${String(grantLifetimeMs)}. It is how long a consent lasts before the user is asked again.`,
        );
    }
}

function assertKnownDefaultScopes(resolved: AuthorizationServerConfig): void
{
    const unknown = resolved.defaultScopes.filter(scope => !Object.hasOwn(resolved.scopes, scope));

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
 * Refuse boot on an issuer no client could use.
 *
 * `.well-known/*` lives at an origin's root, so an issuer carrying a path has no
 * place to publish its metadata and every discovery request 404s. An issuer that
 * is neither https nor loopback http means tokens crossing the network in the
 * clear. Both are configuration drift between environments, so the deploy that
 * introduces them is where they have to surface — the posture, the place and the
 * voice of `assertOAuthRedirectUris`, one door down.
 *
 * This only asserts. `configureAuthorizationServer` reduced the value it reads
 * if it could, so anything reaching here that is not an origin is one the
 * reduction deliberately left alone.
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

    assertPublishableIssuer(resolved.issuer, resolved.issuerSource);

    authLogger.service.info(
        `OAuth 2.1 authorization server enabled. issuer=${resolved.issuer}, `
        + `authorization_endpoint=${resolved.authorizeUrl}, scopes=${Object.keys(resolved.scopes).join(' ')}.`,
    );
}

/**
 * The value an operator wrote, reduced to what the metadata document carries.
 *
 * `URL.origin` is the reduction, and the raw string must already be that origin
 * or that origin with a trailing slash for it to apply. Nothing else is reduced:
 * the parser also resolves `/a/..` and `/%2e%2e` to `/`, and a path that
 * disappeared while being read is not a path an operator wrote by accident.
 * Those values are stored as written, for the boot check to refuse by name.
 *
 * RFC 8414 §3.3 has a client compare the `issuer` it reads against the
 * identifier it put in the well-known path, so two documents naming one server
 * differently is a client that refuses the metadata — and `SPFN_API_URL` is
 * written with a trailing slash as often as without one.
 */
function canonicalIssuer(raw: string): string
{
    const url = parseUrl(raw);

    return url && isOriginOnly(raw, url) ? url.origin : raw;
}

/** Whether the operator wrote an origin, and nothing after it but a slash. */
function isOriginOnly(raw: string, url: URL): boolean
{
    return raw === url.origin || raw === `${url.origin}/`;
}

/** `new URL`, answering null where it throws. */
function parseUrl(value: string): URL | null
{
    try
    {
        return new URL(value);
    }
    catch
    {
        return null;
    }
}

/** The three ways an issuer is not an origin this server can publish under. */
function assertPublishableIssuer(issuer: string, source: string): void
{
    const url = parseUrl(issuer);

    if (!url)
    {
        throw new Error(
            `${source} must be an absolute URL for the OAuth 2.1 authorization server to issue tokens `
            + `under; it is "${issuer}".`,
        );
    }

    assertIssuerIdentifiesOneOrigin(url, issuer, source);
    assertIssuerTransportIsSafe(url, issuer, source);
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

    if (!isOriginOnly(issuer, url))
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
