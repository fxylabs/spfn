/**
 * `spfn kit plan` and `spfn kit update` — unit 06 sections 4.6 and 4.7.
 *
 * Everything that can refuse an update refuses it before the first write: a
 * dirty worktree, a drifted managed file, an expired entitlement, a missing
 * signed edge chain, an unapproved plan. That ordering is the point of the
 * preflight — once packages are installed and migrations applied, "stop" is a
 * much more expensive word.
 *
 * Approval is exact. A breaking release or an external effect makes the plan
 * require a human, and the only thing that satisfies that requirement is the
 * digest of the very plan being run. There is no blanket `--yes`, so an agent
 * cannot pre-authorise "whatever the update turns out to be".
 */

import { KitError, KIT_EXIT } from './../errors.js';
import { createEventSink, type KitOperationResult } from './../events.js';
import { detectManagedDrift, fileDigest } from './../drift.js';
import { readAgentPackRecord, writeAgentPackRecord } from './../agent-pack.js';
import { JournalStore } from './../journal.js';
import { acquireOperationLock } from './../lock.js';
import { kitPaths } from './../paths.js';
import { writeOperationContext } from './../operation-context.js';
import { buildPlan, checkApproval, planDigest, type KitPlanV1 } from './../plan.js';
import { resolveUpdateEdges, type KitReleaseManifestView, type KitUpdateEdge } from './../manifest.js';
import { applyManifestVersions, installedGraphMismatches } from './../package-graph.js';
import {
    compareCustomerSource,
    customerSourceDigests,
    readCustomerBaseline,
    writeCustomerBaseline,
    type CustomerSourceChange,
} from './../customer-source.js';
import { lockFromManifest, readLicenseFile, requireInstalledLock, writeInstalledLock } from './../installed-state.js';
import { executeOperation, type OperationStep, type StepOutcome } from './../runner.js';
import type { KitAdapters } from './../ports.js';
import {
    assertMigrationFinished,
    assertStatusReadable,
    verifyNothingPending,
    assertCommittedStateTracked,
    installFrozenGraph,
    materializeTargets,
    newOperationId,
    requireCredential,
    resolveRelease,
    runLocalGates,
    writeRegistryNpmrc,
    type MaterializeTarget,
} from './shared.js';

/**
 * What this checkout currently holds at a managed path.
 *
 * For a managed bridge that is the file's own digest. The Agent Pack has no
 * file at its path — it expanded into a directory — so what it currently holds
 * is the archive digest the expansion recorded. Reading the directory as a file
 * would report every project as drifted the moment the pack became a tree.
 */
function installedDigestOf(projectDir: string, path: string, agentPackPath: string): string | null
{
    if (path !== agentPackPath)
    {
        return fileDigest(projectDir, path);
    }

    const record = readAgentPackRecord(projectDir);

    return record === null ? fileDigest(projectDir, path) : record.targetDigest;
}

export interface UpdateRequest
{
    projectDir: string;
    /** An exact entitled release, or undefined for the newest entitled stable. */
    toRelease?: string;
    /** Produce the plan and write nothing. */
    planOnly?: boolean;
    approvedPlanDigest?: string;
    json: boolean;
    write?: (line: string) => void;
    resuming?: boolean;
}

export interface UpdatePlanResult extends KitOperationResult
{
    plan?: KitPlanV1;
    planDigest?: string;
}

