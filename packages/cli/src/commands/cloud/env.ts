/**
 * `spfn cloud env pull|push` — move project keys between the providers and the
 * local SPFN env layout without a value ever reaching the terminal.
 *
 * pull: Supabase keys → where each belongs. The anon key and project URL are
 * public by design and land in `.env.local`; the service-role key and (optionally)
 * `DATABASE_URL` go through the keychain path (`storeSecret`), leaving only a
 * `secret:keychain:` reference in `.env.server`.
 *
 * push: local env values → Vercel project env. Values resolve from the local env
 * files and the keychain; everything is sent `encrypted` except `NEXT_PUBLIC_*`.
 * Output reports key names and counts only.
 */

import { join } from 'path';
import prompts from 'prompts';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { parseEnvFile, upsertEnvVar, ensureGitignored } from '../../utils/env-file.js';
import { storeSecret } from '../secret/store-value.js';
import { readCloudConfig, requireLinked } from '../../utils/cloud/config.js';
import { requireCloudToken } from '../../utils/cloud/tokens.js';
import { getSupabaseApiKeys, getSupabasePoolerConfigs, type SupabaseApiKey } from '../../utils/cloud/supabase-api.js';
import { upsertVercelEnvVars, type VercelEnvVar } from '../../utils/cloud/vercel-api.js';
import { KEYCHAIN_REF_PREFIX, resolveKeychainEnv } from '../../utils/secret-store/index.js';

