/**
 * Administrator session for `spfn ops token`
 *
 * SPFN authenticates a request with a JWT the client signs itself: the client
 * generates a key pair, hands the public half over at login, and signs each
 * request with the private half. A browser app has the Next.js layer do this;
 * the CLI does it here.
 *
 * The key pair lives in memory for one command. It is generated, used to sign
 * the single call that follows, and revoked before the command ends — whether
 * the call succeeded or not. Nothing is written to disk, so a run killed
 * outright leaves a registered public key whose private half is gone; that key
 * is useless to anyone, but it sits in the administrator's device list until
 * the server's own key expiry (90 days) removes it.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import { loadAuthCrypto } from './auth-crypto.js';

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
    const { generateKeyPair, generateClientToken } = await loadAuthCrypto();
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
 * command — the key stops being usable at the server's own expiry.
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

function abort(err: unknown): never
{
    console.error(chalk.red(`❌ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
}

/**
 * Sign in, run one admin-authenticated call, and revoke the ephemeral key
 * before the command ends — on the failing path as much as the succeeding one.
 *
 * The revoke cannot sit in a `finally` beside a `process.exit()`: exit ends the
 * process synchronously, so the `finally` never runs. A command that failed
 * after signing in — an operator signing in with an account that is not an
 * administrator gets 403 on every attempt — would then leave a registered key
 * behind each time. So the failure is caught, the key revoked, and the exit
 * taken last.
 */
export async function withAdminSession<T>(
    appUrl: string,
    run: (session: AdminSession) => Promise<T>,
): Promise<T>
{
    const session = await openAdminSession(appUrl).catch(abort);

    let result: T;

    try
    {
        result = await run(session);
    }
    catch (err)
    {
        await closeAdminSession(appUrl, session);
        abort(err);
    }

    await closeAdminSession(appUrl, session);

    return result;
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