export async function runUpdate(request: UpdateRequest, adapters: KitAdapters): Promise<UpdatePlanResult>
{
    const paths = kitPaths(request.projectDir);
    const journalStore = new JournalStore(request.projectDir, { now: () => adapters.clock.now() });
    const existing = journalStore.readActive();
    const secrets: string[] = [];
    const sink = createEventSink({ json: request.json, write: request.write, knownSecrets: secrets });
    const installed = requireInstalledLock(paths.lockFile);

    if (existing !== null && existing.type !== 'update')
    {
        throw new KitError('KIT_OPERATION_ACTIVE', 'This project has a different operation open.', {
            evidence: { operationId: existing.operationId, type: existing.type },
            next: { command: `spfn kit resume ${existing.operationId} --json`, requiresHumanApproval: false },
        });
    }

    // Drift and a dirty worktree are *start* gates. An update already under way
    // has passed them, and by then the managed files are meant to differ from
    // the installed lock — re-asking would refuse every resume. What guards a
    // resume instead is the checkpoint verification in the step engine.
    const starting = existing === null && request.resuming !== true;

    if (starting && !request.planOnly)
    {
        const drift = detectManagedDrift(request.projectDir, installed);

        if (drift.length > 0)
        {
            throw new KitError('KIT_MANAGED_DRIFT', 'A managed file has been edited, so this update cannot start.', {
                evidence: { firstPath: drift[0].path, files: drift.length },
                next: { command: 'spfn kit check --json', requiresHumanApproval: false },
            });
        }
        if (!(await adapters.git.isClean({ cwd: request.projectDir })))
        {
            throw new KitError('KIT_WORKTREE_DIRTY', 'The Git worktree has uncommitted changes.', {
                next: { command: 'spfn kit plan --json', requiresHumanApproval: false },
            });
        }
    }

    const { manifest, manifestUrl } = await resolveRelease(adapters, installed.catalogUrl, {
        release: request.toRelease,
    });

    if (manifest.version === installed.release)
    {
        return idempotent(sink, installed.release);
    }

    const entitlement = await adapters.license.entitlement({
        activationId: activationIdOf(paths.licenseFile),
        kitId: installed.kitId,
        release: manifest.version,
        packageName: releasePackageName(manifest),
    });

    if (!entitlement.entitled)
    {
        throw new KitError('KIT_ENTITLEMENT_EXPIRED', 'This license does not currently cover that release.', {
            evidence: { release: manifest.version, reason: entitlement.reason ?? 'not-entitled' },
        });
    }

    const edges = resolveUpdateEdges(
        manifest.updateEdges,
        installed.release,
        manifest.version,
        manifest.compatibility.fromReleases,
    );
    const plan = buildPlan({
        operation: 'update',
        manifest,
        fromRelease: installed.release,
        installedPackages: installed.packages,
        installedManaged: [
            ...installed.managedResources.map(resource => ({ path: resource.path, targetDigest: resource.targetDigest })),
            { path: installed.agentPack.path, targetDigest: installed.agentPack.targetDigest },
        ],
        edges,
    });
    const digest = planDigest(plan);

    if (request.planOnly)
    {
        return planResult(sink, plan, digest);
    }

    const operationId = existing?.operationId
        ?? newOperationId('update', adapters.clock.now(), manifest.version.replace(/[^a-z0-9]/gi, ''));

    // Taken before the journal is written, so a project that is already busy is
    // refused without gaining a second operation record.
    const handle = acquireOperationLock({
        root: request.projectDir,
        operationId,
        command: 'kit update',
        now: adapters.clock.now(),
        activeJournal: existing,
        resuming: request.resuming === true,
    });
    // The lock is already held, so every refusal from here on gives it back.
    let journal;

    try
    {
        journal = existing ?? journalStore.create({
            operationId,
            type: 'update',
            kitId: manifest.kitId,
            sourceRelease: installed.release,
            targetRelease: manifest.version,
            manifestDigest: manifest.manifestDigest,
            planDigest: digest,
            phase: 'plan-approval',
            status: 'active',
            checkpoints: [{ id: 'catalog-verified', status: 'completed', completedAt: adapters.clock.now() }],
            externalRefs: {},
        });

        if (journal.planDigest !== digest)
        {
            throw new KitError('KIT_RESUME_MISMATCH', 'The open update was planned against a different plan.', {
                evidence: { journalPlan: journal.planDigest, currentPlan: digest },
                operationId: journal.operationId,
            });
        }

        writeOperationContext(request.projectDir, {
            schemaVersion: 1,
            operationId: journal.operationId,
            catalogUrl: installed.catalogUrl,
            manifestUrl,
            approvedPlanDigest: request.approvedPlanDigest,
        });
    }
    catch (error)
    {
        handle.release();

        throw error;
    }

    return executeOperation({
        journalStore,
        journal,
        lock: handle,
        sink,
        resuming: existing !== null,
        steps: updateSteps({ request, adapters, plan, digest, edges, manifest, manifestUrl, installed, secrets }),
        completedCode: 'KIT_UPDATE_COMPLETE',
        completedSummary: `The project is updated to ${manifest.version}. `
            + 'No deployment was configured, so nothing outside this machine changed.',
    });
}

interface UpdateStepOptions
{
    request: UpdateRequest;
    adapters: KitAdapters;
    plan: KitPlanV1;
    digest: string;
    edges: KitUpdateEdge[];
    manifest: Awaited<ReturnType<typeof resolveRelease>>['manifest'];
    manifestUrl: string;
    installed: ReturnType<typeof requireInstalledLock>;
    secrets: string[];
}

