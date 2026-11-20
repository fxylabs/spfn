/**
 * Shutdown Manager
 *
 * Manages graceful shutdown with drain behavior.
 * All tracked operations must complete before shutdown proceeds.
 *
 * Features:
 * - Hook registry: Multiple modules can register independent cleanup handlers
 * - Operation tracking: Long-running tasks are awaited during shutdown (drain)
 * - State management: isShuttingDown() for rejecting new work
 */

import { serverLogger } from './logger';

// ============================================================================
// Types
// ============================================================================

export interface ShutdownHookOptions
{
    /**
     * Timeout for this hook in milliseconds
     * If the hook exceeds this time, it is skipped and the next hook runs.
     * The shutdown budget can cut it shorter: a hook never runs past the
     * hooks' budget, which all hooks and `beforeShutdown` share (see
     * shutdown-budget.ts).
     * @default 10000 (10s)
     */
    timeout?: number;

    /**
     * Execution order (lower runs first)
     * @default 100
     */
    order?: number;
}

interface ShutdownHook
{
    name: string;
    handler: () => Promise<void>;
    timeout: number;
    order: number;
}

interface TrackedOperation
{
    name: string;
    startedAt: number;
}

type ShutdownState = 'running' | 'draining' | 'closed';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HOOK_TIMEOUT = 10_000;
const DEFAULT_HOOK_ORDER = 100;
const DRAIN_POLL_INTERVAL = 500;

// ============================================================================
// ShutdownManager
// ============================================================================

export class ShutdownManager
{
    private state: ShutdownState = 'running';
    private hooks: ShutdownHook[] = [];
    private operations = new Map<string, TrackedOperation>();
    private operationCounter = 0;

    /**
     * Register a shutdown hook
     *
     * Hooks run in order during shutdown, after all tracked operations drain.
     * The job queue still accepts sends while they run; job handlers that were
     * already running may still be running too.
     * Each hook has its own timeout — failure does not block subsequent hooks.
     *
     * @example
     * shutdown.onShutdown('ai-service', async () => {
     *     await aiService.cancelPending();
     * }, { timeout: 30000, order: 10 });
     */
    onShutdown(
        name: string,
        handler: () => Promise<void>,
        options?: ShutdownHookOptions,
    ): void
    {
        this.hooks.push({
            name,
            handler,
            timeout: options?.timeout ?? DEFAULT_HOOK_TIMEOUT,
            order: options?.order ?? DEFAULT_HOOK_ORDER,
        });

        // Keep sorted by order
        this.hooks.sort((a, b) => a.order - b.order);

        serverLogger.debug(`Shutdown hook registered: ${name}`, {
            order: options?.order ?? DEFAULT_HOOK_ORDER,
            timeout: `${options?.timeout ?? DEFAULT_HOOK_TIMEOUT}ms`,
        });
    }

    /**
     * Track a long-running operation
     *
     * During shutdown (drain phase), the process waits for ALL tracked
     * operations to complete before proceeding with cleanup.
     *
     * If shutdown has already started, the operation is rejected immediately.
     *
     * @returns The operation result (pass-through)
     *
     * @example
     * const result = await shutdown.trackOperation(
     *     'ai-generate',
     *     aiService.generate(prompt)
     * );
     */
    async trackOperation<T>(name: string, operation: Promise<T>): Promise<T>
    {
        if (this.state !== 'running')
        {
            throw new Error(`Cannot start operation '${name}': server is shutting down`);
        }

        return this.track(name, operation);
    }

    /**
     * Track work core itself started and did not await — an after-commit
     * callback — so the drain waits for it like any tracked operation
     *
     * Unlike `trackOperation()`, it is accepted while the shutdown is draining:
     * the work was accepted before the shutdown began (its transaction
     * committed) and is finishing now. Once the drain and hooks are over
     * (state `closed`) nothing waits any more, so it is not recorded.
     *
     * @internal called by the transaction runner
     */
    trackDetached(name: string, work: Promise<unknown>): void
    {
        if (this.state === 'closed')
        {
            return;
        }

        void this.track(name, work).catch(() => undefined);
    }

