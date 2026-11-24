/**
 * @spfn/auth - The closed sets `configureAuth` accepts (au5-B2)
 *
 * Every policy value is checked when it is configured, so a value outside its
 * set — `'Reject'`, the string `'false'`, a provider name with a typo — is a
 * configuration error naming the option and the values it takes, instead of
 * quietly reading as the loosest behaviour at the first request that asks.
 *
 * Each object inside the configuration — `csrf`, `oauthProviders`, a
 * provider's policy, `oauthLink`, a `recentAuth` — is read once, by
 * `readOptions`, and the snapshot is what is checked and what `configureAuth`
 * stores (#477): never the application's object, which a request would
 * otherwise read again. `csrf.exemptPaths` is read the same way, by
 * `readList`, into a copy.
 *
 * `undefined` is always accepted: it means "not set", and tests and apps pass
 * it to put an option back to its default.
 *
 * The types of those objects are declared here, and `config.ts` re-exports
 * them, so each key list is checked against its type (`optionKeys`) without
 * this module importing `config.ts`, which imports it.
 */

import { SOCIAL_PROVIDERS } from '../types';
import { optionKeys, readList, readOptions, type OptionTerms } from '@spfn/core/options';

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
     *          `spfn init` are given `enforce`. The consent POST
     *          (`/_auth/oauth2/authorize`) is checked in every mode regardless.
     */
    mode?: CsrfMode;

    /**
     * Backend paths that skip the check, matched exactly.
     *
     * These are route paths as the backend sees them (`/webhooks/stripe`), not
     * `/api/rpc/...` URLs, with route params already substituted. Intended for
     * endpoints a browser session never calls — webhook receivers and the like.
     * A path listed here is unprotected for cookie callers too, so list only
     * endpoints that carry their own authentication. `/_auth/oauth2/authorize`
     * cannot be exempted: an entry naming it is ignored with a warning.
     */
    exemptPaths?: string[];
}

/**
 * Whether linking or unlinking a provider from a signed-in session needs a
 * recent authentication: a session key younger than the link window, or the
 * current password. The MFA step-up runs either way.
 */
export interface OAuthLinkRecentAuth
{
    /** @default true */
    link?: boolean;
    /** @default true */
    unlink?: boolean;
}

/**
 * What one social provider is allowed to do (#155, #157)
 */
export interface OAuthProviderPolicy
{
    /**
     * Whether the provider is a way to sign in.
     *
     * `false` makes it link-only: it can be linked to and unlinked from a
     * signed-in account, every sign-in start and sign-in callback for it is
     * refused with `OAuthProviderLinkOnlyError` (`reason=link_only`), it is
     * listed under `linkOnly` instead of `providers`, and a linked identity of
     * it does not count as a way into the account when another credential is
     * removed.
     *
     * @default true
     */
    signIn?: boolean;

    /** Overrides `oauthLink.recentAuth` for this provider. */
    recentAuth?: OAuthLinkRecentAuth;
}

/**
 * Settings for linking a provider to a signed-in account
 */
export interface OAuthLinkConfig
{
    /** The default for every provider; `oauthProviders[p].recentAuth` overrides it. */
    recentAuth?: OAuthLinkRecentAuth;

    /**
     * How young the session key must be for a link or unlink to go through
     * without the current password, in minutes.
     *
     * @default `SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES` when set (the window
     *          0.3.0-beta.49 used), else 10
     */
    recentAuthMinutes?: number;
}

const OAUTH_EMAIL_MATCHES = ['attach', 'reject', 'separate'];
const CSRF_MODES = ['off', 'warn', 'enforce'];
const CSRF_KEYS = optionKeys<AuthCsrfConfig>({ mode: true, exemptPaths: true });
const PROVIDER_POLICY_KEYS = optionKeys<OAuthProviderPolicy>({ signIn: true, recentAuth: true });
const RECENT_AUTH_KEYS = optionKeys<OAuthLinkRecentAuth>({ link: true, unlink: true });
const OAUTH_LINK_KEYS = optionKeys<OAuthLinkConfig>({ recentAuth: true, recentAuthMinutes: true });

