/**
 * The step engine every Kit operation runs on.
 *
 * Install, restore and update differ in their steps, not in how a step is run,
 * checkpointed, failed or picked up again — so that part lives here once.
 *
 * The resume rule is the reason this file exists (unit 06 section 4.8). A
 * completed checkpoint is *not* permission to skip a step. On a resume each
 * completed step is asked to re-read the world and produce its evidence again;
 * only when that evidence digests to the same value as the one recorded is the
 * checkpoint accepted. If the world has moved — a different commit, a different
 * migration set, a different managed file — the operation stops with
 * `KIT_RESUME_MISMATCH` rather than continuing on top of a state nobody
 * planned for.
 *
 * One answer is not a moved world: a step whose own effect is gone — an
 * installed graph that is no longer on disk — says so with `rerun`, and is run
 * again rather than refused. Running it again is what restores it, and the
 * steps after it then go on as they would have.
 */

import { KitError, KIT_EXIT, isKitError } from './errors.js';
import { digestOfJson } from './digest.js';
import type { KitEventSink, KitOperationResult } from './events.js';
import {
    JournalStore,
    checkpoint as findCheckpoint,
    isCheckpointComplete,
    type KitExternalRefs,
    type KitOperationJournalV1,
} from './journal.js';
import type { KitLockHandle } from './lock.js';
import type { KitCheckpointId, KitOperationStatus } from './validate.js';

export interface StepContext
{
    journal: KitOperationJournalV1;
    /** Values steps hand to later steps. Never a secret that outlives the run. */
    state: Record<string, unknown>;
    resuming: boolean;
}

export type StepOutcome =
    | { kind: 'done'; evidence?: unknown; externalRefs?: KitExternalRefs }
    | {
        kind: 'waiting';
        status: Extract<KitOperationStatus, 'waiting-approval' | 'waiting-cloud' | 'waiting-settlement'>;
        code: string;
        summary: string;
        evidence?: Record<string, string | number | boolean | null>;
        next?: { command: string; requiresHumanApproval: boolean; approvalDigest?: string };
    };

export interface VerifyResult
{
    ok: boolean;
    /**
     * With `ok: false`: what is missing is this step's own effect, not a
     * project that moved, and running the step again restores it. The runner
     * runs it again instead of stopping with `KIT_RESUME_MISMATCH`.
     */
    rerun?: boolean;
    /** Why the world no longer matches. Printed with the mismatch. */
    reason?: string;
    /** Re-read evidence. Digested and compared with the recorded digest. */
    evidence?: unknown;
}

export interface OperationStep
{
    checkpoint: KitCheckpointId;
    /** Lower-case phase name; the journal's `phase` field takes this shape. */
    phase: string;
    summary: string;
    run(context: StepContext): Promise<StepOutcome>;
    /** Re-read the world on a resume. A step without one is re-run instead. */
    verify?(context: StepContext): Promise<VerifyResult>;
}

export interface ExecuteOperationOptions
{
    journalStore: JournalStore;
    journal: KitOperationJournalV1;
    steps: readonly OperationStep[];
    sink: KitEventSink;
    lock?: KitLockHandle;
    resuming?: boolean;
    /** Values available to the first step. */
    initialState?: Record<string, unknown>;
    /** Emitted on success, e.g. `local-ready`. */
    completedCode?: string;
    completedSummary?: string;
}

export async function executeOperation(options: ExecuteOperationOptions): Promise<KitOperationResult>
{
    const { journalStore, sink } = options;
    const context: StepContext = {
        journal: options.journal,
        state: { ...(options.initialState ?? {}) },
        resuming: options.resuming === true,
    };

    try
    {
        for (const step of options.steps)
        {
            if (isCheckpointComplete(context.journal, step.checkpoint))
            {
                const reused = await reuseCheckpoint(step, context, sink);

                if (reused instanceof KitError)
                {
                    return failed(reused, context, options);
                }
                if (reused === 'reused')
                {
                    continue;
                }
            }

            const outcome = await runStep(step, context, options);

            if (outcome !== null)
            {
                return outcome;
            }
        }

        context.journal = journalStore.update(context.journal, { status: 'completed', phase: 'complete' });
        journalStore.archive(context.journal);

        const code = options.completedCode ?? 'KIT_OPERATION_COMPLETED';
        const summary = options.completedSummary ?? 'The operation finished.';

        sink.emit({
            schemaVersion: 1,
            operationId: context.journal.operationId,
            phase: 'complete',
            status: 'completed',
            code,
            summary,
        });

        return {
            status: 'completed',
            exitCode: KIT_EXIT.OK,
            code,
            summary,
            operationId: context.journal.operationId,
            phase: 'complete',
            events: sink.events,
        };
    }
    finally
    {
        options.lock?.release();
    }
}

