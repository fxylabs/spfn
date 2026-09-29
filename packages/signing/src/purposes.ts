/**
 * Purposes: the kinds of token an application issues, each with its own keys
 * and its own audience.
 *
 * ```ts
 * const purposes = definePurposes({
 *     api: { kidPrefix: 'api', audience: 'https://issuer.example/api', maxTtlSec: 300 },
 *     webhook: { kidPrefix: 'whk', audience: 'https://issuer.example/webhook', maxTtlSec: 60 },
 * });
 *
 * const loaded = await purposes.load({ api: apiKeyConfig, webhook: webhookKeyConfig });
 * const token = await loaded.signer('api').sign({ sub: userId });
 * const verify = loaded.verifier('api');
 * ```
 *
 * No storage, no HTTP. Which kid signs, and which kids are retired, is the
 * caller's to remember and to pass in; this module only refuses a
 * configuration that would let one purpose's token pass another's verifier.
 */

import type { JsonWebKey, KeyObject } from 'node:crypto';
import { createSigner, type SignerConfig } from './create-signer';
import { decodeBase64Url, timeClaims } from './jws';
import { formatPublicKeys, isKid, toJwks } from './keys';
import type { AwsKmsClient } from './providers/aws-kms';
import type { GcpKmsClient } from './providers/gcp-kms';
import { privateKeyFromBytes } from './providers/local';
import { assertPurposeKids, assertPurposeSpec, purposeAudience } from './purpose-spec';
import type {
    JwsPayload,
    ProviderName,
    PublicKeyEntry,
    PurposeSpec,
    Signer,
    SigningAlgorithm,
    VerifyResult,
} from './types';
import { purposeVerifier } from './verify';

/** One line of a purpose's key configuration: `kid:alg:provider:ref`. */
export interface KeyConfigEntry
{
    kid: string;
    alg: SigningAlgorithm;
    provider: ProviderName;
    /**
     * `local`: base64url of a 32-byte key or PKCS#8 DER. `gcp-kms`: the key
     * version name. `aws-kms`: the key id, alias or ARN — everything after
     * the third colon, so an ARN's own colons are kept.
     */
    ref: string;
}

/** Clients for the KMS providers, for every key that names one. */
export interface ProviderOptions
{
    gcpKms?: { client?: GcpKmsClient };
    awsKms?: { client?: AwsKmsClient; region?: string };
}

export interface PurposeSignOptions
{
    /** Seconds until `exp`. Default, and ceiling: the purpose's `maxTtlSec`. */
    ttlSec?: number;
    /** Required for a scoped purpose, refused for any other. */
    scope?: string;
    /** Epoch milliseconds to compute `iat` and `exp` from. Default: now. */
    now?: number;
}

/**
 * A signer bound to one purpose. It writes `aud`, `iat` and `exp` itself and
 * refuses claims that carry any of them, so a token cannot leave with an
 * audience or a lifetime its purpose does not allow.
 */
export interface PurposeSigner
{
    readonly kid: string;
    readonly alg: SigningAlgorithm;
    sign(claims: JwsPayload, options?: PurposeSignOptions): Promise<string>;
}

/** Kids to leave out — retired keys. Remembering which ones is the caller's. */
export interface ExcludeOptions
{
    exclude?: readonly string[];
}

export interface LoadedPurposes<N extends string>
{
    /** The signer for `kid`, or for the purpose's first configured key. */
    signer(name: N, options?: { kid?: string }): PurposeSigner;
    /** The purpose's public keys as `kid:key,…`. */
    publicKeys(name: N, options?: ExcludeOptions): string;
    /** The purpose's public keys as a JWK Set. */
    jwks(name: N, options?: ExcludeOptions): { keys: JsonWebKey[] };
    /** `purposeVerifier()` over the purpose's own keys. */
    verifier(
        name: N,
        options?: ExcludeOptions & { scope?: string; clockSkewSec?: number },
    ): (token: unknown, now?: number) => VerifyResult;
}

export interface PurposeRegistry<N extends string>
{
    readonly names: readonly N[];
    spec(name: N): Readonly<PurposeSpec>;
    /**
     * Parse `kid:alg:provider:ref` entries, separated by commas or newlines.
     * Throws on an entry without four fields, a kid without the purpose's
     * prefix, more keys than `maxKeys`, a duplicate kid, or an unknown `alg`
     * or provider. No message quotes an entry: it may hold key material.
     */
    parseKeyConfig(name: N, text: string): KeyConfigEntry[];
    /**
     * Build a signer for every configured key. Throws on any `parseKeyConfig`
     * error, on a KMS key whose algorithm is not the configured one, and when
     * one public key appears twice — in two purposes, or twice in one.
     */
    load(
        config: Record<N, string>,
        options?: { providers?: ProviderOptions },
    ): Promise<LoadedPurposes<N>>;
}

interface LoadedKey
{
    signer: Signer;
    entry: PublicKeyEntry;
}

const ALGORITHMS: readonly string[] = ['EdDSA', 'ES256'];

const PROVIDERS: readonly string[] = ['local', 'gcp-kms', 'aws-kms'];

