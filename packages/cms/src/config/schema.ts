/**
 * CMS Environment Variable Schema
 *
 * Centralized schema definition for all environment variables used in @spfn/cms.
 * This provides type safety, validation, and documentation for CMS configuration.
 *
 * @module config/schema
 */

import {
    defineEnvSchema,
    envString,
    envBoolean,
} from '@spfn/core/env';

/**
 * CMS environment variable schema
 *
 * Defines all CMS environment variables with:
 * - Type information
 * - Default values
 * - Validation rules
 * - Documentation
 *
 * @example
 * ```typescript
 * import { cmsEnvSchema } from '@spfn/cms/config';
 *
 * // Access schema information
 * console.log(cmsEnvSchema.SPFN_CMS_DEFAULT_LOCALE.description);
 * console.log(cmsEnvSchema.SPFN_CMS_DEFAULT_LOCALE.default);
 * ```
 */
export const cmsEnvSchema = defineEnvSchema({
    // ============================================================================
    // Locale Configuration
    // ============================================================================
    SPFN_CMS_DEFAULT_LOCALE: {
        ...envString({
            description: '[DEPRECATED] Use labelConfig.defaultLocale instead. Default language for CMS content (ISO 639-1 language code)',
            default: 'en',
            required: false,
            examples: ['en', 'ko', 'ja', 'zh', 'es', 'fr', 'de'],
        }),
    },

    SPFN_CMS_DETECT_BROWSER_LANGUAGE: {
        ...envBoolean({
            description: 'Automatically detect and use browser language for content localization',
            default: true,
            required: false,
        }),
    },
});
