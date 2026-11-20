/**
 * Everything a Kit operation needs from the outside world, as one set of
 * interfaces.
 *
 * The operations in `operations/` contain the order of the steps, the
 * checkpoints and the refusals — the parts that are the same whatever is on the
 * other end. The ports are the parts that are not: a control plane, a registry,
 * a package manager, a database, Git, a cloud provider.
 *
 * The reason for the seam is not testability alone. It is that a Wave-1 install
 * has to be provable *before* any of those services may be touched: with fake
 * ports the whole sequence, including its failures and resumes, runs on a
 * temporary directory and reaches nothing real.
 *
 * Two rules hold across every port:
 *   - a port reports outcomes, it does not decide policy. `activate` says
 *     `project-limit`; whether that is fatal is the operation's call;
 *   - a secret crosses a port boundary only as a value the CLI immediately puts
 *     into a keychain item or a child environment. No port writes one to disk.
 */

import type { KitGate, KitReleaseManifestView } from './manifest.js';
import type { KitScaffoldDescriptor } from './scaffold.js';
import type { KitCredentialStore } from './credentials.js';
import type { SetupFetcher } from './setup-descriptor.js';
import type { TrustedKey } from './signature.js';
import type { KitProviderId } from './validate.js';

export interface KitClock
{
    /** An ISO-8601 instant with second precision, matching the contract. */
    now(): string;
}

export interface KitCatalogRelease
{
    version: string;
    sequence: number;
    releaseClass: 'security' | 'maintenance' | 'feature' | 'breaking';
    manifestUrl: string;
    /**
     * Unit 05 section 2.2, the approved vocabulary.
     *
     * `active` may be installed, updated to or rebuilt. `superseded` is no
     * longer recommended on its own but an entitled client may still rebuild
     * that exact version — which is why picking the latest release filters on
     * active while an explicit version does not. `revoked` blocks new metadata
     * and tarball acquisition outright.
     */
    status: 'active' | 'superseded' | 'revoked';
    /**
     * Optional, from unit 05 section 2.2. Where a revoked release has a
     * successor, this names it, so a report can say what to move to instead of
     * only that the release is gone.
     *
     * Carried through the view deliberately unread. Nothing selects on it yet,
     * and inventing that behaviour here would put a policy in the generic CLI
     * that no approved design has decided.
     */
    replacementVersion?: string;
}

export interface KitCatalogView
{
    kitId: string;
    sequence: number;
    releases: KitCatalogRelease[];
}

/**
 * Transport for the signed documents. Each call returns the *signed wrapper*,
 * never a document the transport has already decided to trust — verification is
 * the CLI's job and stays in one place.
 */
export interface CatalogPort
{
    fetchSignedCatalog(url: string): Promise<unknown>;
    fetchSignedManifest(url: string): Promise<unknown>;
}

export interface ActivationRequest
{
    kitId: string;
    installationId: string;
    localClientId: string;
    /** Read from a masked prompt or stdin, held in memory, never stored. */
    licenseKey: string;
    /** The client-generated credential already parked in the pending item. */
    candidateCredential: string;
}

export interface ActivationResult
{
    status: 'activated' | 'license-invalid' | 'license-revoked' | 'project-limit' | 'unavailable';
    activationId?: string;
    accessExpiresAt?: string;
    generation?: number;
    /** Secret-free detail for the report, e.g. how many slots are in use. */
    detail?: Record<string, string | number | boolean | null>;
}

export interface EntitlementResult
{
    entitled: boolean;
    reason?: 'expired' | 'not-entitled' | 'revoked' | 'unavailable';
}

export interface EntitlementRequest
{
    activationId: string;
    kitId: string;
    release: string;
    /**
     * The package whose availability answers the question, from the release
     * that is being asked about.
     *
     * A generic CLI cannot know what a Kit ships as. Guessing it from the Kit
     * id works only for Kits whose package happens to be named after them, and
     * a wrong guess is answered by the registry as "not entitled" — a refusal
     * the customer reads as a licence problem when nothing about the licence
     * is wrong. The manifest names its packages, so the caller that holds the
     * manifest says which one to ask about, and this stays a transport.
     */
    packageName?: string;
}

