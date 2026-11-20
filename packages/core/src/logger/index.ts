/**
 * Logger Module Exports
 *
 * Entry point for logger module
 *
 * 💡 Usage examples:
 * ```typescript
 * import { logger } from '@spfn/core';
 *
 * // Basic usage
 * logger.info('Application started');
 * logger.error('Connection failed', error);
 *
 * // Create module-specific logger
 * const dbLogger = logger.child('database');
 * dbLogger.debug('Connecting to database...');
 *
 * // Add context
 * logger.warn('Retry attempt', { attempt: 3, delay: 1000 });
 * ```
 *
 * 💡 Transports:
 * - Console: Colored output for development, JSON for production
 */

// Logger Instance
export { logger } from './factory';
export { Logger } from './logger';
export { describeError } from './error-description';

// Types
export type { LogLevel, Transport } from './types';
export type { ErrorDescription, DatabaseErrorDescription } from './error-description';