function updateSteps(options: UpdateStepOptions): OperationStep[]
{
    const { request, adapters, manifest, installed } = options;
    const projectDir = request.projectDir;
    const paths = kitPaths(projectDir);

    return [
        {
            checkpoint: 'plan-approved',
            phase: 'plan-approval',
            summary: 'Recording the customer-source baseline and checking the approval this plan needs',
            async run(context): Promise<StepOutcome>
            {
                /* Taken here because this is the last moment before the first
                   write, and taken every time this step runs because every one
                   of those runs is still before it: the step only completes
                   once the approval is satisfied, and nothing after it has run
                   yet. Unit 09's checkpoint vocabulary is a frozen contract, so
                   the baseline shares this checkpoint rather than adding one. */
                const files = customerSourceDigests(projectDir, [installed, manifest]);

                writeCustomerBaseline(projectDir, {
                    schemaVersion: 1,
                    operationId: context.journal.operationId,
                    release: installed.release,
                    files,
                });

                const approval = checkApproval(options.plan, request.approvedPlanDigest);

                if (approval.satisfied)
                {
                    return { kind: 'done', evidence: { planDigest: approval.digest, customerFiles: Object.keys(files).length } };
                }

                return {
                    kind: 'waiting',
                    status: 'waiting-approval',
                    code: 'KIT_APPROVAL_REQUIRED',
                    summary: approval.reason === 'approval-mismatch'
                        ? 'The approval given is for a different plan than the one this update would run.'
                        : 'This update changes something a person has to approve.',
                    evidence: { reason: approval.reason ?? 'approval-required', releaseClass: options.plan.releaseClass },
                    next: {
                        command: `spfn kit update --to ${manifest.version} --approve-plan ${approval.digest} --json`,
                        requiresHumanApproval: true,
                        approvalDigest: approval.digest,
                    },
                };
            },
        },
        {
            checkpoint: 'materialize-complete',
            phase: 'materialize',
            summary: 'Applying the release\'s managed file changes',
            async run(): Promise<StepOutcome>
            {
                for (const change of options.plan.managedChanges)
                {
                    if (change.expectedFromDigest === null)
                    {
                        continue;
                    }

                    const actual = installedDigestOf(projectDir, change.path, manifest.agentPack.path);

                    // The edge says which bytes it was authored against. If the
                    // file is not those bytes, the transform is being applied to
                    // something nobody tested it on.
                    if (actual !== change.expectedFromDigest)
                    {
                        throw new KitError('KIT_MANAGED_DRIFT', 'A managed file is not the version this update edge expects.', {
                            evidence: { path: change.path, expected: change.expectedFromDigest, actual: actual ?? 'missing' },
                        });
                    }
                }

                const changed = new Set(options.plan.managedChanges.map(change => change.path));
                const targets: MaterializeTarget[] = manifest.managedResources
                    .filter(resource => changed.has(resource.path))
                    .map(resource => ({
                        path: resource.path,
                        artifact: resource.artifact,
                        targetDigest: resource.targetDigest,
                    }));

                // The pack is an archive, so it is expanded rather than
                // written — the same judgement install applies.
                if (changed.has(manifest.agentPack.path))
                {
                    targets.push({
                        path: manifest.agentPack.path,
                        artifact: manifest.agentPack.artifact,
                        targetDigest: manifest.agentPack.targetDigest,
                        kind: 'tree',
                        root: manifest.agentPack.root,
                    });
                }

                // Drift was refused before this update started, so every
                // managed file holds the previous release's bytes and replacing
                // them applies the approved plan rather than losing an edit.
                const written = await materializeTargets(adapters, projectDir, targets, { existing: 'replace' });

                // Rewritten from the release being installed, not left as
                // install found it: a release may publish under a scope the
                // project's `.npmrc` has never named, and a project installed
                // before the registry session moved into the child environment
                // still carries a line pnpm 10 and later refuse to expand.
                writeRegistryNpmrc(projectDir, manifest, adapters.registryUrl);

                if (changed.has(manifest.agentPack.path))
                {
                    const prefix = `${manifest.agentPack.root.replace(/\/+$/, '')}/`;

                    writeAgentPackRecord(projectDir, {
                        schemaVersion: 1,
                        version: manifest.agentPack.version,
                        artifact: manifest.agentPack.artifact,
                        targetDigest: manifest.agentPack.targetDigest,
                        root: manifest.agentPack.root,
                        files: Object.fromEntries(
                            Object.entries(written).filter(([path]) => path.startsWith(prefix)),
                        ),
                    });
                }

                return { kind: 'done', evidence: written };
            },
            async verify()
            {
                // Only the files this plan touches, so the evidence compared on
                // a resume has the same shape as the evidence recorded.
                const digests: Record<string, string | null> = {};

                for (const change of options.plan.managedChanges)
                {
                    // The pack contributes the files it expanded to, so this
                    // has the shape the step itself returned — which is what a
                    // resume compares it against.
                    if (change.path === manifest.agentPack.path)
                    {
                        for (const path of Object.keys(readAgentPackRecord(projectDir)?.files ?? {}))
                        {
                            digests[path] = fileDigest(projectDir, path);
                        }

                        continue;
                    }

                    digests[change.path] = fileDigest(projectDir, change.path);
                }

                return { ok: true, evidence: digests };
            },
        },
        {
            checkpoint: 'install-frozen',
            phase: 'dependencies',
            summary: 'Installing the target release\'s exact dependency graph',
            async run(): Promise<StepOutcome>
            {
                const credential = await requireCredential(adapters, manifest.kitId, paths.licenseFile);

                options.secrets.push(credential.record.credential);

                /* The declaration first, because nothing downstream reads the
                   manifest: pnpm reads `package.json` and the lockfile, and
                   left alone they still describe the release being replaced. */
                const declared = applyManifestVersions(projectDir, manifest);

                await installFrozenGraph(adapters, {
                    projectDir,
                    kitId: manifest.kitId,
                    activationId: credential.license.activationId,
                    localClientId: credential.license.localClientId,
                    credential: credential.record.credential,
                    // The lockfile pins the previous release, so holding it
                    // frozen would install the previous release and succeed.
                    resolve: declared.length > 0,
                    expect: manifest,
                });

                /* Evidence a resume can re-derive, which is what the step
                   engine compares. How many attempts it took and whether the
                   declaration needed repinning are facts about *this run*, and
                   a checkpoint recorded with them could never be verified
                   again — the digest would differ every time. */
                return { kind: 'done', evidence: { packages: manifest.packages.length, graph: 'exact' } };
            },
            async verify()
            {
                const mismatches = installedGraphMismatches(projectDir, manifest);

                return mismatches.length === 0
                    ? { ok: true, evidence: { packages: manifest.packages.length, graph: 'exact' } }
                    : { ok: false, reason: 'installed-graph-is-not-the-target-release' };
            },
        },
        {
            checkpoint: 'migration-applied',
            phase: 'migration',
            summary: 'Applying the expand migrations this release needs',
            async run(context): Promise<StepOutcome>
            {
                const status = await adapters.database.status({ cwd: projectDir });

                assertStatusReadable(status, context.journal.operationId);

                if (!status.configured || !status.reachable)
                {
                    return {
                        kind: 'waiting',
                        status: 'waiting-cloud',
                        code: 'KIT_WAITING_DATABASE',
                        summary: 'The database this project migrates is not reachable right now.',
                        evidence: { configured: status.configured, reachable: status.reachable },
                        next: {
                            command: `spfn kit resume ${context.journal.operationId} --json`,
                            requiresHumanApproval: false,
                        },
                    };
                }
                if (status.pending.length === 0)
                {
                    return { kind: 'done', evidence: { applied: status.applied, pending: 0 } };
                }

                const result = await adapters.database.migrate({ cwd: projectDir, withBackup: true });

                assertMigrationFinished(result, context.journal.operationId);

                return {
                    kind: 'done',
                    evidence: { applied: result.applied, pending: 0 },
                    externalRefs: result.backupId === undefined ? undefined : { backupId: result.backupId },
                };
            },
            async verify()
            {
                return verifyNothingPending(await adapters.database.status({ cwd: projectDir }));
            },
        },
        {
            checkpoint: 'local-gates-passed',
            phase: 'gates',
            summary: 'Checking customer source is untouched, running the release gates and committing',
            async run(context): Promise<StepOutcome>
            {
                /* Before the gates, not after: a gate can write — a build
                   emits, a test fixture rewrites — and the invariant being
                   proved is that *the update* left customer source alone. */
                const changed = verifyCustomerSource(projectDir, context.journal.operationId, [installed, manifest]);

                if (changed.length > 0)
                {
                    throw new KitError('CLI_CUSTOMER_SOURCE_CHANGED', 'This update changed customer-owned files.', {
                        evidence: {
                            files: changed.length,
                            firstPath: changed[0].path,
                            kind: changed[0].before === null
                                ? 'added'
                                : (changed[0].after === null ? 'removed' : 'rewritten'),
                        },
                    });
                }

                const gates = await runLocalGates(adapters, projectDir, manifest.gates);

                writeInstalledLock(paths.lockFile, lockFromManifest(manifest, {
                    manifestUrl: options.manifestUrl,
                    catalogUrl: installed.catalogUrl,
                    cliVersion: adapters.cliVersion,
                    installedAt: adapters.clock.now(),
                }));

                const committed = await adapters.git.commit({
                    cwd: projectDir,
                    message: `chore: update ${manifest.kitId} to ${manifest.version}`,
                });

                await assertCommittedStateTracked(adapters, projectDir);

                return {
                    kind: 'done',
                    evidence: { gates, commit: committed.commit, customerSource: 'unchanged' },
                    externalRefs: { sourceCommit: committed.commit },
                };
            },
        },
    ];
}

