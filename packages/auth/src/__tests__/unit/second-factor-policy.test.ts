/**
 * @spfn/auth - The second-factor policy option and its route classification (#309)
 *
 * The boot rows B1–B7 of the #309 case table, the option's own contract, and
 * the classification's guarantee. A refusal is driven through
 * `afterInfrastructure`, which runs every assert before it touches the
 * database, so the wiring is what is tested; a configuration that boots is
 * shown through the same assert, since the rest of boot needs a database.
 *
 * The route and session rows S/R/K are in
 * integration/second-factor-policy.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono, type Context, type Next } from 'hono';
import { defineRouter, registerRoutes, resolveRouteMiddlewares, route } from '@spfn/core/route';

import { mainAuthRouter } from '@/server/routes';
import { markEnrolmentRoutes, ROUTE_CHANNELS, ROUTE_ENROLMENT, ROUTE_SECOND_FACTOR_METHODS } from '@/server/routes/channels';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import {
    __resetSecondFactorPolicyForTests,
    assertSecondFactorPolicy,
    configureSecondFactor,
    getSecondFactorPolicy,
    requireMethod,
    type SecondFactorOptions,
} from '@/server/lib/second-factor-policy';
import { isEnrolmentGate, registerEnrolmentGate, restrictedRouteAdmits, type SessionRequirement } from '@/server/lib/enrolment-routes';
import { getPasskeyConfig } from '@/server/lib/config';
import { createAuthLifecycle } from '@/server/lifecycle';
import { buildMobileContractBundle } from '@/server/client-proof/contract-bundle';

const KEYRING = `active:${Buffer.alloc(32, 5).toString('base64')}`;
const PASSKEY_ENV = { SPFN_AUTH_PASSKEY_RP_ID: 'localhost', SPFN_AUTH_PASSKEY_ORIGINS: 'http://localhost:3000' };
const DEVICE_CHANNELS_OFF = { deviceCode: false, deviceLink: false };

/** A lifecycle stating this policy, its device channels off unless the row says otherwise. */
function lifecycleWith(secondFactor: SecondFactorOptions, channels = DEVICE_CHANNELS_OFF)
{
    return createAuthLifecycle({ channels, secondFactor });
}

