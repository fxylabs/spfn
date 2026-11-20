/**
 * The pieces install, restore and update all need.
 *
 * Release identity is resolved the same way for every operation — fetch the
 * signed catalog, fetch the signed manifest, verify both against the trusted
 * keys, and only then read them. Dependencies are installed the same way too,
 * including the one retry unit 06 table A allows after an unauthorized fetch:
 * the session is re-issued and the *whole* exact install is repeated, because a
 * half-installed graph resumed with a fresh token is not the graph the lockfile
 * describes.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KitError } from './../errors.js';
import { sha256Digest } from './../digest.js';
import { expandArchive } from './../expand.js';
import { createChildEnv, registryNpmrc } from './../child-env.js';
import { readManifest, assertManifestCliCompatible, type KitReleaseManifestView } from './../manifest.js';
import { installedGraphMismatches } from './../package-graph.js';
import {
    readCatalog,
    unreadableStatusReason,
    type DatabaseStatus,
    type KitAdapters,
    type KitCatalogView,
    type MigrationResult,
} from './../ports.js';
import type { VerifyResult } from './../runner.js';
import { verifySignedDocument } from './../signature.js';
import { readLicenseFile, type KitLicenseFileV1 } from './../installed-state.js';
import { AGENT_PACK_RECORD_PATH, readAgentPackRecord } from './../agent-pack.js';
import type { KitCredentialRecord } from './../credentials.js';
import type { KitGate } from './../manifest.js';

/** `op-<yyyymmddhhmmss>-<type>-<suffix>`, inside the contract's ID pattern. */
export function newOperationId(type: string, now: string, suffix: string): string
{
    const stamp = now.replace(/[-:TZ.]/g, '').slice(0, 14);

    return `op-${stamp}-${type}-${suffix}`.toLowerCase();
}

export interface ReleaseIdentity
{
    catalog: KitCatalogView;
    manifest: KitReleaseManifestView;
    manifestUrl: string;
}

/**
 * Fetch and verify the catalog and one manifest.
 *
 * A revoked release is refused here rather than later: a rollback or an update
 * that targets one would otherwise get all the way to a plan before anyone
 * noticed it was pointing at something withdrawn.
 */
export async function resolveRelease(
    adapters: KitAdapters,
    catalogUrl: string,
    options: { release?: string; manifestUrl?: string } = {},
): Promise<ReleaseIdentity>
{
    const catalog = await verifiedCatalog(adapters, catalogUrl);
    const target = options.release === undefined
        ? latestActiveRelease(catalog)
        : catalog.releases.find(release => release.version === options.release);

    if (target === undefined)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The catalog does not offer that release.', {
            evidence: { requested: options.release ?? 'latest-active', kitId: catalog.kitId },
        });
    }

    /* Only `revoked` is refused. A superseded release named explicitly is a
       legitimate rebuild of something already installed, so it passes here and
       is filtered out only where a release gets chosen automatically. */
    if (target.status === 'revoked')
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'That release has been withdrawn.', {
            evidence: { release: target.version, status: target.status },
        });
    }

    const manifestUrl = options.manifestUrl ?? target.manifestUrl;
    const manifest = await verifiedManifest(adapters, manifestUrl);

    if (manifest.version !== target.version || manifest.kitId !== catalog.kitId)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The manifest does not match the catalog entry it was reached from.', {
            evidence: {
                catalogRelease: target.version,
                manifestRelease: manifest.version,
                catalogKit: catalog.kitId,
                manifestKit: manifest.kitId,
            },
        });
    }

    assertManifestCliCompatible(manifest, adapters.cliVersion);

    return { catalog, manifest, manifestUrl };
}

export async function verifiedCatalog(adapters: KitAdapters, catalogUrl: string): Promise<KitCatalogView>
{
    const checked = verifySignedDocument(await adapters.catalog.fetchSignedCatalog(catalogUrl), adapters.trustedKeys);

    if (!checked.ok)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The release catalog is not signed by a trusted key.', {
            evidence: { reason: checked.reason ?? 'signature-invalid' },
        });
    }

    const catalog = readCatalog(checked.document);

    if (catalog === null)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The release catalog is not readable.', {
            evidence: { catalogUrl },
        });
    }

    return catalog;
}

export async function verifiedManifest(adapters: KitAdapters, manifestUrl: string): Promise<KitReleaseManifestView>
{
    const checked = verifySignedDocument(await adapters.catalog.fetchSignedManifest(manifestUrl), adapters.trustedKeys);

    if (!checked.ok)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The release manifest is not signed by a trusted key.', {
            evidence: { reason: checked.reason ?? 'signature-invalid' },
        });
    }

    return readManifest(checked.document);
}

