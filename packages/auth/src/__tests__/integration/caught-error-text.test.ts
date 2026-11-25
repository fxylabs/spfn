/**
 * @spfn/auth - a caught error's text reaches no redirect and no log line (#382)
 *
 * A failed statement's error carries every bound value: drizzle's message and
 * stack header end in `params: …`, and the driver error under it holds
 * `Key (email)=(…)` in `detail`. Each row fails a real statement against the
 * test database and hands that error to one sink.
 *
 * The other auth log sites pass `{ error }` to core's logger, which describes
 * it; core's caught-error-text scan holds them to that (no auth entry is
 * pending there). The redirect is not a log call, so the scan cannot see it.
 *
 * | #  | goes unnoticed without the row                                                          |
 * | -- | --------------------------------------------------------------------------------------- |
 * | C1 | the sign-in callback's error redirect carrying the statement's message to the browser    |
 * | C2 | the link-state branch of the same route doing so (a second, separate catch)             |
 * | C3 | `ensureAdminExists` logging a failed create's message, its hash and its key with it      |
 * | C4 | `fromProvider` logging what the provider call threw, values included                    |
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { registerRoutes } from '@spfn/core/route';
import { OAuthProviderError } from '@spfn/auth/errors';

const seams = vi.hoisted(() => ({
    callbackFailure: null as unknown,
    linkFailure: null as unknown,
}));

vi.mock('../../server/services/oauth.service', async (importActual) =>
{
    const actual = await importActual<typeof import('../../server/services/oauth.service')>();

    return {
        ...actual,
        oauthCallbackService: async (params: Parameters<typeof actual.oauthCallbackService>[0]) =>
        {
            if (seams.callbackFailure)
            {
                throw seams.callbackFailure;
            }

            return await actual.oauthCallbackService(params);
        },
    };
});

vi.mock('../../server/lib/oauth/state', async (importActual) =>
{
    const actual = await importActual<typeof import('../../server/lib/oauth/state')>();

    return {
        ...actual,
        openOAuthLinkState: async (sealed: string) =>
        {
            if (seams.linkFailure)
            {
                throw seams.linkFailure;
            }

            return await actual.openOAuthLinkState(sealed);
        },
    };
});

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users } from '@/server/entities';
import { initializeAuth } from '@/server/services/rbac.service';
import { getRoleByName } from '@/server/services/role.service';
import { ensureAdminExists } from '@/server/setup';
import { getOAuthProvider, registerOAuthProvider } from '../../server/lib/oauth';
import { createOAuthState } from '../../server/lib/oauth/state';
import { buildStartCookieName } from '../../server/lib/oauth/start-cookies';
import { fromProvider } from '../../server/services/oauth.service';
import { mainAuthRouter } from '../../server/routes';

const EMAIL = 'leak-probe@example.test';
const HASH = '$2b$FAKEHASH';
const PHONE = '+821099990000';
const SECRET = 'test-secret-with-at-least-32-characters-for-security-testing';
const NONCE = 'nonce-of-this-browser';
const KEY_ID = 'key-1';

/**
 * What no sink may hold: the bound values, the driver's detail, drizzle's
 * params line. Core's description prints the count as `(3 params)`, so the
 * line is matched with its colon.
 */
const LEAKS = [EMAIL, HASH, PHONE, '$2b$', 'Key (', 'Failing row', 'params:'];

const dbAvailable = await isDatabaseAvailable();
const previousProvider = getOAuthProvider('superself');

let requests = 0;

function clientIp(): string
{
    requests += 1;

    return `2001:db8:382::${requests.toString(16)}`;
}

function expectNoLeak(text: string): void
{
    for (const leak of LEAKS)
    {
        expect(text).not.toContain(leak);
    }
}

/** The insert of a user whose email is taken: a real 23505, its values in message, stack and detail */
async function duplicateInsert(): Promise<Error>
{
    const role = await getRoleByName('user');
    const row = { email: EMAIL, passwordHash: HASH, roleId: role!.id };

    await getTestDb().insert(users).values(row);

    return await getTestDb().insert(users).values(row).then(
        () => expect.fail('the duplicate insert succeeded'),
        (error: Error) => error,
    );
}

