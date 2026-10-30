/**
 * @spfn/auth - Link-only providers and the recent-authentication setting on links
 * (GitHub fxylabs/spfn#155, #157)
 *
 * One test per row of the case table in artifacts/issue-155-157-link-policy-design.md
 * §8: P for the recent-authentication rule on link and unlink, O for a link-only
 * provider's sign-in, M for the last-credential check. Rows R1-R7 are in
 * unit/oauth-link-policy-config.test.ts.
 *
 * Driven the same way as oauth-link.test.ts: real requests against the mounted
 * auth router, Battle.net a stand-in registered under the `battlenet` id whose
 * authorization codes name the identity they establish. Google and Apple are
 * stand-ins only where a row needs them enabled; the real providers are put back
 * after the file.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { mfaVerifications, passkeys, userPublicKeys, userSocialAccounts, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import {
    appleProvider,
    googleProvider,
    registerOAuthProvider,
    type NormalizedIdentity,
    type OAuthProvider,
} from '@/server/lib/oauth';
import { battlenetProvider } from '@/server/lib/oauth/battlenet-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { configureAuth, getPasskeyConfig, type AuthConfig } from '@/server/lib/config';
import { oauthUrlInterceptor } from '@/nextjs/interceptors/oauth';
import { authLoginEvent, oauthLinkRemovedEvent } from '@/server/events';
import { PasskeyConfigError } from '@spfn/auth/errors';
import type { SocialProvider } from '@/server/types';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const APP_URL = 'http://localhost:3000';
const RETURN_URL = '/settings/connections';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;

const FLASH: NormalizedIdentity = {
    providerUserId: '100001', email: null, emailVerified: false, name: 'Flash#1234', handle: 'Flash#1234',
};
const JAEDONG: NormalizedIdentity = {
    providerUserId: '100002', email: null, emailVerified: false, name: 'Jaedong#5678', handle: 'Jaedong#5678',
};

const identities = new Map<string, NormalizedIdentity>([
    ['code-flash', FLASH],
    ['code-jaedong', JAEDONG],
]);

/** How many code exchanges reached the provider — a refused callback must not get that far. */
let exchanges = 0;

function battlenetStandIn(enabled = true): OAuthProvider
{
    return {
        id: 'battlenet',
        isEnabled: () => enabled,
        getAuthUrl: (state: string) => `https://oauth.battle.example/authorize?state=${state}`,
        exchangeCodeForTokens: async (code: string) =>
        {
            exchanges += 1;

            return { accessToken: `access-${code}-${exchanges}`, expiresIn: 86400, identity: identities.get(code) };
        },
        getUserInfo: async () =>
        {
            throw new Error('the stand-in answers identity from the token response');
        },
    };
}

/** An enabled stand-in for a provider a row only needs to be configured. */
function enabledStandIn(id: SocialProvider, extra: Partial<OAuthProvider> = {}): OAuthProvider
{
    return {
        id,
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://${id}.example/authorize?state=${state}`,
        exchangeCodeForTokens: async () =>
        {
            throw new Error(`${id} stand-in exchanges no code`);
        },
        getUserInfo: async () =>
        {
            throw new Error(`${id} stand-in has no user info`);
        },
        ...extra,
    };
}

interface Session
{
    authorization: string;
    keyId: string;
}

interface StartedLink
{
    state: string;
    cookie: string;
}

/** A sign-in state as the sign-in interceptor seals it, and the CSRF cookie it sets. */
interface StartedSignIn
{
    state: string;
    cookie: string;
    key: KeyPair;
}

