/**
 * @spfn/auth - The closed sets `configureAuth` accepts (au5-B2)
 *
 * Every policy value is checked when it is configured, so a value outside its
 * set — `'Reject'`, the string `'false'`, a provider name with a typo — is a
 * configuration error naming the option and the values it takes, instead of
 * quietly reading as the loosest behaviour at the first request that asks.
 *
 * `undefined` is always accepted: it means "not set", and tests and apps pass
 * it to put an option back to its default.
 */

import { SOCIAL_PROVIDERS } from '../types';

const OAUTH_EMAIL_MATCHES = ['attach', 'reject', 'separate'];
const CSRF_MODES = ['off', 'warn', 'enforce'];
const PROVIDER_POLICY_KEYS = ['signIn', 'recentAuth'];
const RECENT_AUTH_KEYS = ['link', 'unlink'];
const OAUTH_LINK_KEYS = ['recentAuth', 'recentAuthMinutes'];

/** The parts of an `AuthConfig` whose values come from a closed set. */
interface PolicyValues
{
    oauthEmailMatch?: unknown;
    csrf?: { mode?: unknown };
    oauthProviders?: unknown;
    oauthLink?: unknown;
}

/**
 * Refuse any policy value outside its declared set.
 *
 * @throws Error naming the option and the values it accepts
 */
export function assertPolicyValues(config: PolicyValues): void
{
    assertOneOf('oauthEmailMatch', config.oauthEmailMatch, OAUTH_EMAIL_MATCHES);
    assertCsrfMode(config.csrf?.mode);
    assertProviderPolicies(config.oauthProviders);
    assertOAuthLink(config.oauthLink);
}

/** `csrf.mode`, read case-insensitively as `getCsrfMode` reads it. */
function assertCsrfMode(mode: unknown): void
{
    const normalized = typeof mode === 'string' ? mode.trim().toLowerCase() : mode;

    if (normalized !== undefined && !CSRF_MODES.includes(normalized as string))
    {
        throw refusal('csrf.mode', mode, CSRF_MODES.map(quoted));
    }
}

function assertProviderPolicies(policies: unknown): void
{
    if (policies === undefined)
    {
        return;
    }

    assertObject('oauthProviders', policies);

    for (const [provider, policy] of Object.entries(policies as Record<string, unknown>))
    {
        if (!(SOCIAL_PROVIDERS as readonly string[]).includes(provider))
        {
            throw refusal('oauthProviders', provider, SOCIAL_PROVIDERS.map(quoted), 'has no provider');
        }

        assertKnownKeys(`oauthProviders.${provider}`, policy, PROVIDER_POLICY_KEYS);
        assertBoolean(`oauthProviders.${provider}.signIn`, (policy as Record<string, unknown>).signIn);
        assertRecentAuth(`oauthProviders.${provider}.recentAuth`, (policy as Record<string, unknown>).recentAuth);
    }
}

function assertOAuthLink(link: unknown): void
{
    if (link === undefined)
    {
        return;
    }

    assertKnownKeys('oauthLink', link, OAUTH_LINK_KEYS);
    assertRecentAuth('oauthLink.recentAuth', (link as Record<string, unknown>).recentAuth);
}

function assertRecentAuth(option: string, recentAuth: unknown): void
{
    if (recentAuth === undefined)
    {
        return;
    }

    assertKnownKeys(option, recentAuth, RECENT_AUTH_KEYS);

    for (const action of RECENT_AUTH_KEYS)
    {
        assertBoolean(`${option}.${action}`, (recentAuth as Record<string, unknown>)[action]);
    }
}

/** An object whose every key is one of `keys` — a misspelt key would otherwise be ignored. */
function assertKnownKeys(option: string, value: unknown, keys: string[]): void
{
    assertObject(option, value);

    const unknown = Object.keys(value as object).find(key => !keys.includes(key));

    if (unknown !== undefined)
    {
        throw refusal(option, unknown, keys, 'has no option');
    }
}

function assertObject(option: string, value: unknown): void
{
    if (typeof value !== 'object' || value === null || Array.isArray(value))
    {
        throw new Error(`configureAuth: ${option} must be an object, received ${describe(value)}.`);
    }
}

function assertBoolean(option: string, value: unknown): void
{
    assertOneOf(option, value, [true, false]);
}

function assertOneOf(option: string, value: unknown, allowed: unknown[]): void
{
    if (value !== undefined && !allowed.includes(value))
    {
        throw refusal(option, value, allowed.map(quoted));
    }
}

function refusal(option: string, value: unknown, allowed: string[], what = 'does not accept'): Error
{
    return new Error(`configureAuth: ${option} ${what} ${describe(value)}. Allowed: ${allowed.join(', ')}.`);
}

function quoted(value: unknown): string
{
    return typeof value === 'string' ? `'${value}'` : String(value);
}

function describe(value: unknown): string
{
    return typeof value === 'string' ? `'${value}'` : `${String(value)} (${typeof value})`;
}
