import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import fse from 'fs-extra';
import { logger } from '../../../utils/logger.js';

const { writeFileSync } = fse;

const AUTH_SOURCE = '/_auth/:path*';
const ASSET_LINKS_SOURCE = '/.well-known/assetlinks.json';

// Generated into the user's app — 2-space style, matching create-next-app output.
const AUTH_REWRITES_BLOCK = `  async rewrites() {
    // @spfn/auth: OAuth provider callbacks must return to this app's origin —
    // the oauth_csrf cookie is set here. Forward /_auth/* to the SPFN API.
    // Android verifies the Sign in with Apple App Link against
    // /.well-known/assetlinks.json, which the SPFN API serves.
    return [
      {
        source: '${AUTH_SOURCE}',
        destination: \`\${process.env.SPFN_API_URL || 'http://localhost:8790'}/_auth/:path*\`,
      },
      {
        source: '${ASSET_LINKS_SOURCE}',
        destination: \`\${process.env.SPFN_API_URL || 'http://localhost:8790'}/.well-known/assetlinks.json\`,
      },
    ];
  },`;

const NEW_CONFIG_TEMPLATE = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
${AUTH_REWRITES_BLOCK}
};

export default nextConfig;
`;

/**
 * Print the rewrite block for the user to apply by hand when the existing
 * next.config can't be patched safely.
 */
function printManualInstructions(): void
{
    logger.warn('Could not update next.config automatically.');
    logger.info('@spfn/auth OAuth requires these rewrites in your next.config:\n');
    console.log(chalk.gray(AUTH_REWRITES_BLOCK + '\n'));
}

/**
 * The index just past the `}` that closes the object literal opened at
 * `openIndex`, found by brace depth, or -1 when the braces never balance.
 * A template literal's `${…}` is just another brace pair to this count.
 */
function findMatchingBrace(content: string, openIndex: number): number
{
    let depth = 0;

    for (let i = openIndex; i < content.length; i++)
    {
        if (content[i] === '{')
        {
            depth++;
        }
        else if (content[i] === '}')
        {
            depth--;

            if (depth === 0)
            {
                return i + 1;
            }
        }
    }

    return -1;
}

/**
 * The config with an assetlinks.json rewrite inserted ahead of its existing
 * `/_auth/:path*` one, or null when that rewrite is not an object literal this
 * can find the bounds of.
 *
 * The object's end is found by brace depth, not by indent — an indent search
 * would stop at the first later sibling that happens to close at the same
 * column. The new object is a copy of the existing one with the path swapped
 * and its comments dropped, so it forwards to the same API under the same
 * default the app already chose.
 */
function insertAssetLinksRewrite(content: string): string | null
{
    const source = /source:\s*(['"`])\/_auth\/:path\*\1/.exec(content);
    const open = source ? content.lastIndexOf('{', source.index) : -1;
    const lineStart = content.lastIndexOf('\n', open) + 1;
    const indent = content.slice(lineStart, open);
    const close = open >= 0 ? findMatchingBrace(content, open) : -1;

    if (!source || open < 0 || indent.trim() !== '' || close < 0)
    {
        return null;
    }

    const copy = content.slice(open, close)
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n')
        .replaceAll(AUTH_SOURCE, ASSET_LINKS_SOURCE);

    return `${content.slice(0, open)}${copy},\n${indent}${content.slice(open)}`;
}

/** Add the rewrites `content` lacks, or null when it cannot be patched safely. */
function patchNextConfig(content: string): string | null
{
    if (content.includes(AUTH_SOURCE))
    {
        return insertAssetLinksRewrite(content);
    }

    if (content.includes('rewrites'))
    {
        // An existing rewrites() would need merging — leave it to the user.
        return null;
    }

    // The optional second group captures an immediately-closed empty object
    // (`const nextConfig = {}`) so the closing brace lands on its own line.
    const patched = content.replace(
        /(const\s+nextConfig[^=]*=\s*\{)(\s*\})?/,
        (_match, opening, closing) => `${opening}\n${AUTH_REWRITES_BLOCK}${closing ? '\n}' : ''}`,
    );

    return patched === content ? null : patched;
}

/**
 * Ensure next.config forwards `/_auth/:path*` and `/.well-known/assetlinks.json`
 * to the SPFN API.
 *
 * The OAuth CSRF cookie is host-only on the Next.js app origin, so provider
 * callbacks default to `{app URL}/_auth/oauth/:provider/callback` and must be
 * forwarded to the API by the app — without this rewrite every OAuth callback
 * 404s, including in local dev. Android verifies the App Link Sign in with
 * Apple relays to by fetching `/.well-known/assetlinks.json` on the same
 * origin, which the API serves; it accepts a 200 with no redirect only.
 *
 * Idempotent: a config that already has both rewrites is left unchanged, and
 * one that has only `/_auth/:path*` gains the second.
 */
export async function setupNextConfig(cwd: string, includeAuth: boolean): Promise<void>
{
    if (!includeAuth)
    {
        return;
    }

    const configPath = ['next.config.ts', 'next.config.js', 'next.config.mjs']
        .map(name => join(cwd, name))
        .find(existsSync);

    if (!configPath)
    {
        writeFileSync(join(cwd, 'next.config.ts'), NEW_CONFIG_TEMPLATE);
        logger.step('Created next.config.ts with the /_auth/* and assetlinks.json → SPFN API rewrites');

        return;
    }

    const content = readFileSync(configPath, 'utf-8');

    if (content.includes(AUTH_SOURCE) && content.includes(ASSET_LINKS_SOURCE))
    {
        logger.warn('next.config already forwards /_auth/* and /.well-known/assetlinks.json, skipping');

        return;
    }

    const patched = patchNextConfig(content);

    if (patched === null)
    {
        printManualInstructions();

        return;
    }

    writeFileSync(configPath, patched);
    logger.step(`Added the @spfn/auth → SPFN API rewrites to ${configPath.split('/').pop()}`);
}
