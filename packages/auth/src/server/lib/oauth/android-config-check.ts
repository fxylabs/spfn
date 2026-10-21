/**
 * @spfn/auth - Boot-time check of the Sign in with Apple on Android configuration
 *
 * Two independent checks, in the voice of `assertOAuthRedirectUris`: each runs
 * once at boot and refuses with one error naming every offending variable, so
 * the operator fixes them all in one restart. A deployment that sets none of the
 * variables a check reads is not examined and boots exactly as before.
 *
 * - `assertAppleRelayUrls`: every `SPFN_AUTH_APPLE_RELAY_URLS` entry is an
 *   absolute https URL with no userinfo, query or fragment, and the Apple web
 *   flow it rides on is configured. A non-https target would let a malicious app
 *   on the victim's device receive the token of a flow an attacker started, and
 *   the relay appends its own query to the configured URL.
 * - `assertAndroidAssetLinks`: `SPFN_AUTH_ANDROID_PACKAGE_NAME` and
 *   `SPFN_AUTH_ANDROID_CERT_SHA256` are set together and well formed, because the
 *   `assetlinks.json` built from them is what Android verifies the App Link by.
 */

type EnvSource = Record<string, string | undefined>;

const RELAY_URLS_VAR = 'SPFN_AUTH_APPLE_RELAY_URLS';
const PACKAGE_NAME_VAR = 'SPFN_AUTH_ANDROID_PACKAGE_NAME';
const CERT_SHA256_VAR = 'SPFN_AUTH_ANDROID_CERT_SHA256';

const APPLE_WEB_ID_VARS = ['SPFN_AUTH_APPLE_SERVICES_ID', 'SPFN_AUTH_APPLE_TEAM_ID', 'SPFN_AUTH_APPLE_KEY_ID'] as const;

/** An applicationId: two or more dot-separated segments, each starting with a letter. */
const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** A SHA-256 certificate fingerprint as keytool and Play Console print it: 32 hex pairs. */
const CERT_SHA256_PATTERN = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/;

/** The comma-separated entries of a list variable, trimmed, empty ones dropped. */
export function listEntries(value: string | undefined): string[]
{
    return (value || '').split(',').map(entry => entry.trim()).filter(Boolean);
}

/** What is wrong with one relay URL, or null when it conforms. */
function relayUrlProblem(value: string): string | null
{
    let url: URL;

    try
    {
        url = new URL(value);
    }
    catch
    {
        return 'is not an absolute URL';
    }

    if (url.protocol !== 'https:')
    {
        return 'is a non-https URL; the relay carries an id_token and goes to an https App Link only';
    }

    if (url.username !== '' || url.password !== '')
    {
        return 'carries userinfo';
    }

    if (url.search !== '' || url.hash !== '')
    {
        return 'carries a query string or fragment; the relay appends its own query';
    }

    return null;
}

/** The Apple web flow is configured the way `appleProvider.isEnabled` reads it. */
function appleWebFlowConfigured(env: EnvSource): boolean
{
    return APPLE_WEB_ID_VARS.every(variable => env[variable])
        && !!env.SPFN_AUTH_APPLE_PRIVATE_KEY !== !!env.SPFN_AUTH_APPLE_PRIVATE_KEY_FILE;
}

/**
 * Refuse boot on a relay URL that is not an https App Link, or on relay URLs
 * without the Apple web flow they ride on.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws When `SPFN_AUTH_APPLE_RELAY_URLS` is set and does not conform. One error names every problem.
 */
export function assertAppleRelayUrls(env: EnvSource = process.env): void
{
    const entries = listEntries(env[RELAY_URLS_VAR]);

    if (entries.length === 0)
    {
        return;
    }

    const refusals = entries
        .map(entry => ({ entry, problem: relayUrlProblem(entry) }))
        .filter((checked): checked is { entry: string; problem: string } => checked.problem !== null)
        .map(({ entry, problem }) => `${RELAY_URLS_VAR}: "${entry}" ${problem}.`);

    if (!appleWebFlowConfigured(env))
    {
        refusals.push(
            `${RELAY_URLS_VAR} is set but the Apple web flow it relays from is not configured: set `
            + `${APPLE_WEB_ID_VARS.join(', ')} and one of SPFN_AUTH_APPLE_PRIVATE_KEY / `
            + 'SPFN_AUTH_APPLE_PRIVATE_KEY_FILE, or unset it.',
        );
    }

    if (refusals.length > 0)
    {
        throw new Error(refusals.join('\n'));
    }
}

/** The refusals for a package name and fingerprint list that are both set. */
function assetLinksRefusals(packageName: string, fingerprints: string[]): string[]
{
    const refusals = PACKAGE_NAME_PATTERN.test(packageName)
        ? []
        : [`${PACKAGE_NAME_VAR} is not an Android package name (the app's applicationId, e.g. com.example.app).`];

    for (const fingerprint of fingerprints.filter(entry => !CERT_SHA256_PATTERN.test(entry)))
    {
        refusals.push(
            `${CERT_SHA256_VAR}: "${fingerprint}" is not a SHA-256 fingerprint (32 colon-separated hex pairs, AA:BB:…).`,
        );
    }

    return refusals;
}

/**
 * Refuse boot on a partial or malformed `assetlinks.json` configuration.
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @throws When either variable is set and the pair does not conform. One error names every problem.
 */
export function assertAndroidAssetLinks(env: EnvSource = process.env): void
{
    const packageName = (env[PACKAGE_NAME_VAR] || '').trim();
    const fingerprints = listEntries(env[CERT_SHA256_VAR]);

    if (!packageName && fingerprints.length === 0)
    {
        return;
    }

    const refusals = !packageName || fingerprints.length === 0
        ? [`Set both ${PACKAGE_NAME_VAR} and ${CERT_SHA256_VAR}, or neither: /.well-known/assetlinks.json needs the package name and its certificate fingerprints.`]
        : assetLinksRefusals(packageName, fingerprints);

    if (refusals.length > 0)
    {
        throw new Error(refusals.join('\n'));
    }
}
