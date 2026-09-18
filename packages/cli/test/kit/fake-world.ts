/**
 * A whole Kit world in memory: control plane, registry, package manager,
 * database, Git and the product's own tooling.
 *
 * Unit 06 section 10 asks for exactly this before anything real is touched —
 * every row of the case tables provable against fakes, on a temporary
 * directory, with no network, no keychain and no license service involved. The
 * knobs on `faults` are the failure injection those rows need.
 *
 * Nothing here is shipped. It lives beside the tests because a fake control
 * plane inside the published CLI would be a liability, not a feature.
 */

import { generateKeyPairSync, sign as signBytes, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson, sha256Digest } from '../../src/kit/digest.js';
import { MemoryKitCredentialStore } from '../../src/kit/credentials.js';
import type { KitAdapters, KitCatalogRelease } from '../../src/kit/ports.js';
import type { KitGate } from '../../src/kit/manifest.js';
import type { SetupFetchResult } from '../../src/kit/setup-descriptor.js';
import type { KitMutationPlan, KitToolingV1 } from '../../src/kit/tooling.js';

export const FAKE_SETUP_ORIGIN = 'https://start.superfunction.xyz';
export const FAKE_SETUP_URL = `${FAKE_SETUP_ORIGIN}/setup/landing-kit`;
/** Where the release documents and artifacts of the fake world live. */
export const FAKE_RELEASE_STORE_URL = 'https://packages.superfunction.xyz/kits/landing-kit';
export const FAKE_CATALOG_URL = `${FAKE_RELEASE_STORE_URL}/catalog`;
export const FAKE_LICENSE_KEY = 'spfnl_fixture_key_0001';
export const FAKE_CLI_VERSION = '0.3.0-beta.5';
export const FAKE_KIT_PACKAGE = '@superfunction/landing-kit';
/** How long the fixture's setup descriptor stays valid, in seconds. */
const DESCRIPTOR_LIFETIME_SECONDS = 31 * 24 * 60 * 60;

export interface FakeReleaseSpec
{
    version: string;
    sequence: number;
    releaseClass?: 'security' | 'maintenance' | 'feature' | 'breaking';
    /** Managed bridge files: path → content. */
    managed?: Record<string, string>;
    agentPack?: string;
    gates?: KitGate[];
    /** Releases this one can be reached from, as signed update edges. */
    edgesFrom?: string[];
    /**
     * Releases this one names in `compatibility.fromReleases` and gives no
     * edge record for.
     *
     * The shape a real first update has: a release cannot carry an edge from a
     * predecessor whose managed bytes it was not built beside, so the direct
     * hop is authorised by the manifest field alone (unit 05 §2.1).
     */
    directFrom?: string[];
    /** Packages that carry migrations. */
    withMigrations?: boolean;
    status?: 'active' | 'superseded' | 'revoked';
    /** What the release's scaffold archive holds: path → content. */
    scaffoldFiles?: Record<string, string>;
    /** What the release's Agent Pack archive holds: path → content. */
    agentPackFiles?: Record<string, string>;
}

export interface FakeWorldOptions
{
    kitId?: string;
    releases?: FakeReleaseSpec[];
    cliVersion?: string;
    /** The CLI version the descriptor demands. */
    minimumCliVersion?: string;
    now?: string;
    /**
     * Where the catalog, the manifests and the artifacts are addressed from.
     *
     * The HTTP tests point this at a loopback fixture so the documents this
     * world builds are the documents a real client fetches over a real socket.
     */
    releaseStoreUrl?: string;
    /** Where the registry proxy and the npm packages are addressed from. */
    registryUrl?: string;
    /**
     * Where the setup descriptor is served from.
     *
     * A certification run points this at a loopback control plane, which is
     * the whole reason the allowlist can be widened by environment: the
     * descriptor has to come from the service under test, not from production.
     */
    setupOrigin?: string;
}

export interface FakeFaults
{
    /** The registry refuses the first session, then works. */
    registryUnauthorizedOnce: boolean;
    registryStale: boolean;
    registryInvalid: boolean;
    packageInstallFails: boolean;
    failingGates: Set<KitGate>;
    databaseConfigured: boolean;
    databaseReachable: boolean;
    databasePending: string[];
    databaseApplied: string[];
    migrationFails: boolean;
    activationStatus: 'activated' | 'license-invalid' | 'license-revoked' | 'project-limit' | 'unavailable';
    entitled: boolean;
    catalogUnavailable: boolean;
    gitDirty: boolean;
    /** Tooling writes a file it was not allowed to touch. */
    toolingWritesOutsideAllowlist: boolean;
    /** Tooling returns a plan that writes customer source. */
    toolingPlansCustomerWrite: boolean;
    /** The control plane cannot take a recovery request right now. */
    recoveryRequestUnavailable: boolean;
    /** Committed-state paths this repository ignores, e.g. a bad .gitignore. */
    untrackedCommittedState: string[];
}

