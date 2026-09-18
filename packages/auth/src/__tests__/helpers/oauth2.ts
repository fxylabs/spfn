/**
 * Shared setup for the OAuth 2.1 authorization server suites.
 *
 * Every one of those suites needs the same four things: the auth router mounted
 * on a Hono app, an authorization server configured, a signed-in user whose
 * requests can be signed, and a registered client. They are here rather than
 * copied five times, and the pieces a test wants to vary — client name, redirect
 * URIs, scopes, whether PKCE is present at all — are parameters.
 *
 * The auth vitest config runs every file in one fork, so module-level state is
 * shared across suites. Each suite passes its own client names for that reason.
 */

import { expect } from 'vitest';
import { Hono } from 'hono';

import { users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { pkceChallengeFor } from '@/server/lib/oauth2/tokens';
import {
    configureAuthorizationServer,
    type AuthorizationServerOptions,
} from '@/server/lib/oauth2/config';

import { getTestDb } from './db';

export const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };
export const TEST_PASSWORD = 'Password123!';

/** The resource every suite issues tokens against unless it says otherwise. */
export const TEST_RESOURCE = 'https://api.example.com/mcp';

/** Where a loopback client asks codes to be sent, unless a row is about that. */
export const TEST_REDIRECT_URI = 'http://127.0.0.1:7777/callback';

/** A scope vocabulary wide enough for the subset and widening rows. */
export const TEST_SCOPES = {
    'mcp:read': 'Read your projects',
    'mcp:write': 'Create and edit your projects',
    'mcp:admin': 'Manage your account settings',
};

/**
 * Forget every rate-limit counter.
 *
 * The in-memory store lives for the life of the process and the auth vitest
 * config runs every file in one fork, so without this a suite's later rows are
 * answered 429 by its earlier ones — and by the previous file's. Called from
 * each suite's `beforeEach`, beside `clearTables`, because it is the same kind
 * of state.
 */
export { resetMemoryRateLimitStore } from '@spfn/core/middleware';

/**
 * Mount the whole auth router the way a real server does: `authenticate` as a
 * server-level middleware, plus the framework error handler.
 */
export async function mountAuthApp(): Promise<Hono>
{
    const { mainAuthRouter } = await import('@/server/routes');
    const { registerRoutes } = await import('@spfn/core/route');
    const { ErrorHandler } = await import('@spfn/core/middleware');

    const app = new Hono();

    registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
    app.onError(ErrorHandler());

    return app;
}

/** Configure the authorization server this suite runs against. */
export function configureTestAuthorizationServer(
    options: Partial<AuthorizationServerOptions> = {},
): void
{
    configureAuthorizationServer({
        issuer: 'https://api.example.com',
        authorizeUrl: 'https://app.example.com/oauth/authorize',
        scopes: TEST_SCOPES,
        ...options,
    });
}

/** An account to consent with. Returns its row id. */
export async function createTestUser(email: string, roleId: number): Promise<number>
{
    const inserted = await getTestDb()
        .insert(users)
        .values({
            email,
            passwordHash: await hashPassword(TEST_PASSWORD),
            roleId,
            emailVerifiedAt: new Date(),
        })
        .returning({ id: users.id });

    return Number(inserted[0]!.id);
}

/**
 * Sign in exactly as a browser session does — generate a key pair, hand the
 * public half over at login, sign a request with the private half.
 *
 * `ip` is honoured through `x-forwarded-for`. Login is rate limited per address
 * AND per account, and that limiter holds state for the life of the process, so
 * a suite whose rows each sign in gives each of them its own address and its own
 * account — otherwise the later rows would be answered 429 by the earlier ones.
 */
export async function signIn(app: Hono, email: string, ip = '203.0.113.2'): Promise<string>
{
    const keyPair = generateKeyPair('ES256');

    const response = await app.request('/_auth/login', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-forwarded-for': ip },
        body: JSON.stringify({
            email,
            password: TEST_PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'consent screen',
        }),
    });

    expect(response.status).toBe(200);

    const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
        expiresIn: '5m',
    });

    return `Bearer ${token}`;
}

/**
 * POST /_auth/oauth2/register with whatever metadata the row is about.
 *
 * `ip` is honoured through `x-forwarded-for`, which is how `getClientIp` reads
 * it. Tests give themselves distinct addresses so that neither the per-IP rate
 * limiter nor the standing cap on unapproved clients carries state from one row
 * into the next.
 */
