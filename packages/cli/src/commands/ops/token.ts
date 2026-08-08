/**
 * `spfn ops token` - ops token lifecycle
 *
 * Issuance, listing and revocation run against the application the rest of
 * `spfn ops` already talks to. The CLI signs in as an administrator, calls the
 * application's own routes, and never reaches into its database — so the token
 * format and the table behind it stay the application's business.
 *
 * The secret exists in the clear exactly once, in the issuance answer;
 * `--to-keychain` stores it directly without ever printing it.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { appAccount, resolveAppUrl } from './resolve.js';
import { deleteOpsToken, keychainSupported, storeOpsToken } from '../../utils/ops/keychain.js';
import { adminRequest, assertInteractive, withAdminSession } from '../../utils/ops/admin-session.js';

interface OpsTokenSummary
{
    id: number;
    name: string;
    scopes: string[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
}

/**
 * The longest expiry that can be asked for, about a century in days.
 *
 * There is an upper bound at all because a day count is turned into a date by
 * arithmetic, and a large enough count overflows the range a date can hold —
 * `Date.now() + 1e11 days` is not a far-off date, it is an invalid one, which
 * reaches the database as a value it refuses rather than as a refusal an
 * operator can read. The server enforces the same bound; this one puts the
 * message in the terminal before a request is sent. It matches the bound in
 * `@spfn/auth`'s issuance route.
 */
const MAX_EXPIRY_DAYS = 36500;

/**
 * The secret exists in the clear only between issuance and delivery, so
 * anything that can refuse delivery is checked before the request is sent. A
 * failure after issuance would leave a token nobody can present and nobody
 * knows to revoke.
 */
function resolveExpiryDays(options: { expiry: boolean; expiresDays: string }): number | null
{
    if (!options.expiry)
    {
        return null;
    }

    const days = Number(options.expiresDays);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS)
    {
        console.error(chalk.red(
            `❌ --expires-days takes 1 to ${MAX_EXPIRY_DAYS} days, got "${options.expiresDays}".`,
        ));
        console.error(chalk.gray('   Pass --no-expiry for a non-expiring token.'));
        process.exit(1);
    }

    return days;
}

function resolveKeychainAccount(options: { toKeychain?: boolean; app?: string }, appUrl: string): string | null
{
    if (!options.toKeychain)
    {
        return null;
    }

    if (!keychainSupported())
    {
        console.error(chalk.red('❌ --to-keychain requires macOS. Issue without it and store the printed secret yourself.'));
        process.exit(1);
    }

    return appAccount(appUrl);
}

async function issueToken(options: {
    name: string;
    scopes: string;
    expiresDays: string;
    expiry: boolean;
    toKeychain?: boolean;
    app?: string;
}): Promise<void>
{
    const scopes = options.scopes.split(',').map(s => s.trim()).filter(s => s.length > 0);
    if (scopes.length === 0)
    {
        console.error(chalk.red("❌ --scopes needs at least one scope ('*' grants all)"));
        process.exit(1);
    }

    const appUrl = resolveAppUrl(options);
    const expiresInDays = resolveExpiryDays(options);
    const keychainAccount = resolveKeychainAccount(options, appUrl);

    await withAdminSession(appUrl, async (session) =>
    {
        const answer = await adminRequest(appUrl, 'POST', '/_auth/ops-tokens', session, {
            name: options.name,
            scopes,
            expiresInDays,
        });

        const record = answer.opsToken as OpsTokenSummary;
        console.log(chalk.green(`✅ Ops token issued (id ${record.id}, name "${record.name}")`));
        console.log(chalk.gray(`   scopes: ${record.scopes.join(', ')}`));
        console.log(chalk.gray(`   expires: ${record.expiresAt ?? 'never'}`));

        if (keychainAccount)
        {
            try
            {
                await storeOpsToken(keychainAccount, answer.token as string);
                console.log(chalk.green(`🔐 Stored in the macOS keychain for ${keychainAccount} — the secret was never printed.`));

                return;
            }
            catch (err)
            {
                // The token is already issued. Printing is the only way the
                // operator gets a usable token out of this run — a locked
                // keychain must not turn into an unrecoverable secret.
                console.error(chalk.yellow(`⚠️  Keychain storage failed (${err instanceof Error ? err.message : String(err)}).`));
                console.error(chalk.yellow('   Falling back to printing the secret.'));
            }
        }

        console.log('');
        console.log(chalk.bold('   Shown once, never stored — copy it now:'));
        console.log(`   ${answer.token}`);
    });
}