interface BuiltRelease
{
    spec: Required<Pick<FakeReleaseSpec, 'version' | 'sequence'>> & FakeReleaseSpec;
    manifest: Record<string, unknown>;
    manifestUrl: string;
    catalogEntry: KitCatalogRelease;
}

export class FakeKitWorld
{
    readonly kitId: string;
    readonly setupOrigin: string;
    readonly setupUrl: string;
    readonly releaseStoreUrl: string;
    readonly catalogUrl: string;
    readonly registryUrl: string;
    readonly licenseKey = FAKE_LICENSE_KEY;
    readonly credentials = new MemoryKitCredentialStore();
    readonly adapters: KitAdapters;

    readonly faults: FakeFaults = {
        registryUnauthorizedOnce: false,
        registryStale: false,
        registryInvalid: false,
        packageInstallFails: false,
        failingGates: new Set<KitGate>(),
        databaseConfigured: true,
        databaseReachable: true,
        databasePending: [],
        databaseApplied: ['0001_init'],
        migrationFails: false,
        activationStatus: 'activated',
        entitled: true,
        catalogUnavailable: false,
        gitDirty: false,
        toolingWritesOutsideAllowlist: false,
        toolingPlansCustomerWrite: false,
        recoveryRequestUnavailable: false,
        untrackedCommittedState: [],
    };

    /**
     * The open and spent recovery challenges this control plane has issued.
     *
     * Keyed by the public recovery id, which is also the id embedded in the
     * challenge — so a CLI that holds the challenge can address the completion
     * without being told the id twice.
     */
    readonly recoveries = new Map<string, { activationId: string; challenge: string; state: 'open' | 'used' | 'superseded' }>();

    /** What went to the address of record. This world's stand-in for an inbox. */
    readonly mailbox: { activationId: string; recoveryId: string; challenge: string }[] = [];

    /**
     * The one credential each activation currently accepts.
     *
     * Unit 04 gives an activation a single current local client, so this is
     * how a second machine's recovery makes the first machine's credential
     * stale: the value moves, and the registry stops honouring the old one.
     * Empty means no recovery has happened and any credential is the first.
     */
    readonly currentCredentials = new Map<string, string>();

    readonly credentialGenerations = new Map<string, number>();

    /** Runs inside a successful package install, in the project directory. */
    onPackageInstall?: (projectDir: string) => void;

    /** Every license key the control plane has seen. Proves none leaked. */
    readonly seenLicenseKeys: string[] = [];
    /** Every child environment the package manager was given. */
    readonly childEnvironments: Record<string, string>[] = [];
    /** Activation calls, to prove idempotency and slot counting. */
    readonly activationCalls: { installationId: string }[] = [];

    private readonly artifacts = new Map<string, Uint8Array>();
    private readonly releases: BuiltRelease[] = [];
    private readonly privateKey;
    private readonly publicKeyDer: string;
    private readonly keyId = 'fixture-key-1';
    private clockSeconds: number;
    private readonly descriptorIssuedAt: string;
    private readonly descriptorExpiresAt: string;
    private commitCounter = 0;
    private sessionCounter = 0;
    private registryRefusals = 0;

    constructor(options: FakeWorldOptions = {})
    {
        const keys = generateKeyPairSync('ed25519');

        this.privateKey = keys.privateKey;
        this.publicKeyDer = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        this.kitId = options.kitId ?? 'campaign-landing';
        this.setupOrigin = (options.setupOrigin ?? FAKE_SETUP_ORIGIN).replace(/\/+$/, '');
        this.setupUrl = `${this.setupOrigin}/setup/landing-kit`;
        this.releaseStoreUrl = (options.releaseStoreUrl ?? FAKE_RELEASE_STORE_URL).replace(/\/+$/, '');
        this.catalogUrl = `${this.releaseStoreUrl}/catalog`;
        this.registryUrl = options.registryUrl ?? 'https://packages.superfunction.xyz/npm/';
        this.clockSeconds = Date.parse(options.now ?? '2026-08-17T00:00:00Z') / 1000;
        this.descriptorIssuedAt = instantOf(this.clockSeconds);
        this.descriptorExpiresAt = instantOf(this.clockSeconds + DESCRIPTOR_LIFETIME_SECONDS);

        for (const spec of options.releases ?? [defaultRelease()])
        {
            this.releases.push(this.buildRelease(spec));
        }

        this.adapters = this.buildAdapters(options);
    }

