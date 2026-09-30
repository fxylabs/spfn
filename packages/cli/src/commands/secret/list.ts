/**
 * `spfn secret list [--env <env>]` — show declared secrets and their status for an
 * environment. Never prints values.
 */

import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { secretEntries, type EnvSchemaEntry } from '../../utils/env-schema.js';
import { describeEnvList, groupBySource } from '../../utils/env-list.js';
import { detectStore, keychainName } from '../../utils/secret-store/index.js';
import { getSopsFile } from '../../utils/secret-config.js';
import { ensureSopsInstalled, sopsDecrypt } from '../../utils/sops.js';
import { loadSecretList, resolveEnv, type SecretOptions } from './options.js';
import { isLocalEnv } from './store-value.js';

type Status = 'set' | 'missing' | 'awaiting-input';

export async function secretList(options: SecretOptions): Promise<void>
{
    const env = resolveEnv(options.env);
    const label = describeEnvList(options);
    const list = await loadSecretList(options);
    const entries = secretEntries(list.schema);

    if (entries.length === 0)
    {
        logger.info(`No secrets declared in ${label}.`);

        return;
    }

    const present = await loadPresence(env, entries);

    console.log(chalk.blue.bold(`\n🔑 Secrets (${label}) — ${env}\n`));

    for (const group of groupBySource(list, entries))
    {
        console.log(`  ${chalk.bold.magenta(group.source)}`);

        for (const entry of group.entries)
        {
            const status = statusOf(entry, present.has(entry.key));
            console.log(`    ${badge(status)} ${chalk.cyan(entry.key)}${entry.generate ? chalk.dim(' (generatable)') : ''}`);
        }
    }

    console.log();
}

/**
 * The set of secret keys that currently have a value for this environment.
 */
async function loadPresence(env: string, entries: EnvSchemaEntry[]): Promise<Set<string>>
{
    if (isLocalEnv(env))
    {
        const store = detectStore();

        if (!(await store.isAvailable()))
        {
            logger.warn(`${store.label} unavailable — status shown as missing.`);

            return new Set();
        }

        const present = new Set<string>();

        for (const entry of entries)
        {
            if ((await store.get(keychainName(entry.key))) !== null)
            {
                present.add(entry.key);
            }
        }

        return present;
    }

    await ensureSopsInstalled();
    const { absFile } = getSopsFile(process.cwd(), env);
    const decrypted = await sopsDecrypt(absFile);

    return new Set(Object.keys(decrypted));
}

function statusOf(entry: EnvSchemaEntry, present: boolean): Status
{
    if (present)
    {
        return 'set';
    }

    return entry.generate ? 'missing' : 'awaiting-input';
}

function badge(status: Status): string
{
    switch (status)
    {
        case 'set':
            return chalk.green('●');
        case 'missing':
            return chalk.yellow('○');
        case 'awaiting-input':
            return chalk.red('○');
    }
}