    private async track<T>(name: string, operation: Promise<T>): Promise<T>
    {
        const id = `${name}-${++this.operationCounter}`;

        this.operations.set(id, {
            name,
            startedAt: Date.now(),
        });

        serverLogger.debug(`Operation tracked: ${id}`, {
            activeOperations: this.operations.size,
        });

        try
        {
            return await operation;
        }
        finally
        {
            this.operations.delete(id);

            serverLogger.debug(`Operation completed: ${id}`, {
                activeOperations: this.operations.size,
            });
        }
    }

    /**
     * Whether the server is shutting down
     *
     * Use this to reject new work early (e.g., return 503 in route handlers).
     */
    isShuttingDown(): boolean
    {
        return this.state !== 'running';
    }

    /**
     * Number of currently active tracked operations, after-commit callbacks included
     */
    getActiveOperationCount(): number
    {
        return this.operations.size;
    }

    /**
     * Mark shutdown as started immediately
     *
     * Call this at the very beginning of the shutdown sequence so that:
     * - Health check returns 503 right away
     * - trackOperation() rejects new work
     * - isShuttingDown() returns true
     */
    beginShutdown(): void
    {
        if (this.state !== 'running')
        {
            return;
        }
        this.state = 'draining';
        serverLogger.info('Shutdown manager: state set to draining');
    }

    /**
     * Execute the full shutdown sequence
     *
     * 1. State → draining (reject new operations)
     * 2. Wait for all tracked operations to complete (drain)
     * 3. Run shutdown hooks in order
     * 4. State → closed
     *
     * The server's own shutdown runs `drain()` and `runHooks()` separately, so
     * the hooks get a share of the budget the drain cannot spend.
     *
     * @param timeout - Max time for the drain and the hooks together (ms):
     *   the drain may use all of it, and each hook gets the lesser of its own
     *   timeout and what is left; a hook with nothing left is skipped
     */
    async execute(timeout: number): Promise<void>
    {
        // beginShutdown() may have already been called
        if (this.state === 'closed')
        {
            serverLogger.warn('ShutdownManager.execute() called but already closed');

            return;
        }

        const deadline = Date.now() + timeout;

        await this.drain(timeout);
        await this.runHooks(deadline);
    }

    /**
     * Wait, at most `timeout` ms, until no tracked operation is in flight
     *
     * The drain is done the first time it finds none in flight. Work tracked
     * while it waits — an after-commit callback started by a transaction that
     * committed during the drain, or by another callback — is in flight from
     * the moment it starts, so it is waited for like the rest. Work started
     * after the drain ended is not waited for by it.
     */
    async drain(timeout: number): Promise<void>
    {
        this.state = 'draining';
        serverLogger.info('Shutdown manager: draining started', {
            activeOperations: this.operations.size,
            registeredHooks: this.hooks.length,
            timeout: `${timeout}ms`,
        });

        const deadline = Date.now() + timeout;

        while (this.operations.size > 0 && Date.now() < deadline)
        {
            const remaining = deadline - Date.now();
            const ops = Array.from(this.operations.values()).map(op => ({
                name: op.name,
                elapsed: `${Math.round((Date.now() - op.startedAt) / 1000)}s`,
            }));

            serverLogger.info('Shutdown manager: drain in progress', {
                activeOperations: this.operations.size,
                remainingTimeout: `${Math.round(remaining / 1000)}s`,
                operations: ops,
            });

            await sleep(Math.min(DRAIN_POLL_INTERVAL, remaining));
        }

        this.logDrainResult();
    }

    /**
     * Run the registered hooks in order, none past `deadline`; state → closed
     */
    async runHooks(deadline: number): Promise<void>
    {
        if (this.hooks.length > 0)
        {
            serverLogger.info(`Shutdown manager: executing ${this.hooks.length} hooks...`);
        }

        for (const hook of this.hooks)
        {
            await this.executeHook(hook, Math.min(hook.timeout, deadline - Date.now()));
        }

        this.state = 'closed';
        serverLogger.info('Shutdown manager: all hooks executed');
    }