/**
 * The newest release a client may be pointed at without being asked.
 *
 * Only `active` qualifies. A `superseded` release is still installable by exact
 * version — an entitled client has to be able to rebuild what it already runs —
 * but choosing one on a client's behalf would hand it a release the catalog has
 * already stopped recommending.
 */
export function latestActiveRelease(catalog: KitCatalogView)
{
    const active = catalog.releases
        .filter(release => release.status === 'active')
        .sort((left, right) => right.sequence - left.sequence);

    if (active.length === 0)
    {
        throw new KitError('KIT_MANIFEST_INVALID', 'The catalog offers no active release.', {
            evidence: { kitId: catalog.kitId, releases: catalog.releases.length },
        });
    }

    return active[0];
}

/** A directory that does not exist, or exists and holds nothing. */
export function assertEmptyTarget(targetDir: string): void
{
    if (!existsSync(targetDir))
    {
        return;
    }

    const entries = readdirSync(targetDir).filter(name => name !== '.DS_Store');

    if (entries.length > 0)
    {
        throw new KitError('KIT_TARGET_NOT_EMPTY', 'A Kit install needs a new or empty directory.', {
            evidence: { targetDir, entries: entries.length },
        });
    }
}

export interface MaterializeTarget
{
    path: string;
    artifact: string;
    targetDigest: string;
    /**
     * What the artifact's bytes are.
     *
     * `file` — the bytes *are* the managed file, written as they arrived. That
     * is every managed bridge: a route, a config, a component.
     *
     * `tree` — the bytes are an archive to expand, the way the scaffold is.
     * The Agent Pack is one: a release's guides, schemas and checklists are a
     * directory, and a directory cannot be written as a file however carefully
     * it is digested.
     *
     * The declared digest covers the *archive* either way, so a tree is proven
     * before it is opened exactly as a file is proven before it is written.
     */
    kind?: 'file' | 'tree';
    /** Where a `tree` is expanded, project-relative. Unused for a file. */
    root?: string;
}

/**
 * Write release artifacts into the project and prove each one is what the
 * manifest said it would be.
 *
 * The digest is checked *before* anything is written, not after. An artifact
 * that fails the check has then never touched the disk, so there is nothing to
 * clean up and no window in which the wrong bytes were readable.
 *
 * Re-entrant, because a resume comes back through here after a materialize
 * that stopped partway: a file already holding exactly the bytes this target
 * would write counts as done, and one holding anything else is refused with
 * the file left alone.
 */
export async function materializeTargets(
    adapters: KitAdapters,
    projectDir: string,
    targets: readonly MaterializeTarget[],
    options: { existing?: 'verify' | 'replace' } = {},
): Promise<Record<string, string>>
{
    const written: Record<string, string> = {};

    for (const target of targets)
    {
        const bytes = await adapters.artifacts.fetch(target.artifact);
        const digest = sha256Digest(bytes);

        if (digest !== target.targetDigest)
        {
            throw new KitError('KIT_MANIFEST_INVALID', 'A release artifact does not match its declared digest.', {
                evidence: { path: target.path, declared: target.targetDigest, actual: digest },
            });
        }

        if (target.kind === 'tree')
        {
            const expanded = expandArchive(bytes, {
                targetDir: projectDir,
                root: target.root,
                artifact: target.artifact,
                existing: options.existing,
            });

            Object.assign(written, expanded.files);

            continue;
        }

        written[target.path] = digest;
        writeManagedFile(join(projectDir, target.path), target.path, bytes, digest, options.existing);
    }

    return written;
}

/**
 * One managed file, written unless it is already exactly this file.
 *
 * The comparison is what makes a resume possible. Overwriting unconditionally
 * would work for a resume too — the bytes are identical — but it would also
 * silently replace an edit somebody made, and this cannot tell the two apart
 * without looking.
 */
function writeManagedFile(
    file: string,
    path: string,
    bytes: Uint8Array,
    digest: string,
    existing: 'verify' | 'replace' = 'verify',
): void
{
    if (existsSync(file) && existing !== 'replace')
    {
        const actual = sha256Digest(readFileSync(file));

        if (actual === digest)
        {
            return;
        }

        throw new KitError('KIT_TARGET_NOT_EMPTY', 'A managed file is already there with different contents.', {
            evidence: { path, expected: digest, actual },
            next: { command: 'spfn kit status --json', requiresHumanApproval: false },
        });
    }

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
}

