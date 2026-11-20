/**
 * `enrollPasskey` against the real router (#400).
 *
 * The browser half is `@simplewebauthn/browser` mocked onto a FixtureAuthenticator,
 * and the client is an `AuthApi` stand-in over `app.request`, so what the server
 * answers each call is what the helper decides on. The rows count what matters
 * to the person: credentials made on the authenticator against credentials the
 * account stored. More made than stored is a passkey in the password manager
 * that never signs in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const browser = vi.hoisted(() => ({
    register: undefined as undefined | ((options: { challenge: string }) => unknown),
    authenticate: undefined as undefined | ((options: { challenge: string }) => unknown),
    registrations: 0,
    assertions: 0,
}));

vi.mock('@simplewebauthn/browser', () => ({
    browserSupportsWebAuthn: () => true,
    browserSupportsWebAuthnAutofill: async () => false,
    startRegistration: async ({ optionsJSON }: { optionsJSON: { challenge: string } }) =>
    {
        browser.registrations++;

        return browser.register!(optionsJSON);
    },
    startAuthentication: async ({ optionsJSON }: { optionsJSON: { challenge: string } }) =>
    {
        browser.assertions++;

        return browser.authenticate!(optionsJSON);
    },
}));

import { clearTables, getTestDb, isDatabaseAvailable, setupTestDb, teardownTestDb } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { passkeys, users, webauthnChallenges } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { enrollPasskey, enrollPasskeyRetryOf } from '@/client/passkeys';
import type { AuthApi } from '@/client/passkeys';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import { __resetSecondFactorPolicyForTests, configureSecondFactor } from '@/server/lib/second-factor-policy';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CEREMONY = { origin: ORIGIN, rpId: RP_ID };

interface Session
{
    authorization: string;
}

describe.skipIf(!dbAvailable)('enrollPasskey against the router (#400)', () =>
{
    let app: Hono;
    /** Every call the stand-in client made, and each refusal as `name:status:code`. */
    const log: string[] = [];
    /** Run before a call goes out, one per call, by the call's name in `log`. */
    const before: Record<string, (() => Promise<void>)[]> = {};

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        app = new Hono();
        app.use('*', async (c, next) =>
        {
            c.set('clientType', 'web');
            await next();
        });
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        browser.registrations = 0;
        browser.assertions = 0;
        log.length = 0;
        for (const name of Object.keys(before))
        {
            delete before[name];
        }
        await getTestDb().insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        });
    });

    function send(method: string, path: string, body: unknown, session: Session): Promise<Response>
    {
        return Promise.resolve(app.request(path, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: session.authorization },
            ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
        }));
    }

    async function signIn(): Promise<Session>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'owner@test.com', password: PASSWORD,
                publicKey: keyPair.publicKey, keyId: keyPair.keyId, fingerprint: keyPair.fingerprint, algorithm: keyPair.algorithm,
            }),
        });
        expect(response.status).toBe(200);

        return { authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}` };
    }

    /** An account with one passkey, and the session that registered it. */
    async function ownerWithPasskey(): Promise<{ session: Session; authenticator: FixtureAuthenticator }>
    {
        const session = await signIn();
        const authenticator = await FixtureAuthenticator.create();
        const options = await send('POST', '/_auth/passkeys/register/options', {}, session);
        const registered = await send('POST', '/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, ...CEREMONY }),
        }, session);
        expect(registered.status).toBe(200);

        return { session, authenticator };
    }

    async function turnBindingOn(session: Session, authenticator: FixtureAuthenticator): Promise<void>
    {
        expect((await enableBinding((path, body) => send('POST', path, body, session), authenticator, CEREMONY)).status).toBe(200);
    }

    /** An account with one passkey and session binding on, and the session that did it. */
    async function boundOwner(): Promise<{ session: Session; authenticator: FixtureAuthenticator }>
    {
        const owner = await ownerWithPasskey();
        await turnBindingOn(owner.session, owner.authenticator);

        return owner;
    }

    /** The browser a person holds: `authenticator` answers proofs, `another` makes the new passkey. */
    function holding(authenticator: FixtureAuthenticator | null, another: FixtureAuthenticator): void
    {
        browser.authenticate = o => authenticator!.assert({ challenge: o.challenge, ...CEREMONY, counter: 0 });
        browser.register = o => another.attest({ challenge: o.challenge, ...CEREMONY });
    }

    /** An `AuthApi` over the router, throwing what `authApi` throws: the envelope's code and status. */
    function apiOver(session: Session): AuthApi
    {
        const call = (method: string, path: string, name: string) => ({
            call: async (input?: { body?: unknown }) =>
            {
                log.push(name);
                await before[name]?.shift()?.();
                const response = await send(method, path, input?.body, session);
                const json = await response.json();

                if (!response.ok)
                {
                    log.push(`${name}:${response.status}:${json.code}`);

                    return Promise.reject(Object.assign(new Error(json.message ?? 'refused'), {
                        name: json.__type, code: json.code, statusCode: response.status, details: json.details,
                    }));
                }

                return json;
            },
        });

        return {
            getSessionBinding: call('GET', '/_auth/session/binding', 'binding'),
            passkeyProofOptions: call('POST', '/_auth/session/passkey-proof/options', 'proofOptions'),
            passkeyRegisterOptions: call('POST', '/_auth/passkeys/register/options', 'registerOptions'),
            passkeyRegisterVerify: call('POST', '/_auth/passkeys/register/verify', 'registerVerify'),
        } as unknown as AuthApi;
    }

    async function storedPasskeys(): Promise<number>
    {
        return (await getTestDb().select().from(passkeys)).length;
    }

    /** Session binding needs device code and device link off for the policy to boot. */
    function requirePasskeyFactor(): void
    {
        configureChannels({ deviceCode: false, deviceLink: false });
        configureSecondFactor({ required: true, methods: ['passkey'], recoveryCodes: false });
    }

    it('R9: enrolment-only session on a bound account — the binding is read, the refused proof stops it before create()', async () =>
    {
        const { authenticator } = await boundOwner();
        requirePasskeyFactor();
        const session = await signIn();
        const stepOptions = await send('POST', '/_auth/mfa/step-up/options', {}, session);
        const stepped = await send('POST', '/_auth/mfa/step-up', {
            response: authenticator.assert({ challenge: (await stepOptions.json()).challenge, ...CEREMONY, counter: 0 }),
        }, session);
        expect(stepped.status).toBe(204);
        holding(authenticator, await FixtureAuthenticator.create());

        await expect(enrollPasskey(apiOver(session))).rejects.toMatchObject({ statusCode: 403, code: 'SECOND_FACTOR_ENROLMENT_REQUIRED' });
        expect(log).toEqual(['binding', 'proofOptions', 'proofOptions:403:SECOND_FACTOR_ENROLMENT_REQUIRED']);
        expect(browser.registrations).toBe(0);
        expect(await storedPasskeys()).toBe(1);
    });

    it('R9b: enrolment-only session on an unbound account holding nothing — reads the binding, enrols with one prompt', async () =>
    {
        requirePasskeyFactor();
        const session = await signIn();
        holding(null, await FixtureAuthenticator.create());

        const result = await enrollPasskey(apiOver(session));

        expect(result).toMatchObject({ ok: true, mfaStatus: { enrolled: true, methods: ['passkey'] } });
        expect(log).toEqual(['binding', 'registerOptions', 'registerVerify']);
        expect(browser.assertions).toBe(0);
        expect(await storedPasskeys()).toBe(1);
    });

    it('R10: an app-supplied proof already spent — the verify\'s refusal is thrown, no proof prompt of the helper\'s', async () =>
    {
        const { session, authenticator } = await boundOwner();
        const proofOptions = await send('POST', '/_auth/session/passkey-proof/options', { procedure: 'passkeyAdd' }, session);
        const spent = authenticator.assert({ challenge: (await proofOptions.json()).challenge, ...CEREMONY, counter: 0 });
        holding(authenticator, await FixtureAuthenticator.create());
        expect(await enrollPasskey(apiOver(session), { passkeyResponse: spent as never })).toMatchObject({ ok: true });
        log.length = 0;

        await expect(enrollPasskey(apiOver(session), { passkeyResponse: spent as never }))
            .rejects.toMatchObject({ statusCode: 403, code: 'PASSKEY_PROOF_REQUIRED', details: { procedure: 'passkeyAdd' } });
        expect(log).toEqual(['registerOptions', 'registerVerify', 'registerVerify:403:PASSKEY_PROOF_REQUIRED']);
        expect(browser.assertions).toBe(0);
        expect(await storedPasskeys()).toBe(2);
    });

    it('PD: binding turned on between the read and the verify, the proof prompt dismissed — no-credential with retry, which stores', async () =>
    {
        const { session, authenticator } = await ownerWithPasskey();
        holding(authenticator, await FixtureAuthenticator.create());
        const proofPrompt = browser.authenticate!;
        browser.authenticate = () => Promise.reject(Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }));
        before.registerVerify = [() => turnBindingOn(session, authenticator)];

        const dismissed = await enrollPasskey(apiOver(session));

        expect(dismissed).toMatchObject({ ok: false, reason: 'no-credential', retry: { mayProve: true } });
        expect(await storedPasskeys()).toBe(1);
        browser.authenticate = proofPrompt;
        log.length = 0;

        expect(await enrollPasskey(apiOver(session), { retry: dismissed.ok ? undefined : dismissed.retry })).toMatchObject({ ok: true });
        expect(log).toEqual(['registerVerify', 'registerVerify:403:PASSKEY_PROOF_REQUIRED', 'proofOptions', 'registerVerify']);
        expect({ registrations: browser.registrations, stored: await storedPasskeys() }).toEqual({ registrations: 1, stored: 2 });
    });

    it('PH: a network error at the verify after create() — rejects as the TypeError with retry, which stores', async () =>
    {
        const { session, authenticator } = await boundOwner();
        holding(authenticator, await FixtureAuthenticator.create());
        const api = apiOver(session);
        (api as { passkeyRegisterVerify: unknown }).passkeyRegisterVerify = {
            call: () => Promise.reject(new TypeError('fetch failed')),
        };

        const offline = await enrollPasskey(api, { label: 'Laptop' }).then(() => undefined, (error: unknown) => error);

        expect(offline).toBeInstanceOf(TypeError);
        expect(await storedPasskeys()).toBe(1);

        expect(await enrollPasskey(apiOver(session), { retry: enrollPasskeyRetryOf(offline) })).toMatchObject({ ok: true, label: 'Laptop' });
        expect({ registrations: browser.registrations, assertions: browser.assertions, stored: await storedPasskeys() })
            .toEqual({ registrations: 1, assertions: 1, stored: 2 });
    });

    it('PB: a stale retry — the registration challenge expired — answers 401 PasskeyChallengeError', async () =>
    {
        const { session, authenticator } = await boundOwner();
        holding(authenticator, await FixtureAuthenticator.create());
        const api = apiOver(session);
        (api as { passkeyRegisterVerify: unknown }).passkeyRegisterVerify = {
            call: () => Promise.reject(new TypeError('fetch failed')),
        };
        const offline = await enrollPasskey(api).then(() => undefined, (error: unknown) => error);
        await getTestDb().update(webauthnChallenges).set({ expiresAt: new Date(Date.now() - 60_000) });

        await expect(enrollPasskey(apiOver(session), { retry: enrollPasskeyRetryOf(offline) }))
            .rejects.toMatchObject({ statusCode: 401, name: 'PasskeyChallengeError' });
        expect(await storedPasskeys()).toBe(1);
    });
});