    // ========================================================================
    // Private
    // ========================================================================

    private logDrainResult(): void
    {
        if (this.operations.size > 0)
        {
            const abandoned = Array.from(this.operations.values()).map(op => op.name);
            serverLogger.warn('Shutdown manager: drain timeout — abandoning operations', {
                abandoned,
            });
        }
        else
        {
            serverLogger.info('Shutdown manager: all operations drained successfully');
        }
    }

    /**
     * Run one hook for at most `timeout` ms; failure does not block the next hook
     */
    private async executeHook(hook: ShutdownHook, timeout: number): Promise<void>
    {
        if (timeout <= 0)
        {
            serverLogger.warn(`Shutdown hook [${hook.name}] skipped: the shutdown budget is spent`);

            return;
        }

        serverLogger.debug(`Shutdown hook [${hook.name}] starting (timeout: ${timeout}ms)`);

        try
        {
            await withTimeout(
                hook.handler(),
                timeout,
                `Shutdown hook '${hook.name}' timeout after ${timeout}ms`,
            );
            serverLogger.info(`Shutdown hook [${hook.name}] completed`);
        }
        catch (error)
        {
            serverLogger.error(
                `Shutdown hook [${hook.name}] failed`,
                { error },
            );
        }
    }
}

// ============================================================================
// Singleton
// ============================================================================

/**
 * On globalThis, not in a module variable: core's entry points are bundled
 * separately, and the transaction runner (in `@spfn/core/db`) must reach the
 * same manager the server (in `@spfn/core/server`) drains.
 */
const MANAGER_KEY = Symbol.for('spfn:shutdown-manager');

const g = globalThis as { [MANAGER_KEY]?: ShutdownManager | null };

/**
 * Get the global ShutdownManager instance
 *
 * Available after server starts. Use this to register shutdown hooks
 * or track long-running operations.
 *
 * @example
 * import { getShutdownManager } from '@spfn/core/server';
 *
 * const shutdown = getShutdownManager();
 *
 * // Register cleanup
 * shutdown.onShutdown('my-service', async () => {
 *     await myService.close();
 * });
 *
 * // Track long operation
 * await shutdown.trackOperation('ai-task', longRunningPromise);
 */
export function getShutdownManager(): ShutdownManager
{
    g[MANAGER_KEY] ??= new ShutdownManager();

    return g[MANAGER_KEY];
}

/**
 * The manager for a server run that starts now
 *
 * A manager whose shutdown has begun belonged to an earlier run — one that was
 * closed, or whose shutdown was driven by hand — and is replaced by a fresh
 * one, so the new run neither starts "shutting down" nor loses its
 * after-commit callbacks. A manager whose shutdown has not begun is kept with
 * its hooks: those were registered for this run before it started.
 *
 * @internal called by startServer()
 */
export function startShutdownRun(): ShutdownManager
{
    if (g[MANAGER_KEY]?.isShuttingDown())
    {
        g[MANAGER_KEY] = null;
    }

    return getShutdownManager();
}

/**
 * End the run `manager` belongs to, once its shutdown is complete: the next
 * `getShutdownManager()` returns a fresh manager, without that run's hooks or
 * shutdown state. A newer run's manager is left alone.
 *
 * The server calls it when `close()` finishes; call it after driving a
 * manager's shutdown yourself (`drain()` / `execute()`).
 */
export function endShutdownRun(manager: ShutdownManager): void
{
    if (g[MANAGER_KEY] === manager)
    {
        g[MANAGER_KEY] = null;
    }
}

/**
 * Reset the singleton (for testing)
 * @internal
 */
export function resetShutdownManager(): void
{
    g[MANAGER_KEY] = null;
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void>
{
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    message: string,
): Promise<T>
{
    let timeoutId: NodeJS.Timeout | undefined;

    return Promise.race([
        promise.finally(() =>
        {
            if (timeoutId) clearTimeout(timeoutId);
        }),
        new Promise<never>((_, reject) =>
        {
            timeoutId = setTimeout(() =>
            {
                reject(new Error(message));
            }, timeout);
        }),
    ]);
}
