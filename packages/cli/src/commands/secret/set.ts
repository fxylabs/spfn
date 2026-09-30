/**
 * `spfn secret set [KEY] [--env <env>] [--instance <name>] [--stdin]` — store a
 * secret value.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { secretEntries, type EnvSchemaEntry } from '../../utils/env-schema.js';
import { describeEnvList, loadEnvList } from '../../utils/env-list.js';
import { assertTargetLayer, resolveTarget, type SecretOptions } from './options.js';
import { storeSecret, describeTarget, type SecretTarget } from './store-value.js';

export async function secretSet(key: string | undefined, options: SecretOptions): Promise<void>
{
    const target = resolveTarget(options);

    if (options.stdin && !key)
    {
        logger.error('--stdin needs the KEY argument.');
        process.exit(1);
    }

    const resolvedKey = key ?? await pickSecretKey(options);
    if (!resolvedKey)
    {
        logger.error('No secret key provided.');
        process.exit(1);
    }

    const entry = await findEntry(options, resolvedKey);
    warnIfNotSecret(options, resolvedKey, entry);
    assertTargetLayer(entry, target);

    const value = options.stdin
        ? await readValueFromStdin(process.stdin)
        : await promptValue(resolvedKey, target);

    logger.step(`Storing ${resolvedKey} → ${await describeTarget(target)}`);

    try
    {
        await storeSecret(process.cwd(), target, resolvedKey, value);
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

/**
 * Read the value from a masked prompt; an empty answer cancels the run.
 */
async function promptValue(key: string, target: SecretTarget): Promise<string>
{
    const { value } = await prompts({
        type: 'password',
        name: 'value',
        message: `Value for ${chalk.cyan(key)} (${target.instance ? `${target.env}.${target.instance}` : target.env})`,
    });

    if (!value)
    {
        logger.warn('Cancelled — no value entered.');
        process.exit(0);
    }

    return value;
}

/**
 * Read the whole of a piped stdin as the value. One trailing newline — the one
 * `echo` or a here-string adds — is dropped; every other byte is kept, inner
 * newlines included. A terminal on stdin is refused rather than read, since
 * typed text would echo the value.
 */
export async function readValueFromStdin(stdin: NodeJS.ReadStream | NodeJS.ReadableStream): Promise<string>
{
    if ('isTTY' in stdin && stdin.isTTY)
    {
        logger.error('--stdin reads a piped value; stdin is a terminal. Pipe the value in, or drop --stdin to be prompted.');
        process.exit(1);
    }

    const chunks: Buffer[] = [];

    for await (const chunk of stdin)
    {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    const value = stripTrailingNewline(Buffer.concat(chunks).toString('utf-8'));

    if (value.length === 0)
    {
        logger.error('--stdin received an empty value.');
        process.exit(1);
    }

    return value;
}

/**
 * Drop exactly one trailing `\n` (or `\r\n`).
 */
export function stripTrailingNewline(value: string): string
{
    return value.replace(/\r?\n$/, '');
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
 * The key's declaration, or undefined when it is undeclared or the schema
 * cannot be loaded here — unknown keys are allowed without comment.
 */
async function findEntry(options: SecretOptions, key: string): Promise<EnvSchemaEntry | undefined>
{
    const list = await loadEnvList(options).catch(() => undefined);

    return list?.schema[key];
}

/**
 * Advisory check: warn when the key exists in the schema but isn't marked secret.
 */
function warnIfNotSecret(options: SecretOptions, key: string, entry: EnvSchemaEntry | undefined): void
{
    if (entry && !entry.sensitive)
    {
        logger.warn(`${key} is not marked as a secret in ${describeEnvList(options)}. Consider declaring it with envSecret().`);
    }
}