    /**
     * Publish a release after an install has already happened.
     *
     * Update cases need a project sitting on R0 while R1 exists, and an install
     * always takes the newest stable — so R1 has to arrive afterwards, exactly
     * as it does in life.
     */
    publish(spec: FakeReleaseSpec): void
    {
        this.releases.push(this.buildRelease(spec));
    }

    /** The release the catalog currently calls newest and stable. */
    get latest(): BuiltRelease
    {
        return [...this.releases].sort((left, right) => right.spec.sequence - left.spec.sequence)[0];
    }

    /**
     * The exact package graph the release owning that scaffold artifact pins.
     *
     * Matched on the artifact because that is what `createBase` is handed: the
     * scaffold belongs to one release, and the base it writes has to declare
     * that release's versions rather than the newest one's.
     */
    packagesOfScaffold(artifact: string | undefined): { name: string; version: string }[]
    {
        const found = this.releases.find(entry =>
            (entry.manifest.scaffold as { artifact?: string } | undefined)?.artifact === artifact)
            ?? this.releases[0];

        return ((found?.manifest.packages ?? []) as { name: string; version: string }[])
            .map(entry => ({ name: entry.name, version: entry.version }));
    }

    release(version: string): BuiltRelease
    {
        const found = this.releases.find(entry => entry.spec.version === version);

        if (!found)
        {
            throw new Error(`No fake release ${version}`);
        }

        return found;
    }

    now(): string
    {
        return instantOf(this.clockSeconds);
    }

    /** The signed setup response the allowlisted origin serves. */
    signedDescriptor(overrides: Record<string, unknown> = {}): unknown
    {
        const payload = {
            schemaVersion: 1,
            kitId: this.kitId,
            toolingEntry: `${FAKE_KIT_PACKAGE}/tooling`,
            locales: ['ko', 'en'],
        };
        const descriptor = {
            schemaVersion: 1,
            descriptorId: 'landing-kit-setup-2026-08',
            productId: 'landing-kit',
            productKind: 'kit',
            issuedAt: this.descriptorIssuedAt,
            expiresAt: this.descriptorExpiresAt,
            setupUrl: this.setupUrl,
            displayName: 'Landing Kit',
            supportUrl: 'https://superfunction.xyz/support/landing-kit',
            cli: {
                package: 'spfn',
                recommendedVersion: FAKE_CLI_VERSION,
                minimumVersion: this.minimumCliVersion,
            },
            catalogUrl: this.catalogUrl,
            manifestUrl: this.latest.manifestUrl,
            payloadKind: 'landing-kit/setup-payload@1',
            payloadDigest: sha256Digest(canonicalJson(payload)),
            payload,
            ...overrides,
        };

        return this.sign(descriptor);
    }

    sign(document: unknown): unknown
    {
        return {
            schemaVersion: 1,
            document,
            signature: {
                keyId: this.keyId,
                algorithm: 'ed25519',
                value: signBytes(null, Buffer.from(canonicalJson(document), 'utf8'), this.privateKey).toString('base64'),
            },
        };
    }

    /** The keys this world's CLI trusts. */
    get trustedKeys()
    {
        return [{ keyId: this.keyId, publicKey: this.publicKeyDer }];
    }

    private minimumCliVersion = FAKE_CLI_VERSION;

