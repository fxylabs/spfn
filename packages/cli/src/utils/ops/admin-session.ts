/**
 * Administrator session for `spfn ops token`
 *
 * SPFN authenticates a request with a JWT the client signs itself: the client
 * generates a key pair, hands the public half over at login, and signs each
 * request with the private half. A browser app has the Next.js layer do this;
 * the CLI does it here.
 *
 * The key pair lives in memory for one command. It is generated, used to sign
 * the single call that follows, and signed out (`POST /_auth/logout`, which
 * revokes the key the request signs with) before the command ends — whether
 * the call succeeded or not. Nothing is written to disk, so a run killed
 * outright leaves a registered public key whose private half is gone; that key
 * is useless to anyone, but it sits in the administrator's device list until
 * the server's own key expiry (90 days) removes it.
 *
 * A 2xx from the sign-in is not by itself a session. The answer is a
 * `LoginResult`, and the CLI reads it: a 202 (`mfaRequired`) registered the key
 * inactive, waiting for a second step a terminal cannot take, and a 200 can
 * carry a session that every ops-token route refuses.
 */

import prompts from 'prompts';
import chalk from 'chalk';
import { loadAuthCrypto } from './auth-crypto.js';
import { joinUrl } from './client.js';

export interface AdminSession
{
    /** Bearer value for `Authorization`, signed with the ephemeral key. */
    authorization: string;
    keyId: string;
}

/** The part of `@spfn/auth`'s `LoginResult` that says whether it is a usable session. */
interface LoginResult
{
    /** The key was registered inactive: no session was started. */
    mfaRequired: boolean;
    passwordChangeRequired?: boolean;
    secondFactorEnrolmentRequired?: boolean;
}

/**
 * Read an answer that is supposed to be JSON.
 *
 * A proxy or load balancer in front of the app answers an error with HTML, and
 * `JSON.parse` on that raises a parser's complaint about a `<` — which tells an
 * operator nothing about what went wrong. The status is what matters there.
 */
function parseJsonAnswer(text: string, status: number, statusText: string): any
{
    if (!text)
    {
        return {};
    }

    try
    {
        return JSON.parse(text);
    }
    catch
    {
        throw new Error(`The app answered ${status} ${statusText} with something that is not JSON.`);
    }
}

async function postJson(appUrl: string, path: string, body: unknown, authorization?: string): Promise<any>
{
    const response = await fetch(joinUrl(appUrl, path), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    const parsed = parseJsonAnswer(text, response.status, response.statusText);

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

    const login: LoginResult = await postJson(appUrl, '/_auth/login', {
        email: answers.email,
        password: answers.password,
        publicKey: keyPair.publicKey,
        keyId: keyPair.keyId,
        fingerprint: keyPair.fingerprint,
        algorithm: keyPair.algorithm,
        deviceName: 'spfn CLI',
    });

    // The key is registered inactive and holds only a challenge. Nothing can
    // sign with it, and no call of the CLI's can remove it — the server
    // discards it with the challenge.
    if (login.mfaRequired)
    {
        throw new Error('This account signs in with a second step on a new device, and this command cannot complete it.');
    }

    const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
        expiresIn: '5m',
    });
    const session = { authorization: `Bearer ${token}`, keyId: keyPair.keyId };

    await refuseRestrictedSession(appUrl, session, login);

    return session;
}

/**
 * The remedies a signed-in session still needs before an ops-token route
 * admits it. Every one of those routes refuses the session until they are done.
 */
function pendingRemedies(login: LoginResult): string[]
{
    return [
        ...(login.passwordChangeRequired ? ['change the password in the app'] : []),
        ...(login.secondFactorEnrolmentRequired ? ['enrol a second factor in the app'] : []),
    ];
}

/**
 * A session the ops-token routes would refuse is signed out at once, and the
 * command stops naming what the account has to do first. The key is live, so
 * it is ended here; `logout` is the one call such a session may make.
 */
async function refuseRestrictedSession(appUrl: string, session: AdminSession, login: LoginResult): Promise<void>
{
    const remedies = pendingRemedies(login);

    if (remedies.length === 0)
    {
        return;
    }

    await closeAdminSession(appUrl, session);

    throw new Error(`This account must ${remedies.join(' and ')} before it can manage ops tokens. Do that, then run this command again.`);
}

/**
 * Sign the ephemeral key out. `logout` revokes the key the request signs with,
 * and unlike `keys/revoke` it admits a session that still has to change its
 * password or enrol a second factor. Best effort: the ops token is already
 * issued by the time this runs, so a failure here is worth a word but not a
 * failed command.
 */
export async function closeAdminSession(appUrl: string, session: AdminSession): Promise<void>
{
    try
    {
        await postJson(appUrl, '/_auth/logout', {}, session.authorization);
    }
    catch (err)
    {
        console.error(chalk.yellow(
            `⚠️  Could not sign out the CLI's temporary key (${err instanceof Error ? err.message : String(err)}).`,
        ));
        console.error(chalk.gray('   Its private half ended with this run, so nothing can sign with it; the server stops accepting it at its expiry.'));
    }
}

function abort(err: unknown): never
{
    console.error(chalk.red(`❌ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
}

/**
 * Sign in, run one admin-authenticated call, and sign the ephemeral key out
 * before the command ends — on the failing path as much as the succeeding one.
 *
 * The sign-out cannot sit in a `finally` beside a `process.exit()`: exit ends the
 * process synchronously, so the `finally` never runs. A command that failed
 * after signing in — an operator signing in with an account that is not an
 * administrator gets 403 on every attempt — would then leave a registered key
 * behind each time. So the failure is caught, the key signed out, and the
 * exit taken last.
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
    const response = await fetch(joinUrl(appUrl, path), {
        method,
        headers: {
            Authorization: session.authorization,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    const parsed = parseJsonAnswer(text, response.status, response.statusText);

    if (!response.ok)
    {
        throw new Error(parsed.message ?? parsed.error ?? `${response.status} ${response.statusText}`);
    }

    return parsed;
}
