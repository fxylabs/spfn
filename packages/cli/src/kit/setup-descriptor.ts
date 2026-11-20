/**
 * The first thing `spfn kit install` does, and the only place a setup URL is
 * turned into something the CLI will act on.
 *
 * Unit 06 section 3.1: the setup link is a public locator, not a secret. That
 * cuts both ways — because it is public it may be shared, and because it is
 * public it must carry nothing else, so a URL with a query or a fragment is
 * refused before a single byte is fetched. The origin is an exact allowlist:
 * a valid signature on a descriptor served from somewhere else does not make
 * that somewhere else an official setup origin.
 *
 * Order matters here, and it is the order below: allowlist, fetch, signature,
 * schema, self-consistency, freshness, payload digest, CLI compatibility. Each
 * step may only trust what the steps above it have already established.
 */

import { KitError } from './errors.js';
import { digestOfJson } from './digest.js';
import { validateSetupDescriptorEnvelope } from './validate.js';
import { verifySignedDocument, type TrustedKey } from './signature.js';
import { atLeast } from './version.js';

/** V1 official setup origins. An exact list, not a suffix match. */
export const SETUP_ORIGIN_ALLOWLIST = ['https://start.superfunction.xyz'] as const;

export const SETUP_PATH_PREFIX = '/setup/';

/**
 * Where a certification or local run says its setup origin is.
 *
 * The allowlist is a trust decision, so it ships built in — the same reasoning
 * as the signing keys. But a control plane running on someone's own machine is
 * a legitimate origin no shipped list can name, and a certification run cannot
 * certify a service it is not allowed to talk to. So this variable exists, and
 * it *replaces* the built-in list rather than adding to it: a stray variable
 * can only ever narrow what this CLI will fetch a descriptor from, down to
 * origins the person running it chose.
 *
 * The format is a comma-separated list of origins — scheme, host, optional
 * port, nothing else. A path, a query, a fragment or userinfo makes the whole
 * variable invalid rather than being trimmed away, because an origin list that
 * silently dropped half an entry is a list nobody actually wrote.
 */
export const SETUP_ALLOWLIST_ENV = 'SPFN_KIT_SETUP_ALLOWLIST';

/**
 * The only hosts this CLI will fetch a setup descriptor from over plain http,
 * and then only when the variable above names them.
 *
 * Loopback and nothing else. An unencrypted fetch is readable and rewritable by
 * anything sitting between the two machines; between two processes on one
 * machine there is nothing to sit between them. Both names are matched
 * literally rather than by prefix or suffix, so `127.0.0.1.evil.example` — a
 * name that resolves wherever its owner likes — is not one of them.
 */
export const LOOPBACK_HTTP_HOSTS = ['localhost', '127.0.0.1'] as const;

/**
 * The origins this run may fetch a setup descriptor from.
 *
 * A malformed variable is refused outright rather than partly honoured: the
 * alternative is a run that quietly allowlists whatever survived parsing.
 */
export function resolveSetupAllowlist(env: NodeJS.ProcessEnv = process.env): readonly string[]
{
    const raw = env[SETUP_ALLOWLIST_ENV];

    if (typeof raw !== 'string' || raw.trim().length === 0)
    {
        return SETUP_ORIGIN_ALLOWLIST;
    }

    const entries = raw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0);
    const refuse = (reason: string, entry: string): never =>
    {
        throw new KitError('KIT_SETUP_URL_INVALID', `${SETUP_ALLOWLIST_ENV} is not a list of setup origins.`, {
            evidence: { reason, entry, variable: SETUP_ALLOWLIST_ENV },
        });
    };

    if (entries.length === 0)
    {
        refuse('empty-list', '');
    }

    // The list is returned as `URL.origin` spellings, because that is what a
    // setup link is compared against. Returning what the variable said would
    // make `https://host/` and `https://host` two different allowlists.
    const origins: string[] = [];

    for (const entry of entries)
    {
        let url: URL;

        try
        {
            url = new URL(entry);
        }
        catch
        {
            refuse('unparseable-origin', entry);

            continue;
        }

        if (url.protocol !== 'https:' && url.protocol !== 'http:')
        {
            refuse('unsupported-scheme', entry);
        }
        if (url.username !== '' || url.password !== '')
        {
            refuse('has-userinfo', entry);
        }
        if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== ''))
        {
            refuse('not-a-bare-origin', entry);
        }
        if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
        {
            refuse('plain-http-off-loopback', entry);
        }

        origins.push(url.origin);
    }

    return origins;
}