    private buildRelease(spec: FakeReleaseSpec): BuiltRelease
    {
        const managed = spec.managed ?? { 'src/app/api/landing/route.ts': `// managed bridge ${spec.version}\n` };
        const agentPackContent = spec.agentPack ?? `# Agent Pack ${spec.version}\n`;
        const managedResources = Object.entries(managed).map(([path, content]) =>
        {
            const artifact = `artifact/${spec.version}/${path}`;

            this.artifacts.set(artifact, Buffer.from(content, 'utf8'));

            return {
                path,
                role: 'managed-bridge',
                artifact,
                targetDigest: sha256Digest(content),
                ownership: 'managed-bridge' as const,
            };
        });
        // The Agent Pack is an archive the CLI expands, the same judgement the
        // release harness applies: a release's guides, schemas and checklists
        // are a directory, not one document.
        const agentPackArtifact = `artifact/${spec.version}/agent-pack.tar`;
        const agentPackFiles = spec.agentPackFiles
            ?? { 'agents-block.md': agentPackContent, 'guides/install.md': `# Install ${spec.version}\n` };
        const agentPackBytes = buildTar(agentPackFiles);

        this.artifacts.set(agentPackArtifact, agentPackBytes);

        // A real ustar archive, so a real scaffold port has something to expand
        // and a real integrity to check it against.
        const scaffoldArtifact = `artifact/${spec.version}/scaffold.tar`;
        const scaffoldBytes = buildTar(spec.scaffoldFiles ?? defaultScaffoldFiles(spec.version));

        this.artifacts.set(scaffoldArtifact, scaffoldBytes);

        const manifest = {
            schemaVersion: 1,
            kitId: this.kitId,
            version: spec.version,
            sequence: spec.sequence,
            channel: 'stable',
            releaseClass: spec.releaseClass ?? 'feature',
            publishedAt: '2026-08-17T00:00:00Z',
            compatibilityLine: 'next16-react19',
            compatibility: {
                node: '>=20.0.0',
                pnpm: '>=10.33.0',
                next: '16.3.1',
                react: '19.2.8',
                spfnCli: '>=0.3.0-beta.5 <0.4.0',
                fromReleases: [...(spec.edgesFrom ?? []), ...(spec.directFrom ?? [])],
            },
            scaffold: {
                recipeVersion: '1.0.0',
                artifact: scaffoldArtifact,
                integrity: sriOf(scaffoldBytes),
            },
            packages: [
                {
                    name: '@spfn/core',
                    version: '0.3.0-beta.5',
                    integrity: this.publishTarball('@spfn/core', '0.3.0-beta.5'),
                    provenanceDigest: sha256Digest('core-provenance'),
                    exportContractDigest: sha256Digest('core-exports'),
                    migrationSetDigest: null,
                },
                {
                    name: FAKE_KIT_PACKAGE,
                    version: spec.version,
                    integrity: this.publishTarball(FAKE_KIT_PACKAGE, spec.version),
                    provenanceDigest: sha256Digest(`kit-provenance-${spec.version}`),
                    exportContractDigest: sha256Digest(`kit-exports-${spec.version}`),
                    migrationSetDigest: spec.withMigrations === true ? sha256Digest(`kit-migrations-${spec.version}`) : null,
                },
            ],
            managedResources,
            agentPack: {
                path: 'AGENTS.md',
                role: 'agent-pack',
                artifact: agentPackArtifact,
                targetDigest: sha256Digest(agentPackBytes),
                ownership: 'managed-document',
                version: spec.version,
                managedBlockDigests: { install: sha256Digest(`install-block-${spec.version}`) },
            },
            cli: { package: 'spfn', version: FAKE_CLI_VERSION, integrity: fakeIntegrity('cli') },
            updateEdges: (spec.edgesFrom ?? []).map(from => ({
                id: `${from}-to-${spec.version}`.replace(/\./g, ''),
                fromRelease: from,
                toRelease: spec.version,
                resources: managedResources.map(resource => ({
                    path: resource.path,
                    expectedFromDigest: sha256Digest(
                        (this.releaseSpec(from)?.managed ?? { [resource.path]: `// managed bridge ${from}\n` })[resource.path]
                        ?? `// managed bridge ${from}\n`,
                    ),
                    targetDigest: resource.targetDigest,
                })),
            })),
            gates: spec.gates ?? ['kit-check', 'typecheck', 'test', 'build'],
        };

        const manifestUrl = `${this.releaseStoreUrl}/manifests/${spec.version}`;

        return {
            spec: spec as BuiltRelease['spec'],
            manifest,
            manifestUrl,
            catalogEntry: {
                version: spec.version,
                sequence: spec.sequence,
                releaseClass: (spec.releaseClass ?? 'feature') as KitCatalogRelease['releaseClass'],
                manifestUrl,
                status: spec.status ?? 'active',
            },
        };
    }

    /** The signed catalog document, as the release store would serve it. */
    signedCatalog(): unknown
    {
        return this.sign({
            schemaVersion: 1,
            kitId: this.kitId,
            sequence: this.latest.spec.sequence,
            releases: this.releases.map(entry => entry.catalogEntry),
        });
    }

    /** The bytes of one release artifact, or null when there is no such name. */
    artifactBytes(artifact: string): Uint8Array | null
    {
        return this.artifacts.get(artifact) ?? null;
    }

