/**
 * Workflow Engine Implementation
 *
 * Orchestrates workflow execution using @spfn/core Job and Events
 */

import { eq, and, desc, inArray } from 'drizzle-orm';
import { Value } from '@sinclair/typebox/value';
import { describeError } from '@spfn/core/logger';
import { assertSafeUrl, SsrfBlockedError } from '@spfn/core/security';

/** URL schemes never legitimate for a storage $ref — classic SSRF/LFI vectors. */
const DANGEROUS_REF_SCHEMES = new Set(['file', 'gopher', 'data', 'ftp', 'ftps', 'dict', 'tftp', 'ldap', 'jar', 'netdoc']);
import type { WorkflowDef, WorkflowEvent, WorkflowStepDef } from '../builder';
import type { WorkflowStatus, WorkflowStepStatus } from '../types';
import {
    workflowExecutions,
    workflowStepExecutions,
    type WorkflowExecution,
    type WorkflowStepExecution,
} from '../entities';
import {
    defaultLogger,
    type WorkflowEngineConfig,
    type WorkflowEngine,
    type WorkflowLogger,
    type ExecutionResult,
    type ExecutionStatus,
    type CancelOptions,
    type ListOptions,
    type ExtractWorkflowInput,
} from './types';

/**
 * Default large output threshold (1MB)
 */
const DEFAULT_LARGE_OUTPUT_THRESHOLD = 1024 * 1024;

/**
 * What the `error` columns and the failure events hold for a failed step:
 * the error's description as JSON text, without its stack frames (#382).
 * Its message would carry a failed statement's SQL and bound values.
 */
function storedError(error: unknown): string
{
    return JSON.stringify(describeError(error, { stack: false }));
}

/**
 * Internal workflow engine implementation
 */