/**
 * The answer to "please e-mail this activation a recovery challenge".
 *
 * `sent` whether or not the activation exists. The control plane answers the
 * same way in both cases on purpose (unit 04 §6.1), so a caller who could tell
 * the difference would be telling an attacker which public activation ids are
 * real. The CLI carries that property forward rather than trying to be more
 * helpful than the service it asked.
 */
export interface RecoveryRequestResult
{
    status: 'sent' | 'unavailable';
    detail?: Record<string, string | number | boolean | null>;
}

export interface RecoveryCompletionResult
{
    status: 'recovered' | 'recovery-invalid' | 'license-revoked' | 'unavailable';
    /** The activation the replacement credential now belongs to. */
    activationId?: string;
    /** The server's name for the client the replacement created. */
    localClientId?: string;
    accessExpiresAt?: string;
    generation?: number;
    detail?: Record<string, string | number | boolean | null>;
}

export interface LicensePort
{
    activate(request: ActivationRequest): Promise<ActivationResult>;
    entitlement(request: EntitlementRequest): Promise<EntitlementResult>;
    /** Unit 06 §4.10 step 1: ask for a challenge at the address of record. */
    requestRecovery(request: { activationId: string }): Promise<RecoveryRequestResult>;
    /**
     * Unit 06 §4.10 steps 4–5.
     *
     * The replacement credential is generated by the CLI and sent, rather than
     * minted by the server and returned: a secret the server mints can be lost
     * in transit, and losing the one that replaces a lost one has no next step.
     */
    completeRecovery(request: {
        recoveryId: string;
        challenge: string;
        replacementCredential: string;
    }): Promise<RecoveryCompletionResult>;
}

export interface RegistrySession
{
    status: 'ok' | 'credential-stale' | 'credential-invalid' | 'unavailable';
    /** Short-lived bearer, handed only to a child environment. */
    token?: string;
    expiresInSeconds?: number;
}

export interface RegistryPort
{
    /**
     * `kitId` names the keychain item the credential lives in, so a port that
     * rotates an expired credential can put the replacement back where the next
     * command will look for it. A port that never rotates ignores it.
     */
    issueSession(request: {
        kitId?: string;
        activationId: string;
        localClientId: string;
        credential: string;
        /**
         * Set on a retry after the registry refused the last credential. The
         * local record can look perfectly current while the server has already
         * stopped honouring it, and re-presenting it would fail identically.
         */
        forceRotation?: boolean;
    }): Promise<RegistrySession>;
}

export interface PackageInstallResult
{
    ok: boolean;
    exitCode: number;
    /** Why it failed, in terms the operation can branch on. */
    failure?: 'unauthorized' | 'network' | 'resolution' | 'other';
}

export interface PackageManagerPort
{
    install(request: {
        cwd: string;
        frozen: boolean;
        env: Record<string, string>;
    }): Promise<PackageInstallResult>;
}

export interface DatabaseStatus
{
    /** Whether a connection string is configured at all. */
    configured: boolean;
    reachable: boolean;
    applied: string[];
    pending: string[];
    /**
     * Set when the project's bookkeeping does not match its migrations, which
     * `spfn db migrate` refuses: what does not match, and the remedy.
     */
    bookkeepingMismatch?: string;
    /**
     * Set when the database refused the app role the read (SQLSTATE 42501):
     * PostgreSQL's message, which names what was refused. Like a mismatch it
     * does not change by waiting — someone has to grant the read.
     */
    permissionDenied?: string;
}