export async function registerClient(
    app: Hono,
    body: Record<string, unknown>,
    ip = '203.0.113.1',
): Promise<Response>
{
    return await app.request('/_auth/oauth2/register', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'x-forwarded-for': ip },
        body: JSON.stringify(body),
    });
}

/** Register a client that will succeed, and answer with its `client_id`. */
export async function registerLoopbackClient(
    app: Hono,
    clientName: string,
    redirectUris: string[] = [TEST_REDIRECT_URI],
    ip?: string,
): Promise<string>
{
    const response = await registerClient(
        app,
        { client_name: clientName, redirect_uris: redirectUris },
        ip,
    );

    expect(response.status).toBe(201);

    return (await response.json() as { client_id: string }).client_id;
}

/** A PKCE pair: the verifier a token request sends and the challenge that binds it. */
export function pkcePair(seed: string): { verifier: string; challenge: string }
{
    const verifier = `verifier-${seed}-0123456789abcdefghijklmnopqrstuvwxyz`;

    return { verifier, challenge: pkceChallengeFor(verifier) };
}

/**
 * An authorize request, as a row varies it.
 *
 * Every field but `client_id` has a working default, and the three ways a row
 * wants something *missing* are spelled out rather than encoded as `undefined` —
 * a row about an absent `resource` and a row that simply did not mention one are
 * different tests.
 */
export interface AuthorizeArgs
{
    client_id: string;
    redirect_uri?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    resource?: string;
    scope?: string;
    state?: string;

    /** Send neither `code_challenge` nor `code_challenge_method`. */
    omitPkce?: boolean;

    /** Send no `resource` at all. */
    omitResource?: boolean;
}

function authorizeQuery(args: AuthorizeArgs, challenge: string): URLSearchParams
{
    const query = new URLSearchParams({
        client_id: args.client_id,
        redirect_uri: args.redirect_uri ?? TEST_REDIRECT_URI,
    });

    if (!args.omitPkce)
    {
        query.set('code_challenge', args.code_challenge ?? challenge);
        query.set('code_challenge_method', args.code_challenge_method ?? 'S256');
    }

    if (!args.omitResource)
    {
        query.set('resource', args.resource ?? TEST_RESOURCE);
    }

    if (args.scope !== undefined)
    {
        query.set('scope', args.scope);
    }

    if (args.state !== undefined)
    {
        query.set('state', args.state);
    }

    return query;
}

/** GET /_auth/oauth2/authorize — what the consent screen would be drawn from. */
export async function describeAuthorize(
    app: Hono,
    authorization: string,
    args: AuthorizeArgs,
    challenge = pkcePair('default').challenge,
): Promise<Response>
{
    return await app.request(`/_auth/oauth2/authorize?${authorizeQuery(args, challenge)}`, {
        headers: { Authorization: authorization },
    });
}

/** POST /_auth/oauth2/authorize — the decision. */
export async function decideAuthorize(
    app: Hono,
    authorization: string,
    args: AuthorizeArgs & { approve: boolean },
    challenge = pkcePair('default').challenge,
): Promise<Response>
{
    const body = Object.fromEntries(authorizeQuery(args, challenge));

    return await app.request('/_auth/oauth2/authorize', {
        method: 'POST',
        headers: { ...JSON_HEADERS, Authorization: authorization },
        body: JSON.stringify({ ...body, approve: args.approve }),
    });
}

/**
 * Consent and come back with the code — the setup line every token test starts
 * from.
 */
export async function obtainCode(
    app: Hono,
    authorization: string,
    args: AuthorizeArgs,
    challenge: string,
): Promise<string>
{
    const response = await decideAuthorize(app, authorization, { ...args, approve: true }, challenge);

    expect(response.status).toBe(200);

    return (await response.json() as { code: string }).code;
}

/** POST /_auth/oauth2/token, form-encoded as RFC 6749 §4.1.3 requires. */
export async function postToken(app: Hono, fields: Record<string, string>): Promise<Response>
{
    return await app.request('/_auth/oauth2/token', {
        method: 'POST',
        headers: FORM_HEADERS,
        body: new URLSearchParams(fields).toString(),
    });
}
