/**
 * Workflow Router
 *
 * Defines a collection of workflows for server registration
 */

import type { WorkflowDef } from '../builder';
import type { WorkflowEngine, WorkflowEngineConfig, OutputStorage, WorkflowLogger } from '../engine';
import { createWorkflowEngine } from '../engine';

/**
 * Workflow router configuration options
 */
export interface WorkflowRouterConfig
{
    /**
     * Large output threshold in bytes
     * Outputs larger than this will be stored in external storage
     * @default 1024 * 1024 (1MB)
     */
    largeOutputThreshold?: number;

    /**
     * Storage for large outputs (optional)
     */
    storage?: OutputStorage;

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
 * Workflow router instance
 *
 * Contains workflow definitions and provides access to the engine
 */
export interface WorkflowRouter<TWorkflows extends WorkflowDef[]>
{
    /**
     * Registered workflows
     */
    readonly workflows: TWorkflows;

    /**
     * Internal workflows reference
     */
    readonly _workflows: TWorkflows;

    /**
     * Workflow engine instance (available after initialization)
     */
    readonly engine: WorkflowEngine<TWorkflows>;

    /**
     * Check if engine is initialized
     */
    readonly isInitialized: boolean;

    /**
     * Initialize the workflow engine
     * Called internally by @spfn/core server
     *
     * @internal
     */
    _init: (db: WorkflowEngineConfig['db'], options?: WorkflowRouterConfig) => void;
}

/**
 * Internal state for workflow router
 */
interface WorkflowRouterState<TWorkflows extends WorkflowDef[]>
{
    engine: WorkflowEngine<TWorkflows> | null;
}

/**
 * Define a workflow router for server registration
 *
 * @example
 * ```typescript
 * import { workflow, defineWorkflowRouter } from '@spfn/workflow';
 *
 * const provisionTenant = workflow('provision-tenant')
 *     .input(Type.Object({ tenantId: Type.String() }))
 *     .pipe(createResources, ctx => ({ tenantId: ctx.input.tenantId }))
 *     .build();
 *
 * export const workflowRouter = defineWorkflowRouter([
 *     provisionTenant,
 *     deprovisionTenant,
 * ]);
 *
 * // In server.config.ts
 * export default defineServerConfig()
 *     .workflows(workflowRouter)
 *     .build();
 *
 * // Usage
 * await workflowRouter.engine.start('provision-tenant', { tenantId: 'abc' });
 * ```
 */
export function defineWorkflowRouter<TWorkflows extends WorkflowDef[]>(
    workflows: TWorkflows,
): WorkflowRouter<TWorkflows>
{
    const state: WorkflowRouterState<TWorkflows> = {
        engine: null,
    };

    return {
        workflows,
        _workflows: workflows,

        get engine(): WorkflowEngine<TWorkflows>
        {
            if (!state.engine)
            {
                throw new Error(
                    'Workflow engine not initialized. ' +
                    'Make sure the server is started with .workflows(router) configuration.',
                );
            }

            return state.engine;
        },

        get isInitialized(): boolean
        {
            return state.engine !== null;
        },

        _init(db: WorkflowEngineConfig['db'], options?: WorkflowRouterConfig): void
        {
            if (state.engine)
            {
                // Already initialized, skip
                return;
            }

            state.engine = createWorkflowEngine({
                db,
                workflows,
                largeOutputThreshold: options?.largeOutputThreshold,
                storage: options?.storage,
                logger: options?.logger,
                validateInput: options?.validateInput,
            });
        },
    };
}

/**
 * Type guard to check if value is a WorkflowRouter
 */
export function isWorkflowRouter(value: unknown): value is WorkflowRouter<WorkflowDef[]>
{
    return (
        typeof value === 'object' &&
        value !== null &&
        '_workflows' in value &&
        '_init' in value &&
        typeof (value as WorkflowRouter<WorkflowDef[]>)._init === 'function'
    );
}
