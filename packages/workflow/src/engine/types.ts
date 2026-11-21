/**
 * Workflow Engine Types
 */

import { logger } from '@spfn/core/logger';
import type { WorkflowDef, WorkflowEvent } from '../builder';
import type { WorkflowExecution, WorkflowStepExecution } from '../entities';

/**
 * Logger interface for workflow engine
 */
export interface WorkflowLogger
{
    info(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

/**
 * Default logger: core's, as `@spfn/workflow`
 *
 * The engine hands a caught error over as `{ error }`, which core's logger
 * describes (#382). The console printed the error object whole — a failed
 * statement's bound values with it.
 */
export const defaultLogger: WorkflowLogger = logger.child('@spfn/workflow');

/**
 * Workflow engine configuration
 */
export interface WorkflowEngineConfig
{
    /**
     * Database instance (drizzle)
     */
    db: unknown;

    /**
     * Storage for large outputs (optional)
     */
    storage?: OutputStorage;

    /**
     * Large output threshold in bytes (default: 1MB)
     */
    largeOutputThreshold?: number;

    /**
     * Custom logger (optional, defaults to core's logger as `@spfn/workflow`)
     */
    logger?: WorkflowLogger;

    /**
     * Enable input schema validation (default: true)
     */
    validateInput?: boolean;
}

/**
 * Output storage interface for large data
 */
export interface OutputStorage
{
    /**
     * Upload data and return URL reference
     */
    upload(data: unknown): Promise<string>;

    /**
     * Download data from URL reference
     */
    download(url: string): Promise<unknown>;
}

/**
 * Execution result from start()
 */
export interface ExecutionResult
{
    /**
     * Execution ID
     */
    id: string;

    /**
     * Workflow name
     */
    workflowName: string;

    /**
     * Initial status
     */
    status: 'pending';
}

/**
 * Execution status with details
 */
export interface ExecutionStatus extends WorkflowExecution
{
    /**
     * Step executions
     */
    steps: WorkflowStepExecution[];
}

/**
 * Cancel options
 */
export interface CancelOptions
{
    /**
     * Execute rollback after cancel
     */
    rollback?: boolean;
}

/**
 * List filter options
 */
export interface ListOptions
{
    /**
     * Filter by workflow name
     */
    workflowName?: string;

    /**
     * Filter by status
     */
    status?: string;

    /**
     * Limit results
     */
    limit?: number;

    /**
     * Offset for pagination
     */
    offset?: number;
}

/**
 * Workflow engine interface
 */
export interface WorkflowEngine<TWorkflows extends WorkflowDef<string, unknown>[]>
{
    /**
     * Start a workflow execution
     */
    start<TName extends TWorkflows[number]['name']>(
        name: TName,
        input: ExtractWorkflowInput<TWorkflows, TName>
    ): Promise<ExecutionResult>;

    /**
     * Get execution status
     */
    get(executionId: string): Promise<ExecutionStatus | null>;

    /**
     * Get step output
     */
    getStepOutput(executionId: string, stepName: string): Promise<unknown>;

    /**
     * List executions
     */
    list(options?: ListOptions): Promise<ExecutionStatus[]>;

    /**
     * Retry failed execution
     */
    retry(executionId: string): Promise<ExecutionResult>;

    /**
     * Cancel execution
     */
    cancel(executionId: string, options?: CancelOptions): Promise<void>;

    /**
     * Subscribe to execution events
     */
    subscribe(
        executionId: string,
        callback: (event: WorkflowEvent) => void
    ): () => void;
}

/**
 * Extract input type from workflow by name
 */
export type ExtractWorkflowInput<
    TWorkflows extends WorkflowDef<string, unknown>[],
    TName extends string,
> = TWorkflows extends (infer W)[]
    ? W extends WorkflowDef<TName, infer TInput>
        ? TInput
        : never
    : never;
