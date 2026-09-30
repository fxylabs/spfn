/**
 * `spfn secret check [--env <env>] [--instance <name>]` — static hygiene lint for
 * declared secrets.
 *
 * Flags secrets sitting in plaintext where they shouldn't, and points server secrets
 * at the keychain workflow. With a deployed `--env` it also checks the names in the
 * encrypted files against their declared layer — SOPS leaves names in the clear, so
 * nothing is decrypted. Reads files only; never prints values.
 */

import { join } from 'path';
import chalk from 'chalk';
import { secretEntries } from '../../utils/env-schema.js';
import { parseEnvFile } from '../../utils/env-file.js';
import { KEYCHAIN_REF_PREFIX } from '../../utils/secret-store/index.js';
import { getSopsFile, hasSopsConfig, type SopsFile } from '../../utils/secret-config.js';
import { sopsKeyNames } from '../../utils/sops.js';
import { layerOf, type EnvLayer, type EnvSchema } from '../../utils/env-schema.js';
import { loadSecretList, resolveTarget, type SecretOptions } from './options.js';
import { isLocalEnv, type SecretTarget } from './store-value.js';

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
    const target = resolveTarget(options);
    const schema = (await loadSecretList(options)).schema;
    const entries = secretEntries(schema);

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

    if (!isLocalEnv(target.env))
    {
        checkPlacement(cwd, schema, target, issues, warnings);
    }

    report(issues, warnings, cwd);
}

/**
 * Names in the target's encrypted files that the list does not know (a warning)
 * or that belong to the other layer (an issue). A name in both files is always
 * in one of the wrong layer, so it is caught too.
 */
function checkPlacement(cwd: string, schema: EnvSchema, target: SecretTarget, issues: string[], warnings: string[]): void
{
    const files: Array<{ file: SopsFile; layer: EnvLayer }> = [{ file: getSopsFile(cwd, target.env), layer: 'environment' }];

    if (target.instance)
    {
        files.push({ file: getSopsFile(cwd, target.env, target.instance), layer: 'instance' });
    }

    for (const { file, layer } of files)
    {
        for (const name of sopsKeyNames(file.absFile))
        {
            const entry = Object.hasOwn(schema, name) ? schema[name] : undefined;

            if (!entry)
            {
                warnings.push(`${chalk.cyan(name)} in ${chalk.yellow(file.relFile)} is not in the env list — export skips it.`);
            }
            else if (layerOf(entry) !== layer)
            {
                issues.push(`${chalk.cyan(name)} is declared with layer "${layerOf(entry)}" but is in ${chalk.yellow(file.relFile)}.`);
            }
        }
    }
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
