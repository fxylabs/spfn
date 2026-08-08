/**
 * Administrator session for `spfn ops token`
 *
 * SPFN authenticates a request with a JWT the client signs itself: the client
 * generates a key pair, hands the public half over at login, and signs each
 * request with the private half. A browser app has the Next.js layer do this;
 * the CLI does it here.
 *
 * The key pair lives in memory for one command. It is generated, used to sign
 * the single call that follows, and revoked on the way out — nothing is
 * written to disk, so an interrupted run leaves at most one key that expires
 * on its own.
 */

import prompts from 'prompts';
import chalk from 'chalk';

/**
 * `@spfn/auth` is loaded on demand: ops tokens live in its schema, but an app
 * that does not use it still uses the rest of the CLI, so a missing package is
 * a message about this one command rather than an import error at startup.
 */
async function loadCrypto()
{
    try
    {
        return await import('@spfn/auth/crypto');
    }
    catch
    {
        throw new Error(
            'This project does not have @spfn/auth installed, and ops tokens live in its schema — '
            + 'so this app has none to issue, list or revoke.\n'
            + '   An app that uses the ops surface installs @spfn/auth for opsTokenAuth; add it there.\n'
            + '   Invoking commands with a token you already hold (spfn ops list / call) does not need it.',
        );
    }
}

export interface AdminSession
{
    /** Bearer value for `Authorization`, signed with the ephemeral key. */
    authorization: string;
    keyId: string;
}

async function postJson(appUrl: string, path: string, body: unknown, authorization?: string): Promise<any>
{
    const response = await fetch(new URL(path, appUrl), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};

    if (!response.ok)
    {
        throw new Error(parsed.message ?? parsed.error ?? `${response.status} ${response.statusText}`);
    }

    return parsed;
}

/**
 * Prompt for the administrator's credentials and sign in.
 *
 * The password is read with a hidden prompt and is never echoed, logged, or
 * kept after the request that carries it.
 */
/**
 * `prompts` ends the process with status 0 when it cannot read — a closed
 * stdin, a pipe, a CI step. Signing in would then do nothing and report
 * success, so the absence of a terminal is refused before anything starts.
 */
export function assertInteractive(what: string): void
{
    if (!process.stdin.isTTY)
    {
        console.error(chalk.red(`❌ ${what} needs a terminal to ask for credentials, and this run has none.`));
        console.error(chalk.gray('   Run it from a terminal. Issuance is an operator act, not a pipeline step.'));
        process.exit(1);
    }
}

export async function openAdminSession(appUrl: string): Promise<AdminSession>
{
    // Anything that can refuse the command is checked before a credential is
    // asked for. Being told the package is missing after typing a password is
    // the wrong order.
    const { generateKeyPair, generateClientToken } = await loadCrypto();
    assertInteractive('Signing in as an administrator');

    const answers = await prompts([
        { type: 'text', name: 'email', message: `Administrator email for ${new URL(appUrl).host}` },
        { type: 'password', name: 'password', message: 'Password' },
    ]);

    if (!answers.email || !answers.password)
    {
        throw new Error('Sign-in cancelled.');
    }

    const keyPair = generateKeyPair('ES256');

    await postJson(appUrl, '/_auth/login', {
        email: answers.email,
        password: answers.password,
        publicKey: keyPair.publicKey,
        keyId: keyPair.keyId,
        fingerprint: keyPair.fingerprint,
        algorithm: keyPair.algorithm,
        deviceName: 'spfn CLI',
    });

    const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
        expiresIn: '5m',
    });

    return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
}

/**
 * Revoke the ephemeral key. Best effort: the ops token is already issued by
 * the time this runs, so a failure here is worth a word but not a failed
 * command — the key expires on its own.
 */
export async function closeAdminSession(appUrl: string, session: AdminSession): Promise<void>
{
    try
    {
        await postJson(appUrl, '/_auth/keys/revoke', { keyId: session.keyId }, session.authorization);
    }
    catch (err)
    {
        console.error(chalk.yellow(
            `⚠️  Could not revoke the CLI's temporary key (${err instanceof Error ? err.message : String(err)}).`,
        ));
        console.error(chalk.gray('   It expires on its own; revoke it from the app if you want it gone now.'));
    }
}

/** Call an admin-authenticated route with the session's signature. */
export async function adminRequest(
    appUrl: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    session: AdminSession,
    body?: unknown,
): Promise<any>
{
    const response = await fetch(new URL(path, appUrl), {
        method,
        headers: {
            Authorization: session.authorization,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};

    if (!response.ok)
    {
        throw new Error(parsed.message ?? parsed.error ?? `${response.status} ${response.statusText}`);
    }

    return parsed;
}
