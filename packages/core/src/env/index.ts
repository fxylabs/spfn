/**
 * Environment Variable Management
 *
 * Schema-based environment variable validation and type-safe access.
 *
 * Note: For environment file loading (loadEnv), use '@spfn/core/env/loader'
 * which is server-only due to 'node:fs' usage.
 *
 * @example
 * ```typescript
 * import { createEnvRegistry, defineEnvSchema, envString } from '@spfn/core/env';
 *
 * // Define schema
 * const schema = defineEnvSchema({
 *   DATABASE_URL: envString({ description: 'Database URL', required: true }),
 * });
 *
 * // Create registry and validate
 * const env = createEnvRegistry(schema).validate();
 * console.log(env.DATABASE_URL);
 * ```
 *
 * @module env
 */

// Parser utilities
export {
    // Core types
    type Parser,
    // String parsers
    parseString,
    createStringParser,
    // Boolean parser
    parseBoolean,
    // Number parsers
    parseNumber,
    createNumberParser,
    parseInteger,
    parseDecimal,
    // URL parsers
    parseUrl,
    createUrlParser,
    parsePostgresUrl,
    parseRedisUrl,
    // Enum parser
    parseEnum,
    createEnumParser,
    // JSON parser
    parseJson,
    createJsonParser,
    // Array parser
    parseArray,
    createArrayParser,
    // Parser composition
    chain,
    withFallback,
    optional,
    //
    createSecureSecretParser,
    createPasswordParser,
} from './validator';

// === Schema-based Environment Management (NEW) ===

// Schema definition
export {
    defineEnvSchema,
    envString,
    envSecret,
    envNumber,
    envBoolean,
    envUrl,
    envEnum,
    envJson,
    isClientAccessible,
    isServerOnly,
    isNextjsAccessible,
    isSpfnServerOnly,
} from './schema';

export type {
    EnvVarSchema,
    EnvSchemaCollection,
    EnvLayer,
    InferEnvType,
} from './schema';

// Registry
export {
    EnvRegistry,
    createEnvRegistry,
    validateAllEnv,
} from './registry';

export type {
    EnvValidationResult,
} from './registry';

// Loader functions are server-only (use 'node:fs')
// Import from '@spfn/core/env/loader' for server-side usage

export type * from './types';