async function listTokens(options: { app?: string }): Promise<void>
{
    const appUrl = resolveAppUrl(options);
    await withAdminSession(appUrl, async (session) =>
    {
        const answer = await adminRequest(appUrl, 'GET', '/_auth/ops-tokens', session);
        const records = answer.opsTokens as OpsTokenSummary[];

        if (records.length === 0)
        {
            console.log(chalk.yellow('No ops tokens issued.'));

            return;
        }

        for (const record of records)
        {
            const state = record.revokedAt
                ? chalk.red('revoked')
                : (record.expiresAt && new Date(record.expiresAt) < new Date())
                    ? chalk.yellow('expired')
                    : chalk.green('active');
            console.log(`  #${record.id}  ${state}  ${record.name}`);
            console.log(chalk.gray(`      scopes: ${record.scopes.join(', ')}`
                + ` | expires: ${record.expiresAt ?? 'never'}`
                + ` | last used: ${record.lastUsedAt ?? 'never'}`));
        }
    });
}

async function revokeToken(id: string, options: { app?: string }): Promise<void>
{
    const tokenId = Number(id);
    if (!Number.isInteger(tokenId) || tokenId <= 0)
    {
        console.error(chalk.red(`❌ Token id must be a positive whole number, got "${id}".`));
        process.exit(1);
    }

    const appUrl = resolveAppUrl(options);

    await withAdminSession(appUrl, async (session) =>
    {
        const answer = await adminRequest(appUrl, 'DELETE', `/_auth/ops-tokens/${tokenId}`, session);
        const record = answer.opsToken as OpsTokenSummary;

        console.log(chalk.green(`✅ Revoked ops token #${record.id} ("${record.name}")`));
    });
}

async function storeToken(options: { app?: string }): Promise<void>
{
    if (!keychainSupported())
    {
        console.error(chalk.red('❌ Keychain storage requires macOS. Use SPFN_OPS_TOKEN instead.'));
        process.exit(1);
    }

    const appUrl = resolveAppUrl(options);
    assertInteractive('Storing a token');

    const { token } = await prompts({
        type: 'password',
        name: 'token',
        message: `Ops token for ${appAccount(appUrl)}`,
    });

    if (!token)
    {
        console.error(chalk.red('❌ No token entered.'));
        process.exit(1);
    }

    await storeOpsToken(appAccount(appUrl), token as string);
    console.log(chalk.green(`🔐 Stored in the macOS keychain for ${appAccount(appUrl)}.`));
}

async function forgetToken(options: { app?: string }): Promise<void>
{
    if (!keychainSupported())
    {
        console.error(chalk.red('❌ Keychain storage requires macOS.'));
        process.exit(1);
    }

    const appUrl = resolveAppUrl(options);
    await deleteOpsToken(appAccount(appUrl));
    console.log(chalk.green(`✅ Removed the keychain item for ${appAccount(appUrl)}.`));
}

export function buildTokenCommand(): Command
{
    const token = new Command('token')
        .description('Issue, list, revoke, and store ops tokens');

    token.command('issue')
        .description('Issue a token, signed in as an administrator (the secret is shown once, or stored with --to-keychain)')
        .requiredOption('--name <name>', 'operator-facing label')
        .requiredOption('--scopes <scopes>', "comma-separated scopes ('*' grants all)")
        .option('--expires-days <days>', 'days until expiry', '90')
        .option('--no-expiry', 'issue a non-expiring token')
        .option('--to-keychain', 'store directly in the macOS keychain instead of printing')
        .option('--app <url>', 'app URL')
        .action(issueToken);

    token.command('list')
        .description('List issued tokens (never shows secrets)')
        .option('--app <url>', 'app URL')
        .action(listTokens);

    token.command('revoke <id>')
        .description('Revoke a token by id')
        .option('--app <url>', 'app URL')
        .action(revokeToken);

    token.command('store')
        .description('Store a token in the macOS keychain (hidden prompt)')
        .option('--app <url>', 'app URL the token belongs to')
        .action(storeToken);

    token.command('forget')
        .description('Remove the keychain item for an app')
        .option('--app <url>', 'app URL')
        .action(forgetToken);

    return token;
}
