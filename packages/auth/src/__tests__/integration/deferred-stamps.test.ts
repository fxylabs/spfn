/**
 * Deferred artefacts are stamped and re-admitted at completion (audit bundle 4, w-x8xt9).
 *
 * A two-step procedure — a TOTP enrolment, a passkey registration, a social
 * link, a session renewal — records who started it and under what standing
 * (`lib/deferred-stamp.ts`), and its completion asks `admitDeferred` of the
 * account as it is then, before the procedure's own rule (step-up, recent
 * authentication), which is asked at the completion too.
 *
 * | Row | Checks                                                                                                   |
 * |-----|----------------------------------------------------------------------------------------------------------|
 * | T1  | a thief session starts TOTP; the owner registers a passkey and marks it; the thief confirms → 403          |
 * |     | `STEP_UP_REQUIRED`, no recovery-code row, no step-up record (au7-A1)                                       |
 * | T2  | a thief session starts a link; the owner signs out every other device; the callback → refused, no row     |
 * |     | (au5-A1)                                                                                                  |
 * | T3  | passkey options obtained; the owner confirms TOTP; register verify → 403, no passkey row (au7-A3)         |
 * | T4  | session A starts, session B of the same account completes → refused, for TOTP and passkey                 |
 * | T5  | after the start: a password change, `setAccountStatus` suspended — and a sign-out of the other devices     |
 * |     | from the starting session itself, which keeps its key but ends its generation — then complete → refused,  |
 * |     | for TOTP, passkey and link                                                                                |
 * | T6  | the same session starts and completes → success for each; a verified replacement A→B (a web re-login     |
 * |     | signed by A) in between → success on B for TOTP and passkey, and for a link started on A                  |
 * | T8  | renewal: a challenge issued for key A renewing key B → refused; a failed verification, then the same     |
 * |     | challenge again → refused (au9-N7)                                                                        |
 * | T9  | a session of an app-registered auth profile: passkey options → verify 200; profile A starts, profile B /  |
 * |     | A under another key id / a device key completes → refused, and A still completes; a TOTP enrolment and a |
 * |     | step-up challenge of profile A → refused to profile B; a link start → 403                                 |
 * |     | `OAUTH_LINK_CREDENTIAL_UNSUPPORTED` (a04f1 F1); a profile reporting a device key's own key id and that    |
 * |     | device key → neither completes the other's registration, each completes its own (a04f2 N1)               |
 * | T10 | one challenge kind per procedure: a 202 handle's `mfa/verify/options` challenge, stamped in the table    |
 * |     | for session A, spent as A's step-up → refused, no step-up record (the Codex probe, a04f2 N3);            |
 * |     | a step-up challenge presented to `mfa/verify` → refused, key still pending; an unstamped step-up row and  |
 * |     | a pre-upgrade `'mfa'` row → refused at step-up;                                                           |
 * |     | a binding-off challenge does not renew, a renewal challenge does not turn binding off (a04f1 F2)           |
 * | T11 | session B spends session A's step-up challenge → refused; session B completes session A's binding-off →  |
 * |     | refused, binding stays on (a04f1)                                                                         |
 * | T12 | a password given at `register/options` on a stale session: a link start and a binding enable after it   |
 * |     | are still refused for recent authentication; the same ceremony's verify → 200 (a04f1 F3)                   |
 * | T13 | a procedure's completion is no credential an app can present: `admitPrincipal` refuses a forged          |
 * |     | `deferred` credential and the server entry exports no `admitCompletion` (a04f1)                           |
 * | T14 | a verified replacement K→K2 of a device key re-points only device-key stamps: a profile reporting K      |
 * |     | still completes its registration and its TOTP enrolment; the device's registration completes on K2      |
 * |     | (a04f2 N2)                                                                                                |
 *
 * T7 — the source check that every completion is admitted — is
 * `unit/deferred-completions.test.ts`.
 *
 * Every row drives the mounted auth router over HTTP, signed the way a browser
 * session signs it. A web re-login carries the `replacementProof` the Next.js
 * proxy signs from its sealed cookie. Battle.net is a stand-in whose token
 * response names the identity, as in `oauth-link.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import * as serverEntry from '@/server';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import {
    mfaRecoveryCodes,
    mfaTotp,
    mfaVerifications,
    passkeys,
    userPublicKeys,
    userSocialAccounts,
    users,
    webauthnChallenges,
} from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { signKeyReplacementProof } from '@/server/lib/key-replacement-proof';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { battlenetProvider } from '@/server/lib/oauth/battlenet-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { generateOAuthNonce } from '@/server/lib/oauth/state';
import { authenticate } from '@/server/middleware/authenticate';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { admitPrincipal, type PrincipalCredential } from '@/server/services/admission.service';
import { hashChallenge } from '@/server/services/webauthn-challenge.service';
import { setAccountStatus } from '@/server/services/user.service';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'BrandNewPassword456!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const RETURN_URL = '/settings/connections';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const CLIENT_TYPE_HEADER = 'x-test-client-type';
const PROFILE_A = 'deferredT9ProfileA';
const PROFILE_B = 'deferredT9ProfileB';
const PROFILE_KEY_HEADER = 'x-t9-profile-key';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const THIEF_IDENTITY: NormalizedIdentity = {
    providerUserId: '200001', email: null, emailVerified: false, name: 'Thief#0001', handle: 'Thief#0001',
};

const standIn: OAuthProvider = {
    id: 'battlenet',
    isEnabled: () => true,
    pkce: 'S256',
    getAuthUrl: (state: string) => `https://oauth.battle.example/authorize?state=${state}`,
    exchangeCodeForTokens: async (code: string) => ({ accessToken: `access-${code}`, expiresIn: 86400, identity: THIEF_IDENTITY }),
    getUserInfo: async () =>
    {
        throw new Error('the stand-in answers identity from the token response');
    },
};

/** A browser session: the key pair it signs with, and the header that carries it. */
interface Session
{
    key: KeyPair;
    authorization: string;
}