/**
 * Compare the checkout against the baseline taken before the first write.
 *
 * A missing baseline is a failure, not a pass. The one way this guard could be
 * wrong in the direction that matters is by having nothing to compare against
 * and reporting "no change" — so it says so instead.
 */
function verifyCustomerSource(
    projectDir: string,
    operationId: string,
    declarations: readonly (ReturnType<typeof requireInstalledLock> | KitReleaseManifestView)[],
): CustomerSourceChange[]
{
    const baseline = readCustomerBaseline(projectDir, operationId);

    if (baseline === null)
    {
        throw new KitError('CLI_CUSTOMER_SOURCE_CHANGED', 'The customer-source baseline for this update is missing.', {
            evidence: { operationId, reason: 'baseline-missing' },
        });
    }

    return compareCustomerSource(baseline.files, customerSourceDigests(projectDir, declarations));
}

/**
 * The package whose version is the release's own version.
 *
 * That is what makes it the release's package rather than a dependency: every
 * other entry in the graph is pinned to a version of its own that has nothing
 * to do with this release's number. Undefined when no package matches, which
 * leaves the answer to whatever convention the transport falls back on.
 */
function releasePackageName(manifest: KitReleaseManifestView): string | undefined
{
    return manifest.packages.find(entry => entry.version === manifest.version)?.name;
}

