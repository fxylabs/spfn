/**
 * `spfn secret set [KEY] [--env <env>]` — store a secret value.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { secretEntries } from '../../utils/env-schema.js';
import { describeEnvList, loadEnvList } from '../../utils/env-list.js';
import { resolveEnv, type SecretOptions } from './options.js';
import { storeSecret, describeTarget } from './store-value.js';

export async function secretSet(key: string | undefined, options: SecretOptions): Promise<void>
{
    const env = resolveEnv(options.env);

    const resolvedKey = key ?? await pickSecretKey(options);
    if (!resolvedKey)
    {
        logger.error('No secret key provided.');
        process.exit(1);
    }

    await warnIfNotSecret(options, resolvedKey);

    const { value } = await prompts({
        type: 'password',
        name: 'value',
        message: `Value for ${chalk.cyan(resolvedKey)} (${env})`,
    });

    if (!value)
    {
        logger.warn('Cancelled — no value entered.');
        process.exit(0);
    }

    logger.step(`Storing ${resolvedKey} → ${await describeTarget(env)}`);

    try
    {
        await storeSecret(process.cwd(), env, resolvedKey, value);
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

/**
 * Prompt the user to choose from the declared secrets when no key is given.
 */
async function pickSecretKey(options: SecretOptions): Promise<string | undefined>
{
    const list = await loadEnvList(options).catch(() => undefined);
    const entries = list ? secretEntries(list.schema) : [];

    if (entries.length === 0)
    {
        return undefined;
    }

    const { key } = await prompts({
        type: 'select',
        name: 'key',
        message: 'Which secret?',
        choices: entries.map((entry) => ({
            title: entry.key,
            description: entry.description,
            value: entry.key,
        })),
    });

    return key;
}

/**
 * Advisory check: warn when the key exists in the schema but isn't marked secret.
 * Unknown keys (not in any schema read) are allowed without comment, and a
 * schema that cannot be loaded here skips the advisory.
 */
async function warnIfNotSecret(options: SecretOptions, key: string): Promise<void>
{
    const list = await loadEnvList(options).catch(() => undefined);
    const entry = list?.schema[key];

    if (entry && !entry.sensitive)
    {
        logger.warn(`${key} is not marked as a secret in ${describeEnvList(options)}. Consider declaring it with envSecret().`);
    }
}
