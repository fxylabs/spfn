/**
 * @spfn/auth - signedTokenAuth unit tests
 *
 * One test per row of the refusal table (#127). The issuer's key set is
 * served by a local http server on loopback, so the number of key-set
 * fetches is counted rather than inferred: an unknown `kid` buys exactly one
 * re-read, and a second unknown `kid` inside the cooldown buys none.
 *
 * Every instance of the middleware is built inside its test, so no key-set
 * cache outlives the test that filled it.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

import { defineSurface } from '@spfn/core/surface';
import { registerRoutes } from '@spfn/core/route';

import { authLogger } from '../../server/logger';
import { getSignedToken, signedTokenAuth } from '../../server/middleware/signed-token-auth';

const ISS = 'https://issuer.example';
const AUD = 'my-app';
const REQUIRED = 'Signed token required: Authorization: Bearer <token>';
const INVALID = 'Invalid signed token';

interface SigningKey
{
    kid: string;
    privateKey: CryptoKey;
    jwk: JWK;
}

let server: Server;
let keysUrl: string;
let fetches = 0;
let served: JWK[] = [];

let keyA: SigningKey;
let keyB: SigningKey;
let keyRsa: SigningKey;

async function signingKey(kid: string, alg: 'EdDSA' | 'RS256'): Promise<SigningKey>
{
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });

    return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

function nowSec(): number
{
    return Math.floor(Date.now() / 1000);
}

interface MintOptions
{
    kid?: string | null;
    alg?: string;
    claims?: Record<string, unknown>;
}

async function mint(key: SigningKey | Uint8Array, options: MintOptions = {}): Promise<string>
{
    const claims = { iss: ISS, aud: AUD, sub: 'caller-1', iat: nowSec(), exp: nowSec() + 300, ...options.claims };
    const payload = Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));
    const kid = options.kid === undefined && !(key instanceof Uint8Array) ? key.kid : options.kid;
    const header = { alg: options.alg ?? 'EdDSA', ...(kid ? { kid } : {}) };

    return await new SignJWT(payload).setProtectedHeader(header)
        .sign(key instanceof Uint8Array ? key : key.privateKey);
}

function base64url(value: unknown): string
{
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function buildApp(keys: string = keysUrl, clockSkewSec?: number): Hono
{
    const surface = defineSurface({
        namespace: '/_app',
        auth: signedTokenAuth({ keysUrl: keys, iss: ISS, aud: AUD, clockSkewSec }),
    });

    const app = new Hono();
    app.onError((err, c) =>
    {
        const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;

        return c.json({ error: err.message }, status as never);
    });
    registerRoutes(app, surface.router({
        whoami: surface.route.get('/whoami').effect('read').handler(async (c) =>
        {
            const token = getSignedToken(c.raw);

            return { kid: token?.kid, sub: token?.claims.sub, auth: c.raw.get('auth') ?? null };
        }),
    }));

    return app;
}

async function call(app: Hono, token: string | null, header?: string): Promise<{ status: number; body: any }>
{
    const authorization = header ?? (token === null ? undefined : `Bearer ${token}`);
    const response = await app.request('/_app/whoami', {
        headers: authorization === undefined ? {} : { Authorization: authorization },
    });

    return { status: response.status, body: await response.json() };
}

function loggedReasons(): string[]
{
    return vi.mocked(authLogger.middleware.warn).mock.calls
        .map(([, context]) => (context as { reason: string }).reason);
}

/** Move the key set's clock past the one-minute cooldown. */
function afterCooldown(): void
{
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
}