const CLAIMS_THE_SIGNER_OWNS = ['aud', 'iat', 'exp'];

function registryError(problem: string): Error
{
    return new Error(`definePurposes: ${problem}`);
}

/** Whether a token of `a` could carry an `aud` that `b`'s verifier accepts. */
function audiencesOverlap(a: PurposeSpec, b: PurposeSpec): boolean
{
    return a.audience === b.audience || (a.scoped === true && b.audience.startsWith(`${a.audience}:`));
}

/** Refuse two purposes a token could pass between: one kid prefix, or one audience. */
function assertSeparate(specs: Record<string, PurposeSpec>): void
{
    const names = Object.keys(specs);

    for (const [index, first] of names.entries())
    {
        for (const second of names.slice(index + 1))
        {
            const [a, b] = [specs[first], specs[second]];

            if (a.kidPrefix === b.kidPrefix || audiencesOverlap(a, b) || audiencesOverlap(b, a))
            {
                throw registryError(`purposes ${first} and ${second} share a kidPrefix or an audience`);
            }
        }
    }
}

function parseKeyEntry(name: string, text: string, position: number): KeyConfigEntry
{
    const [kid, alg, provider, ...rest] = text.split(':');
    const ref = rest.join(':');
    const where = `purpose ${name}, key entry ${position}`;

    if (ref === '' || !isKid(kid))
    {
        throw registryError(`${where}: expected kid:alg:provider:ref with a kid of [A-Za-z0-9._-]`);
    }

    if (!ALGORITHMS.includes(alg) || !PROVIDERS.includes(provider))
    {
        throw registryError(`${where}: alg must be EdDSA or ES256, provider local, gcp-kms or aws-kms`);
    }

    return { kid, alg: alg as SigningAlgorithm, provider: provider as ProviderName, ref };
}

function parseKeyConfig(name: string, spec: PurposeSpec, text: unknown): KeyConfigEntry[]
{
    if (typeof text !== 'string')
    {
        throw registryError(`purpose ${name}: the key configuration is not a string`);
    }

    const entries = text.split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry, index) => parseKeyEntry(name, entry, index + 1));
    const kids = entries.map((entry) => entry.kid);

    if (entries.length === 0 || new Set(kids).size !== kids.length)
    {
        throw registryError(`purpose ${name}: no key configured, or one kid configured twice`);
    }

    assertPurposeKids(name, spec, kids);

    return entries;
}

/** A `local` key from its ref. Errors name the purpose and kid, never the material. */
function localPrivateKey(name: string, entry: KeyConfigEntry): KeyObject
{
    const bytes = decodeBase64Url(entry.ref);

    if (!bytes)
    {
        throw registryError(`purpose ${name}, key ${entry.kid}: the local key is not base64url`);
    }

    return privateKeyFromBytes(bytes, entry.alg, `purpose ${name}, key ${entry.kid}`);
}

function signerConfig(name: string, entry: KeyConfigEntry, providers: ProviderOptions): SignerConfig
{
    const { kid, alg, ref } = entry;

    if (entry.provider === 'local')
    {
        return { provider: 'local', kid, alg, privateKey: localPrivateKey(name, entry) };
    }

    if (entry.provider === 'gcp-kms')
    {
        return { provider: 'gcp-kms', kid, keyVersionName: ref, client: providers.gcpKms?.client };
    }

    return { provider: 'aws-kms', kid, alg, keyId: ref, ...providers.awsKms };
}

async function loadKey(
    name: string,
    entry: KeyConfigEntry,
    providers: ProviderOptions,
): Promise<LoadedKey>
{
    const signer = await createSigner(signerConfig(name, entry, providers));

    // Cloud KMS takes the algorithm from the key, not from the configuration.
    if (signer.alg !== entry.alg)
    {
        throw registryError(
            `purpose ${name}, key ${entry.kid}: the key is ${signer.alg}, configured as ${entry.alg}`,
        );
    }

    return { signer, entry: await signer.publicKey() };
}

/**
 * Refuse a public key that appears twice.
 *
 * Two purposes on one key are one purpose with two audiences — the only thing
 * left keeping their tokens apart is `aud`, and a verifier configured by hand
 * without it would accept both.
 */
function assertKeysUnshared(keys: ReadonlyMap<string, LoadedKey[]>): void
{
    const owners = new Map<string, string>();

    for (const [name, loaded] of keys)
    {
        for (const { entry } of loaded)
        {
            const spki = entry.public.export({ format: 'der', type: 'spki' }).toString('base64');
            const owner = `${name}/${entry.kid}`;

            if (owners.has(spki))
            {
                throw registryError(`${owner} has the same public key as ${owners.get(spki)}`);
            }

            owners.set(spki, owner);
        }
    }
}