/**
 * Returns the mismatch to report, `'rerun'` when the step's own effect is gone
 * and the step is to run again, or `'reused'` when the checkpoint still holds.
 */
async function reuseCheckpoint(
    step: OperationStep,
    context: StepContext,
    sink: KitEventSink,
): Promise<KitError | 'rerun' | 'reused'>
{
    if (!context.resuming || step.verify === undefined)
    {
        sink.emit({
            schemaVersion: 1,
            operationId: context.journal.operationId,
            phase: step.phase,
            status: 'progress',
            code: 'KIT_CHECKPOINT_REUSED',
            summary: `${step.summary} — already done.`,
        });

        return 'reused';
    }

    const verified = await step.verify(context);

    if (!verified.ok && verified.rerun === true)
    {
        sink.emit({
            schemaVersion: 1,
            operationId: context.journal.operationId,
            phase: step.phase,
            status: 'progress',
            code: 'KIT_CHECKPOINT_RERUN',
            summary: `${step.summary} — its effect is gone from the project, so it runs again.`,
            evidence: { checkpoint: step.checkpoint, reason: verified.reason ?? null },
        });

        return 'rerun';
    }

    const recorded = findCheckpoint(context.journal, step.checkpoint)?.evidenceDigest;
    const reReadDigest = verified.evidence === undefined ? undefined : digestOfJson(verified.evidence);

    if (!verified.ok || (recorded !== undefined && reReadDigest !== undefined && recorded !== reReadDigest))
    {
        return new KitError('KIT_RESUME_MISMATCH', 'The project is no longer in the state this operation recorded.', {
            evidence: {
                checkpoint: step.checkpoint,
                reason: verified.reason ?? 'evidence-digest-changed',
                recordedEvidence: recorded ?? null,
                currentEvidence: reReadDigest ?? null,
            },
            operationId: context.journal.operationId,
            phase: step.phase,
            next: { command: 'spfn kit status --json', requiresHumanApproval: false },
        });
    }

    sink.emit({
        schemaVersion: 1,
        operationId: context.journal.operationId,
        phase: step.phase,
        status: 'progress',
        code: 'KIT_CHECKPOINT_VERIFIED',
        summary: `${step.summary} — verified against the project as it is now.`,
    });

    return 'reused';
}

/** Runs one step. Returns a result when the operation must stop here. */
async function runStep(
    step: OperationStep,
    context: StepContext,
    options: ExecuteOperationOptions,
): Promise<KitOperationResult | null>
{
    const { journalStore, sink } = options;

    context.journal = journalStore.update(context.journal, { phase: step.phase, status: 'active' });

    sink.emit({
        schemaVersion: 1,
        operationId: context.journal.operationId,
        phase: step.phase,
        status: 'started',
        code: 'KIT_PHASE_STARTED',
        summary: step.summary,
    });

    let outcome: StepOutcome;

    try
    {
        outcome = await step.run(context);
    }
    catch (error)
    {
        if (!isKitError(error))
        {
            throw error;
        }

        context.journal = journalStore.failCheckpoint(context.journal, step.checkpoint);

        return failed(error, context, options);
    }

    if (outcome.kind === 'waiting')
    {
        context.journal = journalStore.update(context.journal, { status: outcome.status, phase: step.phase });

        sink.emit({
            schemaVersion: 1,
            operationId: context.journal.operationId,
            phase: step.phase,
            status: 'waiting',
            code: outcome.code,
            summary: outcome.summary,
            evidence: outcome.evidence,
            next: outcome.next,
        });

        return {
            status: 'waiting',
            exitCode: KIT_EXIT.INPUT_REQUIRED,
            code: outcome.code,
            summary: outcome.summary,
            operationId: context.journal.operationId,
            phase: step.phase,
            evidence: outcome.evidence,
            next: outcome.next,
            events: sink.events,
        };
    }

    if (outcome.externalRefs !== undefined)
    {
        context.journal = journalStore.update(context.journal, { externalRefs: outcome.externalRefs });
    }

    context.journal = journalStore.completeCheckpoint(context.journal, step.checkpoint, outcome.evidence);

    return null;
}

function failed(
    error: KitError,
    context: StepContext,
    options: ExecuteOperationOptions,
): KitOperationResult
{
    const phase = error.phase ?? context.journal.phase;

    options.sink.emit({
        schemaVersion: 1,
        operationId: context.journal.operationId,
        phase,
        status: 'failed',
        code: error.code,
        summary: error.message,
        evidence: error.evidence,
        next: error.next,
    });

    return {
        status: 'failed',
        exitCode: error.exitCode,
        code: error.code,
        summary: error.message,
        operationId: context.journal.operationId,
        phase,
        evidence: error.evidence,
        next: error.next,
        events: options.sink.events,
    };
}
