/**
 * Core Package Configuration
 *
 * @example
 * ```typescript
 * import { registry } from '@spfn/core/config';
 *
 * const env = registry.validate();
 * console.log(env.DB_POOL_MAX);
 * ```
 *
 * @module config
 */

import { createEnvRegistry } from '@spfn/core/env';
import { coreEnvSchema } from './schema';

/**
 * Core environment schema
 */
export { coreEnvSchema as envSchema } from './schema';

/**
 * The table owner's URL variable's name (see the schema)
 */
export { DATABASE_OWNER_URL } from './schema';

/**
 * Environment registry
 *
 * @example
 * ```typescript
 * // Reset for testing
 * registry.reset();
 * ```
 */
export const registry = createEnvRegistry(coreEnvSchema);

/**
 * Validated environment configuration
 */
export const env = registry.validate();
