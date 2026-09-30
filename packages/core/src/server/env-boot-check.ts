/**
 * Environment boot check
 *
 * Every registry's `validate()` is lazy: a variable is read and checked the
 * first time something touches it. For a server that means a missing required
 * variable surfaces as a failed request, possibly hours after a deploy that was
 * broken from the start. This check reads the whole list once, before the
 * server serves anything, so the failure lands where the fix is.
 *
 * The list is `@spfn/core`'s own registry plus whatever the app hands over
 * through `defineServerConfig().env({ registries })`. `SKIP_ENV_VALIDATION`
 * does not apply: it exists so a build step without secrets can import code
 * that holds a lazy proxy, and a server that is about to serve is not a build
 * step.
 */

import { registry as coreRegistry } from '@spfn/core/config';
import { validateAllEnv } from '../env/registry';
import type { EnvValidationResult } from '../env/registry';
import { serverLogger } from './logger';
import type { ServerConfig } from './types';

/**
 * Validate every variable the server can see and log what fails.
 *
 * Only keys and messages are logged, never a value. Registry messages name the
 * key and the rule, core's parsers describe the expected shape rather than
 * echo the input, and a sensitive key's validator message is dropped by the
 * registry because an app's own validator may still echo it.
 *
 * A key declared by two registries fails once in the log, not twice.
 */
export function runEnvBootCheck(config: ServerConfig): EnvValidationResult
{
    const result = validateAllEnv([coreRegistry, ...(config.env?.registries ?? [])]);
    const errors = uniqueByMessage(result.errors);
    const warnings = uniqueByMessage(result.warnings);

    for (const warning of warnings)
    {
        serverLogger.warn(`Environment: ${warning.message}`);
    }

    if (errors.length > 0)
    {
        serverLogger.error(
            `Environment validation failed (${errors.length}):\n`
            + errors.map(error => `  - ${error.message}`).join('\n'),
        );
    }

    return { valid: errors.length === 0, errors, warnings };
}

function uniqueByMessage<T extends { key: string; message: string }>(entries: T[]): T[]
{
    const seen = new Set<string>();

    return entries.filter((entry) =>
    {
        const id = `${entry.key}\n${entry.message}`;

        if (seen.has(id))
        {
            return false;
        }

        seen.add(id);

        return true;
    });
}
