/**
 * @spfn/auth - Sign in with Apple on Android against the database
 * (GitHub fxylabs/spfn#149, design w-1t19t — case tables G and N)
 *
 * The whole Android round trip through the router: the native start, Apple's
 * form_post relayed to the App Link, and the id_token read off that Location
 * posted to `POST /_auth/oauth/apple/native`. Apple is played by a local RS256
 * pair — only jose's remote JWKS lookup is replaced — and it puts the start's
 * `nonce` into the id_token verbatim, as Apple does, so signature, issuer,
 * audience, expiry and the nonce-to-key binding are all checked for real.
 *
 * | # | case | outcome |
 * | --- | --- | --- |
 * | G1 | a relay state sent to `GET /_auth/oauth/apple/callback` | error redirect (`invalid_state`); no user created, no key registered |
 * | N1 | id_token signed by a stub JWKS with `aud` = Services ID and `nonce` = SHA-256(fingerprint), posted to `/native` with that key | enrolled (criterion c3) |
 * | N2 | the same id_token posted with another key | refused (`NonceKeyBindingError` or nonce mismatch); no key registered — the #149 point-3 attack |
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, EncryptJWT, generateKeyPair as generateJoseKeyPair, SignJWT } from 'jose';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { userPublicKeys, users } from '@/server/entities';
import { generateKeyPair, type KeyPair } from '@/server/lib/crypto';

vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

const { registerOAuthProvider } = await import('@/server/lib/oauth');
const { appleProvider } = await import('@/server/lib/oauth/apple-provider');
const { createAppleRelayState } = await import('@/server/lib/oauth/state');
const { initializeAuth } = await import('@/server/services/rbac.service');

const dbAvailable = await isDatabaseAvailable();

const SERVICES_ID = 'com.example.app.web';
const RELAY_URL = 'https://app.example.com/_auth/apple-relay';
const APP_STATE = '0123456789abcdef'.repeat(4);
const SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function sha256hex(value: string): string
{
    return createHash('sha256').update(value).digest('hex');
}

describe.skipIf(!dbAvailable)('Sign in with Apple on Android (case tables G and N)', () =>
{
    let app: Hono;
    let appleSigningKey: CryptoKey;
    let testIndex = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = SESSION_SECRET;
        app = await mountAuthApp();
        registerOAuthProvider(appleProvider);
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        testIndex += 1;

        const pair = await generateJoseKeyPair('RS256');
        appleSigningKey = pair.privateKey;
        vi.mocked(createRemoteJWKSet).mockReturnValue((async () => pair.publicKey) as never);

        vi.stubEnv('SPFN_APP_URL', 'https://app.example.com');
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', 'https://app.example.com');
        vi.stubEnv('SPFN_AUTH_APPLE_REDIRECT_URI', '');
        vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', '');
        vi.stubEnv('SPFN_AUTH_APPLE_SERVICES_ID', SERVICES_ID);
        vi.stubEnv('SPFN_AUTH_APPLE_TEAM_ID', 'TEAM123456');
        vi.stubEnv('SPFN_AUTH_APPLE_KEY_ID', 'KEY9876543');
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY', 'not read: no code is exchanged on this path');
        vi.stubEnv('SPFN_AUTH_APPLE_PRIVATE_KEY_FILE', '');
        vi.stubEnv('SPFN_AUTH_APPLE_RELAY_URLS', RELAY_URL);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    function headers(extra: Record<string, string> = {}): Record<string, string>
    {
        return { 'x-forwarded-for': `198.51.149.${testIndex & 0xff}`, ...extra };
    }

    /** The app's start: its key fingerprint's SHA-256 as the request nonce. */
    async function start(key: KeyPair): Promise<URL>
    {
        const response = await app.request('/_auth/oauth/apple/native/start', {
            method: 'POST',
            headers: headers(JSON_HEADERS),
            body: JSON.stringify({ requestNonce: sha256hex(key.fingerprint), state: APP_STATE, relayUrl: RELAY_URL }),
        });
        expect(response.status).toBe(200);

        return new URL((await response.json() as { authUrl: string }).authUrl);
    }

    /** Apple: an id_token for the Services ID carrying the authorize URL's nonce verbatim. */
    async function appleIdToken(authUrl: URL): Promise<string>
    {
        return await new SignJWT({
            nonce: authUrl.searchParams.get('nonce'),
            email: `android-${testIndex}@privaterelay.appleid.com`,
            email_verified: 'true',
        })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer('https://appleid.apple.com')
            .setAudience(SERVICES_ID)
            .setSubject(`apple-android-${testIndex}`)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(appleSigningKey);
    }

    /** Apple's form_post to the Return URL, and the App Link the relay answers with. */
    async function relayed(authUrl: URL, idToken: string): Promise<URL>
    {
        const response = await app.request('/_auth/oauth/apple/callback', {
            method: 'POST',
            headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded' }),
            body: new URLSearchParams({ state: authUrl.searchParams.get('state')!, code: 'c', id_token: idToken }).toString(),
        });
        expect(response.status).toBe(303);

        return new URL(response.headers.get('location')!);
    }

    async function postNative(idToken: string, key: KeyPair, nonce = key.fingerprint): Promise<Response>
    {
        return await app.request('/_auth/oauth/apple/native', {
            method: 'POST',
            headers: headers(JSON_HEADERS),
            body: JSON.stringify({
                idToken,
                nonce,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: 'ES256',
                platform: 'android',
            }),
        });
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys)
            .where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function counts(): Promise<{ users: number; keys: number }>
    {
        return {
            users: (await getTestDb().select().from(users)).length,
            keys: (await getTestDb().select().from(userPublicKeys)).length,
        };
    }

    it('G1: a relay state sent to the GET callback is an invalid_state error redirect; no user, no key', async () =>
    {
        const before = await counts();
        const state = await createAppleRelayState({ appState: APP_STATE, relayUrl: RELAY_URL });

        const response = await app.request(
            `/_auth/oauth/apple/callback?${new URLSearchParams({ code: 'c', state })}`,
            { headers: headers() },
        );

        expect(response.status).toBe(302);
        const location = new URL(response.headers.get('location')!, 'https://app.example.com');
        expect(location.searchParams.get('reason')).toBe('invalid_state');
        expect(await counts()).toEqual(before);
    });

    it('G1: a state sealed under the relay key never verifies on the GET callback, even one carrying a web payload', async () =>
    {
        // The key the native start seals with (state.ts, `oauth-relay-state:` +
        // the session secret). Only key separation refuses this: the payload is a
        // complete web state, so a shared key would pass it on to the CSRF check.
        const relayKey = new Uint8Array(await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(`oauth-relay-state:${SESSION_SECRET}`),
        ));
        const key = generateKeyPair('ES256');
        const web = {
            returnUrl: '/',
            nonce: 'n'.repeat(32),
            provider: 'apple',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: 'ES256',
        };
        const state = encodeURIComponent(await new EncryptJWT({ state: web })
            .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
            .setIssuedAt()
            .setExpirationTime('10m')
            .encrypt(relayKey));
        const before = await counts();

        const response = await app.request(
            `/_auth/oauth/apple/callback?${new URLSearchParams({ code: 'c', state })}`,
            { headers: headers() },
        );

        const location = new URL(response.headers.get('location')!, 'https://app.example.com');
        expect(location.searchParams.get('reason')).toBe('invalid_state');
        expect(await counts()).toEqual(before);
    });

    it('N1: the relayed id_token, posted to /native with the key whose fingerprint made its nonce, enrolls', async () =>
    {
        const key = generateKeyPair('ES256');
        const authUrl = await start(key);
        const link = await relayed(authUrl, await appleIdToken(authUrl));

        expect(`${link.origin}${link.pathname}`).toBe(RELAY_URL);
        expect(link.searchParams.get('state')).toBe(APP_STATE);

        const response = await postNative(link.searchParams.get('id_token')!, key);

        expect(response.status).toBe(200);
        const body = await response.json() as { mfaRequired: boolean; userId: string; keyId: string; isNewUser: boolean };
        expect(body).toMatchObject({ mfaRequired: false, keyId: key.keyId, isNewUser: true });
        expect(await keyRow(key.keyId)).toMatchObject({ userId: Number(body.userId), isActive: true });
    });

    it('N2: the same id_token posted with another key is refused either way, and registers no key', async () =>
    {
        const before = await counts();
        const victim = generateKeyPair('ES256');
        const attacker = generateKeyPair('ES256');
        const authUrl = await start(victim);
        const idToken = (await relayed(authUrl, await appleIdToken(authUrl))).searchParams.get('id_token')!;

        const ownNonce = await postNative(idToken, attacker);
        expect(ownNonce.status).toBe(401);
        expect(await ownNonce.text()).toContain('InvalidSocialTokenError');

        const victimNonce = await postNative(idToken, attacker, victim.fingerprint);
        expect(victimNonce.status).toBe(400);
        expect(await victimNonce.text()).toContain('NonceKeyBindingError');

        expect(await keyRow(attacker.keyId)).toBeUndefined();
        expect(await counts()).toEqual(before);
    });
});
