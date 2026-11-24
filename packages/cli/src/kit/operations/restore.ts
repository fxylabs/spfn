/**
 * `spfn kit restore` — unit 06 section 4.2.
 *
 * The case this exists for: someone clones the repository on a machine where
 * the private packages have never been installed. There is no project-local
 * `spfn` binary yet, no `node_modules`, and no way to run anything the Kit
 * ships. What there *is* is the committed lock, the committed license file and
 * the public CLI — and that has to be enough.
 *
 * Restore reinstalls; it does not re-scaffold. It writes no managed file and
 * no customer file. If a managed file has drifted, restoring on top of it would
 * either overwrite someone's edit or install a graph that does not match the
 * source, so it stops instead.
 */

import { KitError } from './../errors.js';
import { createEventSink, type KitOperationResult } from './../events.js';
import { detectManagedDrift } from './../drift.js';
import { JournalStore } from './../journal.js';
import { acquireOperationLock } from './../lock.js';
import { kitPaths } from './../paths.js';
import { writeOperationContext } from './../operation-context.js';
import { requireInstalledLock } from './../installed-state.js';
import { executeOperation, type OperationStep, type StepOutcome } from './../runner.js';
import type { KitAdapters } from './../ports.js';
import {
    installFrozenGraph,
    newOperationId,
    requireCredential,
    runLocalGates,
    verifiedManifest,
    verifyInstalledGraph,
} from './shared.js';

export interface RestoreRequest
{
    projectDir: string;
    json: boolean;
    write?: (line: string) => void;
    resuming?: boolean;
}

export async function runRestore(request: RestoreRequest, adapters: KitAdapters): Promise<KitOperationResult>
{
    const paths = kitPaths(request.projectDir);
    const journalStore = new JournalStore(request.projectDir, { now: () => adapters.clock.now() });
    const existing = journalStore.readActive();
    const secrets: string[] = [];
    const sink = createEventSink({ json: request.json, write: request.write, knownSecrets: secrets });
    const lock = requireInstalledLock(paths.lockFile);

    if (existing !== null && existing.type !== 'restore')
    {
        throw new KitError('KIT_OPERATION_ACTIVE', 'This project has a different operation open.', {
            evidence: { operationId: existing.operationId, type: existing.type },
            next: { command: `spfn kit resume ${existing.operationId} --json`, requiresHumanApproval: false },
        });
    }

    // The manifest is fetched again rather than trusted from the lock: the lock
    // says which release, the signature says the release is still that release.
    const manifest = await verifiedManifest(adapters, lock.manifestUrl);

    if (manifest.manifestDigest !== lock.manifestDigest || manifest.version !== lock.release)
    {
        throw new KitError('KIT_LOCK_INVALID', 'The committed lock and the signed manifest disagree.', {
            evidence: {
                lockRelease: lock.release,
                manifestRelease: manifest.version,
                lockDigest: lock.manifestDigest,
                manifestDigest: manifest.manifestDigest,
            },
            next: { command: 'spfn kit recover --json', requiresHumanApproval: false },
        });
    }

    const operationId = existing?.operationId
        ?? newOperationId('restore', adapters.clock.now(), String(lock.sequence));

    // Taken before the journal is written, so a busy project is refused without
    // gaining a second operation record.
    const handle = acquireOperationLock({
        root: request.projectDir,
        operationId,
        command: 'kit restore',
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
            type: 'restore',
            kitId: lock.kitId,
            sourceRelease: lock.release,
            targetRelease: lock.release,
            manifestDigest: lock.manifestDigest,
            planDigest: lock.manifestDigest,
            phase: 'preflight',
            status: 'active',
            checkpoints: [{ id: 'catalog-verified', status: 'completed', completedAt: adapters.clock.now() }],
            externalRefs: {},
        });

        writeOperationContext(request.projectDir, {
            schemaVersion: 1,
            operationId: journal.operationId,
            catalogUrl: lock.catalogUrl,
            manifestUrl: lock.manifestUrl,
        });
    }
    catch (error)
    {
        handle.release();

        throw error;
    }

    const steps: OperationStep[] = [
        {
            checkpoint: 'install-frozen',
            phase: 'dependencies',
            summary: 'Reinstalling the exact dependency graph this checkout records',
            async run(): Promise<StepOutcome>
            {
                const drift = detectManagedDrift(request.projectDir, lock);

                if (drift.length > 0)
                {
                    throw new KitError('KIT_MANAGED_DRIFT', 'A managed file in this checkout no longer matches the release.', {
                        evidence: { firstPath: drift[0].path, files: drift.length },
                    });
                }

                const credential = await requireCredential(adapters, lock.kitId, paths.licenseFile);

                secrets.push(credential.record.credential);

                const evidence = await installFrozenGraph(adapters, {
                    projectDir: request.projectDir,
                    kitId: lock.kitId,
                    activationId: credential.license.activationId,
                    localClientId: credential.license.localClientId,
                    credential: credential.record.credential,
                    // The signed manifest, not the lock: its scopes are the
                    // routes pnpm sends to the private registry, and nothing
                    // signs the lock.
                    manifest,
                });

                return { kind: 'done', evidence: { attempts: evidence.attempts } };
            },
            async verify()
            {
                const drift = detectManagedDrift(request.projectDir, lock);

                if (drift.length > 0)
                {
                    return { ok: false, reason: `managed-drift: ${drift[0].path}` };
                }

                return verifyInstalledGraph(request.projectDir, manifest);
            },
        },
        {
            checkpoint: 'local-gates-passed',
            phase: 'gates',
            summary: 'Re-running the release gates on the restored checkout',
            async run(): Promise<StepOutcome>
            {
                const status = await adapters.database.status({ cwd: request.projectDir });
                const gates = await runLocalGates(adapters, request.projectDir, manifest);

                return {
                    kind: 'done',
                    evidence: { gates, pendingMigrations: status.reachable ? status.pending.length : null },
                };
            },
        },
    ];

    return executeOperation({
        journalStore,
        journal,
        lock: handle,
        sink,
        resuming: existing !== null,
        steps,
        completedCode: 'KIT_RESTORE_COMPLETE',
        completedSummary: `The checkout is restored to ${lock.kitId} ${lock.release} and its gates pass.`,
    });
}
