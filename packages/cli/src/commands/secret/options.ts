/**
 * Shared option shape and `--env` / `--instance` validation for the `spfn secret`
 * subcommands.
 */

import { logger } from '../../utils/logger.js';
import { VALID_ENVS, layerOf, type EnvLayer, type EnvSchemaEntry } from '../../utils/env-schema.js';
import { loadEnvList, type EnvList } from '../../utils/env-list.js';
import { isLocalEnv, type SecretTarget } from './store-value.js';

export interface SecretOptions
{
    env?: string;
    instance?: string;
    package?: string;
    all?: boolean;
    stdin?: boolean;
}

/** Instance name shape — it becomes part of a file name, so lowercase and dashes only. */
const INSTANCE_PATTERN = /^[a-z0-9-]+$/;

/**
 * The env list a subcommand works on — the `-p` package alone, or the whole
 * app. A list that cannot be built — two sources declaring a key differently,
 * say — ends the run.
 */
export async function loadSecretList(options: SecretOptions): Promise<EnvList>
{
    return await loadEnvList(options).catch((error: unknown) =>
    {
        logger.error(error instanceof Error ? error.message : String(error));

        return process.exit(1);
    });
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

/**
 * Whether an `--instance` value is a valid instance name.
 */
export function isValidInstance(instance: string): boolean
{
    return INSTANCE_PATTERN.test(instance);
}

/**
 * Resolve `--env` and `--instance` together. An instance names a deployment of a
 * deployed environment, so it is refused for `local` and when malformed.
 */
export function resolveTarget(options: SecretOptions): SecretTarget
{
    const env = resolveEnv(options.env);
    const instance = options.instance;

    if (instance === undefined)
    {
        return { env };
    }

    if (!isValidInstance(instance))
    {
        logger.error(`Invalid instance: "${instance}". Use lowercase letters, digits and dashes.`);
        process.exit(1);
    }

    if (isLocalEnv(env))
    {
        logger.error('--instance applies to a deployed environment; pass --env too.');
        process.exit(1);
    }

    return { env, instance };
}

/**
 * The layer a target's file holds — `instance` with `--instance`, `environment`
 * without — or undefined for `local`, where the keychain holds every value.
 */
export function targetLayer(target: SecretTarget): EnvLayer | undefined
{
    if (isLocalEnv(target.env))
    {
        return undefined;
    }

    return target.instance ? 'instance' : 'environment';
}

/**
 * The entries whose values belong in the target's file.
 */
export function entriesForTarget(entries: EnvSchemaEntry[], target: SecretTarget): EnvSchemaEntry[]
{
    const layer = targetLayer(target);

    return layer ? entries.filter((entry) => layerOf(entry) === layer) : entries;
}

/**
 * End the run when a declared key belongs to another layer than the target's
 * file — `spfn secret export` would refuse the value where it is written.
 */
export function assertTargetLayer(entry: EnvSchemaEntry | undefined, target: SecretTarget): void
{
    const layer = targetLayer(target);

    if (!entry || !layer || layerOf(entry) === layer)
    {
        return;
    }

    const hint = layer === 'environment' ? 'pass --instance <name>' : 'drop --instance';
    logger.error(`${entry.key} is declared with layer "${layerOf(entry)}" — ${hint}.`);
    process.exit(1);
}
