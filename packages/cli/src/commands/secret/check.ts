/**
 * `spfn secret check` — static hygiene lint for declared secrets.
 *
 * Flags secrets sitting in plaintext where they shouldn't, and points server secrets
 * at the keychain workflow. Reads files only; never prints values.
 */

import { join } from 'path';
import chalk from 'chalk';
import { secretEntries } from '../../utils/env-schema.js';
import { parseEnvFile } from '../../utils/env-file.js';
import { KEYCHAIN_REF_PREFIX } from '../../utils/secret-store/index.js';
import { hasSopsConfig } from '../../utils/secret-config.js';
import { loadSecretList, type SecretOptions } from './options.js';

/**
 * Files that may be committed — a real secret value here is a leak. The reference
 * is split by consumer (.env.local.example / .env.server.example); the combined
 * .env.example stays on the list because a project scaffolded before the split
 * still has one, and a leak in it is just as real.
 */
const COMMITTED_FILES = ['.env', '.env.example', '.env.local.example', '.env.server.example'];

const PLACEHOLDER = /(your-|changeme|placeholder|example|<.*>)/i;

export async function secretCheck(options: SecretOptions): Promise<void>
{
    const cwd = process.cwd();
    const entries = secretEntries((await loadSecretList(options)).schema);

    const secretKeys = new Set(entries.map((entry) => entry.key));
    const issues: string[] = [];
    const warnings: string[] = [];

    for (const file of COMMITTED_FILES)
    {
        const parsed = parseEnvFile(join(cwd, file));

        for (const [key, value] of Object.entries(parsed))
        {
            if (secretKeys.has(key) && value.length > 0 && !PLACEHOLDER.test(value))
            {
                issues.push(`${chalk.cyan(key)} has a real value in committed ${chalk.yellow(file)} — move it to the keychain/SOPS.`);
            }
        }
    }

    const serverEnv = parseEnvFile(join(cwd, '.env.server'));

    for (const key of secretKeys)
    {
        const value = serverEnv[key];

        if (value && !value.startsWith(KEYCHAIN_REF_PREFIX))
        {
            warnings.push(`${chalk.cyan(key)} is plaintext in .env.server — run \`spfn secret set ${key}\` to move it to the keychain.`);
        }
    }

    report(issues, warnings, cwd);
}

function report(issues: string[], warnings: string[], cwd: string): void
{
    console.log(chalk.blue.bold('\n🔍 Secret hygiene check\n'));

    for (const issue of issues)
    {
        console.log(`  ${chalk.red('✗')} ${issue}`);
    }

    for (const warning of warnings)
    {
        console.log(`  ${chalk.yellow('⚠')} ${warning}`);
    }

    if (!hasSopsConfig(cwd))
    {
        console.log(`  ${chalk.dim('ℹ no .sops.yaml — prod secrets need a backend (spfn secret keygen, or add a KMS rule)')}`);
    }

    if (issues.length === 0 && warnings.length === 0)
    {
        console.log(chalk.green('  ✓ No plaintext secret leaks found.'));
    }

    console.log();

    if (issues.length > 0)
    {
        process.exit(1);
    }
}