    /** Everything the release store would serve, by artifact name. */
    artifactStore(): Record<string, Uint8Array>
    {
        return Object.fromEntries(this.artifacts);
    }

    /**
     * A package tarball with the integrity the manifest declares for it.
     *
     * The digest in the manifest and the digest of the bytes a registry serves
     * have to be the same number for an exact install to be provable at all —
     * so the bytes are made here, once, and the manifest records what they hash
     * to rather than a plausible-looking constant.
     */
    private publishTarball(name: string, version: string): string
    {
        const existing = this.packageTarballs.find(entry => entry.name === name && entry.version === version);

        if (existing !== undefined)
        {
            return existing.integrity;
        }

        // A real npm tarball: gzipped, with everything under `package/`. A
        // package manager run against this fixture unpacks it for real, so a
        // shape only this repository's own reader accepts would not do.
        const bytes = npmTarball(name, version);
        const integrity = sriOf(bytes);

        this.packageTarballs.push({ name, version, bytes, integrity });

        return integrity;
    }

    /** Every package tarball the manifests point at. */
    readonly packageTarballs: { name: string; version: string; bytes: Uint8Array; integrity: string }[] = [];

    private releaseSpec(version: string): FakeReleaseSpec | undefined
    {
        return this.releases.find(entry => entry.spec.version === version)?.spec;
    }

    private tick(): string
    {
        const value = this.now();

        this.clockSeconds += 1;

        return value;
    }

