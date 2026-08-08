/**
 * Administrator session lifecycle for `spfn ops token`.
 *
 * The ephemeral key the CLI signs with must be revoked before the command
 * ends, and the failing path is the one that used to lose it: the revoke sat in
 * a `finally` beside `process.exit()`, and exit ends the process synchronously,
 * so the `finally` never ran. An operator signing in with an account that is
 * not an administrator gets 403 on every attempt, and every attempt left a
 * registered key behind until the server's 90-day expiry removed it.
 *
 * The signing is stubbed at `ops/auth-crypto.js` because this file is about the
 * lifecycle, not the signature — the real key pair, login and signature are
 * walked end to end by `@spfn/auth`'s ops-token route tests. Stubbing the local
 * loader rather than `@spfn/auth/crypto` also keeps the test honest about the
 * dependency: the CLI does not depend on that package, so it is not there to
 * stub.
 *
 * The assertions are about ORDER, not merely about the revoke happening. A test
 * has to replace `process.exit` with something it can observe, and anything
 * observable lets execution continue — which runs a `finally` that a real exit
 * would have skipped. So "the revoke happened" passes under both the broken and
 * the fixed arrangement, and only "the revoke happened before exit was called"
 * tells them apart. `exit` is recorded into the same trace as the requests for
 * exactly that reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('prompts', () => ({
    default: vi.fn(async () => ({ email: 'admin@test.com', password: 'a password' })),
}));

vi.mock('../ops/auth-crypto.js', () => ({
    loadAuthCrypto: async () => ({
        generateKeyPair: () => ({
            publicKey: 'public',
            privateKey: 'private',
            keyId: 'ephemeral-key',
            fingerprint: 'fingerprint',
            algorithm: 'ES256',
        }),
        generateClientToken: () => 'signed-jwt',
    }),
}));

import { adminRequest, withAdminSession } from '../ops/admin-session.js';

const APP = 'http://app.test';

/** Everything the command did, requests and the exit alike, in order. */
let trace: string[];
let lastAuthorization: string | null;
let exitCode: number | undefined;

/** Stand in for the application, recording what the CLI sent it. */
function serve(respond: (path: string) => Response): void
{
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) =>
    {
        const url = new URL(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;

        trace.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        lastAuthorization = headers.Authorization ?? null;

        return respond(url.pathname);
    });
}

const ok = () => new Response('{}', { status: 200 });

describe('withAdminSession', () =>
{
    beforeEach(() =>
    {
        trace = [];
        lastAuthorization = null;
        exitCode = undefined;
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

        const silent = () =>
        {
            // Output is asserted through the spies, not printed into the run.
        };

        vi.spyOn(console, 'error').mockImplementation(silent);
        vi.spyOn(console, 'log').mockImplementation(silent);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            exitCode = code;
            trace.push('exit');

            throw new Error('process.exit');
        }) as never);
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('signs in, runs the call, and revokes the key it signed with', async () =>
    {
        serve(path => path === '/_auth/ops-tokens'
            ? new Response(JSON.stringify({ token: 'spfn_ops_secret' }), { status: 200 })
            : ok());

        const answer = await withAdminSession(APP, async session =>
            adminRequest(APP, 'POST', '/_auth/ops-tokens', session, { name: 'laptop' }));

        expect(answer.token).toBe('spfn_ops_secret');
        expect(trace).toEqual([
            'POST /_auth/login',
            'POST /_auth/ops-tokens',
            'POST /_auth/keys/revoke',
        ]);

        // The revoke carries the session's signature, so the server knows
        // which key is being given up.
        expect(lastAuthorization).toBe('Bearer signed-jwt');
    });

    it('revokes the key before exiting when the call failed', async () =>
    {
        serve(path => path === '/_auth/ops-tokens'
            ? new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })
            : ok());

        await expect(withAdminSession(APP, async session =>
            adminRequest(APP, 'POST', '/_auth/ops-tokens', session, { name: 'laptop' })))
            .rejects.toThrow('process.exit');

        expect(exitCode).toBe(1);

        // The revoke comes before the exit. Under a real `process.exit` there is
        // no "after" to run in, which is the whole point of the ordering.
        expect(trace).toEqual([
            'POST /_auth/login',
            'POST /_auth/ops-tokens',
            'POST /_auth/keys/revoke',
            'exit',
        ]);
    });

    it('reports the application\'s own refusal rather than a status code', async () =>
    {
        serve(path => path === '/_auth/ops-tokens'
            ? new Response(JSON.stringify({ message: 'Insufficient role' }), { status: 403 })
            : ok());

        await expect(withAdminSession(APP, async session =>
            adminRequest(APP, 'POST', '/_auth/ops-tokens', session, { name: 'laptop' })))
            .rejects.toThrow('process.exit');

        expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('Insufficient role');
    });

    it('refuses without a terminal before any credential is asked for', async () =>
    {
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        serve(ok);

        await expect(withAdminSession(APP, async () => 'unreachable'))
            .rejects.toThrow('process.exit');

        expect(exitCode).toBe(1);

        // Nothing was sent to the application: the refusal comes before the
        // sign-in, not after a password was typed into a run that cannot read
        // one. (The trace holds more than one `exit` only because this test's
        // stub lets execution continue past the first; a real exit ends there.)
        expect(trace.filter(entry => entry !== 'exit')).toEqual([]);
    });
});
