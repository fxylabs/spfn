/**
 * @spfn/auth - Sign in with Apple, web flow (fxylabs/spfn#142, case table A)
 *
 * A real ES256 key pair signs the client secret (exported as PKCS#8 PEM into
 * the env, as an operator would set it), and a real RS256 pair signs the
 * id_token the stubbed token endpoint returns. Only jose's remote JWKS lookup
 * is replaced, so signature, issuer, audience, expiry and nonce are checked
 * for real — the technique of `oauth-native.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from 'jose';

vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

import { appleProvider } from '../../server/lib/oauth/apple-provider';
import { resetAppleClientSecretCache } from '../../server/lib/oauth/apple-client-secret';

const APPLE_ISS = 'https://appleid.apple.com';
const SERVICES_ID = 'com.example.app.web';
const BUNDLE_ID = 'com.example.app';
const TEAM_ID = 'TEAM123456';
const KEY_ID = 'KEY9876543';
const APP_URL = 'https://app.example.com';
const STATE = 'sealed-state-from-the-start';

let signingPem: string;
let idTokenKey: CryptoKey;
let idTokenPublicKey: CryptoKey;

function sha256hex(value: string): string
{
    return createHash('sha256').update(value).digest('hex');
}

function configureWeb(): void
{
    vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', SERVICES_ID);
    vi.stubEnv('SPFN_AUTH_APPLE_TEAM_ID', TEAM_ID);
    vi.stubEnv('SPFN_AUTH_APPLE_KEY_ID', KEY_ID);
    vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', signingPem);
}

async function signIdToken(claims: Record<string, unknown>, aud = SERVICES_ID): Promise<string>
{
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(APPLE_ISS)
        .setAudience(aud)
        .setSubject('apple-sub-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(idTokenKey);
}

function jsonResponse(body: unknown, status = 200): Response
{
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** The token endpoint answering with an id_token signed now, for `nonceOf` and `aud`. */
async function stubTokenEndpoint(nonceOf = STATE, aud = SERVICES_ID): Promise<ReturnType<typeof vi.fn>>
{
    const idToken = await signIdToken(
        { nonce: sha256hex(nonceOf), email: 'relay@privaterelay.appleid.com', email_verified: 'true' },
        aud,
    );
    const fetchMock = vi.fn(async () => jsonResponse({
        access_token: 'apple-access',
        refresh_token: 'apple-refresh',
        expires_in: 3600,
        id_token: idToken,
        token_type: 'Bearer',
    }));
    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): URLSearchParams
{
    return (fetchMock.mock.calls[call][1] as RequestInit).body as URLSearchParams;
}

/** A6's assertions, shared by the key-source variants A14 and A15. */
async function expectA6Exchange(): Promise<void>
{
    const fetchMock = await stubTokenEndpoint();

    const tokens = await appleProvider.exchangeCodeForTokens('c', { state: STATE });

    expect(fetchMock.mock.calls[0][0]).toBe('https://appleid.apple.com/auth/token');
    const body = sentBody(fetchMock);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c');
    expect(body.get('client_id')).toBe(SERVICES_ID);
    expect(body.get('redirect_uri')).toBe(`${APP_URL}/_auth/oauth/apple/callback`);

    const secret = body.get('client_secret')!;
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: KEY_ID });
    const claims = decodeJwt(secret);
    expect(claims).toMatchObject({ iss: TEAM_ID, sub: SERVICES_ID, aud: 'https://appleid.apple.com' });
    expect(claims.exp! - claims.iat!).toBe(3600);

    expect(tokens.identity?.providerUserId).toBe('apple-sub-1');
    expect(tokens.identity?.email).toBe('relay@privaterelay.appleid.com');
    expect(tokens.identity?.emailVerified).toBe(true);
    expect(tokens.identity?.name).toBeUndefined();
    expect(tokens.refreshToken).toBe('apple-refresh');
    expect(tokens.expiresIn).toBe(3600);
}

