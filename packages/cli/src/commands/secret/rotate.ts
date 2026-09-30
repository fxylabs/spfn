/**
 * `spfn secret rotate [KEY|--all] [--env <env>]` — replace secret values.
 *
 * Generatable secrets (those with a `generate` strategy) are minted fresh and
 * stored. External secrets can't be regenerated here — the command points the user
 * at the provider. Rotation changes the source of truth only; a deploy is needed to
 * roll it out, and a value a departing teammate already saw must be rotated at the
 * value level regardless of who can decrypt.
 */

import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { secretEntries, type EnvSchema, type EnvSchemaEntry } from '../../utils/env-schema.js';
import { generateSecretValue } from '../../utils/secret-gen.js';
import { loadSecretList, resolveEnv, type SecretOptions } from './options.js';
import { storeSecret, describeTarget } from './store-value.js';

export async function secretRotate(key: string | undefined, options: SecretOptions): Promise<void>
{
    const env = resolveEnv(options.env);
    const schema = (await loadSecretList(options)).schema;

    const targets = options.all ? secretEntries(schema) : [requireEntry(schema, key)];
    const generatable = targets.filter((entry) => entry.generate);
    const external = targets.filter((entry) => !entry.generate);

    if (generatable.length > 0)
    {
        logger.step(`Rotating ${generatable.length} secret(s) → ${await describeTarget(env)}`);

        for (const entry of generatable)
        {
            try
            {
                await storeSecret(process.cwd(), env, entry.key, generateSecretValue(entry.generate!));
            }
            catch (error)
            {
                logger.error(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }
        }
    }

    for (const entry of external)
    {
        logger.warn(`${chalk.cyan(entry.key)} is external — reissue it at the provider, then \`spfn secret set ${entry.key} --env ${env}\`.`);
    }

    if (generatable.length > 0)
    {
        logger.info('Rotation updates the source only — commit and deploy to apply.');
    }
}

function requireEntry(schema: EnvSchema, key: string | undefined): EnvSchemaEntry
{
    if (!key)
    {
        logger.error('Provide a KEY, or use --all to rotate every secret.');
        process.exit(1);
    }

    const entry = schema[key];

    if (!entry)
    {
        logger.error(`${key} is not declared in the schema.`);
        process.exit(1);
    }

    return entry;
}
