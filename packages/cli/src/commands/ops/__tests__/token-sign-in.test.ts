/**
 * `spfn ops token` — a password sign-in that is not a session (#525).
 *
 * `POST /_auth/login` answers 2xx for more than "signed in". A 202 says the
 * key the CLI sent is registered but inactive until a second step it cannot
 * take; a 200 can carry a session every ops-token route refuses. A CLI that
 * reads any 2xx as a session signs with the pending key, is answered "Invalid
 * or revoked key", and reports a cleanup that never applied — or, on the
 * restricted 200, cleans up through `keys/revoke`, which such a session may not
 * call, and leaves a live key behind.
 *
 * The rows enter at the command and stub only the application (`fetch`), the
 * prompt and the key pair, so what they pin is the sequence of calls the
 * operator's run makes. `exit` is recorded into the same trace: a stubbed exit
 * lets execution continue, so only the order tells "stopped" from "went on".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('prompts', () => ({
    default: vi.fn(async () => ({ email: 'admin@test.com', password: 'a password' })),
}));

vi.mock('../../../utils/ops/auth-crypto.js', () => ({
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

import { buildTokenCommand } from '../token.js';

/** Every request the run made, and its exit, in order. */
let trace: string[];
let exitCode: number | undefined;

function serve(login: Response): void
{
    vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) =>
    {
        const path = new URL(String(input)).pathname;
        trace.push(`${init?.method ?? 'GET'} ${path}`);

        if (path === '/_auth/login')
        {
            return login;
        }

        return path === '/_auth/logout'
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify({ message: 'Refused' }), { status: 403 });
    });
}

async function issue(): Promise<void>
{
    await buildTokenCommand().parseAsync(
        ['issue', '--name', 'laptop', '--scopes', 'waitlist:read', '--app', 'https://app.example.com'],
        { from: 'user' },
    );
}

function printedErrors(): string
{
    return vi.mocked(console.error).mock.calls.flat().join('\n');
}

beforeEach(() =>
{
    trace = [];
    exitCode = undefined;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.spyOn(console, 'log').mockImplementation(() =>
    {});
    vi.spyOn(console, 'error').mockImplementation(() =>
    {});
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

describe('spfn ops token issue, signed in with a password', () =>
{
    it('K1: stops at a 202 — signs nothing with the pending key and revokes nothing', async () =>
    {
        serve(new Response(JSON.stringify({
            mfaRequired: true,
            challenge: { secret: 'challenge-secret', expiresAtMillis: Date.now() + 600_000 },
        }), { status: 202 }));

        await expect(issue()).rejects.toThrow('process.exit');

        expect(exitCode).toBe(1);
        expect(trace).toEqual(['POST /_auth/login', 'exit']);
        expect(printedErrors()).toMatch(/second step/);
    });

    it.each([
        { flag: 'passwordChangeRequired', remedy: /change the password/ },
        { flag: 'secondFactorEnrolmentRequired', remedy: /enrol a second factor/ },
    ])('K2: a session with $flag names the remedy and signs out with logout', async ({ flag, remedy }) =>
    {
        serve(new Response(JSON.stringify({
            mfaRequired: false,
            userId: '1',
            email: 'admin@test.com',
            [flag]: true,
        }), { status: 200 }));

        await expect(issue()).rejects.toThrow('process.exit');

        expect(exitCode).toBe(1);
        expect(trace).toEqual(['POST /_auth/login', 'POST /_auth/logout', 'exit']);
        expect(printedErrors()).toMatch(remedy);
    });
});
