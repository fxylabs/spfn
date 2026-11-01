/**
 * @spfn/core/server - Server creation and lifecycle management
 *
 * High-level server utilities for SPFN framework.
 *
 * @module @spfn/core/server
 *
 * @example
 * ```ts
 * import { startServer, createServer } from '@spfn/core/server';
 *
 * // Level 1: Zero config - Just start
 * await startServer();
 *
 * // Level 2: Runtime config
 * await startServer({ port: 4000, cors: { origin: '*' } });
 *
 * // Level 3: Programmatic app creation
 * const app = await createServer({ debug: true });
 * ```
 */

import '@spfn/core/config';

// Server functions
/** @deprecated Use `loadEnv` from '@spfn/core/env/loader' instead */
export { loadEnvFiles } from './dotenv-loader';
export { loadEnv } from '../env/loader';
export {
    createServer,
    startServer,
    CORE_NAMESPACE,
    CORE_HEALTH_PATH,
    CORE_TIME_PATH,
    CORE_TIME_OPERATION_ID,
    CORE_TIME_ROUTE,
    ServerTimeResponseSchema,
    createCoreTimeRoute,
} from './server';
export type { ServerClock, ServerTimeResponse } from './server';
export { createServerlessApp, resetServerlessApp, provisionInfrastructure } from './serverless';
export { getShutdownManager } from './shutdown-manager';

// Migration boot gate
export { getMigrationSnapshot, resetMigrationSnapshot, PendingMigrationsError } from './migration-gate';
export type { MigrationSnapshot } from './migration-gate';
export { TenancyRoleError } from './tenancy-gate';
export type { TenancyGateResult, TenancyRoleFinding } from './tenancy-gate';

// Config builder
export { defineServerConfig } from './config-builder';

// Server types
export type { ServerConfig, AppFactory, ServerInstance } from './types';
export type { ShutdownHookOptions } from './shutdown-manager';
