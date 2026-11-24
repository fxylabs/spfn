/**
 * One admission point for a person principal (audit bundle 3, w-10ace).
 *
 * "May this person be let in now" is answered by `admitPrincipal` alone; every
 * door extracts its credential and asks it. These rows hold that in place.
 *
 * | Row | Checks                                                                                              |
 * |-----|-----------------------------------------------------------------------------------------------------|
 * | T1  | every door × status {active, suspended} × deletion {none, pending, deleted}, and inactive → refused |
 * |     | in that door's own answer (a pending deletion with the pending-deletion answer, whatever the       |
 * |     | status); active with none → admitted. The door list is derived from the source (every caller of   |
 * |     | `admitPrincipal`), so a door this table does not drive fails the first T1 row. Every door is also  |
 * |     | driven for an active account that must change its password (#362): admitted where what it leads to |
 * |     | admits that session (renewal, sign-out, mfa/verify), otherwise refused in its own answer            |
 * | T2  | only the admission module can make a principal (brand + sealed constructor), and no source casts   |
 * |     | its way to one                                                                                      |
 * | T3  | a one-time token dies with the key that issued it — logout, revoke-all, password change — and a    |
 * |     | stream opened with it closes                                                                        |
 * | T4  | suspension refuses an OAuth 2.1 client (access token, refresh, code exchange); reactivation brings |
 * |     | the grant back and not the web session                                                              |
 * | T5  | a 202 sign-in is not completed for an account suspended while its challenge was open                |
 * | T6  | a device-code approval dies with the approving key                                                  |
 * | T7  | `setAccountStatus(…, 'suspended')` ends every session and stream; `updateUserService` takes no status |
 * | T8  | a deletion cancel that read the account before a suspension committed does not lift it: the        |
 * |     | deletion is cleared and the account stays suspended. Without it, a cancel overwrites an operator's |
 * |     | suspension with `active`                                                                          |
 * | T8b | a password cancel that read an active account with nothing pending before a suspension committed   |
 * |     | is answered as a wrong password (#364). Without it, the refusal under the lock answers            |
 * |     | `DeletionNotRequestedError`, telling the caller the suspended account's password was right        |
 * | T9  | a password sign-in that read the account before a suspension committed writes no key: refused as a |
 * |     | wrong password, and nothing it registered is admitted after reactivation. Without it, the key      |
 * |     | outlives the suspension, or the refusal under the lock tells the caller the password was right    |
 * | T10 | a token minted through core's endpoint with a custom `getSubject` and the shared manager is honoured |
 * |     | for the key holder recorded beside the tag, and refused once that key is revoked. Without it, the  |
 * |     | subject is parsed as the user id and a custom subject is refused or checked against another account |
 * | T11 | `mfa/verify` for a non-active account spends no recovery code and counts no attempt; the same code  |
 * |     | completes the sign-in after reactivation. Without it, a refused attempt burns a recovery code       |
 *
 * Every row drives the production path: the auth router mounted as a server
 * mounts it, `optionalAuth` / `oneTimeTokenAuth` / the core SSE handler on routes
 * of their own (no route in the package carries them), and `@spfn/mcp`'s
 * `createMcpRoute` with `verifyAccessToken`, as the README wires it.
 *
 * T1 writes the status and the deletion straight to the row. That isolates the
 * rule itself: `setAccountStatus` and `setAccountDeletion` would also end every
 * key, and a door would then be refused for its dead credential whatever it
 * does with the account (T7 covers the writer). It is also the state a value
 * written outside the package leaves.
 */

