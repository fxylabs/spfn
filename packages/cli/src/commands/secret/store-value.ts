/**
 * Shared write path for `secret set/generate/rotate`.
 *
 * Local secrets go to the OS keychain (with a reference written into `.env.server`);
 * every other environment is written into its encrypted SOPS file. The runtime
 * never sees a keychain reference — `spfn dev` injects locally, GitOps injects in
 * prod.
 */

import { join } from 'path';
import { logger } from '../../utils/logger.js';
import { detectStore, keychainName, keychainRef } from '../../utils/secret-store/index.js';
import { upsertEnvVar, ensureGitignored, restrictEnvFilePerms } from '../../utils/env-file.js';
import { ensureSopsInstalled, sopsSetValue } from '../../utils/sops.js';
import { getSopsFile, hasSopsConfig } from '../../utils/secret-config.js';

/**
 * Where a secret command reads and writes: an environment, and optionally one
 * named instance of it (deployed environments only).
 */
export interface SecretTarget
{
    env: string;
    instance?: string;
}

export function isLocalEnv(env: string): boolean
{
    return env === 'local';
}

/** Env-var name shape — the only keys we let into a keychain item or a SOPS path. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reject a malformed secret key before it reaches the keychain or the SOPS `["key"]`
 * path expression, where a stray quote would corrupt the encrypted file.
 */
export function assertValidKey(key: string): void
{
    if (!KEY_PATTERN.test(key))
    {
        throw new Error(`Invalid secret key "${key}". Use an env-var name: letters, digits, and underscores, not starting with a digit.`);
    }
}

/** Human-readable description of where a value will be stored for a target. */
export async function describeTarget(target: SecretTarget): Promise<string>
{
    if (isLocalEnv(target.env))
    {
        return detectStore().label;
    }

    return `SOPS (${getSopsFile(process.cwd(), target.env, target.instance).relFile})`;
}

/**
 * Store one secret value for the given target.
 */
export async function storeSecret(cwd: string, target: SecretTarget, key: string, value: string): Promise<void>
{
    assertValidKey(key);

    if (isLocalEnv(target.env))
    {
        const store = detectStore();

        if (!(await store.isAvailable()))
        {
            throw new Error(
                `${store.label} is unavailable on this machine. ` +
                'On Windows install `@napi-rs/keyring`; on headless Linux no keyring daemon is present.',
            );
        }

        await store.set(keychainName(key), value);

        const serverEnvPath = join(cwd, '.env.server');
        const result = upsertEnvVar(serverEnvPath, key, keychainRef(key));
        restrictEnvFilePerms(serverEnvPath);
        ensureGitignored(cwd, [{ pattern: '.env.server', comment: 'spfn server env (secrets)' }]);

        logger.success(`Stored ${key} in ${store.label}; .env.server ${result} the reference.`);

        return;
    }

    await ensureSopsInstalled();

    if (!hasSopsConfig(cwd))
    {
        logger.warn(
            '.sops.yaml not found — add a backend (run `spfn secret keygen` for age, or a KMS rule) ' +
            'so the file can be decrypted on deploy.',
        );
    }

    const { absFile, relFile } = getSopsFile(cwd, target.env, target.instance);
    await sopsSetValue(absFile, relFile, key, value);

    logger.success(`Set ${key} in ${relFile} (encrypted). Commit and deploy to apply.`);
}
