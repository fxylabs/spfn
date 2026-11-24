/**
 * `spfn kit status` and `spfn kit check` — unit 06 sections 4.3 and 4.5.
 *
 * Both are read-only, and both follow one rule that is easy to get wrong: a
 * field the CLI could not determine is reported as `unknown`, never as healthy
 * and never as broken. When the network is down, "is a newer release
 * available?" has no answer — and an agent that reads `unknown` waits, while an
 * agent that reads a guess acts on it.
 *
 * That rule is why both take `adapters | null`. Section 4.3 forbids hiding the
 * local state because the remote side is unreachable, and a build with no
 * control-plane client at all is only the most complete case of unreachable:
 * the lock, the license file, the drift and the open operation are all still
 * readable from disk, and everything else says `unknown`.
 *
 * `check` reports; it does not repair. Every diagnostic carries a stable code,
 * the path it is about, and the command that would fix it.
 */

import { detectManagedDrift } from './../drift.js';
import { JournalStore, RESUMABLE_STATUSES } from './../journal.js';
import { readLockOwner } from './../lock.js';
import { kitPaths } from './../paths.js';
import { readInstalledLock, readLicenseFile } from './../installed-state.js';
import { installedGraphMismatches } from './../package-graph.js';
import type { KitDiagnostic } from './../tooling.js';
import type { KitAdapters } from './../ports.js';
import { latestActiveRelease, verifiedCatalog } from './shared.js';

export type Unknowable<T> = T | 'unknown';

export interface KitStatusReport
{
    schemaVersion: 1;
    installed: boolean;
    kitId: string | null;
    release: string | null;
    sequence: number | null;
    manifestDigest: string | null;
    activationId: string | null;
    /** Whether this machine holds a credential for the activation. */
    credential: Unknowable<'present' | 'missing'>;
    managedDrift: Unknowable<number>;
    database: Unknowable<{ applied: number; pending: number }>;
    catalogSequence: Unknowable<number>;
    updateAvailable: Unknowable<string | null>;
    operation: {
        operationId: string;
        type: string;
        status: string;
        phase: string;
        lastCheckpoint: string | null;
    } | null;
    lockHeldBy: string | null;
}

export interface InspectRequest
{
    projectDir: string;
}

export async function runStatus(request: InspectRequest, adapters: KitAdapters | null): Promise<KitStatusReport>
{
    const paths = kitPaths(request.projectDir);
    const lock = readInstalledLock(paths.lockFile);
    const license = readLicenseFile(paths.licenseFile);
    const now = (): string => adapters?.clock.now() ?? new Date().toISOString();
    const journal = new JournalStore(request.projectDir, { now }).readActive();
    const owner = readLockOwner(request.projectDir);
    const report: KitStatusReport = {
        schemaVersion: 1,
        installed: lock !== null,
        kitId: lock?.kitId ?? license?.kitId ?? null,
        release: lock?.release ?? null,
        sequence: lock?.sequence ?? null,
        manifestDigest: lock?.manifestDigest ?? null,
        activationId: license?.activationId ?? null,
        credential: 'unknown',
        managedDrift: lock === null ? 'unknown' : detectManagedDrift(request.projectDir, lock).length,
        database: 'unknown',
        catalogSequence: 'unknown',
        updateAvailable: 'unknown',
        operation: journal === null ? null : {
            operationId: journal.operationId,
            type: journal.type,
            status: journal.status,
            phase: journal.phase,
            lastCheckpoint: [...journal.checkpoints].reverse()
                .find(entry => entry.status === 'completed')?.id ?? null,
        },
        lockHeldBy: owner === null ? null : owner.command,
    };

    if (adapters !== null && license !== null && lock !== null)
    {
        const credential = await adapters.credentials.read({
            kitId: lock.kitId,
            activationId: license.activationId,
            localClientId: license.localClientId,
        }).catch(() => null);

        report.credential = credential === null ? 'missing' : 'present';
    }

    try
    {
        const status = adapters === null
            ? { configured: false, reachable: false, applied: [], pending: [] }
            : await adapters.database.status({ cwd: request.projectDir });

        report.database = status.configured && status.reachable
            ? { applied: status.applied.length, pending: status.pending.length }
            : 'unknown';
    }
    catch
    {
        report.database = 'unknown';
    }

    if (adapters !== null && lock !== null)
    {
        try
        {
            const catalog = await verifiedCatalog(adapters, lock.catalogUrl);
            const latest = latestActiveRelease(catalog);

            report.catalogSequence = catalog.sequence;
            report.updateAvailable = latest.version === lock.release ? null : latest.version;
        }
        catch
        {
            // An unreachable catalog is not a verdict about this project.
            report.catalogSequence = 'unknown';
            report.updateAvailable = 'unknown';
        }
    }

    return report;
}