import { describe, it, expect, expectTypeOf, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { Type } from '@sinclair/typebox';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import {
    configureTestAuthorizationServer,
    createTestUser,
    decideAuthorize,
    FORM_HEADERS,
    obtainCode,
    pkcePair,
    registerLoopbackClient,
    TEST_PASSWORD,
    TEST_REDIRECT_URI,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { configureChannels } from '@/server/lib/channels-config';
import { accountDeletionRequests, mfaTotp, userPublicKeys, users, type User } from '@/server/entities';
import { usersRepository } from '@/server/repositories';
import { admitPrincipal } from '@/server/services/admission.service';
import { requestAccountDeletionService } from '@/server/services/account-deletion.service';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authLoginEvent } from '@/server/events';
import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import { oneTimeTokenAuth } from '@/server/middleware/one-time-token-auth';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { getAuth } from '@/server/helpers/context';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';
import { ABSENT_BODY_SHA256, signClientProof } from '@/server/client-proof/proof';
import { TEST_KEY_ID, TEST_PRIVATE_KEY_PKCS8_B64, TEST_PUBLIC_KEY_SPKI_B64 } from '@/server/client-proof/__tests__/test-keys';
import {
    AuthContext,
    VerifiedOAuth2AccessToken,
    type PrincipalCredential,
} from '@/server/services/admission.service';
import { setAccountStatus, updateUserService } from '@/server/services/user.service';
import { verifyAccessToken } from '@/server/services/oauth2-access-token.service';
import type { AccountDeletionState, UserStatus } from '@/server/types';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { createSSEHandler } = await import('@spfn/core/event/sse');
const { defineEvent, defineEventRouter } = await import('@spfn/core/event');
const { createMcpRoute } = await import('@spfn/mcp/server');
const { createServer, defineServerConfig } = await import('@spfn/core/server');
const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { initOneTimeTokenManager, getOneTimeTokenManager } = await import('@/server/lib/one-time-token');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const NEW_PASSWORD = 'BrandNewPassword456!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const APP_PROFILE = 'admissionT1AppProfileV1';
const APP_PROFILE_USER_HEADER = 'x-t1-account';
const STREAM_EVENT = 'admissionT1Ping';

/** Where an account stands: an operator's status and its deletion, two facts. */
interface AccountState
{
    status: UserStatus;
    deletion: AccountDeletionState | null;
}

/** The states that forbid access — every one of them is refused at every door. */
const REFUSING: AccountState[] = [
    { status: 'inactive', deletion: null },
    { status: 'suspended', deletion: null },
    { status: 'active', deletion: 'pending' },
    { status: 'suspended', deletion: 'pending' },
    { status: 'active', deletion: 'deleted' },
    { status: 'suspended', deletion: 'deleted' },
];

const SERVER_ROOT = join(__dirname, '..', '..', 'server');
const ADMISSION_MODULE = join('services', 'admission.service.ts');

interface Session
{
    keyId: string;
    authorization: string;
}

/** A door's attempt, prepared while the account was active and made after its state moved. */
type Attempt = () => Promise<Response>;

interface Door
{
    name: string;
    prepare: (account: Account) => Promise<Attempt>;
    admitted: (response: Response, account: Account) => Promise<void>;
    refused: (response: Response, state: AccountState) => Promise<void>;
    /**
     * Its answer to an active account that must change its password (#362):
     * `'admitted'` where what the door leads to admits that session, otherwise
     * the refusal it answers with.
     */
    passwordChange: 'admitted' | ((response: Response) => Promise<void>);
}

interface Account
{
    id: number;
    email: string;
    ip: string;
}

/**
 * Every file that produces a person principal: the callers of `admitPrincipal`
 * — and of `admitCompletion`, its entry for a credential asked again under the
 * account lock — read off the source.
 */
function admissionCallers(): string[]
{
    return sourceFiles(SERVER_ROOT)
        .filter((file) => !file.endsWith(ADMISSION_MODULE) && /\badmit(?:Principal|Completion)\(/.test(readFileSync(file, 'utf8')))
        .map((file) => relative(SERVER_ROOT, file).split(sep).join('/'))
        .sort();
}

/** Every non-test TypeScript file under `root`. */
function sourceFiles(root: string): string[]
{
    return readdirSync(root).flatMap((entry) =>
    {
        const full = join(root, entry);

        if (statSync(full).isDirectory())
        {
            return entry === '__tests__' ? [] : sourceFiles(full);
        }

        return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
    });
}

describe.skipIf(!dbAvailable)('one admission point for a person principal (T1-T11)', () =>
{
    let app: Hono;
    let sse: ReturnType<typeof createSSEHandler>;
    let counter = 0;
    const openStreams: AbortController[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        // selfDeletion is off unless the app states it (#475).
        configureChannels({ selfDeletion: true });
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

        initOneTimeTokenManager();
        registerAuthProfile(APP_PROFILE, {
            verify: async (c) => ({ userId: c.req.header(APP_PROFILE_USER_HEADER)!, keyId: 'app-profile-key', scheme: APP_PROFILE }),
        });
        app = mountApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        configureTestAuthorizationServer();
    });

    afterEach(() =>
    {
        openStreams.splice(0).forEach((controller) => controller.abort());
        vi.restoreAllMocks();
    });

    // ========================================================================
    // The server
    // ========================================================================

    /**
     * The auth router as a server mounts it, the MCP route as the README wires it,
     * and the doors no package route carries on routes of their own. A stand-in
     * for the web proxy's client-type marker comes first: session binding and
     * renewal are web-only.
     */
    function mountApp(): Hono
    {
        const mounted = new Hono();
        const events = defineEventRouter({ [STREAM_EVENT]: defineEvent(STREAM_EVENT, Type.Object({})) });

        sse = createSSEHandler(events, { auth: { enabled: true } }, getOneTimeTokenManager());
        mounted.use('*', async (c, next) =>
        {
            c.set('clientType', 'web');
            await next();
        });
        mounted.post('/t/me', authenticate.handler, (c) => c.json({ userId: getAuth(c).userId }));
        mounted.get('/t/optional', optionalAuth.handler, (c) => c.json({ userId: c.get('auth')?.userId ?? null }));
        mounted.get('/t/ott', oneTimeTokenAuth.handler, (c) => c.json({ userId: getAuth(c).userId }));
        mounted.get('/events/stream', sse);
        registerRoutes(mounted, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        registerRoutes(mounted, createMcpRoute({
            appUrl: 'https://api.example.com',
            serverInfo: { name: 'admission-t1', version: '1.0.0' },
            validateToken: verifyAccessToken,
            resolveContext: async (auth) => ({ userId: auth.userId }),
            listTools: () => [],
        }));
        mounted.onError(ErrorHandler());

        return mounted;
    }

    async function send(method: string, path: string, account: Account, body?: unknown, headers: Record<string, string> = {}): Promise<Response>
    {
        return await app.request(path, {
            method,
            headers: { ...JSON_HEADERS, 'x-forwarded-for': account.ip, ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    const post = (path: string, account: Account, body: unknown, authorization?: string) =>
        send('POST', path, account, body, authorization ? { Authorization: authorization } : {});

    async function expectError(response: Response, status: number, code: string): Promise<void>
    {
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }

    /** The answer the cookie/Bearer surfaces give an account that may not be let in. */
    async function expectAccountRefusal(response: Response, state: AccountState): Promise<void>
    {
        await expectError(response, 403, state.deletion === 'pending' ? 'AccountPendingDeletionError' : 'AccountDisabledError');
    }

    // ========================================================================
    // Accounts, sessions and credentials
    // ========================================================================

    /** An account of this row's own, on an address of its own: login is rate limited by both. */
    async function newAccount(): Promise<Account>
    {
        counter += 1;
        const email = `admission-${counter}@test.com`;

        return { id: await createTestUser(email, (await getRoleByName('user'))!.id), email, ip: `198.51.${counter >> 8}.${counter & 0xff}` };
    }

    async function writeState(account: Account, state: AccountState): Promise<void>
    {
        await getTestDb().update(users).set(state).where(eq(users.id, account.id));
    }

    function bearer(keyId: string, privateKey: string): string
    {
        return `Bearer ${generateClientToken({ keyId }, privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    /** Sign in with a password from a new device; answers the raw response with the session it would be. */
    async function login(account: Account): Promise<{ response: Response; session: Session }>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', account, {
            email: account.email,
            password: TEST_PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        return { response, session: { keyId: key.keyId, authorization: bearer(key.keyId, key.privateKey) } };
    }

    async function signIn(account: Account): Promise<Session>
    {
        const { response, session } = await login(account);

        expect(response.status).toBe(200);

        return session;
    }

    async function issueToken(account: Account, session: Session): Promise<string>
    {
        const issued = await post('/_auth/tokens', account, {}, session.authorization);

        expect(issued.status).toBe(200);

        return (await issued.json()).token as string;
    }

    /** Open an SSE stream with a one-time token, and keep it open until the row ends. */
    async function openStream(token: string): Promise<{ response: Response; ended: Promise<void> }>
    {
        const controller = new AbortController();
        const response = await app.request(new Request(
            `http://localhost/events/stream?events=${STREAM_EVENT}&token=${token}`,
            { signal: controller.signal },
        ));

        openStreams.push(controller);

        return { response, ended: response.status === 200 ? drained(response.body!.getReader()) : Promise.resolve() };
    }

    async function drained(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void>
    {
        while (!(await reader.read().catch(() => ({ done: true }))).done)
        {
            // keep reading until the server ends the stream
        }
    }

    /** Whether the stream ended within a second — a closed stream ends at once. */
    async function endsSoon(stream: { ended: Promise<void> }): Promise<boolean>
    {
        return await Promise.race([
            stream.ended.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
        ]);
    }

    /** Turn session binding on for `session`'s device, so its key may renew. */
    async function bindToPasskey(account: Account, session: Session): Promise<void>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', account, {}, session.authorization);
        const verified = await post('/_auth/passkeys/register/verify', account, {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
        }, session.authorization);

        expect(verified.status).toBe(200);
        expect((await enableBinding((path, body) => post(path, account, body, session.authorization), authenticator, { origin: ORIGIN, rpId: RP_ID })).status).toBe(200);
    }

    function totpCode(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    /** Enrol TOTP, then sign in from a new device: answers the open 202 challenge, the TOTP secret and the recovery codes. */
    async function openChallenge(account: Account): Promise<{ challenge: string; secret: string; keyId: string; recoveryCodes: string[] }>
    {
        const session = await signIn(account);
        const enrolled = await post('/_auth/mfa/totp/enroll', account, {}, session.authorization);
        const secret = (await enrolled.json()).secret as string;
        const confirmed = await post('/_auth/mfa/totp/confirm', account, { code: totpCode(secret) }, session.authorization);

        expect(confirmed.status).toBe(200);
        const { recoveryCodes } = await confirmed.json() as { recoveryCodes: string[] };
        // The confirm spent the current step; the verify below must not read as its replay.
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });

        const { response, session: pending } = await login(account);

        expect(response.status).toBe(202);

        return { challenge: (await response.json()).challenge.secret as string, secret, keyId: pending.keyId, recoveryCodes };
    }

    /** A grant approved by `account` for a CLI: a fresh code, and the tokens a first exchange of another. */
    async function grantFor(account: Account)
    {
        const session = await signIn(account);
        const clientId = await registerLoopbackClient(app, `admission-cli-${counter}`, [TEST_REDIRECT_URI], account.ip);
        const first = pkcePair(`admission-${counter}-a`);
        const second = pkcePair(`admission-${counter}-b`);
        const exchanged = await exchange(clientId, await obtainCode(app, session.authorization, { client_id: clientId }, first.challenge), first.verifier);

        expect(exchanged.status).toBe(200);

        const tokens = await exchanged.json() as { access_token: string; refresh_token: string };
        const code = await obtainCode(app, session.authorization, { client_id: clientId }, second.challenge);

        return { session, clientId, tokens, code, verifier: second.verifier };
    }

    async function tokenRequest(fields: Record<string, string>): Promise<Response>
    {
        return await app.request('/_auth/oauth2/token', { method: 'POST', headers: FORM_HEADERS, body: new URLSearchParams(fields).toString() });
    }

    function exchange(clientId: string, code: string, verifier: string): Promise<Response>
    {
        return tokenRequest({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
        });
    }

    function refresh(clientId: string, refreshToken: string): Promise<Response>
    {
        return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    }

    /** An MCP `initialize`, as Claude Code sends it. */
    async function mcp(accessToken: string): Promise<Response>
    {
        return await app.request('/mcp', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't1', version: '1.0.0' } },
            }),
        });
    }

    async function expectInvalidGrant(response: Response): Promise<void>
    {
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_grant');
    }

    /** A client-proof request for `/t/me`, signed with the frozen test key registered to `account`. */
    async function proofRequest(account: Account): Promise<Attempt>
    {
        await getTestDb().insert(userPublicKeys).values({
            userId: account.id,
            keyId: TEST_KEY_ID,
            publicKey: TEST_PUBLIC_KEY_SPKI_B64,
            algorithm: 'ES256',
            fingerprint: 'client-proof-test-key',
        });

        return async () =>
        {
            const clientId = String(account.id);
            const nonce = `nonce-${Math.random().toString(16).slice(2)}`;
            const issuedAtMillis = BigInt(Date.now());
            const proof = signClientProof(
                { method: 'POST', path: '/t/me', clientId, keyId: TEST_KEY_ID, nonce, issuedAtMillis, bodySha256: ABSENT_BODY_SHA256 },
                TEST_PRIVATE_KEY_PKCS8_B64,
            );

            return await app.request('/t/me', {
                method: 'POST',
                headers: {
                    [CLIENT_PROOF_HEADERS.profile]: 'clientProofV1',
                    [CLIENT_PROOF_HEADERS.clientId]: clientId,
                    [CLIENT_PROOF_HEADERS.keyId]: TEST_KEY_ID,
                    [CLIENT_PROOF_HEADERS.nonce]: nonce,
                    [CLIENT_PROOF_HEADERS.issuedAtMillis]: issuedAtMillis.toString(),
                    [CLIENT_PROOF_HEADERS.proof]: proof,
                },
            });
        };
    }

    // ========================================================================
    // T1 — the doors
    // ========================================================================

    const admittedAs = async (response: Response, account: Account) =>
    {
        expect(response.status).toBe(200);
        expect((await response.json()).userId).toBe(String(account.id));
    };

    /** `optionalAuth`'s answer to an unusable principal: the anonymous caller. */
    const answeredAnonymous = async (response: Response) =>
    {
        expect(response.status).toBe(200);
        expect((await response.json()).userId).toBeNull();
    };

    /** The answer to a session that must change its password first: not signed out, told why. */
    const expectPasswordChangeRefusal = (response: Response) => expectError(response, 403, 'PasswordChangeRequiredError');

    const DOORS: Record<string, Door> = {
        bearer: {
            name: 'authenticate, Bearer',
            prepare: async (account) =>
            {
                const session = await signIn(account);

                return () => post('/t/me', account, {}, session.authorization);
            },
            admitted: admittedAs,
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        clientProofV1: {
            name: 'authenticate, clientProofV1',
            prepare: proofRequest,
            admitted: admittedAs,
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        appProfile: {
            name: 'authenticate, an app-registered profile',
            prepare: async (account) => () => send('POST', '/t/me', account, undefined, {
                [CLIENT_PROOF_HEADERS.profile]: APP_PROFILE,
                [APP_PROFILE_USER_HEADER]: String(account.id),
            }),
            admitted: admittedAs,
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        optionalAuth: {
            name: 'optionalAuth, Bearer',
            prepare: async (account) =>
            {
                const session = await signIn(account);

                return () => send('GET', '/t/optional', account, undefined, { Authorization: session.authorization });
            },
            admitted: admittedAs,
            refused: answeredAnonymous,
            passwordChange: answeredAnonymous,
        },
        oneTimeToken: {
            name: 'oneTimeTokenAuth',
            prepare: async (account) =>
            {
                const token = await issueToken(account, await signIn(account));

                return () => send('GET', `/t/ott?token=${token}`, account);
            },
            admitted: admittedAs,
            refused: async (response) =>
            {
                expect(response.status).toBe(401);
                expect((await response.json()).error).toMatchObject({ code: 'UnauthorizedError', message: 'Account is not active' });
            },
            passwordChange: expectPasswordChangeRefusal,
        },
        sseStream: {
            name: 'an SSE stream opened with a one-time token',
            prepare: async (account) =>
            {
                const token = await issueToken(account, await signIn(account));

                return async () => (await openStream(token)).response;
            },
            admitted: async (response) => expect(response.status).toBe(200),
            refused: async (response) => expect(response.status).toBe(401),
            // The core SSE handler answers every refused token alike.
            passwordChange: async (response) => expect(response.status).toBe(401),
        },
        renewal: {
            name: 'authenticateForRenewal',
            prepare: async (account) =>
            {
                const session = await signIn(account);
                await bindToPasskey(account, session);

                return () => post('/_auth/session/renew/options', account, {}, session.authorization);
            },
            admitted: async (response) => expect(response.status).toBe(200),
            refused: async (response) => expectError(response, 401, 'SessionRenewalRefusedError'),
            passwordChange: 'admitted',
        },
        signOut: {
            name: 'authenticateForSignOut, an expired bound key inside its grace',
            prepare: async (account) =>
            {
                const session = await signIn(account);
                await bindToPasskey(account, session);
                await getTestDb().update(userPublicKeys)
                    .set({ expiresAt: new Date(Date.now() - 60_000) })
                    .where(eq(userPublicKeys.keyId, session.keyId));

                return () => post('/_auth/logout', account, {}, session.authorization);
            },
            admitted: async (response) => expect(response.status).toBe(204),
            refused: expectAccountRefusal,
            passwordChange: 'admitted',
        },
        oauth2AccessToken: {
            name: 'verifyAccessToken, behind /mcp',
            prepare: async (account) =>
            {
                const { tokens } = await grantFor(account);

                return () => mcp(tokens.access_token);
            },
            admitted: async (response) => expect(response.status).toBe(200),
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        oauth2Refresh: {
            name: 'the token endpoint, refresh_token',
            prepare: async (account) =>
            {
                const { clientId, tokens } = await grantFor(account);

                return () => refresh(clientId, tokens.refresh_token);
            },
            admitted: async (response) => expect(response.status).toBe(200),
            refused: expectInvalidGrant,
            passwordChange: expectInvalidGrant,
        },
        oauth2CodeExchange: {
            name: 'the token endpoint, authorization_code',
            prepare: async (account) =>
            {
                const { clientId, code, verifier } = await grantFor(account);

                return () => exchange(clientId, code, verifier);
            },
            admitted: async (response) => expect(response.status).toBe(200),
            refused: expectInvalidGrant,
            passwordChange: expectInvalidGrant,
        },
        oauth2Consent: {
            name: 'consent approval, POST /_auth/oauth2/authorize',
            prepare: async (account) =>
            {
                const session = await signIn(account);
                const clientId = await registerLoopbackClient(app, `admission-consent-${counter}`, [TEST_REDIRECT_URI], account.ip);

                return () => decideAuthorize(app, session.authorization, { client_id: clientId, approve: true });
            },
            admitted: async (response) =>
            {
                expect(response.status).toBe(200);
                expect((await response.json()).code).toEqual(expect.any(String));
            },
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        mfaVerify: {
            name: 'mfa/verify completing a 202 sign-in',
            prepare: async (account) =>
            {
                const { challenge, secret } = await openChallenge(account);

                return () => post('/_auth/mfa/verify', account, { challenge, code: totpCode(secret, 1) });
            },
            admitted: async (response) => expect(response.status).toBe(200),
            refused: async (response) => expectError(response, 401, 'MfaVerificationFailedError'),
            passwordChange: 'admitted',
        },
        totpConfirm: {
            name: 'mfa/totp/confirm completing an enrolment (admitDeferred)',
            prepare: async (account) =>
            {
                const session = await signIn(account);
                const enrolled = await post('/_auth/mfa/totp/enroll', account, {}, session.authorization);
                const secret = (await enrolled.json()).secret as string;

                return () => post('/_auth/mfa/totp/confirm', account, { code: totpCode(secret) }, session.authorization);
            },
            admitted: async (response) =>
            {
                expect(response.status).toBe(200);
                expect((await response.json()).recoveryCodes).toHaveLength(10);
            },
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        deletionRequest: {
            name: 'deletion/request, its session re-admitted under the account lock (admitCompletion)',
            prepare: async (account) =>
            {
                const session = await signIn(account);

                return () => post('/_auth/deletion/request', account, { password: TEST_PASSWORD }, session.authorization);
            },
            admitted: async (response) =>
            {
                expect(response.status).toBe(200);
                expect((await response.json()).purgeScheduledAt).toEqual(expect.any(String));
            },
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
        deviceCode: {
            name: 'device-code collection',
            prepare: async (account) =>
            {
                const session = await signIn(account);
                const key = generateKeyPair('ES256');
                const started = await (await post('/_auth/device/start', account, {
                    publicKey: key.publicKey,
                    keyId: key.keyId,
                    fingerprint: key.fingerprint,
                    algorithm: key.algorithm,
                })).json();

                expect((await post('/_auth/device/approve', account, { userCode: started.userCode }, session.authorization)).status).toBe(200);

                return () => post('/_auth/device/poll', account, { deviceCode: started.deviceCode });
            },
            admitted: async (response) =>
            {
                expect(response.status).toBe(200);
                expect((await response.json()).status).toBe('approved');
            },
            refused: expectAccountRefusal,
            passwordChange: expectPasswordChangeRefusal,
        },
    };

    /** Which doors each caller of `admitPrincipal` is — the table T1 must drive. */
    const DOORS_BY_FILE: Record<string, string[]> = {
        'lib/one-time-token.ts': ['sseStream'],
        'middleware/auth-profiles.ts': ['clientProofV1', 'appProfile'],
        'middleware/authenticate-for-renewal.ts': ['renewal'],
        // Sign-out is the one Bearer door that does not compare a bound key's
        // browser family (`presentedOn: null`): ending a session from a changed
        // browser must work, and a thief ending it does no harm.
        'middleware/authenticate-for-sign-out.ts': ['signOut'],
        'middleware/authenticate.ts': ['bearer', 'optionalAuth'],
        'middleware/one-time-token-auth.ts': ['oneTimeToken'],
        'services/device-auth.service.ts': ['deviceCode'],
        // Every completion of a two-step procedure asks again here
        // (`admitCompletion`), under the account lock: TOTP confirm, passkey register/verify, step-up and
        // binding-off by passkey, renewal, and the link callback — the last one
        // with no session in front of it, driven in deferred-stamps.test.ts T2/T5.
        'services/deferred-admission.service.ts': ['totpConfirm'],
        // The deletion request asks again under the account lock, behind `authenticate`;
        // the races only the second asking catches are account-status-vs-deletion T6, T11, T12.
        'services/account-deletion.service.ts': ['deletionRequest'],
        'services/mfa.service.ts': ['mfaVerify'],
        // Consent approval asks again under the account lock, behind `authenticate`;
        // the race that only the second asking catches is account-lock-round4 R9.
        'services/oauth2-authorize.service.ts': ['oauth2Consent'],
        'services/oauth2-access-token.service.ts': ['oauth2AccessToken'],
        'services/oauth2-token.service.ts': ['oauth2Refresh', 'oauth2CodeExchange'],
        // The renewal routes' service asks again, behind the middleware: one door.
        'services/session-renew.service.ts': ['renewal'],
    };

    it('T1 the door table drives every caller of admitPrincipal in the source, and only those', () =>
    {
        expect(admissionCallers()).toEqual(Object.keys(DOORS_BY_FILE).sort());
        expect([...new Set(Object.values(DOORS_BY_FILE).flat())].sort()).toEqual(Object.keys(DOORS).sort());
    });

    describe.each(Object.keys(DOORS))('T1 door %s', (doorId) =>
    {
        const door = DOORS[doorId];

        it(`${door.name}: an active account is admitted`, async () =>
        {
            const account = await newAccount();
            const attempt = await door.prepare(account);

            await door.admitted(await attempt(), account);
        });

        it.each(REFUSING)(`${door.name}: an account $status with deletion $deletion is refused in this door's answer`, async (state) =>
        {
            const account = await newAccount();
            const attempt = await door.prepare(account);

            await writeState(account, state);

            await door.refused(await attempt(), state);
        });

        it(`${door.name}: an active account that must change its password gets this door's answer to it`, async () =>
        {
            const account = await newAccount();
            const attempt = await door.prepare(account);

            await getTestDb().update(users).set({ passwordChangeRequired: true }).where(eq(users.id, account.id));
            const response = await attempt();

            await (door.passwordChange === 'admitted' ? door.admitted(response, account) : door.passwordChange(response));
        });
    });

    // ========================================================================
    // T2 — nothing but the admission makes a principal
    // ========================================================================

    /**
     * The mechanism, in three parts that do not depend on a name:
     *
     * - `AuthContext`, `Principal` and `VerifiedOAuth2AccessToken` carry a
     *   compile-time brand (a private member, `admitted`). No value outside the
     *   class can have it, so an object literal — or a spread of a real
     *   principal with one field swapped — is not assignable: renaming a type or
     *   copying its fields does not compile. It is not on the object at run time.
     * - Their constructors take a seal symbol private to the admission module and
     *   throw on anything else, so `new` from outside fails at run time too.
     * - What is left is a cast, and the scan refuses one: no source outside the
     *   admission module casts to, constructs or extends a principal type, and no
     *   `c.set('auth', …)` carries an `as`.
     */
    it('T2 a principal can be made by the admission module only — no literal, no forged construction, no cast in the source', () =>
    {
        type PlainAuthContext = {
            user: User;
            userId: string;
            keyId: string;
            role: string | null;
            locale: string;
            chosenLocale: string | null;
            credential: PrincipalCredential;
            scheme: string;
        };

        type PlainAccessToken = { clientId: string; scopes: string[]; expiresAt: number; userId: string };

        expectTypeOf<PlainAuthContext>().not.toExtend<AuthContext>();
        expectTypeOf<PlainAccessToken>().not.toExtend<VerifiedOAuth2AccessToken>();
        expect(() => Reflect.construct(AuthContext, [Symbol('forged'), {}, 'bearer'])).toThrow(/admitPrincipal/);
        expect(() => Reflect.construct(VerifiedOAuth2AccessToken, [Symbol('forged'), {}, {}])).toThrow(/admitPrincipal/);

        const PRINCIPAL = '(?:AuthContext|Principal|VerifiedOAuth2AccessToken)\\b';
        const forbidden = [
            new RegExp(`\\bas\\s+(?:unknown\\s+as\\s+)?${PRINCIPAL}`),
            new RegExp(`(?<![\\w$])<${PRINCIPAL}>`),
            new RegExp(`\\bnew\\s+${PRINCIPAL}`),
            new RegExp(`\\bextends\\s+${PRINCIPAL}`),
            /\.set\(\s*['"]auth['"].*\sas\s/,
        ];
        const offenders = sourceFiles(join(SERVER_ROOT, '..'))
            .filter((file) => !file.endsWith(ADMISSION_MODULE))
            .flatMap((file) => readFileSync(file, 'utf8').split('\n')
                .filter((line) => forbidden.some((pattern) => pattern.test(line)))
                .map((line) => `${relative(SERVER_ROOT, file)}: ${line.trim()}`));

        expect(offenders).toEqual([]);
    });

    // ========================================================================
    // T3 — a one-time token dies with the key that issued it
    // ========================================================================

    const REVOCATIONS: [string, (account: Account, session: Session) => Promise<Response>][] = [
        ['logout', (account, session) => post('/_auth/logout', account, {}, session.authorization)],
        ['revoke-all', (account, session) => post('/_auth/keys/revoke-all', account, { includeCurrent: true }, session.authorization)],
        ['password change', (account, session) => send('PUT', '/_auth/password', account,
            { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, includeCurrent: true }, { Authorization: session.authorization })],
    ];

    it.each(REVOCATIONS)('T3 %s: a token the key issued is refused, and a stream opened with one before closes', async (_name, revoke) =>
    {
        const account = await newAccount();
        const session = await signIn(account);
        const held = await issueToken(account, session);
        const stream = await openStream(await issueToken(account, session));

        expect(stream.response.status).toBe(200);
        expect(sse._openConnectionsByKey(session.keyId)).toBe(1);

        expect((await revoke(account, session)).status).toBeLessThan(300);

        await expectError(await send('GET', `/t/ott?token=${held}`, account), 401, 'UnauthorizedError');
        expect(await endsSoon(stream)).toBe(true);
        expect(sse._openConnectionsByKey(session.keyId)).toBe(0);
    });

    // ========================================================================
    // T4 — suspension and an OAuth 2.1 client
    // ========================================================================

    it('T4 suspended: access token, refresh and code exchange refused; reactivated: the same grant refreshes, the web session does not return', async () =>
    {
        const account = await newAccount();
        const { session, clientId, tokens, code, verifier } = await grantFor(account);

        await setAccountStatus(account.id, 'suspended', { from: 'any', reason: 'T4 suspension' });

        await expectAccountRefusal(await mcp(tokens.access_token), { status: 'suspended', deletion: null });
        await expectInvalidGrant(await refresh(clientId, tokens.refresh_token));
        await expectInvalidGrant(await exchange(clientId, code, verifier));

        await setAccountStatus(account.id, 'active', { from: 'suspended', reason: 'T4 reactivation' });

        expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200);
        await expectError(await post('/t/me', account, {}, session.authorization), 401, 'KeyRevokedError');
        await admittedAs(await post('/t/me', account, {}, (await signIn(account)).authorization), account);
    });

    // ========================================================================
    // T5 — a 202 sign-in of an account suspended meanwhile
    // ========================================================================

    it('T5 mfa/verify with a correct proof for an account suspended after the 202 is refused: key inactive, no login event', async () =>
    {
        const account = await newAccount();
        const { challenge, secret, keyId } = await openChallenge(account);
        const logins: unknown[] = [];
        authLoginEvent.subscribe((payload) => void logins.push(payload));

        // Written to the row, not through setAccountStatus: that would also end
        // the key generation the challenge belongs to, and the challenge would be
        // refused for its generation whatever mfa/verify does with the status.
        await writeState(account, { status: 'suspended', deletion: null });

        await expectError(await post('/_auth/mfa/verify', account, { challenge, code: totpCode(secret, 1) }), 401, 'MfaVerificationFailedError');
        await new Promise((resolve) => setTimeout(resolve, 40));

        const [key] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId));
        expect(key.isActive).toBe(false);
        expect(logins).toEqual([]);
    });

    // ========================================================================
    // T6 — a device-code approval dies with the approving key
    // ========================================================================

    it('T6 a device code approved by a key revoked since is not collected', async () =>
    {
        const account = await newAccount();
        const approver = await signIn(account);
        const other = await signIn(account);
        const key = generateKeyPair('ES256');
        const started = await (await post('/_auth/device/start', account, {
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        })).json();

        expect((await post('/_auth/device/approve', account, { userCode: started.userCode }, approver.authorization)).status).toBe(200);
        expect((await post('/_auth/keys/revoke', account, { keyId: approver.keyId }, other.authorization)).status).toBe(200);

        await expectError(await post('/_auth/device/poll', account, { deviceCode: started.deviceCode }), 400, 'DeviceAuthExpiredError');
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, key.keyId))).toHaveLength(0);
    });

    // ========================================================================
    // T7 — the one writer of account status
    // ========================================================================

    it('T7 setAccountStatus(suspended) ends every key and closes the open stream; updateUserService takes no status', async () =>
    {
        const account = await newAccount();
        const first = await signIn(account);
        const second = await signIn(account);
        const stream = await openStream(await issueToken(account, first));

        expect(stream.response.status).toBe(200);

        await setAccountStatus(account.id, 'suspended', { from: 'any', reason: 'T7 suspension' });

        // Refused as revoked keys, before the status is ever read.
        for (const session of [first, second])
        {
            const refused = await post('/t/me', account, {}, session.authorization);
            expect(refused.status).toBe(401);
            expect((await refused.json()).error.message).toBe('Invalid or revoked key');
        }
        expect(await endsSoon(stream)).toBe(true);
        expect(sse._openConnectionsByKey(first.keyId)).toBe(0);

        expectTypeOf<Parameters<typeof updateUserService>[1]>().not.toHaveProperty('status');
    });

    // ========================================================================
    // T8, T9 — a decision taken on a read a suspension has overtaken
    // ========================================================================

    /**
     * Let `findByEmailOrPhoneOnPrimary` read, then commit `between` before
     * handing the read back — a writer in the gap. `between` runs in a
     * transaction of its own (`requiresNew`), so it commits whatever the
     * request does.
     */
    function staleReadThen(between: () => Promise<unknown>): void
    {
        const read = usersRepository.findByEmailOrPhoneOnPrimary.bind(usersRepository);

        vi.spyOn(usersRepository, 'findByEmailOrPhoneOnPrimary').mockImplementationOnce(async (email, phone) =>
        {
            const found = await read(email, phone);
            await runInTransaction(between, { requiresNew: true, context: 'test:writer-in-the-gap' });

            return found;
        });
    }

    async function stateOf(account: Account): Promise<AccountState>
    {
        const [row] = await getTestDb().select({ status: users.status, deletion: users.deletion })
            .from(users).where(eq(users.id, account.id));

        return row!;
    }

    it('T8 a deletion cancel that read the account before a suspension committed clears the deletion and leaves it suspended', async () =>
    {
        const account = await newAccount();
        await requestAccountDeletionService(account.id, { requestedBy: 'admin' });
        staleReadThen(() => setAccountStatus(account.id, 'suspended', { from: 'any', reason: 'T8 suspension' }));

        const cancelled = await post('/_auth/deletion/cancel', account, { email: account.email, password: TEST_PASSWORD });

        expect(cancelled.status).toBe(204);
        expect(await stateOf(account)).toEqual({ status: 'suspended', deletion: null });
        const requests = await getTestDb().select({ status: accountDeletionRequests.status })
            .from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, account.id));
        expect(requests).toEqual([{ status: 'cancelled' }]);
    });

    it('T8b a password cancel that read an active account with nothing pending before a suspension committed is answered as a wrong password', async () =>
    {
        const account = await newAccount();
        staleReadThen(() => setAccountStatus(account.id, 'suspended', { from: 'any', reason: 'T8b suspension' }));

        const cancelled = await post('/_auth/deletion/cancel', account, { email: account.email, password: TEST_PASSWORD });

        await expectError(cancelled, 401, 'InvalidCredentialsError');
        expect(await stateOf(account)).toEqual({ status: 'suspended', deletion: null });
    });

    it('T9 a password sign-in that read the account before a suspension committed is refused as a wrong password, and leaves no key that reactivation admits', async () =>
    {
        const account = await newAccount();
        staleReadThen(() => setAccountStatus(account.id, 'suspended', { from: 'any', reason: 'T9 suspension' }));

        const { response, session } = await login(account);

        // Refused under the lock, and answered there as the password channel
        // answers a refused account: as a wrong password (#364).
        await expectError(response, 401, 'InvalidCredentialsError');
        await setAccountStatus(account.id, 'active', { from: 'suspended', reason: 'T9 reactivation' });

        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, session.keyId))).toHaveLength(0);
        const admission = await admitPrincipal({ userId: account.id, credential: { kind: 'deviceKey', keyId: session.keyId }, route: null, presentedOn: null });
        expect('admitted' in admission).toBe(false);
    });

    // ========================================================================
    // T10 — a one-time token admits the key holder the issuer recorded
    // ========================================================================

    it('T10 a token minted through core with a custom getSubject and the shared manager: honoured for its key holder, refused once the key is revoked', async () =>
    {
        const account = await newAccount();
        const session = await signIn(account);
        const other = await signIn(account);
        const events = defineEventRouter({ admissionT10Ping: defineEvent('admissionT10Ping', Type.Object({})) });
        const server = await createServer(defineServerConfig()
            .infrastructure({ database: false, redis: false })
            .middlewares([authenticate])
            .events(events, {
                auth: {
                    enabled: true,
                    tokenManager: getOneTimeTokenManager(),
                    getSubject: (c) => `user:${getAuth(c).userId}`,
                },
            })
            .build());
        const mint = async () =>
        {
            const minted = await server.request('/events/token', { method: 'POST', headers: { Authorization: session.authorization } });
            expect(minted.status).toBe(200);

            return (await minted.json()).token as string;
        };
        const connect = async (token: string) =>
        {
            const controller = new AbortController();
            openStreams.push(controller);

            return await server.request(new Request(`http://localhost/events/stream?events=admissionT10Ping&token=${token}`, { signal: controller.signal }));
        };

        expect((await connect(await mint())).status).toBe(200);

        const held = await mint();
        expect((await post('/_auth/keys/revoke', account, { keyId: session.keyId }, other.authorization)).status).toBe(200);

        expect((await connect(held)).status).toBe(401);
    });

    // ========================================================================
    // T11 — mfa/verify asks the account before it spends a proof
    // ========================================================================

    it('T11 mfa/verify with a correct recovery code for a non-active account is refused and spends nothing; after reactivation the same code completes it', async () =>
    {
        const account = await newAccount();
        const { challenge, recoveryCodes } = await openChallenge(account);

        // Written to the row, as in T5: setAccountStatus would end the challenge's
        // key generation, and the challenge would be refused for that instead.
        await writeState(account, { status: 'suspended', deletion: null });
        await expectError(await post('/_auth/mfa/verify', account, { challenge, recoveryCode: recoveryCodes[0] }), 401, 'MfaVerificationFailedError');

        await writeState(account, { status: 'active', deletion: null });
        expect((await post('/_auth/mfa/verify', account, { challenge, recoveryCode: recoveryCodes[0] })).status).toBe(200);
    });
});