export interface FrozenInstallOptions
{
    projectDir: string;
    /** Which Kit's keychain item holds the credential, for a rotation. */
    kitId: string;
    activationId: string;
    localClientId: string;
    credential: string;
    /** Whether one retry after an unauthorized fetch is allowed. */
    allowSessionRetry?: boolean;
    /**
     * Let the package manager re-resolve instead of holding the lockfile.
     *
     * An update is the one operation where the committed lockfile is *meant*
     * to change: it pins the previous release's versions, and installing
     * against it frozen succeeds by installing the previous release. The
     * result is checked against the manifest afterwards, so re-resolving is
     * not the same as accepting whatever the registry happens to offer.
     */
    resolve?: boolean;
    /** Refuse unless the installed tree ends up holding exactly this graph. */
    expect?: KitReleaseManifestView;
}

export interface FrozenInstallEvidence
{
    attempts: number;
    sessionExpiresInSeconds: number;
}

/**
 * Install the exact graph with a short-lived registry session.
 *
 * The session only ever exists in two places: this function's local variable
 * and the child process's environment. It is not written to `.npmrc`, not
 * passed as an argument, and not put in the journal.
 *
 * The environment carries it twice over, under two names that answer to two
 * readers: `SPFN_REGISTRY_TOKEN` for the proxy verification this CLI does
 * itself, and the registry's own npm configuration key for the package manager.
 * Both are the same session and both die with the child.
 */
export async function installFrozenGraph(
    adapters: KitAdapters,
    options: FrozenInstallOptions,
): Promise<FrozenInstallEvidence>
{
    const maxAttempts = options.allowSessionRetry === false ? 1 : 2;
    let lastFailure: string | undefined;
    let expiresInSeconds = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1)
    {
        const session = await adapters.registry.issueSession({
            kitId: options.kitId,
            activationId: options.activationId,
            localClientId: options.localClientId,
            credential: options.credential,
            // The retry only means something if it presents something else.
            forceRotation: attempt > 1,
        });

        if (session.status === 'credential-stale')
        {
            throw new KitError('KIT_CREDENTIAL_STALE', 'This machine\'s Kit credential is no longer the current one.', {
                evidence: { activationId: options.activationId },
                next: { command: 'spfn kit recover --json', requiresHumanApproval: false },
            });
        }
        if (session.status === 'credential-invalid')
        {
            throw new KitError('KIT_CREDENTIAL_MISSING', 'The control plane does not recognise this machine\'s credential.', {
                evidence: { activationId: options.activationId },
                next: { command: 'spfn kit recover --json', requiresHumanApproval: false },
            });
        }
        if (session.status !== 'ok' || session.token === undefined)
        {
            throw new KitError('KIT_GATE_FAILED', 'The package registry could not issue a session.', {
                evidence: { attempt, status: session.status },
            });
        }

        expiresInSeconds = session.expiresInSeconds ?? 0;

        const result = await adapters.packageManager.install({
            cwd: options.projectDir,
            frozen: options.resolve !== true,
            env: createChildEnv({ registryToken: session.token, registryUrl: adapters.registryUrl }),
        });

        if (result.ok)
        {
            assertGraphInstalled(options);

            return { attempts: attempt, sessionExpiresInSeconds: expiresInSeconds };
        }

        lastFailure = result.failure ?? 'other';

        // Only an unauthorized fetch is worth a second session. Anything else
        // would fail identically with a fresh token.
        if (result.failure !== 'unauthorized' || attempt === maxAttempts)
        {
            break;
        }
    }

    if (lastFailure === 'resolution')
    {
        throw new KitError('KIT_UNSUPPORTED_RESOLUTION', 'The exact dependency graph could not be resolved.', {
            evidence: { projectDir: options.projectDir },
        });
    }

    throw new KitError('KIT_GATE_FAILED', 'The exact dependency install did not succeed.', {
        evidence: { reason: lastFailure ?? 'other', attempts: maxAttempts },
        next: { command: 'spfn kit resume --json', requiresHumanApproval: false },
    });
}

/**
 * Every npm scope the release publishes under.
 *
 * All of them, not the first one: a release whose packages span `@spfn` and
 * `@superfunction` and whose `.npmrc` names only one leaves the other to be
 * resolved by whatever the machine's own configuration says — which is a
 * broken install at best and a request to somebody else's registry at worst.
 */
function scopesOf(manifest: KitReleaseManifestView): string[]
{
    const scopes = manifest.packages
        .filter(entry => entry.name.startsWith('@'))
        .map(entry => entry.name.split('/')[0]);

    return scopes.length === 0 ? ['@superfunction'] : [...new Set(scopes)];
}

