/**
 * `spfn secret` — unified secret management across local (keychain) and prod (SOPS).
 */

import { Command } from 'commander';
import { secretSet } from './set.js';
import { secretList } from './list.js';
import { secretGenerate } from './generate.js';
import { secretRotate } from './rotate.js';
import { secretKeygen } from './keygen.js';
import { secretRecipients } from './recipients.js';
import { secretCheck } from './check.js';

const ENV_OPTION = ['-e, --env <env>', 'Target environment (local | development | staging | production)', 'local'] as const;
const PKG_OPTION = ['-p, --package <package>', 'Read only this package\'s env schema (default: the whole app — spfn.config.js env.schemas + installed @spfn/* packages)'] as const;

export const secretCommand = new Command('secret')
    .description('Manage secrets: keychain locally, SOPS (age / GCP KMS / AWS KMS) for deployed environments');

secretCommand
    .command('set [key]')
    .description('Store a secret value (prompts for the value, masked)')
    .option(...ENV_OPTION)
    .option(...PKG_OPTION)
    .action(secretSet);

secretCommand
    .command('list')
    .description('List declared secrets and their status (never prints values)')
    .option(...ENV_OPTION)
    .option(...PKG_OPTION)
    .action(secretList);

secretCommand
    .command('generate [key]')
    .description('Generate value(s) for schema secrets that declare a generate strategy')
    .option('-a, --all', 'Generate every generatable secret')
    .option(...ENV_OPTION)
    .option(...PKG_OPTION)
    .action(secretGenerate);

secretCommand
    .command('rotate [key]')
    .description('Rotate secret value(s); external secrets are flagged for manual reissue')
    .option('-a, --all', 'Rotate every secret')
    .option(...ENV_OPTION)
    .option(...PKG_OPTION)
    .action(secretRotate);

secretCommand
    .command('keygen')
    .description('Generate an age key pair for SOPS (no-cloud backend)')
    .action(secretKeygen);

secretCommand
    .command('recipients <action> [key]')
    .description('Manage .sops.yaml age recipients: add | remove | list')
    .action(secretRecipients);

secretCommand
    .command('check')
    .description('Static hygiene lint — flag plaintext secret leaks')
    .option(...PKG_OPTION)
    .action(secretCheck);
