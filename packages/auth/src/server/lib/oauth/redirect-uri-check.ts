/**
 * @spfn/auth - Boot-time check of explicit OAuth redirect URI overrides
 *
 * The callback's CSRF check is a double-submit against a host-only `oauth_csrf`
 * cookie the Next.js interceptor sets on the web app host. A redirect URI pointed
 * at another origin — the API host in a split local setup, say — therefore returns
 * to a host the cookie never reaches, and every callback is refused for CSRF. The
 * provider getters read the override lazily on the first OAuth request and accept
 * any string, so that misconfiguration boots clean and only surfaces much later as
 * a refusal nobody traces back to the env value.
 *
 * This runs once at boot and refuses instead, naming every offending variable so
 * the operator fixes them all in one restart. It is boot-time only: the provider
 * getters keep computing the redirect URI exactly as before, per request.
 */

import { authLogger } from '../../logger';

const PROVIDERS = ['google', 'kakao', 'naver', 'github'] as const;

type Provider = typeof PROVIDERS[number];

type EnvSource = Record<string, string | undefined>;

const OPT_OUT_VAR = 'SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK';

/** Env names are uppercase; the callback path segment is the lowercase provider id. */
function redirectUriVar(provider: Provider): string
{
    return `SPFN_AUTH_${provider.toUpperCase()}_REDIRECT_URI`;
}

/**
 * The web app origin the callback has to come back to, or null when the configured
 * value is absent or unparseable. Without it there is no origin to compare against,
 * and neither case is this check's to refuse: a flow that builds a URL on the app
 * fails naming both variables, and a malformed `SPFN_APP_URL` is refused by the
 * startup env validation.
 */
function resolveWebAppOrigin(env: EnvSource): string | null
{
    const configured = env.NEXT_PUBLIC_SPFN_APP_URL || env.SPFN_APP_URL;

    if (!configured)
    {
        return null;
    }

    try
    {
        return new URL(configured).origin;
    }
    catch
    {
        return null;
    }
}

/**
 * null when the override conforms; otherwise the detail to append to the refusal,
 * which is empty for a plain origin or path mismatch because the refusal already
 * names the origin and the path it expected.
 *
 * Compares `origin` to `origin` rather than to a string built by hand: `new URL()`
 * drops a default port, so 'http://host:80' and 'http://host' are one origin.
 */
function conformanceDetail(value: string, webAppOrigin: string, callbackPath: string): string | null
{
    let url: URL;

    try
    {
        url = new URL(value);
    }
    catch
    {
        return ' The value is not a URL.';
    }

    if (url.origin !== webAppOrigin || url.pathname !== callbackPath)
    {
        return '';
    }

    if (url.search !== '' || url.hash !== '')
    {
        return ' The value carries a query string or fragment; the callback URL is the path alone.';
    }

    return null;
}

/** The refusal for one provider, or null when its override is unset or conforms. */
function providerRefusal(provider: Provider, env: EnvSource, webAppOrigin: string): string | null
{
    const variable = redirectUriVar(provider);
    const value = env[variable];

    if (!value)
    {
        return null;
    }

    const callbackPath = `/_auth/oauth/${provider}/callback`;
    const detail = conformanceDetail(value, webAppOrigin, callbackPath);

    if (detail === null)
    {
        return null;
    }

    return `${variable} must be on the web app origin (${webAppOrigin}) at ${callbackPath}: `
        + "the callback's CSRF cookie is host-only and /_auth/* is forwarded to the API by the "
        + 'app\'s rewrite. Unset it to use the default, fix the origin, or set '
        + `${OPT_OUT_VAR}=off for a deployment that deliberately terminates the callback `
        + `elsewhere.${detail}`;
}

/**
 * Refuse boot when an explicit OAuth redirect URI override leaves the web app origin.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws When one or more overrides do not conform. One error names them all.
 */
export function assertOAuthRedirectUris(env: EnvSource = process.env): void
{
    const examined = PROVIDERS.map(redirectUriVar).join(', ');

    if (env[OPT_OUT_VAR] === 'off')
    {
        authLogger.service.info(
            `${OPT_OUT_VAR}=off: the OAuth callback origin check is disabled. Not examined: ${examined}.`,
        );

        return;
    }

    const webAppOrigin = resolveWebAppOrigin(env);

    if (!webAppOrigin)
    {
        authLogger.service.info(
            'The OAuth callback origin check was skipped: neither NEXT_PUBLIC_SPFN_APP_URL nor '
            + 'SPFN_APP_URL is set to a parseable URL, so there is no web app origin to check '
            + `against. Not examined: ${examined}.`,
        );

        return;
    }

    const refusals = PROVIDERS
        .map(provider => providerRefusal(provider, env, webAppOrigin))
        .filter((refusal): refusal is string => refusal !== null);

    if (refusals.length > 0)
    {
        throw new Error(refusals.join('\n'));
    }
}