    private buildAdapters(options: FakeWorldOptions): KitAdapters
    {
        this.minimumCliVersion = options.minimumCliVersion ?? FAKE_CLI_VERSION;

        const world = this;

        return {
            cliVersion: options.cliVersion ?? FAKE_CLI_VERSION,
            controlPlaneUrl: 'https://start.superfunction.xyz',
            registryUrl: this.registryUrl,
            trustedKeys: this.trustedKeys,
            clock: { now: () => world.tick() },
            credentials: this.credentials,

            async setupFetcher(url: string): Promise<SetupFetchResult>
            {
                if (url !== world.setupUrl)
                {
                    throw new Error(`fake origin has nothing at ${url}`);
                }

                return { body: world.signedDescriptor() };
            },

            catalog: {
                async fetchSignedCatalog()
                {
                    if (world.faults.catalogUnavailable)
                    {
                        throw new Error('catalog unreachable');
                    }

                    return world.signedCatalog();
                },
                async fetchSignedManifest(url: string)
                {
                    if (world.faults.catalogUnavailable)
                    {
                        throw new Error('registry unreachable');
                    }

                    const found = world.releases.find(entry => entry.manifestUrl === url);

                    if (!found)
                    {
                        throw new Error(`fake registry has no manifest at ${url}`);
                    }

                    return world.sign(found.manifest);
                },
            },

            license: {
                async activate(request)
                {
                    world.seenLicenseKeys.push(request.licenseKey);
                    world.activationCalls.push({ installationId: request.installationId });

                    if (world.faults.activationStatus !== 'activated')
                    {
                        return { status: world.faults.activationStatus };
                    }
                    if (request.licenseKey !== world.licenseKey)
                    {
                        return { status: 'license-invalid' };
                    }

                    return {
                        status: 'activated',
                        // One activation ID per installation, so a retry of the
                        // same install never consumes a second slot.
                        activationId: `act-${createHash('sha256').update(request.installationId).digest('hex').slice(0, 16)}`,
                        accessExpiresAt: '2026-08-17T01:00:00Z',
                        generation: 1,
                    };
                },
                async entitlement()
                {
                    return world.faults.entitled
                        ? { entitled: true }
                        : { entitled: false, reason: 'expired' as const };
                },

                /* Unit 04 §6.1: the same answer whether or not the activation
                   exists, so nothing a caller sees says which it was. What
                   goes to the address of record lands in `world.mailbox`,
                   which is this world's stand-in for an inbox. */
                async requestRecovery(request)
                {
                    if (world.faults.recoveryRequestUnavailable)
                    {
                        return { status: 'unavailable' as const };
                    }

                    const recoveryId = createHash('sha256')
                        .update(`recovery:${request.activationId}:${world.mailbox.length}`)
                        .digest('hex')
                        .slice(0, 16);
                    const challenge = `spfnr_${recoveryId}.${createHash('sha256')
                        .update(`challenge:${recoveryId}`)
                        .digest('base64url')
                        .slice(0, 43)}`;

                    /* One open challenge per activation. A newer request
                       supersedes the older one, which is what stops a stolen
                       old mail from being spent after a new one is asked for. */
                    for (const open of world.recoveries.values())
                    {
                        if (open.activationId === request.activationId && open.state === 'open')
                        {
                            open.state = 'superseded';
                        }
                    }

                    world.recoveries.set(recoveryId, {
                        activationId: request.activationId,
                        challenge,
                        state: 'open',
                    });
                    world.mailbox.push({ activationId: request.activationId, recoveryId, challenge });

                    return { status: 'sent' as const };
                },

                async completeRecovery(request)
                {
                    const recovery = world.recoveries.get(request.recoveryId);

                    if (recovery === undefined
                        || recovery.state !== 'open'
                        || recovery.challenge !== request.challenge)
                    {
                        return { status: 'recovery-invalid' as const };
                    }

                    /* Single use, and the previous local client is revoked in
                       the same move — unit 04 gives an activation one current
                       client, so the machine that held the old one is stale
                       from this instant. */
                    recovery.state = 'used';
                    world.currentCredentials.set(recovery.activationId, request.replacementCredential);
                    world.credentialGenerations.set(
                        recovery.activationId,
                        (world.credentialGenerations.get(recovery.activationId) ?? 1) + 1,
                    );

                    return {
                        status: 'recovered' as const,
                        activationId: recovery.activationId,
                        localClientId: `lc-${request.recoveryId}`,
                        accessExpiresAt: '2026-08-17T02:00:00Z',
                        generation: world.credentialGenerations.get(recovery.activationId) ?? 2,
                    };
                },
            },

            registry: {
                async issueSession(request)
                {
                    if (world.faults.registryStale)
                    {
                        return { status: 'credential-stale' };
                    }
                    if (world.faults.registryInvalid)
                    {
                        return { status: 'credential-invalid' };
                    }

                    /* Unit 06 table B, "clean clone·stale token": once a
                       recovery has moved the current credential, the machine
                       still holding the previous one is refused — which is the
                       whole reason the previous machine has to recover too. */
                    const current = world.currentCredentials.get(request.activationId);

                    if (current !== undefined && current !== request.credential)
                    {
                        return { status: 'credential-stale' };
                    }
                    if (world.faults.registryUnauthorizedOnce && world.registryRefusals === 0)
                    {
                        world.registryRefusals += 1;

                        return { status: 'ok', token: 'spfnr_expired_session', expiresInSeconds: 1 };
                    }

                    world.sessionCounter += 1;

                    return {
                        status: 'ok',
                        token: `spfnr_session_${world.sessionCounter}_${request.activationId}`,
                        expiresInSeconds: 1800,
                    };
                },
            },

            packageManager: {
                async install(request)
                {
                    world.childEnvironments.push(request.env);

                    if (world.faults.packageInstallFails)
                    {
                        return { ok: false, exitCode: 1, failure: 'other' };
                    }
                    if (request.env.SPFN_REGISTRY_TOKEN === 'spfnr_expired_session')
                    {
                        return { ok: false, exitCode: 1, failure: 'unauthorized' };
                    }

                    const marker = join(request.cwd, 'node_modules', '.installed');

                    mkdirSync(dirname(marker), { recursive: true });
                    writeFileSync(marker, 'ok\n', 'utf8');

                    /* What a package manager actually does: put on disk what
                       the project declares. Modelled because the CLI now reads
                       the installed tree back — an update that forgets to
                       repin `package.json` installs the previous release here,
                       exactly as it did against the real registry. */
                    materializeDeclaredGraph(request.cwd);

                    /* A seam for what a real graph can do on the way past: a
                       postinstall script, a patch step, a formatter. Nothing
                       in the CLI writes here, which is exactly why the
                       customer-source guard cannot be satisfied by reading
                       the CLI's own intentions. */
                    world.onPackageInstall?.(request.cwd);

                    return { ok: true, exitCode: 0 };
                },
            },

            database: {
                async status()
                {
                    return {
                        configured: world.faults.databaseConfigured,
                        reachable: world.faults.databaseReachable,
                        applied: [...world.faults.databaseApplied],
                        pending: [...world.faults.databasePending],
                    };
                },
                async migrate()
                {
                    if (world.faults.migrationFails)
                    {
                        return {
                            ok: false,
                            applied: [...world.faults.databaseApplied],
                            pending: [...world.faults.databasePending],
                            failure: 'statement-failed',
                        };
                    }

                    world.faults.databaseApplied = [...world.faults.databaseApplied, ...world.faults.databasePending];
                    world.faults.databasePending = [];

                    return {
                        ok: true,
                        applied: [...world.faults.databaseApplied],
                        pending: [],
                        backupId: 'bk-fixture-01',
                    };
                },
            },

            gates: {
                async run(gate)
                {
                    return world.faults.failingGates.has(gate)
                        ? { ok: false, summary: `${gate} failed in the fixture` }
                        : { ok: true };
                },
            },

            git: {
                /* The fake repository tracks everything it holds except the
                   two directories no repository would. Enough to answer "is
                   the committed state committed", which is what the caller
                   asks — a fake that answered "yes" unconditionally would make
                   that check untestable. */
                async trackedAmong(request)
                {
                    return request.paths.filter(path => existsSync(join(request.cwd, path))
                        && !world.faults.untrackedCommittedState.includes(path));
                },
                async init(request)
                {
                    mkdirSync(join(request.cwd, '.git'), { recursive: true });
                },
                async isClean()
                {
                    return !world.faults.gitDirty;
                },
                async commit()
                {
                    world.commitCounter += 1;

                    return { commit: createHash('sha1').update(`commit-${world.commitCounter}`).digest('hex') };
                },
                async head()
                {
                    return world.commitCounter === 0
                        ? null
                        : createHash('sha1').update(`commit-${world.commitCounter}`).digest('hex');
                },
            },

            scaffold: {
                async createBase(request)
                {
                    mkdirSync(join(request.targetDir, 'src', 'app'), { recursive: true });

                    /* The scaffold declares the release's own graph, because a
                       real one does: what a package manager installs comes
                       from `package.json` and the lockfile, never from the
                       manifest, and a fake whose scaffold declared nothing
                       would make that dependency invisible. */
                    const declared = Object.fromEntries(
                        world.packagesOfScaffold(request.scaffold?.artifact).map(entry => [entry.name, entry.version]),
                    );

                    writeFileSync(
                        join(request.targetDir, 'package.json'),
                        `${JSON.stringify({
                            name: request.name,
                            private: true,
                            dependencies: { spfn: FAKE_CLI_VERSION, ...declared },
                        }, null, 4)}\n`,
                        'utf8',
                    );
                    writeFileSync(join(request.targetDir, 'src', 'app', 'page.tsx'), 'export default function Page() { return null; }\n', 'utf8');
                    writeFileSync(join(request.targetDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
                },
            },

            artifacts: {
                async fetch(artifact: string)
                {
                    const bytes = world.artifacts.get(artifact);

                    if (bytes === undefined)
                    {
                        throw new Error(`fake registry has no artifact ${artifact}`);
                    }

                    return bytes;
                },
            },

            async loadProjectModule(specifier: string)
            {
                if (specifier !== `${FAKE_KIT_PACKAGE}/tooling`)
                {
                    throw missingExportError(specifier);
                }

                return { default: world.tooling() };
            },
        };
    }

    private tooling(): KitToolingV1
    {
        const world = this;

        return {
            kitId: world.kitId,
            async inspect()
            {
                return { kitId: world.kitId, release: world.latest.spec.version };
            },
            async planInstall(context): Promise<KitMutationPlan>
            {
                if (world.faults.toolingWritesOutsideAllowlist)
                {
                    // A "pure" planner that writes, into whatever directory it
                    // was handed. The isolated copy exists to catch this.
                    writeFileSync(join(context.projectDir, 'tooling-side-effect.txt'), 'written during planning\n', 'utf8');
                }

                const manifest = world.latest.manifest as { managedResources: { path: string; artifact: string; targetDigest: string }[] };

                return {
                    kitId: world.kitId,
                    release: world.latest.spec.version,
                    entries: [
                        ...manifest.managedResources.map(resource => ({
                            targetPath: resource.path,
                            owner: 'managed-bridge' as const,
                            expectedInputDigest: null,
                            targetDigest: resource.targetDigest,
                            artifact: resource.artifact,
                        })),
                        ...(world.faults.toolingPlansCustomerWrite
                            ? [{
                                targetPath: 'src/app/page.tsx',
                                owner: 'customer' as const,
                                targetDigest: sha256Digest('rewritten'),
                                artifact: 'artifact/customer-write',
                            }]
                            : []),
                    ],
                };
            },
            async planUpdate(context)
            {
                return this.planInstall(context);
            },
            async check()
            {
                return [];
            },
        };
    }
}

/** The instant shape every document of the fake world carries: no millis. */
function instantOf(epochSeconds: number): string
{
    return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function defaultRelease(): FakeReleaseSpec
{
    return { version: '1.0.0', sequence: 1, releaseClass: 'feature' };
}

function fakeIntegrity(seed: string): string
{
    return `sha512-${createHash('sha512').update(seed).digest('base64').replace(/=+$/, '').slice(0, 86)}==`;
}

/**
 * What Node throws for a package that has no `./tooling` export.
 *
 * Spelled with the real code, because the CLI now tells "there is no such
 * export" apart from "the export is there and it would not load" — and a
 * fixture that threw a bare `Error` would make every package look broken.
 */
export function missingExportError(specifier: string): Error & { code: string }
{
    const error = new Error(
        `Package subpath './tooling' is not defined by "exports" in the package.json of ${specifier}`,
    ) as Error & { code: string };

    error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';

    return error;
}

/** A real subresource integrity value over real bytes. */
export function sriOf(bytes: Uint8Array, algorithm: 'sha256' | 'sha512' = 'sha512'): string
{
    return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`;
}

/**
 * A publishable npm tarball for a package that does nothing.
 *
 * `main` points at a file that exists, and `sideEffects: false` keeps a bundler
 * from looking for anything else — enough for a package manager to install it
 * and for a project to depend on it.
 */
export function npmTarball(name: string, version: string): Uint8Array
{
    const manifest = {
        name,
        version,
        main: 'index.js',
        type: 'module',
        sideEffects: false,
        license: 'UNLICENSED',
    };

    return new Uint8Array(gzipSync(Buffer.from(buildTar({
        'package/package.json': `${JSON.stringify(manifest, null, 2)}\n`,
        'package/index.js': `export const name = ${JSON.stringify(name)};\n`,
    }))));
}

/** The base a release scaffolds when the spec does not name its own. */
/** Write `node_modules/<name>/package.json` for everything the project declares. */
function materializeDeclaredGraph(projectDir: string): void
{
    const manifestPath = join(projectDir, 'package.json');

    if (!existsSync(manifestPath))
    {
        return;
    }

    const document = JSON.parse(readFileSync(manifestPath, 'utf8')) as
        { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    for (const block of [document.dependencies, document.devDependencies])
    {
        for (const [name, version] of Object.entries(block ?? {}))
        {
            const directory = join(projectDir, 'node_modules', ...name.split('/'));

            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version }, null, 4)}\n`, 'utf8');
        }
    }
}