describe.skipIf(!dbAvailable)('Link-only providers and the recent-authentication setting (#155, #157)', () =>
{
    let app: Hono;
    let ownerId: number;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = 'localhost';
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = APP_URL;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        registerOAuthProvider(battlenetProvider);
        registerOAuthProvider(googleProvider);
        registerOAuthProvider(appleProvider);
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        registerOAuthProvider(battlenetStandIn());
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        exchanges = 0;

        ownerId = await createUser('owner@test.com');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        configureAuth({ oauthProviders: undefined, oauthLink: undefined });
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function configure(config: Pick<AuthConfig, 'oauthProviders' | 'oauthLink'>): void
    {
        configureAuth(config);
    }

    async function createUser(email: string): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        return Number(row!.id);
    }

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.157.${ipCounter % 250 + 1}`;
    }

    function post(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        return Promise.resolve(app.request(path, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': nextIp(),
                ...(authorization ? { Authorization: authorization } : {}),
            },
            body: JSON.stringify(body),
        }));
    }

    function get(path: string): Promise<Response>
    {
        return Promise.resolve(app.request(path, { headers: { 'x-forwarded-for': nextIp() } }));
    }

    function sessionFor(key: KeyPair): Session
    {
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: key.keyId };
    }

    async function signIn(email: string): Promise<Session>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);

        return sessionFor(key);
    }

    async function ageSession(session: Session, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(userPublicKeys.keyId, session.keyId));
    }

    async function enrolSecondFactor(session: Session): Promise<void>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        expect(enroll.status).toBe(200);

        const secret = (await enroll.json()).secret as string;
        const code = hotp(decodeBase32(secret), totpStep(Date.now()));
        const confirm = await post('/_auth/mfa/totp/confirm', { code }, session.authorization);
        expect(confirm.status).toBe(200);
    }

    async function forgetStepUp(session: Session): Promise<void>
    {
        await getTestDb().delete(mfaVerifications).where(eq(mfaVerifications.keyId, session.keyId));
    }

    function linkStartRequest(
        session: Session,
        body: Record<string, unknown> = {},
        provider: SocialProvider = 'battlenet',
    ): Promise<Response>
    {
        return post(`/_auth/oauth/${provider}/link`, {
            returnUrl: RETURN_URL,
            nonce: generateOAuthNonce(),
            startId: generateOAuthNonce(),
            ...body,
        }, session.authorization);
    }

    async function startLink(session: Session): Promise<StartedLink>
    {
        const nonce = generateOAuthNonce();
        const startId = generateOAuthNonce();
        const response = await linkStartRequest(session, { nonce, startId });

        expect(response.status).toBe(200);

        const { authUrl } = await response.json() as { authUrl: string };

        return {
            state: new URL(authUrl).searchParams.get('state')!,
            cookie: `${buildStartCookieName('csrf', startId)}=${nonce}`,
        };
    }

    async function callback(state: string, code: string, cookie: string): Promise<URL>
    {
        const params = new URLSearchParams({ code, state });
        const response = await app.request(`/_auth/oauth/battlenet/callback?${params}`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    async function linkedOwner(): Promise<Session>
    {
        const session = await signIn('owner@test.com');
        const started = await startLink(session);
        const location = await callback(started.state, 'code-flash', started.cookie);

        expect(location.searchParams.get('oauthLink')).toBe('linked');

        return session;
    }

    /** Seal a Battle.net sign-in state now, the way the sign-in interceptor does. */
    async function startSignIn(): Promise<StartedSignIn>
    {
        const key = generateKeyPair('ES256');
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'battlenet',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            nonce,
        });

        return { state, cookie: `${buildStartCookieName('csrf', key.keyId)}=${nonce}`, key };
    }

    /** A whole Battle.net sign-in; its key is the new account's session. */
    async function battlenetAccount(code: string): Promise<{ userId: number; session: Session }>
    {
        const started = await startSignIn();
        const location = await callback(started.state, code, started.cookie);

        expect(location.searchParams.get('isNewUser')).toBe('true');

        return { userId: Number(location.searchParams.get('userId')), session: sessionFor(started.key) };
    }

    function unlink(session: Session, provider: SocialProvider = 'battlenet', body: Record<string, unknown> = {})
    {
        return post(`/_auth/oauth/${provider}/unlink`, body, session.authorization);
    }

    async function addSocialRow(userId: number, provider: SocialProvider, providerUserId: string): Promise<void>
    {
        await getTestDb().insert(userSocialAccounts).values({ userId, provider, providerUserId });
    }

    async function socialRowOf(userId: number, provider: SocialProvider)
    {
        const [row] = await getTestDb().select().from(userSocialAccounts).where(and(
            eq(userSocialAccounts.userId, userId),
            eq(userSocialAccounts.provider, provider),
        ));

        return row;
    }

    async function keyCount(): Promise<number>
    {
        return (await getTestDb().select().from(userPublicKeys)).length;
    }

    async function userCount(): Promise<number>
    {
        return (await getTestDb().select().from(users)).length;
    }

    function captureEvent<TPayload>(
        event: { subscribe: (handler: (payload: TPayload) => void) => unknown },
    ): TPayload[]
    {
        const seen: TPayload[] = [];
        event.subscribe((payload) =>
        {
            seen.push(payload);
        });

        return seen;
    }

    function errorReasonOf(location: URL): string | null
    {
        expect(location.pathname).toBe('/auth/error');

        return location.searchParams.get('reason');
    }

    async function codeOf(response: Response): Promise<string>
    {
        return (await response.json()).code;
    }

    // ========================================================================
    // 8-2. The recent-authentication rule on link and unlink (#155)
    // ========================================================================

    describe('8-2 recent authentication on link and unlink', () =>
    {
        it('P1: with nothing configured, a stale session with no password is refused RECENT_AUTH_REQUIRED', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);

            const response = await linkStartRequest(session);

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('RECENT_AUTH_REQUIRED');
        });

        it('P2: with Battle.net link turned off, the same stale session starts a Battle.net link', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);
            configure({ oauthProviders: { battlenet: { recentAuth: { link: false } } } });

            const response = await linkStartRequest(session);

            expect(response.status).toBe(200);
            expect((await response.json()).authUrl).toMatch(/^https:\/\/oauth\.battle\.example\//);
        });

        it('P3: the same setting leaves another provider\'s link on the rule', async () =>
        {
            vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
            vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'test-client-secret');
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);
            configure({ oauthProviders: { battlenet: { recentAuth: { link: false } } } });

            const response = await linkStartRequest(session, {}, 'google');

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('RECENT_AUTH_REQUIRED');
        });

        it('P4: turning the rule off leaves the step-up for an enrolled account', async () =>
        {
            const session = await signIn('owner@test.com');
            await enrolSecondFactor(session);
            await forgetStepUp(session);
            configure({ oauthProviders: { battlenet: { recentAuth: { link: false } } } });

            const response = await linkStartRequest(session);

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('STEP_UP_REQUIRED');
        });

        it('P5: a longer link window lets a 20-minute-old session link while passkey enrolment stays at ten', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 20);
            configure({ oauthLink: { recentAuthMinutes: 30 } });

            expect((await linkStartRequest(session)).status).toBe(200);

            const enrol = await post('/_auth/passkeys/register/options', {}, session.authorization);

            expect(enrol.status).toBe(403);
            expect(await codeOf(enrol)).toBe('RECENT_AUTH_REQUIRED');
        });

        it('P6: a link starts with no passkey variable and no app URL, where the passkey configuration cannot resolve', async () =>
        {
            const session = await signIn('owner@test.com');
            vi.stubEnv('SPFN_AUTH_PASSKEY_RP_ID', undefined);
            vi.stubEnv('SPFN_AUTH_PASSKEY_ORIGINS', undefined);
            vi.stubEnv('SPFN_APP_URL', undefined);
            vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', undefined);

            expect(() => getPasskeyConfig()).toThrow(PasskeyConfigError);

            const response = await linkStartRequest(session);

            expect(response.status).toBe(200);
        });

        it('P7: with Battle.net unlink turned off, a stale session unlinks, announced as link_removed', async () =>
        {
            const session = await linkedOwner();
            await ageSession(session, 11);
            configure({ oauthProviders: { battlenet: { recentAuth: { unlink: false } } } });
            const removed = captureEvent(oauthLinkRemovedEvent);

            const response = await unlink(session);

            expect(response.status).toBe(200);
            expect(await socialRowOf(ownerId, 'battlenet')).toBeUndefined();
            expect(removed).toEqual([expect.objectContaining({ userId: String(ownerId), provider: 'battlenet' })]);
        });

        it('P8: with nothing configured, a stale session\'s unlink is refused and the identity stays', async () =>
        {
            const session = await linkedOwner();
            await ageSession(session, 11);

            const response = await unlink(session);

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('RECENT_AUTH_REQUIRED');
            expect(await socialRowOf(ownerId, 'battlenet')).toBeDefined();
        });

        it('P9: turning unlink\'s rule off leaves the step-up, and the identity stays', async () =>
        {
            const session = await linkedOwner();
            await enrolSecondFactor(session);
            await forgetStepUp(session);
            configure({ oauthProviders: { battlenet: { recentAuth: { unlink: false } } } });

            const response = await unlink(session);

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('STEP_UP_REQUIRED');
            expect(await socialRowOf(ownerId, 'battlenet')).toBeDefined();
        });
    });

    // ========================================================================
    // 8-3. A link-only provider's sign-in (#157)
    // ========================================================================

    describe('8-3 link-only sign-in', () =>
    {
        const linkOnly = { oauthProviders: { battlenet: { signIn: false } } };

        it('O1: the sign-in URL is refused OAUTH_PROVIDER_LINK_ONLY and the proxy sets no cookie', async () =>
        {
            configure(linkOnly);
            const requestCtx = {
                path: '/_auth/oauth/battlenet/url',
                body: { returnUrl: '/' },
                metadata: {} as Record<string, unknown>,
            } as unknown as RequestInterceptorContext;

            await oauthUrlInterceptor.request?.(requestCtx, vi.fn(async () => undefined));

            const response = await post('/_auth/oauth/battlenet/url', requestCtx.body);

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('OAUTH_PROVIDER_LINK_ONLY');

            const responseCtx = {
                response: { ok: false, status: 403 },
                cookies: new Map<string, string>(),
                setCookies: [],
                metadata: requestCtx.metadata,
            } as unknown as ResponseInterceptorContext;

            await oauthUrlInterceptor.response?.(responseCtx, vi.fn(async () => undefined));

            expect(responseCtx.setCookies).toEqual([]);
        });

        it('O2: the API-mode start is refused and returns no state', async () =>
        {
            configure(linkOnly);
            const key = generateKeyPair('ES256');

            const response = await post('/_auth/oauth/start', {
                provider: 'battlenet',
                returnUrl: '/',
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(response.status).toBe(403);

            const body = await response.json();
            expect(body.code).toBe('OAUTH_PROVIDER_LINK_ONLY');
            expect(body.authUrl).toBeUndefined();
        });

        it('O3: the redirect start ends on the error page with reason link_only, never at Battle.net', async () =>
        {
            configure(linkOnly);
            const { state } = await startSignIn();

            const response = await get(`/_auth/oauth/battlenet?state=${encodeURIComponent(state)}`);
            const location = new URL(response.headers.get('location')!, APP_URL);

            expect(response.status).toBe(302);
            expect(location.host).not.toBe('oauth.battle.example');
            expect(errorReasonOf(location)).toBe('link_only');
        });

        it('O4: a linked identity\'s sign-in state issued before the setting is refused before its code is spent', async () =>
        {
            await linkedOwner();
            const started = await startSignIn();
            configure(linkOnly);
            const keysBefore = await keyCount();
            const logins = captureEvent(authLoginEvent);
            exchanges = 0;

            const location = await callback(started.state, 'code-flash', started.cookie);

            expect(errorReasonOf(location)).toBe('link_only');
            expect(exchanges).toBe(0);
            expect(await keyCount()).toBe(keysBefore);
            expect(logins).toEqual([]);
        });

        it('O5: an unlinked identity\'s sign-in callback makes no account and no social row', async () =>
        {
            const started = await startSignIn();
            configure(linkOnly);
            const usersBefore = await userCount();

            const location = await callback(started.state, 'code-jaedong', started.cookie);

            expect(errorReasonOf(location)).toBe('link_only');
            expect(exchanges).toBe(0);
            expect(await userCount()).toBe(usersBefore);
            expect(await getTestDb().select().from(userSocialAccounts)).toEqual([]);
        });

        it('O6: Google made link-only refuses both of Google\'s own start routes', async () =>
        {
            vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
            vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'test-client-secret');
            configure({ oauthProviders: { google: { signIn: false } } });

            const redirect = await get('/_auth/oauth/google?state=any-state');
            const url = await post('/_auth/oauth/google/url', { returnUrl: '/', state: 'any-state' });

            expect(redirect.status).toBe(302);
            expect(errorReasonOf(new URL(redirect.headers.get('location')!, APP_URL))).toBe('link_only');
            expect(url.status).toBe(403);
            expect(await codeOf(url)).toBe('OAUTH_PROVIDER_LINK_ONLY');
        });

        it('O7: a native sign-in with a link-only provider is refused before its id_token is verified', async () =>
        {
            const verifyNativeIdToken = vi.fn(async () => FLASH);
            registerOAuthProvider(enabledStandIn('google', { verifyNativeIdToken }));
            configure({ oauthProviders: { google: { signIn: false } } });
            const key = generateKeyPair('ES256');

            const response = await post('/_auth/oauth/google/native', {
                idToken: 'id-token',
                nonce: key.fingerprint,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('OAUTH_PROVIDER_LINK_ONLY');
            expect(verifyNativeIdToken).not.toHaveBeenCalled();
        });

        it('O8: Apple made link-only refuses the Android native start', async () =>
        {
            registerOAuthProvider(enabledStandIn('apple'));
            configure({ oauthProviders: { apple: { signIn: false } } });

            const response = await post('/_auth/oauth/apple/native/start', {
                requestNonce: 'a'.repeat(64),
                state: 'app-state-0123456789',
                relayUrl: 'https://app.example.com/apple-relay',
            });

            expect(response.status).toBe(403);
            expect(await codeOf(response)).toBe('OAUTH_PROVIDER_LINK_ONLY');
        });

        it('O9: a link-only provider still links from a session', async () =>
        {
            configure(linkOnly);

            await linkedOwner();

            expect(await socialRowOf(ownerId, 'battlenet')).toMatchObject({ providerUserId: '100001' });
        });

        it('O10: a link-only provider still unlinks', async () =>
        {
            const session = await linkedOwner();
            configure(linkOnly);

            const response = await unlink(session);

            expect(response.status).toBe(200);
            expect(await socialRowOf(ownerId, 'battlenet')).toBeUndefined();
        });

        it('O11: the provider list moves a link-only provider from providers to linkOnly', async () =>
        {
            configure(linkOnly);

            const listing = await (await get('/_auth/oauth/providers')).json();

            expect(listing.providers).not.toContain('battlenet');
            expect(listing.linkOnly).toEqual(['battlenet']);
        });

        it('O12: a link-only provider that is not configured is in neither list', async () =>
        {
            registerOAuthProvider(battlenetStandIn(false));
            configure(linkOnly);

            const listing = await (await get('/_auth/oauth/providers')).json();

            expect(listing.providers).not.toContain('battlenet');
            expect(listing.linkOnly).toEqual([]);
        });

        it('O13: with nothing configured, a linked identity signs in and nothing is link-only', async () =>
        {
            await linkedOwner();
            const started = await startSignIn();

            const location = await callback(started.state, 'code-flash', started.cookie);
            const listing = await (await get('/_auth/oauth/providers')).json();

            expect(location.searchParams.get('userId')).toBe(String(ownerId));
            expect(location.searchParams.get('isNewUser')).toBe('false');
            expect(listing.providers).toContain('battlenet');
            expect(listing.linkOnly).toEqual([]);
        });
    });

    // ========================================================================
    // 8-4. The last way in (#157)
    // ========================================================================

    describe('8-4 last way in', () =>
    {
        const linkOnly = { oauthProviders: { battlenet: { signIn: false } } };

        it('M1: an account whose other way in is a link-only identity cannot unlink its Kakao sign-in', async () =>
        {
            const { userId, session } = await battlenetAccount('code-flash');
            await addSocialRow(userId, 'kakao', 'kakao-1');
            configure(linkOnly);

            const response = await unlink(session, 'kakao');

            expect(response.status).toBe(409);
            expect(await codeOf(response)).toBe('LAST_RECOVERY_CREDENTIAL');
            expect(await socialRowOf(userId, 'kakao')).toBeDefined();
        });

        it('M2: with nothing configured, the same account unlinks Kakao as in 0.3.0-beta.49', async () =>
        {
            const { userId, session } = await battlenetAccount('code-flash');
            await addSocialRow(userId, 'kakao', 'kakao-1');

            const response = await unlink(session, 'kakao');

            expect(response.status).toBe(200);
            expect(await socialRowOf(userId, 'kakao')).toBeUndefined();
        });

        it('M3: an account whose other way in is a link-only identity cannot revoke its only passkey', async () =>
        {
            const { userId, session } = await battlenetAccount('code-flash');
            const [passkey] = await getTestDb().insert(passkeys).values({
                userId,
                credentialId: `cred-${generateOAuthNonce()}`,
                publicKey: 'pk',
                deviceType: 'singleDevice',
            }).returning({ id: passkeys.id });
            configure(linkOnly);

            const response = await post('/_auth/passkeys/revoke', { passkeyId: String(passkey!.id) }, session.authorization);

            expect(response.status).toBe(409);
            expect(await codeOf(response)).toBe('LAST_RECOVERY_CREDENTIAL');

            const [row] = await getTestDb().select().from(passkeys).where(eq(passkeys.id, passkey!.id));
            expect(row!.revokedAt).toBeNull();
        });

        it('M4: a link-only identity unlinks beside a Google sign-in, which stays', async () =>
        {
            const { userId, session } = await battlenetAccount('code-flash');
            await addSocialRow(userId, 'google', 'google-1');
            configure(linkOnly);

            const response = await unlink(session);

            expect(response.status).toBe(200);
            expect(await socialRowOf(userId, 'battlenet')).toBeUndefined();
            expect(await socialRowOf(userId, 'google')).toBeDefined();
        });

        it('M5: an account made by a Battle.net sign-in before the setting unlinks its only, link-only, identity', async () =>
        {
            const { userId, session } = await battlenetAccount('code-flash');
            configure(linkOnly);

            const response = await unlink(session);

            expect(response.status).toBe(200);
            expect(await socialRowOf(userId, 'battlenet')).toBeUndefined();
        });
    });
});