export interface KitCheckReport
{
    schemaVersion: 1;
    healthy: boolean;
    diagnostics: KitDiagnostic[];
}

export async function runCheck(request: InspectRequest, adapters: KitAdapters | null): Promise<KitCheckReport>
{
    const paths = kitPaths(request.projectDir);
    const lock = readInstalledLock(paths.lockFile);
    const diagnostics: KitDiagnostic[] = [];

    if (lock === null)
    {
        diagnostics.push({
            code: 'KIT_LOCK_INVALID',
            severity: 'error',
            path: '.spfn/kit-lock.json',
            summary: 'This project has no readable Kit lock, so its installed release is unknown.',
            fixCommand: 'spfn kit recover --json',
        });

        return { schemaVersion: 1, healthy: false, diagnostics };
    }

    for (const entry of detectManagedDrift(request.projectDir, lock))
    {
        diagnostics.push({
            code: 'KIT_MANAGED_DRIFT',
            severity: 'error',
            path: entry.path,
            summary: entry.actual === null
                ? 'A file the Kit manages is missing.'
                : 'A file the Kit manages has been edited.',
            expected: entry.expected,
            actual: entry.actual ?? 'missing',
            fixCommand: 'spfn kit status --json',
        });
    }

    const license = readLicenseFile(paths.licenseFile);

    if (license === null)
    {
        diagnostics.push({
            code: 'KIT_CREDENTIAL_MISSING',
            severity: 'error',
            path: '.spfn/license.json',
            summary: 'This checkout records no activation.',
            fixCommand: 'spfn kit recover --json',
        });
    }
    else if (adapters !== null && await adapters.credentials.read({
        kitId: lock.kitId,
        activationId: license.activationId,
        localClientId: license.localClientId,
    }) === null)
    {
        diagnostics.push({
            code: 'KIT_CREDENTIAL_MISSING',
            severity: 'error',
            summary: 'This machine holds no credential for the recorded activation.',
            fixCommand: 'spfn kit recover --json',
        });
    }

    const now = (): string => adapters?.clock.now() ?? new Date().toISOString();
    const journal = new JournalStore(request.projectDir, { now }).readActive();

    if (journal !== null && RESUMABLE_STATUSES.includes(journal.status))
    {
        diagnostics.push({
            code: 'KIT_OPERATION_ACTIVE',
            severity: 'warning',
            summary: `An operation is still open (${journal.type}, ${journal.status}).`,
            fixCommand: `spfn kit resume ${journal.operationId} --json`,
        });
    }
    // The lock records the manifest's packages, and the graph is those packages
    // at those versions — not a `node_modules` directory, which pnpm leaves
    // behind when it empties it.
    if (installedGraphMismatches(request.projectDir, lock).length > 0)
    {
        diagnostics.push({
            code: 'KIT_GATE_FAILED',
            severity: 'warning',
            summary: 'The dependency graph is not installed in this checkout.',
            fixCommand: 'spfn kit restore --json',
        });
    }

    return {
        schemaVersion: 1,
        healthy: diagnostics.every(diagnostic => diagnostic.severity !== 'error'),
        diagnostics,
    };
}