/** Exactly one of the two loopback names. Never a prefix or a suffix match. */
export function isLoopbackHost(hostname: string): boolean
{
    return (LOOPBACK_HTTP_HOSTS as readonly string[]).includes(hostname);
}

/** Redirects are followed only inside the allowlist, and only this far. */
export const MAX_SETUP_REDIRECTS = 3;

export interface SetupDescriptorV1
{
    schemaVersion: 1;
    descriptorId: string;
    productId: string;
    productKind: 'kit';
    issuedAt: string;
    expiresAt: string;
    setupUrl: string;
    displayName: string;
    supportUrl: string;
    cli: {
        package: 'spfn';
        recommendedVersion: string;
        minimumVersion: string;
    };
    catalogUrl: string;
    manifestUrl: string;
    payloadKind: string;
    payloadDigest: string;
    /** Opaque to the CLI. Verified by digest, never read for meaning. */
    payload: Record<string, unknown>;
}

/**
 * Refuse a setup URL that is not an official public locator.
 *
 * A query or a fragment is refused for a reason worth spelling out: a license
 * key pasted into a link would otherwise reach process arguments, shell
 * history and any log that records the command line.
 */
export function assertAllowedSetupUrl(raw: string, allowlist: readonly string[] = resolveSetupAllowlist()): URL
{
    let url: URL;

    try
    {
        url = new URL(raw);
    }
    catch
    {
        throw new KitError('KIT_SETUP_URL_INVALID', 'The setup link is not a URL.', {
            evidence: { reason: 'unparseable' },
        });
    }

    const fail = (reason: string, summary: string): never =>
    {
        throw new KitError('KIT_SETUP_URL_INVALID', summary, {
            evidence: { reason, origin: url.origin },
        });
    };
    /**
     * http is relaxed only for an origin that is *both* loopback and on the
     * allowlist, and the two conditions are checked together for a reason: an
     * `http://127.0.0.1` link nobody allowlisted must still fail as `not-https`
     * exactly as it did before, or a default run would start reporting a
     * different refusal for the same URL.
     */
    const onAllowlist = allowlist.includes(url.origin);

    if (url.protocol !== 'https:' && !(onAllowlist && url.protocol === 'http:' && isLoopbackHost(url.hostname)))
    {
        fail('not-https', 'A setup link must be https.');
    }
    if (url.username !== '' || url.password !== '')
    {
        fail('has-userinfo', 'A setup link must not carry credentials.');
    }
    if (url.search !== '' || url.hash !== '')
    {
        fail('has-query-or-fragment', 'A setup link is a public locator and must carry no query or fragment.');
    }
    if (!onAllowlist)
    {
        fail('origin-not-allowlisted', 'That setup origin is not an official Superfunction setup origin.');
    }
    if (!url.pathname.startsWith(SETUP_PATH_PREFIX) || url.pathname.length <= SETUP_PATH_PREFIX.length)
    {
        fail('path-not-allowlisted', `A setup link path must start with ${SETUP_PATH_PREFIX}.`);
    }

    return url;
}

/** Fetches one URL and returns the parsed JSON body, or the redirect target. */
export interface SetupFetchResult
{
    /** Set when the origin answered with a redirect. */
    redirectTo?: string;
    body?: unknown;
}

export type SetupFetcher = (url: string) => Promise<SetupFetchResult>;

export interface ResolveSetupDescriptorOptions
{
    setupUrl: string;
    fetcher: SetupFetcher;
    trustedKeys: readonly TrustedKey[];
    /** The running public CLI version. */
    cliVersion: string;
    /** ISO instant used for the expiry check. */
    now: string;
    allowlist?: readonly string[];
}

