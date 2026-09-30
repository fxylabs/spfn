/**
 * `spfn secret list [--env <env>] [--instance <name>]` — show declared secrets and their
 * status for an environment, or for one instance of it. A deployed target lists the
 * secrets `--all` would take for it (see `entriesForTarget`), plus any name in its
 * encrypted file that the whole-app list does not know ("not in list"). A deployed file is read by the names SOPS
 * leaves in the clear — nothing is decrypted. Never prints values.
 */

import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { secretEntries, type EnvSchemaEntry } from '../../utils/env-schema.js';
import { describeEnvList, groupBySource, type EnvList } from '../../utils/env-list.js';
import { detectStore, keychainName } from '../../utils/secret-store/index.js';
import { getSopsFile } from '../../utils/secret-config.js';
import { sopsKeyNames } from '../../utils/sops.js';
import { entriesForTarget, loadSecretList, resolveTarget, type SecretOptions } from './options.js';
import { isLocalEnv, type SecretTarget } from './store-value.js';

type Status = 'set' | 'missing' | 'awaiting-input';

export async function secretList(options: SecretOptions): Promise<void>
{
    const target = resolveTarget(options);
    const label = describeEnvList(options);
    const list = await loadSecretList(options);
    const entries = entriesForTarget(secretEntries(list.schema), target);
    const present = await loadPresence(target, entries);
    const unlisted = options.package ? [] : unlistedNames(list, present);

    if (entries.length === 0 && unlisted.length === 0)
    {
        logger.info(`No secrets declared in ${label}.`);

        return;
    }

    console.log(chalk.blue.bold(`\n🔑 Secrets (${label}) — ${target.instance ? `${target.env}.${target.instance}` : target.env}\n`));

    for (const group of groupBySource(list, entries))
    {
        console.log(`  ${chalk.bold.magenta(group.source)}`);

        for (const entry of group.entries)
        {
            const status = statusOf(entry, present.has(entry.key));
            console.log(`    ${badge(status)} ${chalk.cyan(entry.key)}${entry.generate ? chalk.dim(' (generatable)') : ''}`);
        }
    }

    printUnlisted(unlisted);
    console.log();
}

/**
 * Names in the target's file that no schema in the whole-app list declares —
 * `spfn secret export` skips them. With `-p` the list is one package, so every
 * other package's names would look unlisted; the caller does not ask then.
 */
function unlistedNames(list: EnvList, present: Set<string>): string[]
{
    return [...present].filter((name) => !Object.hasOwn(list.schema, name)).sort();
}

function printUnlisted(names: string[]): void
{
    if (names.length === 0)
    {
        return;
    }

    console.log(`  ${chalk.bold.magenta('(not in list)')}`);

    for (const name of names)
    {
        console.log(`    ${chalk.yellow('?')} ${chalk.cyan(name)} ${chalk.dim('not in list')}`);
    }
}

/**
 * The set of secret keys that currently have a value for this environment. A
 * deployed target's set is every name in its encrypted file, listed or not.
 */
async function loadPresence(target: SecretTarget, entries: EnvSchemaEntry[]): Promise<Set<string>>
{
    if (isLocalEnv(target.env))
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

    return new Set(sopsKeyNames(getSopsFile(process.cwd(), target.env, target.instance).absFile));
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
