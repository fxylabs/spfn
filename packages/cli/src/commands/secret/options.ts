/**
 * Shared option shape and `--env` validation for the `spfn secret` subcommands.
 */

import { logger } from '../../utils/logger.js';
import { VALID_ENVS } from '../../utils/env-schema.js';
import { loadEnvList, type EnvList } from '../../utils/env-list.js';

export interface SecretOptions
{
    env?: string;
    package?: string;
    all?: boolean;
}

/**
 * The env list a subcommand works on — the `-p` package alone, or the whole
 * app. Declarations two sources disagree on are reported; a list that cannot
 * be built ends the run.
 */
export async function loadSecretList(options: SecretOptions): Promise<EnvList>
{
    const list = await loadEnvList(options).catch((error: unknown) =>
    {
        logger.error(error instanceof Error ? error.message : String(error));

        return process.exit(1);
    });

    for (const notice of list.notices)
    {
        logger.warn(notice);
    }

    return list;
}

/**
 * Resolve and validate the `--env` value, defaulting to `local`.
 */
export function resolveEnv(env?: string): string
{
    const value = env ?? 'local';

    if (!VALID_ENVS.includes(value as (typeof VALID_ENVS)[number]))
    {
        logger.error(`Invalid environment: "${value}". Valid values: ${VALID_ENVS.join(', ')}`);
        process.exit(1);
    }

    return value;
}