/** `oauthProviders` is keyed by the providers this package knows, each giving its policy. */
const PROVIDER_TERMS: OptionTerms = { noun: 'a provider', plural: 'providers', giving: 'giving each provider its policy' };

type Options = Partial<Record<string, unknown>>;

/** The parts of an `AuthConfig` whose values come from a closed set. */
interface PolicyValues
{
    oauthEmailMatch?: unknown;
    csrf?: unknown;
    oauthProviders?: unknown;
    oauthLink?: unknown;
}

/** The reader of each object an `AuthConfig` holds. */
const NESTED_READERS: Readonly<Record<string, (value: unknown) => Options>> = {
    csrf: readCsrf,
    oauthProviders: readProviderPolicies,
    oauthLink: readOAuthLink,
};

/**
 * `config` — the snapshot `configureAuth` read — with each object it holds
 * replaced by that object's own snapshot, once every policy value in them is
 * checked.
 *
 * @throws Error naming the option and the values it accepts, an object that is
 *   not a plain object, or a name in one that is not an option
 */
export function readPolicyValues<T extends PolicyValues>(config: T): T
{
    assertOneOf('oauthEmailMatch', config.oauthEmailMatch, OAUTH_EMAIL_MATCHES);

    return Object.fromEntries(Object.entries(config).map(([key, value]) =>
        [key, value === undefined || !Object.hasOwn(NESTED_READERS, key) ? value : NESTED_READERS[key](value)])) as T;
}

/** `csrf.mode`, read case-insensitively as `getCsrfMode` reads it, and `exemptPaths` copied. */
function readCsrf(csrf: unknown): Options
{
    const read = readOptions<Options>('configureAuth: csrf', csrf, CSRF_KEYS);
    const normalized = typeof read.mode === 'string' ? read.mode.trim().toLowerCase() : read.mode;

    if (normalized !== undefined && !CSRF_MODES.includes(normalized as string))
    {
        throw refusal('csrf.mode', read.mode, CSRF_MODES.map(quoted));
    }

    return {
        ...read,
        ...(read.exemptPaths !== undefined && {
            exemptPaths: readList<string>('configureAuth: csrf.exemptPaths', read.exemptPaths, 'of backend route paths'),
        }),
    };
}

function readProviderPolicies(policies: unknown): Options
{
    const read = readOptions<Options>('configureAuth: oauthProviders', policies, SOCIAL_PROVIDERS, PROVIDER_TERMS);

    return Object.fromEntries(Object.entries(read).map(([provider, policy]) =>
        [provider, policy === undefined ? policy : readProviderPolicy(provider, policy)]));
}

function readProviderPolicy(provider: string, policy: unknown): Options
{
    const read = readOptions<Options>(`configureAuth: oauthProviders.${provider}`, policy, PROVIDER_POLICY_KEYS);

    assertBoolean(`oauthProviders.${provider}.signIn`, read.signIn);

    return { ...read, ...readRecentAuth(`oauthProviders.${provider}.recentAuth`, read) };
}

function readOAuthLink(link: unknown): Options
{
    const read = readOptions<Options>('configureAuth: oauthLink', link, OAUTH_LINK_KEYS);

    return { ...read, ...readRecentAuth('oauthLink.recentAuth', read) };
}

/** `{ recentAuth }` read from its own object, or nothing when `holder` does not state it. */
function readRecentAuth(option: string, holder: Options): Options
{
    if (holder.recentAuth === undefined)
    {
        return {};
    }

    const read = readOptions<Options>(`configureAuth: ${option}`, holder.recentAuth, RECENT_AUTH_KEYS);

    for (const action of RECENT_AUTH_KEYS)
    {
        assertBoolean(`${option}.${action}`, read[action]);
    }

    return { recentAuth: read };
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

function refusal(option: string, value: unknown, allowed: string[]): Error
{
    return new Error(`configureAuth: ${option} does not accept ${describe(value)}. Allowed: ${allowed.join(', ')}.`);
}

function quoted(value: unknown): string
{
    return typeof value === 'string' ? `'${value}'` : String(value);
}

function describe(value: unknown): string
{
    return typeof value === 'string' ? `'${value}'` : `${String(value)} (${typeof value})`;
}