class WorkflowEngineImpl<TWorkflows extends WorkflowDef[]>
implements WorkflowEngine<TWorkflows>
{
    private config: WorkflowEngineConfig;
    private workflows: Map<string, WorkflowDef>;
    private subscribers: Map<string, Set<(event: WorkflowEvent) => void>>;
    private logger: WorkflowLogger;
    /** Track executions currently being processed to prevent race conditions */
    private processingExecutions: Set<string>;

    constructor(
        workflows: TWorkflows,
        config: WorkflowEngineConfig,
    )
    {
        this.config = config;
        this.workflows = new Map();
        this.subscribers = new Map();
        this.logger = config.logger ?? defaultLogger;
        this.processingExecutions = new Set();

        // Register workflows
        for (const wf of workflows)
        {
            this.workflows.set(wf.name, wf);
        }
    }

    /**
     * Get database instance
     */
     
    private get db(): any
    {
        return this.config.db;
    }

    /**
     * Start a workflow execution
     */
    async start<TName extends TWorkflows[number]['name']>(
        name: TName,
        input: ExtractWorkflowInput<TWorkflows, TName>,
    ): Promise<ExecutionResult>
    {
        const workflow = this.workflows.get(name);
        if (!workflow)
        {
            throw new Error(`Workflow '${name}' not found`);
        }

        // Validate input against schema if enabled (default: true)
        if (this.config.validateInput !== false && workflow.inputSchema)
        {
            if (!Value.Check(workflow.inputSchema, input))
            {
                const errors = [...Value.Errors(workflow.inputSchema, input)];
                const errorMessages = errors.map(e => `${e.path}: ${e.message}`).join(', ');
                throw new Error(`Invalid workflow input: ${errorMessages}`);
            }
        }

        // Create execution and steps in a transaction for atomicity
        const execution = await this.db.transaction(async (tx: typeof this.db) =>
        {
            // Create execution record
            const [exec] = await tx
                .insert(workflowExecutions)
                .values({
                    workflowName: name,
                    status: 'pending' as WorkflowStatus,
                    input: input as Record<string, unknown>,
                    currentStep: 0,
                })
                .returning() as WorkflowExecution[];

            // Create step execution records
            const stepRecords = workflow.steps.map((step, index) => ({
                executionId: exec.id,
                stepName: step.name,
                stepIndex: index,
                status: 'pending' as WorkflowStepStatus,
            }));

            if (stepRecords.length > 0)
            {
                await tx
                    .insert(workflowStepExecutions)
                    .values(stepRecords);
            }

            return exec;
        });

        // Emit started event
        this.emitEvent({
            type: 'started',
            workflowName: name,
            executionId: execution.id,
            input: input as unknown,
            timestamp: new Date(),
        });

        // Start first step (async, don't await)
        this.executeNextStep(execution.id, workflow, input as Record<string, unknown>)
            .catch((error) =>
            {
                this.logger.error(`[Workflow:${name}] Execution error`, { error });
            });

        return {
            id: execution.id,
            workflowName: name,
            status: 'pending',
        };
    }

    /**
     * Execute steps iteratively until completion or failure
     */
    private async executeNextStep(
        executionId: string,
        workflow: WorkflowDef,
        input: Record<string, unknown>,
    ): Promise<void>
    {
        // Resolve each completed step's output at most once across the whole loop
        // (resolveOutput can hit object storage). See getCompletedResults.
        const resolvedCache = new Map<string, unknown>();

        while (true)
        {
            // Get current execution state
            const execution = await this.getExecution(executionId);
            if (!execution || (execution.status !== 'pending' && execution.status !== 'running'))
            {
                return;
            }

            // Update status to running
            if (execution.status === 'pending')
            {
                await this.updateExecutionStatus(executionId, 'running');
            }

            // Get completed results from the already-loaded steps (resolveOutput
            // memoized across iterations)
            const results = await this.getCompletedResults(execution.steps, resolvedCache);

            // Find next pending steps
            const pendingSteps = execution.steps.filter(s => s.status === 'pending');
            if (pendingSteps.length === 0)
            {
                // All steps completed
                await this.completeExecution(executionId);

                return;
            }

            // Get the next step(s) to execute
            const currentStepIndex = Math.min(...pendingSteps.map(s => s.stepIndex));

            // Update currentStep in execution record
            await this.db
                .update(workflowExecutions)
                .set({ currentStep: currentStepIndex })
                .where(eq(workflowExecutions.id, executionId));

            // Check if this is a parallel group
            const stepDef = workflow.steps[currentStepIndex];
            if (stepDef.type === 'parallel')
            {
                // Execute all parallel steps concurrently.
                // Wait for ALL steps to complete before handling failures
                // to prevent rollback from racing with still-running steps.
                const parallelSteps = workflow.steps.filter(
                    s => s.parallelGroup === stepDef.parallelGroup,
                );
                const errors = await Promise.all(
                    parallelSteps.map(step =>
                        this.executeStep(executionId, workflow, step, input, results, execution.steps),
                    ),
                );

                // Handle failure after all parallel steps have settled
                const firstError = errors.find(e => e !== null);
                if (firstError)
                {
                    await this.handleStepFailure(executionId, workflow, firstError);

                    return;
                }
            }
            else
            {
                // Execute sequential step
                const error = await this.executeStep(executionId, workflow, stepDef, input, results, execution.steps);
                if (error)
                {
                    await this.handleStepFailure(executionId, workflow, error);

                    return;
                }
            }
        }
    }

    /**
     * Execute a single step
     *
     * Returns the stored error (`storedError`) if the step failed, or null if successful.
     */
    private async executeStep(
        executionId: string,
        workflow: WorkflowDef,
        step: WorkflowStepDef,
        input: Record<string, unknown>,
        results: Record<string, unknown>,
        loadedSteps: WorkflowStepExecution[],
    ): Promise<string | null>
    {
        // Use the step rows already loaded this iteration instead of re-SELECTing.
        const stepExecution = loadedSteps.find(s => s.stepName === step.name);
        if (!stepExecution || stepExecution.status !== 'pending')
        {
            return null;
        }

        // Update step status to running
        await this.updateStepStatus(stepExecution.id, 'running');

        this.emitEvent({
            type: 'step.started',
            workflowName: workflow.name,
            executionId,
            stepName: step.name,
            stepIndex: stepExecution.stepIndex,
            timestamp: new Date(),
        });

        try
        {
            // Map input using the mapper function
            const context = {
                input,
                results,
                execution: {
                    id: executionId,
                    workflowName: workflow.name,
                    startedAt: new Date(),
                },
            };

            const stepInput = step.mapper(context);

            // Execute the job
            const output = await step.job.run(stepInput);

            // Store output (handle large data)
            const storedOutput = await this.storeOutput(output);

            // Update step as completed
            await this.updateStepStatus(stepExecution.id, 'completed', storedOutput);

            this.emitEvent({
                type: 'step.completed',
                workflowName: workflow.name,
                executionId,
                stepName: step.name,
                stepIndex: stepExecution.stepIndex,
                output: storedOutput,
                timestamp: new Date(),
            });

            return null;
        }
        catch (error)
        {
            const errorMessage = storedError(error);

            // Update step as failed
            await this.updateStepStatus(stepExecution.id, 'failed', undefined, errorMessage);

            this.emitEvent({
                type: 'step.failed',
                workflowName: workflow.name,
                executionId,
                stepName: step.name,
                stepIndex: stepExecution.stepIndex,
                error: errorMessage,
                timestamp: new Date(),
            });

            return errorMessage;
        }
    }

    /**
     * Handle step failure - rollback if enabled
     */
    private async handleStepFailure(
        executionId: string,
        workflow: WorkflowDef,
        error: string,
    ): Promise<void>
    {
        // Update execution status
        await this.db
            .update(workflowExecutions)
            .set({
                status: 'failed' as WorkflowStatus,
                error,
            })
            .where(eq(workflowExecutions.id, executionId));

        this.emitEvent({
            type: 'failed',
            workflowName: workflow.name,
            executionId,
            error,
            timestamp: new Date(),
        });

        // Execute rollback if enabled
        if (workflow.rollbackEnabled)
        {
            await this.executeRollback(executionId, workflow);
        }
    }

    /**
     * Execute rollback in reverse order
     */
    private async executeRollback(
        executionId: string,
        workflow: WorkflowDef,
    ): Promise<void>
    {
        await this.updateExecutionStatus(executionId, 'compensating');

        const execution = await this.getExecution(executionId);
        if (!execution) return;

        // Get completed steps in reverse order
        const completedSteps = execution.steps
            .filter(s => s.status === 'completed')
            .sort((a, b) => b.stepIndex - a.stepIndex);

        for (const stepExecution of completedSteps)
        {
            const stepDef = workflow.steps.find(s => s.name === stepExecution.stepName);
            if (!stepDef || !stepDef.job.compensate)
            {
                continue;
            }

            try
            {
                const input = execution.input as Record<string, unknown>;
                const output = await this.resolveOutput(stepExecution.output);

                await stepDef.job.compensate(input, output);

                await this.updateStepStatus(stepExecution.id, 'compensated');
            }
            catch (compensateError)
            {
                // Log but continue with other compensations
                this.logger.error(
                    `[Workflow:${workflow.name}] Compensate error for step ${stepExecution.stepName}`,
                    { error: compensateError },
                );
            }
        }

        await this.updateExecutionStatus(executionId, 'compensated');
    }

    /**
     * Complete the workflow execution
     */
    private async completeExecution(executionId: string): Promise<void>
    {
        const execution = await this.getExecution(executionId);
        if (!execution) return;

        await this.db
            .update(workflowExecutions)
            .set({
                status: 'completed' as WorkflowStatus,
                completedAt: new Date(),
            })
            .where(eq(workflowExecutions.id, executionId));

        this.emitEvent({
            type: 'completed',
            workflowName: execution.workflowName,
            executionId,
            timestamp: new Date(),
        });
    }

    /**
     * Get execution with steps
     */
    private async getExecution(executionId: string): Promise<ExecutionStatus | null>
    {
        const [execution] = await this.db
            .select()
            .from(workflowExecutions)
            .where(eq(workflowExecutions.id, executionId)) as WorkflowExecution[];

        if (!execution) return null;

        const steps = await this.db
            .select()
            .from(workflowStepExecutions)
            .where(eq(workflowStepExecutions.executionId, executionId))
            .orderBy(workflowStepExecutions.stepIndex) as WorkflowStepExecution[];

        return { ...execution, steps };
    }

    /**
     * Get step execution
     */
    private async getStepExecution(
        executionId: string,
        stepName: string,
    ): Promise<WorkflowStepExecution | null>
    {
        const [step] = await this.db
            .select()
            .from(workflowStepExecutions)
            .where(
                and(
                    eq(workflowStepExecutions.executionId, executionId),
                    eq(workflowStepExecutions.stepName, stepName),
                ),
            ) as WorkflowStepExecution[];

        return step || null;
    }

    /**
     * Get completed step results
     */
    private async getCompletedResults(
        steps: WorkflowStepExecution[],
        resolvedCache: Map<string, unknown>,
    ): Promise<Record<string, unknown>>
    {
        // Derive from the steps already loaded by getExecution this iteration —
        // re-SELECTing them here was a third read of the step table per step.
        const results: Record<string, unknown> = {};
        for (const step of steps)
        {
            if (step.status !== 'completed')
            {
                continue;
            }

            // resolveOutput may download large offloaded outputs from object
            // storage. A completed step's output is immutable, so resolve it once
            // per execution — the loop calls this every iteration, which would
            // otherwise re-download every prior output O(N^2) times.
            if (!resolvedCache.has(step.stepName))
            {
                resolvedCache.set(step.stepName, await this.resolveOutput(step.output));
            }

            results[step.stepName] = resolvedCache.get(step.stepName);
        }

        return results;
    }

    /**
     * Update execution status
     */
    private async updateExecutionStatus(
        executionId: string,
        status: WorkflowStatus,
    ): Promise<void>
    {
        await this.db
            .update(workflowExecutions)
            .set({
                status,
            })
            .where(eq(workflowExecutions.id, executionId));
    }

    /**
     * Update step status
     */
    private async updateStepStatus(
        stepId: string,
        status: WorkflowStepStatus,
        output?: unknown,
        error?: string,
    ): Promise<void>
    {
        const updates: Record<string, unknown> = {
            status,
        };

        if (status === 'running')
        {
            updates.startedAt = new Date();
        }
        if (status === 'completed' || status === 'failed')
        {
            updates.completedAt = new Date();
        }
        if (output !== undefined)
        {
            updates.output = output;
        }
        if (error !== undefined)
        {
            updates.error = error;
        }

        await this.db
            .update(workflowStepExecutions)
            .set(updates)
            .where(eq(workflowStepExecutions.id, stepId));
    }

    /**
     * Store output (handle large data)
     */
    private async storeOutput(output: unknown): Promise<unknown>
    {
        if (!output || !this.config.storage) return output;

        const json = JSON.stringify(output);
        const threshold = this.config.largeOutputThreshold ?? DEFAULT_LARGE_OUTPUT_THRESHOLD;

        if (Buffer.byteLength(json, 'utf8') > threshold)
        {
            const url = await this.config.storage.upload(output);

            return { $ref: url };
        }

        return output;
    }

    /**
     * Resolve output (fetch from storage if needed)
     */
    private async resolveOutput(output: unknown): Promise<unknown>
    {
        if (!output) return output;

        const ref = output as { $ref?: string };
        if (ref.$ref && this.config.storage)
        {
            // A $ref normally comes from our own storage.upload(), but step output
            // is data — a malicious step could shape it as { $ref: 'http://169.254...' }
            // (SSRF) or { $ref: 'file:///etc/passwd' } (LFI) to abuse download().
            // storage.download is app-provided so we can't pin its connection; instead
            // validate the ref's scheme before handing it over:
            //   - http(s): full SSRF check (still TOCTOU vs download's own resolve)
            //   - known dangerous schemes (file/gopher/…): reject outright
            //   - plain keys ('uploads/x') and other schemes (s3://, gs://): left to
            //     the backend, which owns its scheme.
            const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(ref.$ref)?.[1]?.toLowerCase();
            if (scheme === 'http' || scheme === 'https')
            {
                await assertSafeUrl(ref.$ref);
            }
            else if (scheme && DANGEROUS_REF_SCHEMES.has(scheme))
            {
                throw new SsrfBlockedError(`Refusing to resolve output $ref with scheme "${scheme}:"`);
            }

            return await this.config.storage.download(ref.$ref);
        }

        return output;
    }

    /**
     * Emit event to subscribers and notification providers
     */
    private emitEvent(event: WorkflowEvent): void
    {
        // Notify subscribers
        const subscribers = this.subscribers.get(event.executionId);
        if (subscribers)
        {
            for (const callback of subscribers)
            {
                try
                {
                    callback(event);
                }
                catch (error)
                {
                    this.logger.error('[WorkflowEngine] Subscriber error', { error });
                }
            }

            // Cleanup subscribers on terminal events to prevent memory leaks
            const terminalEvents: string[] = ['completed', 'failed', 'cancelled'];
            if (terminalEvents.includes(event.type))
            {
                this.subscribers.delete(event.executionId);
            }
        }

        // Send notifications (async, don't block)
        this.sendNotifications(event).catch((error) =>
        {
            this.logger.error('[WorkflowEngine] Notification error', { error });
        });
    }

    /**
     * Send notifications based on workflow config
     */
    private async sendNotifications(event: WorkflowEvent): Promise<void>
    {
        const workflow = this.workflows.get(event.workflowName);
        if (!workflow || workflow.notifyConfigs.length === 0)
        {
            return;
        }

        for (const { on, when, providers } of workflow.notifyConfigs)
        {
            // Check if this event type should trigger notification
            if (!on.includes(event.type))
            {
                continue;
            }

            // Check conditional
            if (when && !when(event))
            {
                continue;
            }

            // Send to all providers
            await Promise.all(
                providers.map(async (provider) =>
                {
                    try
                    {
                        await provider.notify(event);
                    }
                    catch (error)
                    {
                        this.logger.error(`[WorkflowEngine] Notification provider '${provider.name}' error`, { error });
                    }
                }),
            );
        }
    }

    // Public API methods

    async get(executionId: string): Promise<ExecutionStatus | null>
    {
        return this.getExecution(executionId);
    }

    async getStepOutput(executionId: string, stepName: string): Promise<unknown>
    {
        const step = await this.getStepExecution(executionId, stepName);
        if (!step) return null;

        return this.resolveOutput(step.output);
    }

    async list(options?: ListOptions): Promise<ExecutionStatus[]>
    {
        // Build where conditions
        const conditions = [];
        if (options?.workflowName)
        {
            conditions.push(eq(workflowExecutions.workflowName, options.workflowName));
        }
        if (options?.status)
        {
            conditions.push(eq(workflowExecutions.status, options.status as WorkflowStatus));
        }

        // Build query with DB-level pagination
        let query = this.db
            .select()
            .from(workflowExecutions)
            .orderBy(desc(workflowExecutions.createdAt));

        if (conditions.length > 0)
        {
            query = query.where(conditions.length === 1 ? conditions[0] : and(...conditions));
        }

        if (options?.limit)
        {
            query = query.limit(options.limit);
        }
        if (options?.offset)
        {
            query = query.offset(options.offset);
        }

        const executions = await query as WorkflowExecution[];

        if (executions.length === 0)
        {
            return [];
        }

        // Fetch all steps in single query (avoid N+1)
        const executionIds = executions.map(e => e.id);
        const allSteps = await this.db
            .select()
            .from(workflowStepExecutions)
            .where(inArray(workflowStepExecutions.executionId, executionIds))
            .orderBy(workflowStepExecutions.stepIndex) as WorkflowStepExecution[];

        // Group steps by executionId
        const stepsByExecutionId = new Map<string, WorkflowStepExecution[]>();
        for (const step of allSteps)
        {
            const steps = stepsByExecutionId.get(step.executionId) ?? [];
            steps.push(step);
            stepsByExecutionId.set(step.executionId, steps);
        }

        // Combine executions with their steps
        return executions.map(execution => ({
            ...execution,
            steps: stepsByExecutionId.get(execution.id) ?? [],
        }));
    }

    async retry(executionId: string): Promise<ExecutionResult>
    {
        // Prevent concurrent retry calls for the same execution
        if (this.processingExecutions.has(executionId))
        {
            throw new Error(`Execution '${executionId}' is already being processed`);
        }

        const execution = await this.getExecution(executionId);
        if (!execution)
        {
            throw new Error(`Execution '${executionId}' not found`);
        }

        // Validate execution status - only failed or compensated can be retried
        const retryableStatuses: WorkflowStatus[] = ['failed', 'compensated'];
        if (!retryableStatuses.includes(execution.status))
        {
            throw new Error(
                `Cannot retry execution '${executionId}' with status '${execution.status}'. ` +
                `Only 'failed' or 'compensated' executions can be retried.`,
            );
        }

        const workflow = this.workflows.get(execution.workflowName);
        if (!workflow)
        {
            throw new Error(`Workflow '${execution.workflowName}' not found`);
        }

        // Mark as processing to prevent race conditions
        this.processingExecutions.add(executionId);

        try
        {
            if (workflow.resumable)
            {
                // Resume from failed step - only reset failed steps
                await this.updateExecutionStatus(executionId, 'running');

                const failedSteps = execution.steps.filter(s => s.status === 'failed');
                for (const step of failedSteps)
                {
                    await this.updateStepStatus(step.id, 'pending');
                }
            }
            else
            {
                // Restart from beginning - reset all steps
                await this.resetAllSteps(execution.steps);

                await this.db
                    .update(workflowExecutions)
                    .set({
                        status: 'pending' as WorkflowStatus,
                        currentStep: 0,
                        error: null,
                        completedAt: null,
                    })
                    .where(eq(workflowExecutions.id, executionId));
            }

            // Start execution (async)
            this.executeNextStep(
                executionId,
                workflow,
                execution.input as Record<string, unknown>,
            )
                .catch((error) =>
                {
                    this.logger.error(`[Workflow:${workflow.name}] Retry error`, { error });
                })
                .finally(() =>
                {
                    this.processingExecutions.delete(executionId);
                });

            return {
                id: executionId,
                workflowName: execution.workflowName,
                status: 'pending',
            };
        }
        catch (error)
        {
            this.processingExecutions.delete(executionId);
            throw error;
        }
    }

    /**
     * Reset all steps to pending state
     */
    private async resetAllSteps(steps: WorkflowStepExecution[]): Promise<void>
    {
        if (steps.length === 0) return;

        await this.db
            .update(workflowStepExecutions)
            .set({
                status: 'pending' as WorkflowStepStatus,
                output: null,
                error: null,
                startedAt: null,
                completedAt: null,
            })
            .where(inArray(workflowStepExecutions.id, steps.map(s => s.id)));
    }

    async cancel(executionId: string, options?: CancelOptions): Promise<void>
    {
        const execution = await this.getExecution(executionId);
        if (!execution)
        {
            throw new Error(`Execution '${executionId}' not found`);
        }

        // Validate execution status - only pending or running can be cancelled
        const cancellableStatuses: WorkflowStatus[] = ['pending', 'running'];
        if (!cancellableStatuses.includes(execution.status))
        {
            throw new Error(
                `Cannot cancel execution '${executionId}' with status '${execution.status}'. ` +
                `Only 'pending' or 'running' executions can be cancelled.`,
            );
        }

        const workflow = this.workflows.get(execution.workflowName);

        await this.updateExecutionStatus(executionId, 'cancelled');

        this.emitEvent({
            type: 'cancelled',
            workflowName: execution.workflowName,
            executionId,
            timestamp: new Date(),
        });

        if (options?.rollback && workflow)
        {
            await this.executeRollback(executionId, workflow);
        }
    }

    subscribe(
        executionId: string,
        callback: (event: WorkflowEvent) => void,
    ): () => void
    {
        if (!this.subscribers.has(executionId))
        {
            this.subscribers.set(executionId, new Set());
        }

        this.subscribers.get(executionId)!.add(callback);

        return () =>
        {
            this.subscribers.get(executionId)?.delete(callback);
        };
    }
}

/**
 * Create a workflow engine
 *
 * @example
 * ```typescript
 * const engine = createWorkflowEngine({
 *     workflows: [provisionTenant, deprovisionTenant],
 *     db: database,
 * });
 *
 * const execution = await engine.start('provision-tenant', {
 *     tenantId: 'abc',
 *     plan: 'pro',
 * });
 * ```
 */
export function createWorkflowEngine<TWorkflows extends WorkflowDef<string, unknown>[]>(
    options: {
        workflows: TWorkflows;
    } & WorkflowEngineConfig,
): WorkflowEngine<TWorkflows>
{
    const { workflows, ...config } = options;

    return new WorkflowEngineImpl(workflows, config);
}