/**
 * An entitlement question needs the activation to ask about. A checkout with no
 * license file asks with an empty one and is told "not entitled", which is the
 * honest answer — the credential step names the missing file a moment later.
 */
function activationIdOf(licenseFile: string): string
{
    return readLicenseFile(licenseFile)?.activationId ?? '';
}

function idempotent(sink: ReturnType<typeof createEventSink>, release: string): UpdatePlanResult
{
    const summary = `Already on ${release}. Nothing to update.`;

    sink.emit({
        schemaVersion: 1,
        phase: 'preflight',
        status: 'completed',
        code: 'KIT_UPDATE_NOT_NEEDED',
        summary,
    });

    return {
        status: 'completed',
        exitCode: KIT_EXIT.OK,
        code: 'KIT_UPDATE_NOT_NEEDED',
        summary,
        phase: 'preflight',
        events: sink.events,
    };
}

function planResult(
    sink: ReturnType<typeof createEventSink>,
    plan: KitPlanV1,
    digest: string,
): UpdatePlanResult
{
    const summary = `Plan for ${plan.fromRelease ?? 'a new install'} → ${plan.toRelease}.`;

    sink.emit({
        schemaVersion: 1,
        phase: 'plan',
        status: 'completed',
        code: 'KIT_PLAN_READY',
        summary,
        evidence: {
            planDigest: digest,
            packageChanges: plan.packageChanges.length,
            managedChanges: plan.managedChanges.length,
            customerWrites: plan.customerWrites,
            requiresHumanApproval: plan.requiresHumanApproval,
        },
        next: plan.requiresHumanApproval
            ? {
                command: `spfn kit update --to ${plan.toRelease} --approve-plan ${digest} --json`,
                requiresHumanApproval: true,
                approvalDigest: digest,
            }
            : { command: `spfn kit update --to ${plan.toRelease} --json`, requiresHumanApproval: false },
    });

    return {
        status: 'completed',
        exitCode: KIT_EXIT.OK,
        code: 'KIT_PLAN_READY',
        summary,
        phase: 'plan',
        plan,
        planDigest: digest,
        events: sink.events,
    };
}