/** A session an application's auth profile admits: the headers its verifier reads. */
interface ProfileSession
{
    headers: Record<string, string>;
}

/** A link start as the browser holds it: the state the provider returns, and the CSRF cookie. */
interface StartedLink
{
    state: string;
    cookie: string;
}

describe.skipIf(!dbAvailable)('deferred artefacts are stamped and re-admitted at completion (bundle 4)', () =>
{
    let app: Hono;
    let ownerId: number;
    let ipCounter = 0;
    let assertionCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

        app = new Hono();
        // The trusted proxy's mark, which session binding needs (T8).
        app.use('*', async (c, next) =>
        {
            const declared = c.req.header(CLIENT_TYPE_HEADER);

            if (declared)
            {
                c.set('clientType', declared);
            }

            await next();
        });
        for (const profile of [PROFILE_A, PROFILE_B])
        {
            registerAuthProfile(profile, {
                verify: async (c) => ({ userId: String(ownerId), keyId: c.req.header(PROFILE_KEY_HEADER)!, scheme: profile }),
            });
        }

        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        registerOAuthProvider(battlenetProvider);
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
        registerOAuthProvider(standIn);
        vi.stubEnv('SPFN_APP_URL', ORIGIN);

        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        ownerId = Number(row!.id);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.100.${ipCounter % 250 + 1}`;
    }

    /** `as`: a device-key session's `Authorization`, or the headers of an app profile's session. */
    function send(method: string, path: string, body: unknown, as?: string | Record<string, string>): Promise<Response>
    {
        return Promise.resolve(app.request(path, {
            method,
            headers: {
                ...JSON_HEADERS,
                'user-agent': CHROME,
                'x-forwarded-for': nextIp(),
                [CLIENT_TYPE_HEADER]: 'web',
                ...(typeof as === 'string' ? { Authorization: as } : as),
            },
            body: JSON.stringify(body),
        }));
    }

    function post(path: string, body: unknown, as?: string | Record<string, string>): Promise<Response>
    {
        return send('POST', path, body, as);
    }

    /** A session of an app-registered auth profile, whose verifier reports `keyId`. */
    function profileSession(profile: string, keyId: string): ProfileSession
    {
        return { headers: { [CLIENT_PROOF_HEADERS.profile]: profile, [PROFILE_KEY_HEADER]: keyId } };
    }

    function sessionOf(key: KeyPair): Session
    {
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { key, authorization: `Bearer ${token}` };
    }

    /** A password sign-in on a new device — or, given `replacing`, the web re-login that replaces its key. */
    async function signIn(replacing?: Session): Promise<Session>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'owner@test.com',
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            ...(replacing
                ? { replacementProof: signKeyReplacementProof({ oldKeyId: replacing.key.keyId, newKeyId: key.keyId }, replacing.key.privateKey, 'ES256') }
                : {}),
        });

        expect(response.status).toBe(200);

        return sessionOf(key);
    }

    /** A verified replacement A→B: the old key is gone, the new one carries on. */
    async function reLogin(session: Session): Promise<Session>
    {
        const replaced = await signIn(session);

        expect(await keyRow(session.key.keyId)).toMatchObject({ isActive: false, replacedByKeyId: replaced.key.keyId });

        return replaced;
    }

    function totpCode(secret: string): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()));
    }

    async function startTotp(session: Session | ProfileSession): Promise<string>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, asOf(session));

        expect(enroll.status).toBe(200);

        return (await enroll.json()).secret as string;
    }

    function confirmTotp(session: Session | ProfileSession, secret: string): Promise<Response>
    {
        return post('/_auth/mfa/totp/confirm', { code: totpCode(secret) }, asOf(session));
    }

    /** What `send` presents for a session of either kind. */
    function asOf(session: Session | ProfileSession): string | Record<string, string>
    {
        return 'headers' in session ? session.headers : session.authorization;
    }

    async function startPasskey(session: Session | ProfileSession, body: Record<string, string> = {}): Promise<string>
    {
        const options = await post('/_auth/passkeys/register/options', body, asOf(session));

        expect(options.status).toBe(200);

        return (await options.json()).challenge as string;
    }

    async function finishPasskey(
        session: Session | ProfileSession,
        challenge: string,
        authenticator?: FixtureAuthenticator,
    ): Promise<Response>
    {
        const device = authenticator ?? await FixtureAuthenticator.create();

        return await post('/_auth/passkeys/register/verify', {
            response: device.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
        }, asOf(session));
    }

    /** Start a link exactly as the interceptor would, and keep what the browser keeps. */
    async function startLink(session: Session): Promise<StartedLink>
    {
        const nonce = generateOAuthNonce();
        const startId = generateOAuthNonce();
        const response = await post('/_auth/oauth/battlenet/link', { returnUrl: RETURN_URL, nonce, startId }, session.authorization);

        expect(response.status).toBe(200);

        const { authUrl } = await response.json() as { authUrl: string };

        return {
            state: new URL(authUrl).searchParams.get('state')!,
            cookie: `${buildStartCookieName('csrf', startId)}=${nonce}`,
        };
    }

    /** The provider sends the browser back; the outcome the page reads. */
    async function finishLink(started: StartedLink): Promise<string | null>
    {
        const params = new URLSearchParams({ code: 'code-thief', state: started.state });
        const response = await app.request(`/_auth/oauth/battlenet/callback?${params}`, { headers: { Cookie: started.cookie } });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, ORIGIN).searchParams.get('oauthLink');
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId));

        return row;
    }

    async function rowsOf(table: typeof mfaRecoveryCodes | typeof passkeys | typeof userSocialAccounts)
    {
        return await getTestDb().select().from(table);
    }

    async function totpConfirmed(): Promise<boolean>
    {
        const [row] = await getTestDb().select().from(mfaTotp).where(eq(mfaTotp.userId, ownerId));

        return Boolean(row?.confirmedAt);
    }

    async function expectError(response: Response, status: number, type: string): Promise<void>
    {
        expect(response.status).toBe(status);
        expect((await response.json()).__type).toBe(type);
    }

    /** Enrol a passkey from `session` and mark it as the second factor; the authenticator that holds it. */
    async function enrolMarkedPasskey(session: Session): Promise<FixtureAuthenticator>
    {
        const authenticator = await FixtureAuthenticator.create();
        const registered = await finishPasskey(session, await startPasskey(session), authenticator);

        expect(registered.status).toBe(200);

        const { passkeyId } = await registered.json();

        expect((await post('/_auth/mfa/passkey/mark', { passkeyId, secondFactor: true }, session.authorization)).status).toBe(200);

        return authenticator;
    }

    // ========================================================================
    // T1–T3 — the audit's probes
    // ========================================================================

    it('T1 a TOTP enrolment a thief started before the owner enrolled is not confirmed: 403 STEP_UP_REQUIRED, nothing written (au7-A1)', async () =>
    {
        const thief = await signIn();
        const owner = await signIn();
        const secret = await startTotp(thief);

        await enrolMarkedPasskey(owner);

        await expectError(await confirmTotp(thief, secret), 403, 'StepUpRequiredError');
        expect(await totpConfirmed()).toBe(false);
        expect(await rowsOf(mfaRecoveryCodes)).toHaveLength(0);
        expect(await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.keyId, thief.key.keyId))).toHaveLength(0);
    });

    it('T2 a link a thief session started is refused at the callback once the owner signed out every other device (au5-A1)', async () =>
    {
        const thief = await signIn();
        const owner = await signIn();
        const started = await startLink(thief);

        expect((await post('/_auth/keys/revoke-all', {}, owner.authorization)).status).toBe(200);

        expect(await finishLink(started)).toBe('failed');
        expect(await rowsOf(userSocialAccounts)).toHaveLength(0);
    });

    it('T3 a passkey registration challenge minted before the owner enrolled is refused at verify: 403, no passkey (au7-A3)', async () =>
    {
        const thief = await signIn();
        const owner = await signIn();
        const challenge = await startPasskey(thief);

        expect((await confirmTotp(owner, await startTotp(owner))).status).toBe(200);

        await expectError(await finishPasskey(thief, challenge), 403, 'StepUpRequiredError');
        expect(await rowsOf(passkeys)).toHaveLength(0);
    });

    // ========================================================================
    // T4 — another session of the account completes
    // ========================================================================

    it('T4 TOTP: an enrolment session A started is not confirmed by session B', async () =>
    {
        const a = await signIn();
        const b = await signIn();
        const secret = await startTotp(a);

        await expectError(await confirmTotp(b, secret), 400, 'MfaNotEnrolledError');
        expect(await totpConfirmed()).toBe(false);
    });

    it('T4 passkey: a registration challenge session A asked for is not spent by session B', async () =>
    {
        const a = await signIn();
        const b = await signIn();
        const challenge = await startPasskey(a);

        await expectError(await finishPasskey(b, challenge), 401, 'PasskeyChallengeError');
        expect(await rowsOf(passkeys)).toHaveLength(0);
    });

    // ========================================================================
    // T5 — the account moved after the start
    // ========================================================================

    /** What happens between start and completion, run from the starting session where it is one of its own. */
    const AFTER_START: [string, (starter: Session) => Promise<void>][] = [
        ['a password change', async (starter) =>
        {
            const changed = await send('PUT', '/_auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, starter.authorization);

            expect(changed.status).toBe(204);
        }],
        ['setAccountStatus suspended', async () =>
        {
            expect(await setAccountStatus(ownerId, 'suspended', { from: 'any', reason: 'T5' })).toBe('changed');
        }],
        // The starting key survives this one and moves into the new key
        // generation with the account: only the generation comparison refuses.
        ['a sign-out of every other device from the starting session', async (starter) =>
        {
            expect((await post('/_auth/keys/revoke-all', {}, starter.authorization)).status).toBe(200);
            expect(await keyRow(starter.key.keyId)).toMatchObject({ isActive: true });
        }],
    ];

    it.each(AFTER_START)('T5 TOTP: after %s, the enrolment is not confirmed', async (_name, move) =>
    {
        const starter = await signIn();
        const secret = await startTotp(starter);

        await move(starter);

        expect((await confirmTotp(starter, secret)).status).not.toBe(200);
        expect(await totpConfirmed()).toBe(false);
        expect(await rowsOf(mfaRecoveryCodes)).toHaveLength(0);
    });

    it.each(AFTER_START)('T5 passkey: after %s, the registration is refused', async (_name, move) =>
    {
        const starter = await signIn();
        const challenge = await startPasskey(starter);

        await move(starter);

        expect((await finishPasskey(starter, challenge)).status).not.toBe(200);
        expect(await rowsOf(passkeys)).toHaveLength(0);
    });

    it.each(AFTER_START)('T5 link: after %s, the callback is refused', async (name, move) =>
    {
        const starter = await signIn();
        const started = await startLink(starter);

        await move(starter);

        expect(await finishLink(started)).toBe(name === 'setAccountStatus suspended' ? 'account_unavailable' : 'failed');
        expect(await rowsOf(userSocialAccounts)).toHaveLength(0);
    });

    // ========================================================================
    // T6 — the legitimate person is not blocked
    // ========================================================================

    it('T6 TOTP: the session that started it confirms it, and so does its verified replacement', async () =>
    {
        const session = await signIn();

        expect((await confirmTotp(session, await startTotp(session))).status).toBe(200);
        expect(await totpConfirmed()).toBe(true);

        await getTestDb().delete(mfaTotp);
        await getTestDb().delete(mfaRecoveryCodes);

        const a = await signIn();
        const secret = await startTotp(a);
        const b = await reLogin(a);
        const confirmed = await confirmTotp(b, secret);

        expect(confirmed.status).toBe(200);
        expect((await confirmed.json()).recoveryCodes).toHaveLength(10);
    });

    it('T6 passkey: the session that asked for the options registers, and so does its verified replacement', async () =>
    {
        const session = await signIn();

        expect((await finishPasskey(session, await startPasskey(session))).status).toBe(200);

        const a = await signIn();
        const challenge = await startPasskey(a);
        const b = await reLogin(a);

        expect((await finishPasskey(b, challenge)).status).toBe(200);
        expect(await rowsOf(passkeys)).toHaveLength(2);
    });

    it('T6 link: the session that started it links, and so does a link whose starting key was replaced by a verified re-login', async () =>
    {
        const session = await signIn();

        expect(await finishLink(await startLink(session))).toBe('linked');

        await getTestDb().delete(userSocialAccounts);

        const a = await signIn();
        const started = await startLink(a);

        await reLogin(a);

        expect(await finishLink(started)).toBe('linked');
        expect(await rowsOf(userSocialAccounts)).toHaveLength(1);
    });

    // ========================================================================
    // T8 — the renewal challenge
    // ========================================================================

    /** Two bound sessions of the account, and the passkey both renew with. */
    async function boundSessions(): Promise<{ a: Session; b: Session; authenticator: FixtureAuthenticator }>
    {
        const a = await signIn();
        const authenticator = await FixtureAuthenticator.create();

        expect((await finishPasskey(a, await startPasskey(a), authenticator)).status).toBe(200);
        expect((await post('/_auth/session/binding', { mode: 'passkey' }, a.authorization)).status).toBe(200);

        const b = await signIn();

        expect(await keyRow(b.key.keyId)).toMatchObject({ binding: 'passkey' });

        return { a, b, authenticator };
    }

    async function renewOptions(session: Session): Promise<string>
    {
        const options = await post('/_auth/session/renew/options', {}, session.authorization);

        expect(options.status).toBe(200);

        return (await options.json()).challenge as string;
    }

    function renewVerify(session: Session, authenticator: FixtureAuthenticator, challenge: string, tamper = false): Promise<Response>
    {
        const pair = generateKeyPair('ES256');

        assertionCounter += 1;

        return post('/_auth/session/renew/verify', {
            response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: assertionCounter, tamper }),
            publicKey: pair.publicKey,
            keyId: pair.keyId,
            fingerprint: pair.fingerprint,
            algorithm: pair.algorithm,
        }, session.authorization);
    }

    it('T8 a renewal challenge issued for key A does not renew key B', async () =>
    {
        const { a, b, authenticator } = await boundSessions();
        const challenge = await renewOptions(a);

        await expectError(await renewVerify(b, authenticator, challenge), 401, 'SessionRenewalRefusedError');
        expect(await keyRow(b.key.keyId)).toMatchObject({ isActive: true });
    });

    it('T8 a renewal challenge whose verification failed cannot be tried again', async () =>
    {
        const { a, authenticator } = await boundSessions();
        const challenge = await renewOptions(a);

        await expectError(await renewVerify(a, authenticator, challenge, true), 401, 'SessionRenewalRefusedError');
        await expectError(await renewVerify(a, authenticator, challenge), 401, 'SessionRenewalRefusedError');
        expect(await keyRow(a.key.keyId)).toMatchObject({ isActive: true });
    });

    // ========================================================================
    // T9 — a session signed in through an app-registered auth profile
    // ========================================================================

    async function stepUpOptions(session: Session | ProfileSession): Promise<string>
    {
        const options = await post('/_auth/mfa/step-up/options', {}, asOf(session));

        expect(options.status).toBe(200);

        return (await options.json()).challenge as string;
    }

    function stepUp(session: Session | ProfileSession, authenticator: FixtureAuthenticator, challenge: string): Promise<Response>
    {
        assertionCounter += 1;

        return post('/_auth/mfa/step-up', {
            response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: assertionCounter }),
        }, asOf(session));
    }

    async function stepUpRecords(keyId: string)
    {
        return await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.keyId, keyId));
    }

    it('T9 a profile session registers a passkey: options → verify 200', async () =>
    {
        const session = profileSession(PROFILE_A, 'app-key-1');

        expect((await finishPasskey(session, await startPasskey(session, { currentPassword: PASSWORD }))).status).toBe(200);
        expect(await rowsOf(passkeys)).toHaveLength(1);
    });

    it('T9 a TOTP enrolment and a step-up challenge profile A started are refused to profile B', async () =>
    {
        const secret = await startTotp(profileSession(PROFILE_A, 'app-key-1'));

        await expectError(await confirmTotp(profileSession(PROFILE_B, 'app-key-1'), secret), 400, 'MfaNotEnrolledError');
        expect(await totpConfirmed()).toBe(false);

        const authenticator = await enrolMarkedPasskey(await signIn());
        const challenge = await stepUpOptions(profileSession(PROFILE_A, 'app-key-1'));

        await expectError(await stepUp(profileSession(PROFILE_B, 'app-key-1'), authenticator, challenge), 401, 'MfaVerificationFailedError');
    });

    it('T9 a registration profile A started is refused to profile B, to A under another key id and to a device key — and A completes it', async () =>
    {
        const starter = profileSession(PROFILE_A, 'app-key-1');
        const challenge = await startPasskey(starter, { currentPassword: PASSWORD });
        const others: (Session | ProfileSession)[] = [
            profileSession(PROFILE_B, 'app-key-1'),
            profileSession(PROFILE_A, 'app-key-2'),
            await signIn(),
        ];

        for (const other of others)
        {
            await expectError(await finishPasskey(other, challenge), 401, 'PasskeyChallengeError');
        }

        expect(await rowsOf(passkeys)).toHaveLength(0);
        expect((await finishPasskey(starter, challenge)).status).toBe(200);
    });

    it('T9 a profile reporting a device key\'s own key id is not that device key: neither completes the other\'s registration', async () =>
    {
        const device = await signIn();
        const profile = profileSession(PROFILE_A, device.key.keyId);
        const deviceChallenge = await startPasskey(device, { currentPassword: PASSWORD });
        const profileChallenge = await startPasskey(profile, { currentPassword: PASSWORD });

        await expectError(await finishPasskey(profile, deviceChallenge), 401, 'PasskeyChallengeError');
        await expectError(await finishPasskey(device, profileChallenge), 401, 'PasskeyChallengeError');
        expect(await rowsOf(passkeys)).toHaveLength(0);
        expect((await finishPasskey(device, deviceChallenge)).status).toBe(200);
        expect((await finishPasskey(profile, profileChallenge)).status).toBe(200);
    });

    it('T9 a profile session cannot start a link: 403 OAUTH_LINK_CREDENTIAL_UNSUPPORTED, nothing sealed', async () =>
    {
        const response = await post('/_auth/oauth/battlenet/link', {
            returnUrl: RETURN_URL, nonce: generateOAuthNonce(), startId: generateOAuthNonce(), currentPassword: PASSWORD,
        }, asOf(profileSession(PROFILE_A, 'app-key-1')));

        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ __type: 'OAuthLinkCredentialUnsupportedError', code: 'OAUTH_LINK_CREDENTIAL_UNSUPPORTED' });
    });

    // ========================================================================
    // T10 — one challenge kind per procedure
    // ========================================================================

    /** A password sign-in on a new device of an enrolled account: its 202 handle and the pending key. */
    async function pendingSignIn(): Promise<{ handle: string; key: KeyPair }>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'owner@test.com', password: PASSWORD, publicKey: key.publicKey, keyId: key.keyId,
            fingerprint: key.fingerprint, algorithm: key.algorithm,
        });

        expect(response.status).toBe(202);

        return { handle: (await response.json()).challenge.secret as string, key };
    }

    async function newDeviceOptions(handle: string): Promise<string>
    {
        const options = await post('/_auth/mfa/verify/options', { challenge: handle });

        expect(options.status).toBe(200);

        return (await options.json()).challenge as string;
    }

    /** Park an unstamped challenge row directly, as a release before stamps wrote one. */
    async function parkUnstampedRow(challenge: string, kind: string): Promise<void>
    {
        await getTestDb().execute(sql`
            INSERT INTO spfn_auth.webauthn_challenges (challenge_hash, kind, user_id, expires_at)
            VALUES (${hashChallenge(challenge)}, ${kind}, ${ownerId}, ${new Date(Date.now() + 300_000).toISOString()})`);
    }

    /** Stamp a challenge row in the table for a device session, as a stamped kind's start would. */
    async function stampRowFor(challenge: string, session: Session): Promise<void>
    {
        const [owner] = await getTestDb().select({ keyEpoch: users.keyEpoch }).from(users).where(eq(users.id, ownerId));

        await getTestDb().update(webauthnChallenges)
            .set({ startedByKeyId: session.key.keyId, keyEpoch: owner!.keyEpoch })
            .where(eq(webauthnChallenges.challengeHash, hashChallenge(challenge)));
    }

    // The row passes the stamp check, so only its kind refuses it.
    it('T10 a 202 handle\'s new-device challenge stamped for session A is not spent as A\'s step-up: refused, no step-up record (the Codex probe)', async () =>
    {
        const a = await signIn();
        const authenticator = await enrolMarkedPasskey(a);
        const { handle } = await pendingSignIn();
        const challenge = await newDeviceOptions(handle);
        const records = (await stepUpRecords(a.key.keyId)).length;

        await stampRowFor(challenge, a);

        expect((await stepUp(a, authenticator, challenge)).status).toBe(401);
        expect(await stepUpRecords(a.key.keyId)).toHaveLength(records);
    });

    it('T10 a stamped step-up challenge presented to mfa/verify is refused: 401, the key stays pending', async () =>
    {
        const a = await signIn();
        const authenticator = await enrolMarkedPasskey(a);
        const { handle, key } = await pendingSignIn();
        const challenge = await stepUpOptions(a);

        assertionCounter += 1;

        const verified = await post('/_auth/mfa/verify', {
            challenge: handle,
            response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: assertionCounter }),
        });

        await expectError(verified, 401, 'MfaVerificationFailedError');
        expect(await keyRow(key.keyId)).toMatchObject({ isActive: false });
    });

    it.each([
        ['a step-up row without a stamp', 'stepUp'],
        ['a pre-upgrade \'mfa\' row', 'mfa'],
    ])('T10 %s is refused at step-up', async (_name, kind) =>
    {
        const a = await signIn();
        const authenticator = await enrolMarkedPasskey(a);
        const challenge = generateOAuthNonce();

        await parkUnstampedRow(challenge, kind);

        expect((await stepUp(a, authenticator, challenge)).status).toBe(401);
        expect(await stepUpRecords(a.key.keyId)).toHaveLength(0);
    });

    async function bindingOffOptions(session: Session): Promise<string>
    {
        const options = await post('/_auth/session/binding/disable/options', {}, session.authorization);

        expect(options.status).toBe(200);

        return (await options.json()).challenge as string;
    }

    function bindingOff(session: Session, authenticator: FixtureAuthenticator, challenge: string): Promise<Response>
    {
        assertionCounter += 1;

        return post('/_auth/session/binding', {
            mode: 'none',
            response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: assertionCounter }),
        }, session.authorization);
    }

    async function sessionBinding(): Promise<string>
    {
        const [row] = await getTestDb().select({ binding: users.sessionBinding }).from(users).where(eq(users.id, ownerId));

        return row!.binding;
    }

    it('T10 a binding-off challenge does not renew the key, and a renewal challenge does not turn binding off', async () =>
    {
        const { b, authenticator } = await boundSessions();

        await expectError(await renewVerify(b, authenticator, await bindingOffOptions(b)), 401, 'SessionRenewalRefusedError');
        await expectError(await bindingOff(b, authenticator, await renewOptions(b)), 403, 'RecentAuthenticationRequiredError');
        expect(await sessionBinding()).toBe('passkey');
        expect(await keyRow(b.key.keyId)).toMatchObject({ isActive: true });
    });

    // ========================================================================
    // T11 — the stamp on step-up by passkey and on binding-off
    // ========================================================================

    it('T11 session B spends session A\'s step-up challenge: refused, no step-up record for B', async () =>
    {
        const a = await signIn();
        const b = await signIn();
        const authenticator = await enrolMarkedPasskey(a);
        const challenge = await stepUpOptions(a);

        expect((await stepUp(b, authenticator, challenge)).status).toBe(401);
        expect(await stepUpRecords(b.key.keyId)).toHaveLength(0);
        expect((await stepUp(a, authenticator, challenge)).status).toBe(204);
    });

    it('T11 session B completes session A\'s binding-off: refused, binding stays on', async () =>
    {
        const { a, b, authenticator } = await boundSessions();
        const challenge = await bindingOffOptions(a);

        await expectError(await bindingOff(b, authenticator, challenge), 403, 'RecentAuthenticationRequiredError');
        expect(await sessionBinding()).toBe('passkey');
        expect((await bindingOff(a, authenticator, challenge)).status).toBe(200);
        expect(await sessionBinding()).toBe('none');
    });

    // ========================================================================
    // T12 — the password proven at register/options is that ceremony's
    // ========================================================================

    it('T12 a password at register/options does not refresh the session: a link start and a binding enable are refused; the verify is admitted', async () =>
    {
        const session = await signIn();

        await getTestDb().update(userPublicKeys)
            .set({ authenticatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
            .where(eq(userPublicKeys.keyId, session.key.keyId));

        const challenge = await startPasskey(session, { currentPassword: PASSWORD });
        const link = await post('/_auth/oauth/battlenet/link', {
            returnUrl: RETURN_URL, nonce: generateOAuthNonce(), startId: generateOAuthNonce(),
        }, session.authorization);

        await expectError(link, 403, 'RecentAuthenticationRequiredError');
        expect((await finishPasskey(session, challenge)).status).toBe(200);
        await expectError(await post('/_auth/session/binding', { mode: 'passkey' }, session.authorization), 403, 'RecentAuthenticationRequiredError');
    });

    // ========================================================================
    // T13 — a completion is no credential an application can present
    // ========================================================================

    it('T13 admitPrincipal refuses a forged deferred credential, and the server entry exports no admitCompletion', async () =>
    {
        const session = await signIn();
        const forged = { kind: 'deferred', keyId: session.key.keyId, enrolment: 'always' } as unknown as PrincipalCredential;

        await expect(admitPrincipal({ userId: ownerId, credential: forged, route: null })).rejects.toThrow(/Unknown credential kind/);
        expect('admitCompletion' in serverEntry).toBe(false);
        expect('admitPrincipal' in serverEntry).toBe(true);
    });

    // ========================================================================
    // T14 — a verified replacement re-points only a device key's stamps
    // ========================================================================

    it('T14 a replacement K→K2 moves the device\'s registration to K2 and leaves a profile\'s that reports K on K: both complete', async () =>
    {
        const device = await signIn();
        const profile = profileSession(PROFILE_A, device.key.keyId);
        const deviceChallenge = await startPasskey(device);
        const profileChallenge = await startPasskey(profile, { currentPassword: PASSWORD });
        const replaced = await reLogin(device);

        expect((await finishPasskey(profile, profileChallenge)).status).toBe(200);
        expect((await finishPasskey(replaced, deviceChallenge)).status).toBe(200);
        expect(await rowsOf(passkeys)).toHaveLength(2);
    });

    it('T14 a replacement K→K2 leaves a profile\'s TOTP enrolment that reports K on K: the profile confirms it', async () =>
    {
        const device = await signIn();
        const profile = profileSession(PROFILE_A, device.key.keyId);
        const secret = await startTotp(profile);

        await reLogin(device);

        expect((await confirmTotp(profile, secret)).status).toBe(200);
        expect(await totpConfirmed()).toBe(true);
    });
});