beforeAll(async () =>
{
    signingPem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
        .export({ type: 'pkcs8', format: 'pem' }) as string;

    const pair = await generateKeyPair('RS256');
    idTokenKey = pair.privateKey;
    idTokenPublicKey = pair.publicKey;
});

beforeEach(() =>
{
    resetAppleClientSecretCache();
    vi.mocked(createRemoteJWKSet).mockReturnValue((async () => idTokenPublicKey) as never);

    vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', APP_URL);
    vi.stubEnv('SPFN_AUTH_APPLE_REDIRECT_URI', '');
    vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', '');
    vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', '');
    vi.stubEnv('SPFN_AUTH_APPLE_TEAM_ID', '');
    vi.stubEnv('SPFN_AUTH_APPLE_KEY_ID', '');
    vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', '');
    vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY_FILE', '');
});

afterEach(() =>
{
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('Apple provider — configuration', () =>
{
    it('A1: all web variables set (PEM) — enabled, form_post', () =>
    {
        configureWeb();

        expect(appleProvider.isEnabled()).toBe(true);
        expect(appleProvider.callbackResponseMode).toBe('form_post');
    });

    it('A2: only SPFN_AUTH_APPLE_CLIENT_IDS — web disabled, native still verifies', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', BUNDLE_ID);

        expect(appleProvider.isEnabled()).toBe(false);

        const token = await signIdToken({ nonce: sha256hex('raw-nonce') }, BUNDLE_ID);
        const identity = await appleProvider.verifyNativeIdToken!(token, { nonce: 'raw-nonce' });
        expect(identity.providerUserId).toBe('apple-sub-1');
    });

    it('A3: the three ids without a key variable — disabled', () =>
    {
        configureWeb();
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', '');

        expect(appleProvider.isEnabled()).toBe(false);
    });

    it('A17: native with SPFN_AUTH_APPLE_CLIENT_IDS unset accepts the Services ID audience', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', SERVICES_ID);

        const token = await signIdToken({ nonce: sha256hex('raw-nonce') }, SERVICES_ID);
        const identity = await appleProvider.verifyNativeIdToken!(token, { nonce: 'raw-nonce' });
        expect(identity.providerUserId).toBe('apple-sub-1');
    });
});

