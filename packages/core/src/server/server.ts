/**
 * SPFN Server
 *
 * Main entry point for server functionality.
 */

export { createServer } from './create-server';
export { CORE_NAMESPACE, CORE_HEALTH_PATH, CORE_TIME_PATH } from './namespace';
export {
    CORE_TIME_OPERATION_ID,
    CORE_TIME_ROUTE,
    ServerTimeResponseSchema,
    createCoreTimeRoute,
} from './server-time';
export type { ServerClock, ServerTimeResponse } from './server-time';
export { startServer } from './start-server';
export { validateServerConfig } from './validation';
export { printBanner } from './banner';
export { getShutdownManager, endShutdownRun } from './shutdown-manager';
export type { ShutdownHookOptions } from './shutdown-manager';
export * from './types';