/** Why a status could not be read, in a word or PostgreSQL's own message. */
export function unreadableStatusReason(status: DatabaseStatus): string
{
    if (status.permissionDenied !== undefined)
    {
        return `permission denied (${status.permissionDenied})`;
    }
    if (status.bookkeepingMismatch !== undefined)
    {
        return 'bookkeeping-mismatch';
    }

    return status.configured ? 'unreachable' : 'not-configured';
}

export interface MigrationResult
{
    ok: boolean;
    applied: string[];
    pending: string[];
    backupId?: string;
    failure?: string;
    /**
     * The status read after migrating, when it could not be read. Then nothing
     * confirms what the migration did, and `ok` is false.
     */
    unreadableAfter?: DatabaseStatus;
}

export interface DatabasePort
{
    status(request: { cwd: string }): Promise<DatabaseStatus>;
    migrate(request: { cwd: string; withBackup: boolean }): Promise<MigrationResult>;
}

export interface GateResult
{
    ok: boolean;
    /** A short secret-free summary; never raw command output. */
    summary?: string;
}

export interface GatePort
{
    run(gate: KitGate, request: { cwd: string }): Promise<GateResult>;
}

export interface GitPort
{
    init(request: { cwd: string }): Promise<void>;
    isClean(request: { cwd: string }): Promise<boolean>;
    commit(request: { cwd: string; message: string }): Promise<{ commit: string }>;
    head(request: { cwd: string }): Promise<string | null>;
    /**
     * Which of these paths the repository actually tracks.
     *
     * Asked because a file that exists is not the same as a file a clean clone
     * will have. `.spfn/kit-lock.json` and `.spfn/license.json` are the two
     * files a restore has nothing without (unit 06 §4.2, §5.1), and a scaffold
     * whose `.gitignore` covers `.spfn/` produces a project that installs,
     * builds, passes every gate and cannot be restored from its own repository.
     */
    trackedAmong(request: { cwd: string; paths: readonly string[] }): Promise<string[]>;
}

export interface ScaffoldPort
{
    /**
     * The project's base, as the release publishes it.
     *
     * `scaffold` is what the signed manifest declared: which archive, and the
     * integrity it has to match. It is passed in rather than looked up because
     * a scaffold that came from anywhere but the release under installation is
     * not this release's scaffold.
     */
    createBase(request: {
        targetDir: string;
        name: string;
        scaffold?: KitScaffoldDescriptor;
    }): Promise<void>;
}

export interface ArtifactPort
{
    /** The bytes of one release artifact. Verified by digest before use. */
    fetch(artifact: string): Promise<Uint8Array>;
}

export interface ProviderPort
{
    id: KitProviderId;
    /** Takes a planned envelope and returns the outcome envelope. */
    execute(envelope: unknown): Promise<unknown>;
}

/** Loads a module from the installed project graph, for tooling discovery. */
export type ProjectModuleLoader = (specifier: string, projectDir: string) => Promise<unknown>;

export interface KitAdapters
{
    clock: KitClock;
    setupFetcher: SetupFetcher;
    trustedKeys: readonly TrustedKey[];
    catalog: CatalogPort;
    license: LicensePort;
    registry: RegistryPort;
    credentials: KitCredentialStore;
    packageManager: PackageManagerPort;
    database: DatabasePort;
    gates: GatePort;
    git: GitPort;
    scaffold: ScaffoldPort;
    artifacts: ArtifactPort;
    loadProjectModule: ProjectModuleLoader;
    /** The running public CLI version, as the descriptor compares against. */
    cliVersion: string;
    controlPlaneUrl: string;
    registryUrl: string;
}

/** Read a fetched catalog into the view the CLI uses. */
export function readCatalog(document: unknown): KitCatalogView | null
{
    const raw = document as Record<string, unknown> | null;

    if (!raw || typeof raw.kitId !== 'string' || !Array.isArray(raw.releases))
    {
        return null;
    }

    return {
        kitId: raw.kitId,
        sequence: typeof raw.sequence === 'number' ? raw.sequence : 0,
        releases: raw.releases as KitCatalogRelease[],
    };
}

export type { KitReleaseManifestView };