export function defaultScaffoldFiles(version: string): Record<string, string>
{
    return {
        'package.json': `${JSON.stringify({ name: 'kit-scaffold', private: true, version: '0.0.0' }, null, 4)}\n`,
        'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
        'src/app/page.tsx': `export default function Page() { return null; } // ${version}\n`,
        'src/server/router.ts': 'export const appRouter = {};\n',
    };
}

/**
 * A POSIX ustar archive of the given files.
 *
 * Written by hand rather than shelled out to `tar`, so the tests do not depend
 * on which `tar` a machine happens to have, and so a deliberately malformed
 * archive is as easy to produce as a well-formed one.
 */
export function buildTar(files: Record<string, string | Uint8Array>, overrides: TarOverrides = {}): Uint8Array
{
    const blocks: Buffer[] = [];

    for (const [path, content] of Object.entries(files))
    {
        const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);

        blocks.push(tarHeader(overrides.rename?.(path) ?? path, bytes.length, overrides.typeFlag ?? '0'));
        blocks.push(bytes);

        const padding = (512 - (bytes.length % 512)) % 512;

        if (padding > 0)
        {
            blocks.push(Buffer.alloc(padding));
        }
    }

    blocks.push(Buffer.alloc(1024));

    return new Uint8Array(Buffer.concat(blocks));
}

export interface TarOverrides
{
    /** Rewrite each entry's path, for the archives that must be refused. */
    rename?: (path: string) => string;
    /** Entry type, e.g. `2` for a symlink the reader must refuse. */
    typeFlag?: string;
}

function tarHeader(path: string, size: number, typeFlag: string): Buffer
{
    const header = Buffer.alloc(512);

    header.write(path.slice(0, 100), 0, 100, 'utf8');
    header.write('000644 \0', 100, 8, 'ascii');
    header.write('000000 \0', 108, 8, 'ascii');
    header.write('000000 \0', 116, 8, 'ascii');
    header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
    header.write('00000000000 ', 136, 12, 'ascii');
    header.write(typeFlag, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.fill(' ', 148, 156);

    let checksum = 0;

    for (const byte of header)
    {
        checksum += byte;
    }

    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    return header;
}