/**
 * Point the release's scopes at the private registry, and nothing else.
 *
 * Written by install *and* by update, from the manifest each of them is acting
 * on. Two reasons it is not enough to write it once at install time:
 *
 *   - a release that starts publishing under a new scope leaves a project whose
 *     `.npmrc` names only the old ones, and the new scope resolves wherever the
 *     machine happens to point;
 *   - a project installed before the registry session moved into the child's
 *     environment carries a credential line pnpm 10 and later refuse to expand.
 *     It is dead there now, and every install warns about a secret leaking to
 *     an attacker-controlled registry until it is gone.
 *
 * Both are the same repair — the file is derived from the manifest, so writing
 * it again from the current manifest is the whole fix.
 */
export function writeRegistryNpmrc(
    projectDir: string,
    manifest: KitReleaseManifestView,
    registryUrl: string,
): void
{
    writeFileSync(join(projectDir, '.npmrc'), registryNpmrc(scopesOf(manifest), registryUrl), 'utf8');
}

/**
 * Refuse an install that left the project holding something else.
 *
 * The registry verification proves the registry would serve the manifest's
 * bytes. This proves the project received them — the two are different claims,
 * and only the second one is what the customer ends up running.
 */
function assertGraphInstalled(options: FrozenInstallOptions): void
{
    if (options.expect === undefined)
    {
        return;
    }

    const mismatches = installedGraphMismatches(options.projectDir, options.expect);

    if (mismatches.length === 0)
    {
        return;
    }

    throw new KitError('KIT_UNSUPPORTED_RESOLUTION', 'The installed graph is not the one this release pins.', {
        evidence: {
            release: options.expect.version,
            packages: mismatches.length,
            firstPackage: mismatches[0].name,
            expected: mismatches[0].expected,
            actual: mismatches[0].actual ?? 'absent',
        },
    });
}

export interface ResolvedCredential
{
    license: KitLicenseFileV1;
    record: KitCredentialRecord;
}

/**
 * The credential this checkout is entitled to use, or the reason it has none.
 *
 * Unit 06 table B splits the two "no credential" cases apart because they need
 * different answers: a missing keychain item means this machine never had one,
 * a stale one means another machine now holds the current credential. Both send
 * the agent to `recover`; only the second means someone else's machine changed.
 */
export async function requireCredential(
    adapters: KitAdapters,
    kitId: string,
    licenseFile: string,
): Promise<ResolvedCredential>
{
    const license = readLicenseFile(licenseFile);

    if (license === null)
    {
        throw new KitError('KIT_CREDENTIAL_MISSING', 'This checkout has no activation on record.', {
            evidence: { licenseFile },
            next: { command: 'spfn kit recover --json', requiresHumanApproval: false },
        });
    }

    const record = await adapters.credentials.read({
        kitId,
        activationId: license.activationId,
        localClientId: license.localClientId,
    });

    if (record === null)
    {
        throw new KitError('KIT_CREDENTIAL_MISSING', 'This machine holds no credential for that activation.', {
            evidence: { activationId: license.activationId },
            next: { command: 'spfn kit recover --json', requiresHumanApproval: false },
        });
    }

    return { license, record };
}

/**
 * The files a clean clone has nothing without.
 *
 * Unit 06 §4.2 makes `spfn kit restore` run from the committed lock and the
 * committed licence file and nothing else, and §5.1 says both are committed.
 * §4.4 adds the third: the guide falls back to the *committed* installed Agent
 * Pack cache, so a pack that only exists on the machine that installed it is a
 * pack no clone and no CI job can read.
 *
 * A checkout missing any of them passes every gate and is unrestorable, and
 * that failure surfaces on a different machine days later — so it is checked
 * here, once, on the machine that made it.
 */
export const COMMITTED_STATE_PATHS = ['.spfn/kit-lock.json', '.spfn/license.json'] as const;

export async function assertCommittedStateTracked(adapters: KitAdapters, projectDir: string): Promise<string[]>
{
    const record = readAgentPackRecord(projectDir);
    /* The record and one file from the tree it describes. One file rather than
       all of them: a `.gitignore` covers a directory, not a scattering of
       files inside it, so the failure this catches is all-or-nothing and
       naming every file would only make the refusal harder to read. */
    const packPaths = record === null
        ? []
        : [AGENT_PACK_RECORD_PATH, ...Object.keys(record.files).sort().slice(0, 1)];
    const required = [...COMMITTED_STATE_PATHS, ...packPaths];
    const tracked = await adapters.git.trackedAmong({ cwd: projectDir, paths: required });
    const missing = required.filter(path => !tracked.includes(path));

    if (missing.length > 0)
    {
        throw new KitError('KIT_LOCK_INVALID', 'The files a clean clone restores from are not in the repository.', {
            evidence: { untracked: missing.join(', '), tracked: tracked.length },
            next: { command: 'spfn kit status --json', requiresHumanApproval: false },
        });
    }

    return [...tracked];
}

