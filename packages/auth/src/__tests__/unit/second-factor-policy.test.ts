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

import { mainAuthRouter } from '@/server/routes';
import { ROUTE_CHANNELS, ROUTE_ENROLMENT, ROUTE_SECOND_FACTOR_METHODS } from '@/server/routes/channels';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import {
    __resetSecondFactorPolicyForTests,
    assertSecondFactorPolicy,
    configureSecondFactor,
    getSecondFactorPolicy,
    requireMethod,
    type SecondFactorOptions,
} from '@/server/lib/second-factor-policy';
import { isEnrolmentRequest } from '@/server/lib/enrolment-routes';
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

        expect(() => assertSecondFactorPolicy(PASSKEY_ENV)).not.toThrow();
    });

    it('B3: methods [\'passkey\'] with SPFN_AUTH_PASSKEY_USER_VERIFICATION set to anything but required refuses boot', async () =>
    {
        process.env.SPFN_AUTH_PASSKEY_USER_VERIFICATION = 'preferred';
        const lifecycle = lifecycleWith({ methods: ['passkey'] });

        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/SPFN_AUTH_PASSKEY_USER_VERIFICATION is "preferred"/);
    });

    it('B3: the variable set to required beside methods [\'passkey\'] boots', () =>
    {
        configureSecondFactor({ methods: ['passkey'] });

        expect(() => assertSecondFactorPolicy({ ...PASSKEY_ENV, SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'required' }))
            .not.toThrow();
    });

    it('B4: methods [\'passkey\'] with the variable unset boots, and the effective user verification is required', () =>
    {
        expect(getPasskeyConfig(PASSKEY_ENV).userVerification).toBe('preferred');

        configureSecondFactor({ methods: ['passkey'] });

        expect(() => assertSecondFactorPolicy(PASSKEY_ENV)).not.toThrow();
        expect(getPasskeyConfig(PASSKEY_ENV).userVerification).toBe('required');
        expect(getPasskeyConfig({ ...PASSKEY_ENV, SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'required' }).userVerification)
            .toBe('required');
    });

    it('B4: a policy listing totp beside the passkey leaves user verification as configured', () =>
    {
        configureSecondFactor({ methods: ['totp', 'passkey'] });

        expect(getPasskeyConfig(PASSKEY_ENV).userVerification).toBe('preferred');
        expect(() => assertSecondFactorPolicy({ ...PASSKEY_ENV, SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'preferred' }))
            .not.toThrow();
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

        expect(() => assertSecondFactorPolicy(PASSKEY_ENV)).not.toThrow();
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
        expect(() => assertSecondFactorPolicy(PASSKEY_ENV)).not.toThrow();
    });

    it('B7: no secondFactor option boots as today, on the defaults', () =>
    {
        createAuthLifecycle({});

        expect(getSecondFactorPolicy()).toEqual({ required: false, methods: ['totp', 'passkey'], recoveryCodes: true });
        expect(() => assertSecondFactorPolicy({ ...PASSKEY_ENV, SPFN_AUTH_PASSKEY_USER_VERIFICATION: 'preferred' }))
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
        const enrolment = Object.entries(ROUTE_ENROLMENT).filter(([, routeClass]) => routeClass !== 'none');

        expect(Object.fromEntries(enrolment)).toEqual({
            passkeyRegisterOptions: 'passkey',
            passkeyRegisterVerify: 'passkey',
            listPasskeys: 'passkey',
            mfaMarkPasskey: 'passkey',
            mfaTotpEnroll: 'totp',
            mfaTotpConfirm: 'totp',
            mfaStatus: 'always',
            getAuthSession: 'always',
            logout: 'always',
        });
    });

    it('the router hands the middleware its enrolment routes by method and path, read under the policy', () =>
    {
        configureSecondFactor({ required: true, methods: ['totp'] });

        expect(isEnrolmentRequest('GET', '/_auth/mfa/status')).toBe(true);
        expect(isEnrolmentRequest('POST', '/_auth/mfa/totp/enroll')).toBe(true);
        expect(isEnrolmentRequest('POST', '/_auth/passkeys/register/options')).toBe(false);
        // Its own gate answers the 404, so the global middleware lets it through to it.
        expect(isEnrolmentRequest('POST', '/_auth/mfa/passkey/mark')).toBe(true);
        expect(isEnrolmentRequest('POST', '/_auth/keys/list')).toBe(false);
        expect(isEnrolmentRequest('GET', '/_auth/keys/list')).toBe(false);
        expect(isEnrolmentRequest('GET', '/app/mfa/status')).toBe(false);
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
