/**
 * Shared resolution for `spfn ops` subcommands: which app to talk to and
 * which token to present. The token value is resolved, used, and never
 * printed.
 */

import chalk from 'chalk';
import { transportRefusalOf } from '../../surface/transport.js';
import { keychainSupported, loadOpsToken } from '../../utils/ops/keychain.js';

export interface OpsTargetOptions
{
    app?: string;
    token?: string;
}

/**
 * Refuse an app URL that would carry a secret in the clear.
 *
 * Every `spfn ops` command sends one: `token issue` prompts for an
 * administrator's password and posts it, and `list` / `call` present an ops
 * token. A stale `SPFN_OPS_APP` left over from a local run, or a typo'd
 * `--app`, is enough to put either on the wire unencrypted — and nothing about
 * the command's output would say so.
 *
 * The rule is the surface client's (`transportRefusalOf`), which throws on the
 * same URL; this renders its answer before any client is created.
 */
function assertTransportSafe(parsed: URL, appUrl: string): void
{
    const refusal = transportRefusalOf(parsed);

    if (refusal === null)
    {
        return;
    }

    if (refusal === 'cleartext-http')
    {
        console.error(chalk.red(`❌ Refusing to talk to ${appUrl} over http.`));
        console.error(chalk.gray('   An administrator password and an ops token cross this connection, and http sends both in the clear.'));
        console.error(chalk.gray('   Use https. http is allowed only against localhost.'));
        process.exit(1);
    }

    console.error(chalk.red(`❌ App URL must be https, got "${parsed.protocol}//".`));
    console.error(chalk.gray('   The ops surface is reached over HTTP(S) — http is allowed only against localhost.'));
    process.exit(1);
}

export function resolveAppUrl(options: OpsTargetOptions): string
{
    const appUrl = options.app ?? process.env.SPFN_OPS_APP;

    if (!appUrl)
    {
        console.error(chalk.red('❌ No app URL. Pass --app <url> or set SPFN_OPS_APP.'));
        process.exit(1);
    }

    let parsed: URL;

    try
    {
        parsed = new URL(appUrl);
    }
    catch
    {
        console.error(chalk.red(`❌ Invalid app URL: ${appUrl}`));
        process.exit(1);
    }

    assertTransportSafe(parsed, appUrl);

    return appUrl;
}

export function appAccount(appUrl: string): string
{
    return new URL(appUrl).host;
}

/**
 * Resolution order: `--token` flag → `SPFN_OPS_TOKEN` → macOS keychain item
 * for the app host.
 */
export async function resolveToken(options: OpsTargetOptions, appUrl: string): Promise<string>
{
    if (options.token)
    {
        return options.token;
    }

    if (process.env.SPFN_OPS_TOKEN)
    {
        return process.env.SPFN_OPS_TOKEN;
    }

    if (keychainSupported())
    {
        // A keychain that cannot be read is not the same as one holding
        // nothing: a locked keychain, or a denied access prompt, rejects here.
        // Left uncaught it reaches the CLI's top-level handler, which prints
        // the raw error object — so the operator gets a stack trace where the
        // answer is one flag away.
        const stored = await loadOpsToken(appAccount(appUrl)).catch((err: unknown) =>
        {
            console.error(chalk.yellow(
                `⚠️  Could not read the keychain (${err instanceof Error ? err.message : String(err)}).`,
            ));
            console.error(chalk.gray('   Unlock it, or pass --token / set SPFN_OPS_TOKEN for this run.'));

            return null;
        });

        if (stored)
        {
            return stored;
        }
    }

    console.error(chalk.red('❌ No ops token found.'));
    console.error(chalk.gray('   Pass --token, set SPFN_OPS_TOKEN, or store one with: spfn ops token store --app <url>'));
    process.exit(1);
}

/** Repeatable `k=v` option collector. */
export function collectKeyValue(entry: string, previous: Record<string, string>): Record<string, string>
{
    const separator = entry.indexOf('=');
    if (separator <= 0)
    {
        console.error(chalk.red(`❌ Expected k=v, got: ${entry}`));
        process.exit(1);
    }

    return {
        ...previous,
        [entry.slice(0, separator)]: entry.slice(separator + 1),
    };
}