/** The claims a purpose's token carries: the caller's, then `aud`, `iat` and `exp`. */
function purposeClaims(
    name: string,
    spec: PurposeSpec,
    claims: JwsPayload,
    options: PurposeSignOptions,
): JwsPayload
{
    const ttlSec = options.ttlSec ?? spec.maxTtlSec;
    const owned = CLAIMS_THE_SIGNER_OWNS.filter((claim) => claim in claims);

    if (!Number.isInteger(ttlSec) || ttlSec <= 0 || ttlSec > spec.maxTtlSec)
    {
        throw registryError(`purpose ${name}: ttlSec must be a whole number, 1 to ${spec.maxTtlSec}`);
    }

    if (owned.length > 0)
    {
        throw registryError(`purpose ${name}: the signer writes ${owned.join(', ')}; do not pass them`);
    }

    return {
        ...claims,
        aud: purposeAudience(name, spec, options.scope),
        ...timeClaims({ ttlSec, now: options.now }),
    };
}

function purposeSigner(name: string, spec: PurposeSpec, signer: Signer): PurposeSigner
{
    return {
        kid: signer.kid,
        alg: signer.alg,
        sign: async (claims, options = {}) => signer.sign(
            purposeClaims(name, spec, claims, options),
            spec.typ === undefined ? undefined : { typ: spec.typ },
        ),
    };
}

/** The keys loaded for `name`, which a JavaScript caller may have misspelled. */
function purposeKeys<N extends string>(keys: ReadonlyMap<N, LoadedKey[]>, name: N): LoadedKey[]
{
    const loaded = keys.get(name);

    if (!loaded)
    {
        throw registryError(`unknown purpose ${name}`);
    }

    return loaded;
}

/** A purpose's public entries without the excluded kids; never none. */
function keptEntries(
    name: string,
    loaded: LoadedKey[],
    exclude: readonly string[] = [],
): PublicKeyEntry[]
{
    const kept = loaded.map((key) => key.entry).filter((entry) => !exclude.includes(entry.kid));

    if (kept.length === 0)
    {
        throw registryError(`purpose ${name}: every key is excluded`);
    }

    return kept;
}

/** The signer for `kid`, or the purpose's first configured key. */
function chosenSigner(name: string, loaded: LoadedKey[], kid: string | undefined): Signer
{
    const chosen = kid === undefined ? loaded[0] : loaded.find((key) => key.signer.kid === kid);

    if (!chosen)
    {
        throw registryError(`purpose ${name} has no key ${kid}`);
    }

    return chosen.signer;
}

function loadedPurposes<N extends string>(
    specs: Record<N, Readonly<PurposeSpec>>,
    keys: ReadonlyMap<N, LoadedKey[]>,
): LoadedPurposes<N>
{
    const kept = (name: N, exclude?: readonly string[]): PublicKeyEntry[] =>
        keptEntries(name, purposeKeys(keys, name), exclude);

    return {
        signer: (name, options = {}) =>
            purposeSigner(name, specs[name], chosenSigner(name, purposeKeys(keys, name), options.kid)),
        publicKeys: (name, options = {}) => formatPublicKeys(kept(name, options.exclude)),
        jwks: (name, options = {}) => toJwks(kept(name, options.exclude)),
        verifier: (name, options = {}) =>
            purposeVerifier(specs[name], kept(name, options.exclude), options),
    };
}

async function load<N extends string>(
    specs: Record<N, Readonly<PurposeSpec>>,
    config: Record<N, string>,
    providers: ProviderOptions,
): Promise<LoadedPurposes<N>>
{
    const names = Object.keys(specs) as N[];
    const unknown = Object.keys(config).filter((name) => !(names as string[]).includes(name));
    const keys = new Map<N, LoadedKey[]>();

    if (unknown.length > 0)
    {
        throw registryError(`configuration for unknown purposes: ${unknown.join(', ')}`);
    }

    // Every configuration is read before any KMS is asked for anything.
    const configured = names.map((name) => parseKeyConfig(name, specs[name], config[name]));

    for (const [index, name] of names.entries())
    {
        keys.set(name, await Promise.all(configured[index].map((entry) => loadKey(name, entry, providers))));
    }

    assertKeysUnshared(keys);

    return loadedPurposes(specs, keys);
}

/**
 * Declare the purposes an application signs for.
 *
 * Throws on a spec that breaks the rules of `PurposeSpec`, and on two
 * purposes that share a kid prefix or an audience — including an audience a
 * scoped purpose would produce with some scope.
 */
export function definePurposes<const P extends Record<string, PurposeSpec>>(
    specs: P,
): PurposeRegistry<keyof P & string>
{
    type N = keyof P & string;

    const names = Object.keys(specs) as N[];

    if (names.length === 0)
    {
        throw registryError('no purposes given');
    }

    names.forEach((name) => assertPurposeSpec(name, specs[name]));
    assertSeparate(specs);

    const frozen = Object.fromEntries(
        names.map((name) => [name, Object.freeze({ ...specs[name] })]),
    ) as unknown as Record<N, Readonly<PurposeSpec>>;
    const specOf = (name: N): Readonly<PurposeSpec> =>
    {
        if (!Object.hasOwn(frozen, name))
        {
            throw registryError(`unknown purpose ${String(name)}`);
        }

        return frozen[name];
    };

    return {
        names: Object.freeze([...names]),
        spec: specOf,
        parseKeyConfig: (name, text) => parseKeyConfig(name, specOf(name), text),
        load: (config, options = {}) => load(frozen, config, options.providers ?? {}),
    };
}