/** The error redirect of a callback past the CSRF gate */
async function callbackRedirect(app: Hono): Promise<string>
{
    const state = await createOAuthState({
        provider: 'superself',
        returnUrl: '/',
        publicKey: 'pk',
        keyId: KEY_ID,
        fingerprint: 'fp',
        algorithm: 'ES256',
        nonce: NONCE,
    });
    const response = await app.request(`/_auth/oauth/superself/callback?code=c&state=${state}`, {
        headers: { 'Cookie': `${buildStartCookieName('csrf', KEY_ID)}=${NONCE}`, 'x-forwarded-for': clientIp() },
    });

    expect(response.status).toBe(302);

    return response.headers.get('location')!;
}

/** Every line the console transport wrote during `work` */
async function loggedDuring(work: () => Promise<unknown>): Promise<string>
{
    const lines: string[] = [];
    const keep = (...args: unknown[]) =>
    {
        lines.push(args.map(String).join(' '));
    };
    const spies = [vi.spyOn(console, 'log').mockImplementation(keep), vi.spyOn(console, 'error').mockImplementation(keep)];

    await work().finally(() => spies.forEach(spy => spy.mockRestore()));

    return lines.join('\n');
}

describe.skipIf(!dbAvailable)('a caught error\'s text outside core (#382)', () =>
{
    let app: Hono;
    let failure: Error;

    beforeAll(async () =>
    {
        await setupTestDb();
        registerOAuthProvider({
            id: 'superself',
            isEnabled: () => true,
            pkce: 'S256',
            getAuthUrl: (state: string) => `https://idp.example/auth?state=${state}`,
            exchangeCodeForTokens: async () => ({ accessToken: 'a', expiresIn: 3600 }),
            getUserInfo: async () => ({ providerUserId: 'idp-1', email: null, emailVerified: false }),
        });
        app = new Hono();
        registerRoutes(app, mainAuthRouter);
    });

    afterAll(async () =>
    {
        if (previousProvider)
        {
            registerOAuthProvider(previousProvider);
        }

        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', SECRET);
        await clearTables(getTestDb());
        await initializeAuth();
        failure = await duplicateInsert();

        // The rows below are not vacuous: the error does carry the values
        expect(failure.message).toContain(EMAIL);
        expect(String((failure.cause as { detail?: unknown }).detail)).toContain(`Key (email)=(${EMAIL})`);
    });

    afterEach(() =>
    {
        seams.callbackFailure = null;
        seams.linkFailure = null;
        vi.unstubAllEnvs();
        delete process.env.SPFN_AUTH_ADMIN_ACCOUNTS;
    });

    it('C1: a sign-in callback failing on a statement redirects with a fixed text, reason failed', async () =>
    {
        seams.callbackFailure = failure;

        const location = await callbackRedirect(app);
        const params = new URL(location, 'https://app.example').searchParams;

        expectNoLeak(decodeURIComponent(location));
        expect([params.get('error'), params.get('reason')]).toEqual(['OAuth sign-in could not be completed.', 'failed']);
    });

    it('C2: a link state failing on a statement redirects with a fixed text, reason failed', async () =>
    {
        seams.linkFailure = failure;

        const location = await callbackRedirect(app);
        const params = new URL(location, 'https://app.example').searchParams;

        expectNoLeak(decodeURIComponent(location));
        expect([params.get('error'), params.get('reason')]).toEqual(['OAuth sign-in could not be completed.', 'failed']);
    });

    it('C3: an admin account whose create fails is logged by its description, not its text', async () =>
    {
        const role = await getRoleByName('user');
        await getTestDb().insert(users).values({ email: 'holder@example.test', phone: PHONE, roleId: role!.id });
        process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
            { email: 'admin-probe@example.test', phone: PHONE, password: 'probe-password-1', role: 'user' },
        ]);

        const output = await loggedDuring(() => ensureAdminExists());

        expect(output).toContain('Failed to create account admin-probe@example.test');
        expect(output).toContain('23505');
        expectNoLeak(output);
    });

    it('C4: a provider call that throws is logged by its description, not its text', async () =>
    {
        const output = await loggedDuring(() => expect(fromProvider(() => Promise.reject(failure))).rejects.toBeInstanceOf(OAuthProviderError));

        expect(output).toContain('OAuth provider call failed');
        expect(output).toContain('23505');
        expectNoLeak(output);
    });
});