export interface ResolvedSetupDescriptor
{
    descriptor: SetupDescriptorV1;
    signatureKeyId: string;
    /** The URL the descriptor was finally read from, after any redirect. */
    resolvedFrom: string;
}

export async function resolveSetupDescriptor(
    options: ResolveSetupDescriptorOptions,
): Promise<ResolvedSetupDescriptor>
{
    const allowlist = options.allowlist ?? resolveSetupAllowlist();
    const requested = assertAllowedSetupUrl(options.setupUrl, allowlist);
    const { body, resolvedFrom } = await fetchThroughRedirects(requested, options.fetcher, allowlist);
    const checked = verifySignedDocument(body, options.trustedKeys);

    if (!checked.ok)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The setup descriptor is not signed by a trusted key.', {
            evidence: { reason: checked.reason ?? 'signature-invalid', keyId: checked.keyId ?? null },
        });
    }

    const validation = validateSetupDescriptorEnvelope(checked.document);

    if (!validation.valid)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The setup descriptor does not match the frozen envelope.', {
            evidence: {
                pointer: validation.issues[0].pointer || '/',
                problem: validation.issues[0].message,
                issues: validation.issues.length,
            },
        });
    }

    const descriptor = checked.document as SetupDescriptorV1;

    // A descriptor that names a different locator than the one it was served
    // from would let one allowlisted path speak for another.
    if (descriptor.setupUrl !== requested.toString())
    {
        throw new KitError('KIT_SETUP_URL_INVALID', 'The descriptor names a different setup link than the one requested.', {
            evidence: { requested: requested.toString(), declared: descriptor.setupUrl },
        });
    }
    if (descriptor.expiresAt <= options.now)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The setup descriptor has expired.', {
            evidence: { expiresAt: descriptor.expiresAt, now: options.now },
        });
    }

    const payloadDigest = digestOfJson(descriptor.payload);

    if (payloadDigest !== descriptor.payloadDigest)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The setup payload does not match its declared digest.', {
            evidence: { declared: descriptor.payloadDigest, actual: payloadDigest },
        });
    }

    assertCliCompatible(descriptor, options.cliVersion);

    return { descriptor, signatureKeyId: checked.keyId as string, resolvedFrom };
}

/** Refuse to install with a CLI older than the release was built against. */
export function assertCliCompatible(descriptor: SetupDescriptorV1, cliVersion: string): void
{
    let compatible: boolean;

    try
    {
        compatible = atLeast(cliVersion, descriptor.cli.minimumVersion);
    }
    catch
    {
        compatible = false;
    }

    if (!compatible)
    {
        throw new KitError('KIT_CLI_INCOMPATIBLE', 'This spfn CLI is older than the Kit requires.', {
            evidence: {
                running: cliVersion,
                minimum: descriptor.cli.minimumVersion,
                recommended: descriptor.cli.recommendedVersion,
            },
            next: {
                command: `pnpm dlx spfn@${descriptor.cli.recommendedVersion} kit install ${descriptor.setupUrl}`,
                requiresHumanApproval: false,
            },
        });
    }
}

async function fetchThroughRedirects(
    start: URL,
    fetcher: SetupFetcher,
    allowlist: readonly string[],
): Promise<{ body: unknown; resolvedFrom: string }>
{
    let current = start;

    for (let hop = 0; hop <= MAX_SETUP_REDIRECTS; hop += 1)
    {
        const result = await fetcher(current.toString());

        if (result.redirectTo === undefined)
        {
            return { body: result.body, resolvedFrom: current.toString() };
        }

        // Every hop is re-checked. A redirect is an instruction from the
        // network, and the network is not on the trusted side of this call.
        current = assertAllowedSetupUrl(new URL(result.redirectTo, current).toString(), allowlist);
    }

    throw new KitError('KIT_SETUP_URL_INVALID', 'The setup link redirected too many times.', {
        evidence: { maxRedirects: MAX_SETUP_REDIRECTS },
    });
}