describe('Apple provider — authorize URL', () =>
{
    it('A4: getAuthUrl', () =>
    {
        configureWeb();

        const url = new URL(appleProvider.getAuthUrl(STATE));

        expect(url.host).toBe('appleid.apple.com');
        expect(url.pathname).toBe('/auth/authorize');
        expect(url.searchParams.get('client_id')).toBe(SERVICES_ID);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('response_mode')).toBe('form_post');
        expect(url.searchParams.get('scope')).toBe('name email');
        expect(url.searchParams.get('state')).toBe(STATE);
        expect(url.searchParams.get('nonce')).toBe(sha256hex(STATE));
        expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/_auth/oauth/apple/callback`);
    });

    it('A5: SPFN_AUTH_APPLE_REDIRECT_URI overrides the redirect_uri', () =>
    {
        configureWeb();
        vi.stubEnv('SPFN_AUTH_APPLE_REDIRECT_URI', 'https://tunnel.example.dev/_auth/oauth/apple/callback');

        const url = new URL(appleProvider.getAuthUrl(STATE));

        expect(url.searchParams.get('redirect_uri')).toBe('https://tunnel.example.dev/_auth/oauth/apple/callback');
    });
});

describe('Apple provider — code exchange', () =>
{
    beforeEach(() =>
    {
        configureWeb();
    });

    it('A6: exchanges the code with an ES256 client secret and returns the id_token identity', async () =>
    {
        await expectA6Exchange();
    });

    it('A7: the name comes from user, the email never does', async () =>
    {
        await stubTokenEndpoint();

        const tokens = await appleProvider.exchangeCodeForTokens('c', {
            state: STATE,
            user: '{"name":{"firstName":"Ada","lastName":"Lovelace"},"email":"spoof@example.com"}',
        });

        expect(tokens.identity?.name).toBe('Ada Lovelace');
        expect(tokens.identity?.email).toBe('relay@privaterelay.appleid.com');
    });

    it.each(['not json', '{}'])('A8: user %j yields no name and no throw', async (user) =>
    {
        await stubTokenEndpoint();

        const tokens = await appleProvider.exchangeCodeForTokens('c', { state: STATE, user });

        expect(tokens.identity?.name).toBeUndefined();
    });

    it('A9: an id_token nonce for a different state is refused', async () =>
    {
        await stubTokenEndpoint('another-state');

        await expect(appleProvider.exchangeCodeForTokens('c', { state: STATE })).rejects.toThrow(/nonce/i);
    });

    it('A10: an id_token for the native bundle id is refused', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', BUNDLE_ID);
        await stubTokenEndpoint(STATE, BUNDLE_ID);

        await expect(appleProvider.exchangeCodeForTokens('c', { state: STATE })).rejects.toThrow();
    });

    it('A11: a 400 from the token endpoint rejects with its status', async () =>
    {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)));

        await expect(appleProvider.exchangeCodeForTokens('c', { state: STATE })).rejects.toThrow(/status 400/);
    });

    it('A12: a body without id_token is invalid', async () =>
    {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ access_token: 'a', expires_in: 3600 })));

        await expect(appleProvider.exchangeCodeForTokens('c', { state: STATE })).rejects.toThrow(/invalid/);
    });

    it('A12b: a body whose expires_in is the string "3600" is invalid', async () =>
    {
        const idToken = await signIdToken(
            { nonce: sha256hex(STATE), email: 'relay@privaterelay.appleid.com', email_verified: 'true' },
            SERVICES_ID,
        );
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
            access_token: 'apple-access',
            refresh_token: 'apple-refresh',
            expires_in: '3600',
            id_token: idToken,
            token_type: 'Bearer',
        })));

        await expect(appleProvider.exchangeCodeForTokens('c', { state: STATE })).rejects.toThrow(/invalid/);
    });

    it('A13: the client secret is cached until less than 60 s remain', async () =>
    {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));

        const fetchMock = await stubTokenEndpoint();
        await appleProvider.exchangeCodeForTokens('c', { state: STATE });
        await appleProvider.exchangeCodeForTokens('c', { state: STATE });

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(sentBody(fetchMock, 1).get('client_secret')).toBe(sentBody(fetchMock, 0).get('client_secret'));

        vi.setSystemTime(new Date('2026-10-17T00:59:10Z'));
        const later = await stubTokenEndpoint();
        await appleProvider.exchangeCodeForTokens('c', { state: STATE });

        expect(sentBody(later).get('client_secret')).not.toBe(sentBody(fetchMock, 0).get('client_secret'));
    });

    it('A14: a PEM written with \\n escapes works', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', signingPem.trim().replaceAll('\n', '\\n'));

        await expectA6Exchange();
    });

    it('A15: SPFN_AUTH_APPLE_PRIVATE_KEY_FILE names a file holding the PEM', async () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'apple142-'));
        const path = join(dir, 'AuthKey.p8');
        writeFileSync(path, signingPem);
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', '');
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY_FILE', path);

        await expectA6Exchange().finally(() => rmSync(dir, { recursive: true, force: true }));
    });

    it('A16: getUserInfo refuses — Apple has no userinfo endpoint', async () =>
    {
        await expect(appleProvider.getUserInfo('x')).rejects.toThrow(/userinfo/);
    });

    it('A18: a garbage key names the variable and never echoes the value', async () =>
    {
        const garbage = 'garbage-key-material-0123456789';
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', garbage);
        await stubTokenEndpoint();

        const error = await appleProvider.exchangeCodeForTokens('c', { state: STATE }).catch((e: unknown) => e);

        expect((error as Error).message).toContain('SPFN_AUTH_APPLE_PRIVATE_KEY');
        expect((error as Error).message).not.toContain(garbage);
    });
});