export async function cloudEnvPull(options: { dbUrl?: boolean }): Promise<void>
{
    const cwd = process.cwd();

    try
    {
        const linked = requireLinked(readCloudConfig(cwd), 'supabase');
        const token = await requireCloudToken('supabase');
        const keys = await getSupabaseApiKeys(token, linked.projectRef);

        writePublicValues(cwd, linked.projectRef, keys);
        await storeServiceKey(cwd, keys);

        if (options.dbUrl)
        {
            await storeDatabaseUrl(cwd, token, linked.projectRef);
        }
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    logger.info('Values were written to files/keychain only — none were displayed.');
}

function writePublicValues(cwd: string, projectRef: string, keys: SupabaseApiKey[]): void
{
    const envLocalPath = join(cwd, '.env.local');

    ensureGitignored(cwd, [{ pattern: '.env.local', comment: 'local env (per-machine values)' }]);
    upsertEnvVar(envLocalPath, 'NEXT_PUBLIC_SUPABASE_URL', `https://${projectRef}.supabase.co`);
    logger.success('NEXT_PUBLIC_SUPABASE_URL → .env.local');

    const anon = findKey(keys, ['anon', 'publishable']);

    if (anon)
    {
        upsertEnvVar(envLocalPath, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', anon.api_key);
        logger.success(`NEXT_PUBLIC_SUPABASE_ANON_KEY → .env.local (from "${anon.name}"; public by design)`);
    }
    else
    {
        logger.warn('No anon/publishable key found on the project — skipped NEXT_PUBLIC_SUPABASE_ANON_KEY.');
    }
}

async function storeServiceKey(cwd: string, keys: SupabaseApiKey[]): Promise<void>
{
    const service = findKey(keys, ['service_role', 'secret']);

    if (!service)
    {
        logger.warn('No service_role/secret key found on the project — skipped SUPABASE_SERVICE_ROLE_KEY.');

        return;
    }

    await storeSecret(cwd, { env: 'local' }, 'SUPABASE_SERVICE_ROLE_KEY', service.api_key);
}

/** Match by key name first, then by type — the dashboard is migrating names (anon→publishable). */
function findKey(keys: SupabaseApiKey[], candidates: string[]): SupabaseApiKey | undefined
{
    return keys.find(key => candidates.includes(key.name))
        ?? keys.find(key => key.type !== undefined && candidates.includes(key.type));
}

async function storeDatabaseUrl(cwd: string, token: string, projectRef: string): Promise<void>
{
    const template = await poolerTemplate(token, projectRef);

    if (!template)
    {
        logger.warn('Could not read the pooler connection template from the API — skipped DATABASE_URL. Copy it from the dashboard (Connect → Session pooler) into `spfn secret set DATABASE_URL` instead.');

        return;
    }

    const { password } = await prompts({
        type: 'password',
        name: 'password',
        message: 'Supabase database password (set at project creation; not retrievable via API)',
    });

    if (!password)
    {
        logger.warn('No password entered — skipped DATABASE_URL.');

        return;
    }

    const url = sessionPoolerUrl(template, password);
    await storeSecret(cwd, { env: 'local' }, 'DATABASE_URL', url);
    logger.info('This is the session-mode pooler connection (IPv4-safe, works for migrations). Serverless runtime can use the transaction pooler (port 6543) instead.');
}

async function poolerTemplate(token: string, projectRef: string): Promise<string | undefined>
{
    try
    {
        const configs = await getSupabasePoolerConfigs(token, projectRef);

        return configs.find(c => c.database_type === 'PRIMARY')?.connection_string
            ?? configs.find(c => c.connection_string)?.connection_string;
    }
    catch (error)
    {
        logger.warn(error instanceof Error ? error.message : String(error));

        return undefined;
    }
}

/**
 * Fill the API's `[YOUR-PASSWORD]` placeholder and pin session mode (port 5432):
 * the API hands out the transaction-mode template (port 6543), which breaks
 * prepared statements and therefore migrations. Exported for tests.
 */
export function sessionPoolerUrl(template: string, password: string): string
{
    const filled = template.replace('[YOUR-PASSWORD]', encodeURIComponent(password));
    const url = new URL(filled);

    url.port = '5432';

    return url.toString();
}

export async function cloudEnvPush(keys: string[]): Promise<void>
{
    const cwd = process.cwd();

    if (keys.length === 0)
    {
        logger.error('Name the env keys to push: `spfn cloud env push KEY [KEY...]` (values are looked up locally, never passed as arguments).');
        process.exit(1);
    }

    try
    {
        const linked = requireLinked(readCloudConfig(cwd), 'vercel');
        const token = await requireCloudToken('vercel');
        const { vars, missing, unresolved } = await resolveLocalValues(cwd, keys);

        for (const key of unresolved)
        {
            logger.warn(`${key}: .env.server points at the keychain but the item could not be resolved — skipped (a stale value from another file will not be pushed in its place).`);
        }

        for (const key of missing)
        {
            logger.warn(`${key}: not found in .env/.env.local/.env.server or the keychain — skipped.`);
        }

        if (vars.length === 0)
        {
            logger.error('Nothing to push.');
            process.exit(1);
        }

        const result = await upsertVercelEnvVars(token, linked.projectId, vars, linked.teamId);
        const failedKeys = new Set(result.failed.map(f => f.key));

        for (const failure of result.failed)
        {
            logger.error(`${failure.key}: rejected by Vercel — ${failure.message}`);
        }

        for (const envVar of vars.filter(v => !failedKeys.has(v.key)))
        {
            logger.success(`${envVar.key} → Vercel ${chalk.cyan(linked.projectName)} (${envVar.type}, ${envVar.target.join('+')})`);
        }

        if (result.failed.length > 0)
        {
            process.exit(1);
        }
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

async function resolveLocalValues(cwd: string, keys: string[]): Promise<{ vars: VercelEnvVar[]; missing: string[]; unresolved: string[] }>
{
    const publicEnv = { ...parseEnvFile(join(cwd, '.env')), ...parseEnvFile(join(cwd, '.env.local')) };
    const serverEnv = parseEnvFile(join(cwd, '.env.server'));
    const keychain = await resolveKeychainEnv(cwd);

    const vars: VercelEnvVar[] = [];
    const missing: string[] = [];
    const unresolved: string[] = [];

    for (const key of keys)
    {
        // A `.env.server` keychain reference is authoritative for its key. When the
        // item cannot be resolved (keyring unavailable, item deleted), the key is an
        // error — falling back to another file would silently push a stale value.
        if (serverEnv[key]?.startsWith(KEYCHAIN_REF_PREFIX) && keychain.env[key] === undefined)
        {
            unresolved.push(key);
            continue;
        }

        const value = keychain.env[key] ?? serverEnv[key] ?? publicEnv[key];

        if (value === undefined)
        {
            missing.push(key);
            continue;
        }

        vars.push({
            key,
            value,
            type: key.startsWith('NEXT_PUBLIC_') ? 'plain' : 'encrypted',
            target: ['production', 'preview'],
        });
    }

    return { vars, missing, unresolved };
}