/** Run the release's local gates. `health` belongs to deployment, not here. */
export async function runLocalGates(
    adapters: KitAdapters,
    projectDir: string,
    gates: readonly KitGate[],
): Promise<Record<string, string>>
{
    const evidence: Record<string, string> = {};

    for (const gate of gates.filter(candidate => candidate !== 'health'))
    {
        const result = await adapters.gates.run(gate, { cwd: projectDir });

        evidence[gate] = result.ok ? 'pass' : 'fail';

        if (!result.ok)
        {
            throw new KitError('KIT_GATE_FAILED', `The ${gate} gate failed.`, {
                evidence: { gate, detail: result.summary ?? null },
                next: { command: 'spfn kit resume --json', requiresHumanApproval: false },
            });
        }
    }

    return evidence;
}

/**
 * Refuse a migration step on a status the database answered but would not
 * give. Not a wait: nothing changes until a person acts.
 *
 * A bookkeeping mismatch is refused by `spfn db migrate` until the bookkeeping
 * or `src/server/drizzle` is fixed by hand. A permission error is a missing
 * grant: without this refusal it reads as "no database" before migrating — a
 * wait no resume ends — and as "nothing pending" after.
 */
export function assertStatusReadable(status: DatabaseStatus, operationId: string): void
{
    const next = { command: `spfn kit resume ${operationId} --json`, requiresHumanApproval: false };

    if (status.bookkeepingMismatch !== undefined)
    {
        throw new KitError(
            'CLI_MIGRATION_BOOKKEEPING_MISMATCH',
            'The project\'s migration bookkeeping does not match src/server/drizzle, so `spfn db migrate` would '
            + 'refuse it. Fix what the detail names (`spfn db status` prints the same), then resume.',
            { evidence: { reason: 'bookkeeping-mismatch', detail: status.bookkeepingMismatch }, next },
        );
    }
    if (status.permissionDenied !== undefined)
    {
        throw new KitError(
            'CLI_MIGRATION_STATUS_UNREADABLE',
            'The database refused the app role the read of the migration status (schema `drizzle`), so nothing '
            + 'can tell what is applied. As the database owner, grant the app role USAGE on schema drizzle and '
            + 'SELECT on its tables — the SQL is in the @spfn/core db README, "Database roles"; spfn does not '
            + 'grant it yet. Then resume.',
            { evidence: { reason: 'permission-denied', detail: status.permissionDenied }, next },
        );
    }
}

/**
 * Stop a migration step that did not end with every migration applied, as far
 * as a status read afterwards can tell.
 *
 * A status that could not be read afterwards is not "nothing pending": it is
 * refused with the reason when the database refused the read, and otherwise
 * left resumable, since resuming reads the status again.
 */
export function assertMigrationFinished(result: MigrationResult, operationId: string): void
{
    const next = { command: `spfn kit resume ${operationId} --json`, requiresHumanApproval: false };

    if (result.unreadableAfter !== undefined)
    {
        assertStatusReadable(result.unreadableAfter, operationId);

        throw new KitError(
            'KIT_MIGRATION_FAILED',
            'The migrations ran, but the status could not be read afterwards, so nothing confirms they applied.',
            { evidence: { reason: unreadableStatusReason(result.unreadableAfter) }, next },
        );
    }
    if (!result.ok || result.pending.length > 0)
    {
        throw new KitError('KIT_MIGRATION_FAILED', 'A package migration did not finish.', {
            evidence: { pending: result.pending.length, detail: result.failure ?? null },
            next,
        });
    }
}

/**
 * A migration step's `verify`: done only on a status that was read and has
 * nothing pending. An unread status has an empty pending list too.
 */
export function verifyNothingPending(status: DatabaseStatus): VerifyResult
{
    if (!status.reachable)
    {
        return { ok: false, reason: `database-status-unreadable: ${unreadableStatusReason(status)}` };
    }

    return status.pending.length === 0
        ? { ok: true, evidence: { applied: status.applied, pending: 0 } }
        : { ok: false, reason: 'database-has-pending-migrations' };
}