describe('second-factor policy (#309)', () =>
{
    const savedKeys = process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    const savedVerification = process.env.SPFN_AUTH_PASSKEY_USER_VERIFICATION;

    afterEach(() =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        restore('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', savedKeys);
        restore('SPFN_AUTH_PASSKEY_USER_VERIFICATION', savedVerification);
    });

    function restore(name: string, value: string | undefined): void
    {
        if (value === undefined)
        {
            delete process.env[name];
        }
        else
        {
            process.env[name] = value;
        }
    }

    // ========================================================================
    // Boot
    // ========================================================================

    it('B1: methods: [] refuses boot', async () =>
    {
        const lifecycle = lifecycleWith({ methods: [] });

        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/secondFactor\.methods is empty/);
    });

    it('B2: required with deviceCode or deviceLink on refuses boot, naming the channel', async () =>
    {
        const withDeviceCode = lifecycleWith({ required: true }, { deviceCode: true, deviceLink: false });
        await expect(withDeviceCode.afterInfrastructure!()).rejects.toThrow(/the deviceCode channel is on/);

        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();

        const withDeviceLink = lifecycleWith({ required: true }, { deviceCode: false, deviceLink: true });
        await expect(withDeviceLink.afterInfrastructure!()).rejects.toThrow(/the deviceLink channel is on/);
    });

    it('B2: a policy that does not require a factor boots beside the device channels', () =>
    {
        configureSecondFactor({ required: false, methods: ['passkey'] });

        expect(() => assertSecondFactorPolicy()).not.toThrow();
    });

    it('B3: methods [\'passkey\'] with SPFN_AUTH_PASSKEY_USER_VERIFICATION preferred boots — a second factor is judged per assertion', () =>
    {
        process.env.SPFN_AUTH_PASSKEY_USER_VERIFICATION = 'preferred';
        configureSecondFactor({ methods: ['passkey'] });

        expect(() => assertSecondFactorPolicy()).not.toThrow();
    });

    it('B4: methods [\'passkey\'] leaves user verification as configured, preferred when unset', () =>
    {
        configureSecondFactor({ methods: ['passkey'] });

        expect(() => assertSecondFactorPolicy()).not.toThrow();
        expect(getPasskeyConfig(PASSKEY_ENV).userVerification).toBe('preferred');
        expect(getPasskeyConfig({ ...PASSKEY_ENV, SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'required' }).userVerification)
            .toBe('required');
    });

    it('B5: required TOTP-only without SPFN_AUTH_TOKEN_ENCRYPTION_KEYS refuses boot', async () =>
    {
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        const lifecycle = lifecycleWith({ required: true, methods: ['totp'] });

        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/SPFN_AUTH_TOKEN_ENCRYPTION_KEYS is\s+unset/);
    });

    it('B5: the same policy with a keyring boots', () =>
    {
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = KEYRING;
        configureChannels(DEVICE_CHANNELS_OFF);
        configureSecondFactor({ required: true, methods: ['totp'] });

        expect(() => assertSecondFactorPolicy()).not.toThrow();
    });

    it('B6: two constructions stating different policies refuse boot, and the first stays in force meanwhile', async () =>
    {
        lifecycleWith({ required: true, methods: ['passkey'], recoveryCodes: false });
        const second = lifecycleWith({ required: false });

        expect(getSecondFactorPolicy()).toEqual({ required: true, methods: ['passkey'], recoveryCodes: false });
        await expect(second.afterInfrastructure!()).rejects.toThrow(
            /different secondFactor policies in two calls: required \(true \/ false\), methods \(\[passkey\] \/ \[totp, passkey\]\), recoveryCodes/,
        );
    });

    it('B6: the same policy stated twice, and a later construction that states none, are no contradiction', () =>
    {
        lifecycleWith({ required: true, methods: ['passkey'] });
        lifecycleWith({ methods: ['passkey'], required: true });
        createAuthLifecycle({});

        expect(getSecondFactorPolicy()).toEqual({ required: true, methods: ['passkey'], recoveryCodes: true });
        expect(() => assertSecondFactorPolicy()).not.toThrow();
    });

    it('B7: no secondFactor option boots as today, on the defaults', () =>
    {
        createAuthLifecycle({});

        expect(getSecondFactorPolicy()).toEqual({ required: false, methods: ['totp', 'passkey'], recoveryCodes: true });
        expect(() => assertSecondFactorPolicy())
            .not.toThrow();
    });

    // ========================================================================
    // The option
    // ========================================================================

    it('refuses an unknown method, an unknown key and a value of the wrong type at configuration', () =>
    {
        expect(() => configureSecondFactor({ methods: ['sms'] } as unknown as SecondFactorOptions))
            .toThrow(/sms is not a second-factor method/);
        expect(() => configureSecondFactor({ requred: true } as unknown as SecondFactorOptions))
            .toThrow(/secondFactor\.requred is not an option/);
        expect(() => configureSecondFactor({ required: 'yes' } as unknown as SecondFactorOptions))
            .toThrow(/secondFactor\.required must be true or false/);
        expect(getSecondFactorPolicy()).toEqual({ required: false, methods: ['totp', 'passkey'], recoveryCodes: true });
    });

    it('an unlisted method answers 404 SECOND_FACTOR_METHOD_DISABLED naming it', () =>
    {
        configureSecondFactor({ methods: ['passkey'], recoveryCodes: false });

        expect(() => requireMethod('totp')).toThrow(expect.objectContaining({
            name: 'SecondFactorMethodDisabledError',
            statusCode: 404,
            code: 'SECOND_FACTOR_METHOD_DISABLED',
            details: { method: 'totp' },
        }));
        expect(() => requireMethod('recoveryCodes')).toThrow(expect.objectContaining({ details: { method: 'recoveryCodes' } }));
        expect(() => requireMethod('passkey')).not.toThrow();
    });

    // ========================================================================
    // The classification
    // ========================================================================

    it('every key of mainAuthRouter is in ROUTE_ENROLMENT, and the table names nothing else', () =>
    {
        expect(Object.keys(mainAuthRouter.routes).filter(key => !Object.hasOwn(ROUTE_ENROLMENT, key))).toEqual([]);
        expect(Object.keys(ROUTE_ENROLMENT).filter(key => !Object.hasOwn(mainAuthRouter.routes, key))).toEqual([]);
        expect(Object.keys(ROUTE_ENROLMENT).sort()).toEqual(Object.keys(ROUTE_CHANNELS).sort());
    });

    it('the enrolment routes are exactly the design\'s, each under its method', () =>
    {
        const enrolment = Object.entries(ROUTE_ENROLMENT)
            .map(([key, row]) => [key, row.secondFactorEnrolment] as const)
            .filter(([, routeClass]) => routeClass !== 'none');

        expect(Object.fromEntries(enrolment)).toEqual({
            passkeyRegisterOptions: 'passkey',
            passkeyRegisterVerify: 'passkey',
            listPasskeys: 'passkey',
            mfaMarkPasskey: 'passkey',
            // enrollPasskey's binding read: refused, it would stop the
            // registration before its ceremony (#400).
            getSessionBinding: 'passkey',
            mfaTotpEnroll: 'totp',
            mfaTotpConfirm: 'totp',
            mfaStatus: 'always',
            mfaStepUp: 'always',
            mfaStepUpOptions: 'always',
            getAuthSession: 'always',
            logout: 'always',
            // The social sign-in's completion: it gives an enrolment-only
            // account its session, as a password sign-in's 200 does.
            oauthFinalize: 'always',
            sessionRenewOptions: 'unchecked',
            sessionRenewVerify: 'unchecked',
        });
    });

    /**
     * What removes the global `auth` from each route, by route key — read from
     * the chain registration resolves, so a skipper on a router counts as one
     * on the route does.
     */
    const authRemovedBy = new Map(resolveRouteMiddlewares(mainAuthRouter, [{ name: 'auth', handler: async () => undefined }])
        .map(resolved => [resolved.name, resolved.removed.find(removed => removed.name === 'auth')?.by]));

    /** A route the global `auth` never runs on, by its own `.skip`. */
    function isPublic(key: string): boolean
    {
        const by = authRemovedBy.get(key);

        return by === '.skip' || by === '.skip(\'*\')';
    }

    /** The middleware that authenticates a route in place of the global `auth`, by name, or null. */
    function ownAuthenticator(key: string): string | null
    {
        const by = authRemovedBy.get(key);

        return by === undefined || isPublic(key) ? null : by;
    }

    /**
     * Every route mounted behind a probe standing where the global `auth`
     * stands: what `restrictedRouteAdmits` reads from there for `requirement`,
     * per route key, for every route the global `auth` runs on.
     */
    async function recognisedFrom(
        probeIsGate: boolean,
        requirement: SessionRequirement = 'secondFactorEnrolment',
    ): Promise<Record<string, boolean | undefined>>
    {
        const app = new Hono();
        const recognised: boolean[] = [];
        const probe = async (c: Context, _next: Next) =>
        {
            recognised.push(restrictedRouteAdmits(c, requirement));

            return c.body(null, 204);
        };
        if (probeIsGate)
        {
            registerEnrolmentGate(probe);
        }
        registerRoutes(app, mainAuthRouter, [{ name: 'auth', handler: probe }]);

        const answers: Record<string, boolean | undefined> = {};

        for (const [key, route] of Object.entries(mainAuthRouter.routes) as [string, { method: string; path: string }][])
        {
            // Nothing stands in front of these but their own handler, which needs a database.
            if (isPublic(key) || ownAuthenticator(key) !== null)
            {
                continue;
            }

            recognised.length = 0;
            await app.request(route.path.replace(/:[a-zA-Z]+/g, 'x'), { method: route.method });
            answers[key] = recognised[0];
        }

        return answers;
    }

    it('F2: the gate recognises exactly the marked routes, by the route that matched, read under the policy', async () =>
    {
        configureSecondFactor({ required: true, methods: ['totp'] });

        const answers = await recognisedFrom(true);
        const expected = Object.fromEntries(Object.entries(ROUTE_ENROLMENT).map(([key, { secondFactorEnrolment: routeClass }]) =>
        {
            const gated = Object.hasOwn(ROUTE_SECOND_FACTOR_METHODS, key);
            const enrolment = routeClass === 'always' || routeClass === 'totp' || (routeClass === 'passkey' && gated);

            return [key, ownAuthenticator(key) !== null || isPublic(key) ? undefined : enrolment];
        }));

        expect(answers).toEqual(expected);
        // Its own gate answers the 404, so the global middleware lets it through to it.
        expect(answers.mfaMarkPasskey).toBe(true);
        expect(answers.passkeyRegisterOptions).toBe(false);
        expect(answers.listKeys).toBe(false);
        expect(answers.mfaStatus).toBe(true);
    });

    it('F2: a middleware that is not a registered gate is never exempted, even standing where auth stands', async () =>
    {
        configureSecondFactor({ required: true });

        const answers = await recognisedFrom(false);

        expect(Object.values(answers).filter(answer => answer !== undefined).every(answer => answer === false)).toBe(true);
        expect(answers.mfaStatus).toBe(false);
    });

    it('F2: an app route at an enrolment route\'s own method and path, registered first, is not the enrolment route', async () =>
    {
        configureSecondFactor({ required: true });
        const app = new Hono();
        const recognised: boolean[] = [];
        const probe = async (c: Context, _next: Next) =>
        {
            recognised.push(restrictedRouteAdmits(c, 'secondFactorEnrolment'));

            return c.body(null, 204);
        };
        registerEnrolmentGate(probe);
        const shadow = defineRouter({ shadow: route.get('/_auth/session').handler(async () => ({ shadow: true })) });
        // Core registers an app's own routes before the package routers, so the app's chain runs first.
        registerRoutes(app, shadow, [{ name: 'auth', handler: probe }]);
        registerRoutes(app, mainAuthRouter, [{ name: 'auth', handler: probe }]);

        await app.request('/_auth/session');

        expect(recognised).toEqual([false]);
    });

    it('F4: every route whose authenticator is not the global one is classified as that authenticator behaves', () =>
    {
        const notGlobal = Object.keys(ROUTE_ENROLMENT).filter(key => isPublic(key) || ownAuthenticator(key) !== null);
        const classOf = (key: string) => ROUTE_ENROLMENT[key as keyof typeof ROUTE_ENROLMENT].secondFactorEnrolment;

        // Renewal authenticates a bound key itself and never asks the policy:
        // an enrolment-only session renews, and the renewed key is held to
        // enrolment on its next request. Its class says it is admitted.
        expect(Object.fromEntries(notGlobal.filter(key => !isPublic(key)).map(key => [key, ownAuthenticator(key)])))
            .toEqual({ logout: 'authForSignOut', sessionRenewOptions: 'authForRenewal', sessionRenewVerify: 'authForRenewal', oauthFinalize: 'oauthFinalizeAuth' });

        // Finalize's door hands every signed finalize to `authenticate` from its
        // own place in the chain: it is a registered gate, so the route's marker
        // (class 'always') answers to it — the integration row N3 drives an
        // enrolment-only account through it.
        const finalizeDoor = (mainAuthRouter.routes.oauthFinalize as { middlewares: { name?: string; handler?: Function }[] })
            .middlewares.find(middleware => middleware?.name === 'oauthFinalizeAuth');
        expect(isEnrolmentGate(finalizeDoor!.handler!)).toBe(true);
        expect(classOf('oauthFinalize')).toBe('always');
        expect(readFileSync(join(__dirname, '..', '..', 'server', 'middleware', 'authenticate-for-renewal.ts'), 'utf8'))
            .not.toMatch(/assertSecondFactorAdmits|isEnrolmentOnly/);
        expect([classOf('sessionRenewOptions'), classOf('sessionRenewVerify')]).toEqual(['unchecked', 'unchecked']);

        // Sign-out runs the global gate itself, registered as one, except for an
        // expired bound key it admits as renewal does — so it keeps the class
        // an enrolment-only session reaches it under (S4 in the integration suite).
        expect(classOf('logout')).toBe('always');

        // A public route authenticates no session, so it can neither admit nor
        // refuse one, and is never an enrolment route — the marker answers only
        // to the global gate.
        expect(notGlobal.filter(isPublic).filter(key => classOf(key) !== 'none')).toEqual([]);
        expect(notGlobal.filter(isPublic)).toContain('mfaVerify');

        // And "unchecked" is used for nothing else.
        expect(Object.keys(ROUTE_ENROLMENT).filter(key => classOf(key) === 'unchecked'))
            .toEqual(['sessionRenewOptions', 'sessionRenewVerify']);
    });

    it('#362 P2: the routes a session that must change its password reaches are exactly the decided ones', async () =>
    {
        // Recognised through the markers the gate reads, not the table alone: a
        // marker that dropped the passwordChange half would leave the person
        // with no way to the one route that clears the requirement.
        const answers = await recognisedFrom(true, 'passwordChange');

        expect(Object.keys(answers).filter(key => answers[key] === true).sort()).toEqual([
            'changePassword',
            'getAuthSession',
            'mfaStatus',
            'mfaStepUp',
            'mfaStepUpOptions',
        ]);
        // The three whose own authenticator stands in front of the global one:
        // sign-out and finalize run it from their place in the chain (driven in
        // the integration suite); renewal never asks.
        expect(Object.fromEntries(['logout', 'oauthFinalize', 'mfaVerify', 'sessionRenewOptions', 'sessionRenewVerify']
            .map(key => [key, ROUTE_ENROLMENT[key as keyof typeof ROUTE_ENROLMENT].passwordChange])))
            .toEqual({ logout: 'admit', oauthFinalize: 'admit', mfaVerify: 'admit', sessionRenewOptions: 'unchecked', sessionRenewVerify: 'unchecked' });
        expect(Object.entries(ROUTE_ENROLMENT).filter(([, row]) => row.passwordChange === 'admit').map(([key]) => key).sort())
            .toEqual(['changePassword', 'getAuthSession', 'logout', 'mfaStatus', 'mfaStepUp', 'mfaStepUpOptions', 'mfaVerify', 'oauthFinalize']);
    });

    it('#362 P8: a route whose row has no passwordChange class fails at mount', () =>
    {
        const routes = { probe: route.get('/_auth/probe362').handler(async () => ({ ok: true })) };

        expect(() => markEnrolmentRoutes(routes, { probe: { secondFactorEnrolment: 'none' } as never }))
            .toThrow('Route "probe" has no passwordChange class in ROUTE_ENROLMENT');
        expect(() => markEnrolmentRoutes(routes, {} as never))
            .toThrow('Route "probe" has no entry in ROUTE_ENROLMENT');
    });

    it('the method gates are on the design\'s four routes, first among their own middlewares', () =>
    {
        expect(ROUTE_SECOND_FACTOR_METHODS).toEqual({
            mfaTotpEnroll: 'totp',
            mfaTotpConfirm: 'totp',
            mfaMarkPasskey: 'passkey',
            mfaRegenerateRecoveryCodes: 'recoveryCodes',
        });

        for (const key of Object.keys(ROUTE_SECOND_FACTOR_METHODS))
        {
            const route = mainAuthRouter.routes[key as keyof typeof mainAuthRouter.routes] as { middlewares?: { name?: string }[] };

            expect(route.middlewares?.[0]?.name, key).toBe('authSecondFactorMethod');
        }
    });

    // ========================================================================
    // The mobile contract
    // ========================================================================

    it('the contract marks each signed-in operation that is not an enrolment route, from the classification', () =>
    {
        const operations = buildMobileContractBundle().operations as {
            id: string;
            authProfile: string;
            secondFactor?: { enrolmentRequired?: { error: string } };
        }[];
        const marked = operations.filter(operation => operation.secondFactor?.enrolmentRequired).map(operation => operation.id);
        const signedIn = operations.filter(operation => operation.authProfile === 'clientProofV1').map(operation => operation.id);

        expect(marked).toEqual(signedIn.filter(id => id !== 'auth.mfa.status'));
        expect(marked).toContain('auth.keys.list');
        expect(operations.find(operation => operation.id === 'auth.enroll.login')).not.toHaveProperty('secondFactor');
        expect(operations.find(operation => operation.id === 'auth.mfa.status')).not.toHaveProperty('secondFactor');
    });
});
