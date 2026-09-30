/**
 * `spfn secret generate [KEY|--all] [--env <env>]` — mint values for schema secrets
 * that declare a `generate` strategy.
 */

import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { generatableSecrets, type EnvSchema } from '../../utils/env-schema.js';
import { generateSecretValue } from '../../utils/secret-gen.js';
import { loadSecretList, resolveEnv, type SecretOptions } from './options.js';
import { storeSecret, describeTarget } from './store-value.js';

export async function secretGenerate(key: string | undefined, options: SecretOptions): Promise<void>
{
    const env = resolveEnv(options.env);
    const schema = (await loadSecretList(options)).schema;

    const targets = options.all
        ? generatableSecrets(schema)
        : [requireGeneratable(schema, key)];

    if (targets.length === 0)
    {
        logger.warn('No generatable secrets found (none declare a `generate` strategy).');

        return;
    }

    logger.step(`Generating ${targets.length} secret(s) → ${await describeTarget(env)}`);

    for (const entry of targets)
    {
        const value = generateSecretValue(entry.generate!);

        try
        {
            await storeSecret(process.cwd(), env, entry.key, value);
        }
        catch (error)
        {
            logger.error(`${entry.key}: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
    }
}

/**
 * Resolve a single generatable entry, exiting with guidance on misuse.
 */
function requireGeneratable(schema: EnvSchema, key: string | undefined)
{
    if (!key)
    {
        logger.error('Provide a KEY, or use --all to generate every generatable secret.');
        process.exit(1);
    }

    const entry = schema[key];

    if (!entry)
    {
        logger.error(`${key} is not declared in the schema.`);
        process.exit(1);
    }

    if (!entry.generate)
    {
        logger.error(`${chalk.cyan(key)} has no generate strategy — it's an external value. Use \`spfn secret set ${key}\`.`);
        process.exit(1);
    }

    return entry;
}