beforeAll(async () =>
{
    [keyA, keyB, keyRsa] = await Promise.all([
        signingKey('key-a', 'EdDSA'),
        signingKey('key-b', 'EdDSA'),
        signingKey('key-rsa', 'RS256'),
    ]);

    server = createServer((_req, res) =>
    {
        fetches++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: served }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    keysUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/keys`;
});

afterAll(async () =>
{
    await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() =>
{
    fetches = 0;
    served = [keyA.jwk, keyRsa.jwk];
    vi.spyOn(authLogger.middleware, 'warn').mockImplementation(() => undefined as never);
});

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('signedTokenAuth — the request', () =>
{
    it('refuses a missing Authorization header or one that is not Bearer', async () =>
    {
        const app = buildApp();

        expect(await call(app, null)).toEqual({ status: 401, body: { error: REQUIRED } });
        expect(await call(app, null, `Basic ${await mint(keyA)}`)).toEqual({ status: 401, body: { error: REQUIRED } });
    });

    it('admits a valid token and carries its claims through getSignedToken, leaving getAuth unset', async () =>
    {
        const { status, body } = await call(buildApp(), await mint(keyA));

        expect(status).toBe(200);
        expect(body).toEqual({ kid: 'key-a', sub: 'caller-1', auth: null });
    });
});

describe('signedTokenAuth — claims', () =>
{
    it('refuses a wrong aud', async () =>
    {
        expect(await call(buildApp(), await mint(keyA, { claims: { aud: 'other-app' } })))
            .toEqual({ status: 401, body: { error: INVALID } });
    });

    it('refuses a wrong iss', async () =>
    {
        expect(await call(buildApp(), await mint(keyA, { claims: { iss: 'https://other.example' } })))
            .toEqual({ status: 401, body: { error: INVALID } });
    });

    it('refuses exp in the past beyond the skew', async () =>
    {
        expect(await call(buildApp(), await mint(keyA, { claims: { exp: nowSec() - 60 } })))
            .toEqual({ status: 401, body: { error: INVALID } });
    });

    it('admits exp in the past within the skew', async () =>
    {
        expect((await call(buildApp(), await mint(keyA, { claims: { exp: nowSec() - 10 } }))).status).toBe(200);
    });

    it('refuses iat in the future beyond the skew, and admits it within', async () =>
    {
        const app = buildApp();

        expect(await call(app, await mint(keyA, { claims: { iat: nowSec() + 120, exp: nowSec() + 600 } })))
            .toEqual({ status: 401, body: { error: INVALID } });
        expect(loggedReasons()).toEqual([expect.stringMatching(/iat is later than now/)]);
        expect((await call(app, await mint(keyA, { claims: { iat: nowSec() + 10 } }))).status).toBe(200);
    });

    it('applies a configured skew to iat', async () =>
    {
        const app = buildApp(keysUrl, 0);

        expect((await call(app, await mint(keyA, { claims: { iat: nowSec() + 5 } }))).status).toBe(401);
    });

    it('refuses a token missing exp or iat', async () =>
    {
        const app = buildApp();

        expect(await call(app, await mint(keyA, { claims: { exp: undefined } })))
            .toEqual({ status: 401, body: { error: INVALID } });
        expect(await call(app, await mint(keyA, { claims: { iat: undefined } })))
            .toEqual({ status: 401, body: { error: INVALID } });
    });
});

describe('signedTokenAuth — signature', () =>
{
    it('refuses a header without kid before any key lookup', async () =>
    {
        expect(await call(buildApp(), await mint(keyA, { kid: null })))
            .toEqual({ status: 401, body: { error: INVALID } });
        expect(fetches).toBe(0);
        expect(loggedReasons()).toEqual([expect.stringMatching(/carries no kid/)]);
    });

    it('refuses RS256 even when the key set holds the RSA key', async () =>
    {
        expect(await call(buildApp(), await mint(keyRsa, { alg: 'RS256' })))
            .toEqual({ status: 401, body: { error: INVALID } });
    });

    it('refuses HS256 signed with any secret', async () =>
    {
        const secret = new TextEncoder().encode('a-shared-secret-of-thirty-two-bytes!');

        expect(await call(buildApp(), await mint(secret, { alg: 'HS256', kid: 'key-a' })))
            .toEqual({ status: 401, body: { error: INVALID } });
    });

    it('refuses alg none', async () =>
    {
        const unsigned = `${base64url({ alg: 'none', kid: 'key-a' })}.`
            + `${base64url({ iss: ISS, aud: AUD, iat: nowSec(), exp: nowSec() + 300 })}.`;

        expect(await call(buildApp(), unsigned)).toEqual({ status: 401, body: { error: INVALID } });
    });

    it('refuses a tampered payload and a tampered signature', async () =>
    {
        const app = buildApp();
        const [header, , signature] = (await mint(keyA)).split('.');
        const forgedPayload = base64url({ iss: ISS, aud: AUD, sub: 'admin', iat: nowSec(), exp: nowSec() + 300 });
        const flipped = (signature!.startsWith('A') ? 'B' : 'A') + signature!.slice(1);
        const [, payload] = (await mint(keyA)).split('.');

        expect(await call(app, `${header}.${forgedPayload}.${signature}`))
            .toEqual({ status: 401, body: { error: INVALID } });
        expect(await call(app, `${header}.${payload}.${flipped}`))
            .toEqual({ status: 401, body: { error: INVALID } });
    });
});

describe('signedTokenAuth — the key set', () =>
{
    it('admits an unknown kid the key set holds after one re-read', async () =>
    {
        const app = buildApp();
        expect((await call(app, await mint(keyA))).status).toBe(200);
        expect(fetches).toBe(1);

        served = [keyA.jwk, keyB.jwk];
        afterCooldown();

        expect(await call(app, await mint(keyB))).toMatchObject({ status: 200, body: { kid: 'key-b' } });
        expect(fetches).toBe(2);
    });

    it('refuses an unknown kid still absent after one re-read, then re-reads no more within the minute', async () =>
    {
        const app = buildApp();
        expect((await call(app, await mint(keyA))).status).toBe(200);

        afterCooldown();
        expect(await call(app, await mint(keyB))).toEqual({ status: 401, body: { error: INVALID } });
        expect(fetches).toBe(2);

        expect(await call(app, await mint(keyB, { kid: 'key-c' }))).toEqual({ status: 401, body: { error: INVALID } });
        expect(fetches).toBe(2);
    });

    it('refuses every token while the key set is unreachable, logging the reason without the token', async () =>
    {
        const closed = createServer();
        await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as AddressInfo).port;
        await new Promise<void>(resolve => closed.close(() => resolve()));

        const token = await mint(keyA);
        expect(await call(buildApp(`http://127.0.0.1:${port}/keys`), token))
            .toEqual({ status: 401, body: { error: INVALID } });

        const warn = vi.mocked(authLogger.middleware.warn);
        expect(warn).toHaveBeenCalledWith('Signed token refused', expect.objectContaining({ reason: expect.any(String) }));
        expect(JSON.stringify(warn.mock.calls)).not.toContain(token.split('.')[2]);
    });
});

describe('signedTokenAuth — construction', () =>
{
    it('refuses an http keysUrl on a non-loopback host', () =>
    {
        expect(() => signedTokenAuth({ keysUrl: 'http://issuer.example/keys', iss: ISS, aud: AUD }))
            .toThrow(/must be https/);
    });

    it('accepts https and loopback http', () =>
    {
        for (const url of ['https://issuer.example/keys', 'http://localhost:8790/keys', 'http://[::1]:8790/keys'])
        {
            expect(signedTokenAuth({ keysUrl: url, iss: ISS, aud: AUD }).name).toBe('signedTokenAuth');
        }
    });

    it('refuses a missing keysUrl, iss or aud, and a negative skew', () =>
    {
        expect(() => signedTokenAuth({ keysUrl: 'not a url', iss: ISS, aud: AUD })).toThrow(/requires keysUrl/);
        expect(() => signedTokenAuth({ keysUrl, iss: '', aud: AUD })).toThrow(/non-empty iss/);
        expect(() => signedTokenAuth({ keysUrl, iss: ISS, aud: '' })).toThrow(/non-empty aud/);
        expect(() => signedTokenAuth({ keysUrl, iss: ISS, aud: AUD, clockSkewSec: -1 })).toThrow(/clockSkewSec/);
    });

    it('skips a global auth middleware, like opsTokenAuth', () =>
    {
        expect(signedTokenAuth({ keysUrl, iss: ISS, aud: AUD }).skips).toEqual(['auth']);
    });
});
