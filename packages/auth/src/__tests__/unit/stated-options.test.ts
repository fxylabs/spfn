/**
 * @spfn/auth - every option the application states is read once, through one rule (#477)
 *
 * The rule's own rows — a value that is not a plain object, an unknown own
 * name, a getter read once, `readRecords`' and `readList`' rows — moved to
 * `@spfn/core/options` with the rule (#492), in
 * `packages/core/src/options/__tests__/options.test.ts`. A declared entry's
 * row stays here: the default checked against its schema is the clone kept.
 *
 * Then two behaviour rows per reader, and per options object inside one:
 *
 * - a misspelt option is refused, the message naming `<name>.<key>` — without
 *   it, a reader that accepts an unknown key (reads with `readEntries`, or not
 *   through the shared reader at all) drops the misspelt option for its
 *   default unseen;
 * - one option given as a getter is read exactly once, and the value the
 *   reader uses is what that read answered — without it, a reader that reads
 *   the application's object again after its snapshot stores an answer that
 *   never passed the check.
 *
 * A map keyed by the application's own names (`authorizationServer.scopes`,
 * `rolePermissions`, `ClientProofState.publicKeys`) has no option names to
 * misspell: its rows are that an inherited entry is refused, and that an
 * entry given as a getter is read once — without that, a reader that checks
 * the map's snapshot and then keeps or reads the application's object again
 * passes silently (`rolePermissions`' getter row is in
 * `integration/rbac.test.ts`). Each list-valued option has one more row: a
 * Proxy array given as it is refused, naming `<name>.<key>` — without it, a
 * reader that keeps the application's array instead of `readList`'s copy
 * passes silently, and a later change to that array alters what is enforced.
 * The readers whose
 * value is seen only through a database (`initializeAuth`'s records and
 * `sessionTtl`, `createRevokeAllLink`) or a key server (`signedTokenAuth`)
 * have their getter rows beside those, in `integration/rbac.test.ts`,
 * `integration/revoke-all-link.test.ts`, `unit/signed-token-auth.test.ts` and
 * `unit/ops-or-user-stacking.test.ts`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { Type } from '@sinclair/typebox';
import { collectJobs } from '@spfn/core/job';

import {
    configureAuth,
    getCsrfMode,
    getOAuthEmailMatch,
    getOAuthLinkRecentAuthMs,
    isSignInProvider,
    linkNeedsRecentAuth,
} from '@/server/lib/config';
import { __resetChannelsForTests, configureChannels, isChannelEnabled } from '@/server/lib/channels-config';
import { __resetDeletionForTests, configureDeletion, getDeletionConfig } from '@/server/lib/deletion-config';
import { configureDeviceAuth, getDeviceAuthConfig } from '@/server/lib/device-auth-config';
import { configureDeviceLink, getDeviceLinkConfig } from '@/server/lib/device-link-config';
import { configureAuthorizationServer, getAuthorizationServerConfig } from '@/server/lib/oauth2/config';
import {
    __resetSecondFactorPolicyForTests,
    configureSecondFactor,
    getSecondFactorPolicy,
} from '@/server/lib/second-factor-policy';
import { configureSignIn, resetSignInGuardForTests, signInGuard } from '@/server/lib/sign-in-guard';
import {
    configurePasswordChange,
    passwordChangeGuard,
    resetPasswordChangeGuardForTests,
} from '@/server/lib/password-change-guard';
import { configurePasswordRule, passwordRule, resetPasswordRuleForTests } from '@/server/lib/password-rule';
import { configurePasskeyHook, passkeyHook, resetPasskeyHookForTests } from '@/server/lib/passkey-hook';
import { getOneTimeTokenManager, initOneTimeTokenManager } from '@/server/lib/one-time-token';
import { defineUserSettings } from '@/server/lib/user-settings/define';
import { defineProfileFields } from '@/server/lib/profile-fields';
import { initializeAuth } from '@/server/services/rbac.service';
import { createRevokeAllLink } from '@/server/services/revoke-all-link.service';
import { createAuthJobRouter } from '@/server/jobs';
import { createAuthLifecycle } from '@/server/lifecycle';
import { ClientProofState } from '@/server/client-proof/state';
import { createClientProofDevHandler } from '@/server/client-proof/dev-handler';
import { createClientProofGuard } from '@/server/client-proof/guard';
import { signedTokenAuth } from '@/server/middleware/signed-token-auth';
import { opsOrUser } from '@/server/middleware/ops-or-user';
import { roleGuard } from '@/server/middleware/role-guard';
import { findMachineVerifier, registerMachineVerifier } from '@/server/middleware/machine-principals';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';

/** An object whose every option is inherited, none its own. */
function inherited(options: object): object
{
    return Object.create(options);
}

describe('declared entries (#477)', () =>
{
    it('check the default they keep — a default whose getter answers again would keep one that fails its schema', () =>
    {
        const answers = [0, 1];
        let reads = 0;
        const declared = defineUserSettings([{
            key: 'review.counter',
            schema: Type.Object({ count: Type.Literal(0) }),
            default: {
                get count()
                {
                    return answers[reads++];
                },
            },
        }]);

        expect(declared.entries.get('review.counter')?.default).toEqual({ count: 0 });
        expect(reads).toBe(1);
    });
});

/**
 * Each reader, a call that states a misspelt option where that reader reads
 * — top level or nested — and the refusal it must print.
 */
const MISSPELT: [string, () => unknown, string][] = [
    ['createAuthLifecycle', () => createAuthLifecycle({ chanels: { signup: false } } as never), 'createAuthLifecycle.chanels is not an option'],
    ['createAuthLifecycle: roles, at the call', () => createAuthLifecycle({ roles: [{ name: 'editor', displayName: 'Editor', prority: 50 }] } as never), 'roles[0].prority is not an option'],
    ['configureDeletion', () => configureDeletion({ onPurged: async () => undefined } as never), 'deletion.onPurged is not an option'],
    ['configureDeviceAuth', () => configureDeviceAuth({ ttlMS: 60_000 } as never), 'deviceAuth.ttlMS is not an option'],
    ['configureDeviceLink', () => configureDeviceLink({ ttlMS: 60_000 } as never), 'deviceLink.ttlMS is not an option'],
    ['configureAuthorizationServer', () => configureAuthorizationServer({ scope: { read: 'Read' } } as never), 'authorizationServer.scope is not an option'],
    ['configureChannels', () => configureChannels({ sigup: false } as never), 'channels.sigup is not a channel'],
    ['configureSecondFactor', () => configureSecondFactor({ requred: true } as never), 'secondFactor.requred is not an option'],
    ['configureSignIn', () => configureSignIn({ admitt: async () => undefined } as never), 'signIn.admitt is not an option'],
    ['configurePasswordChange', () => configurePasswordChange({ admitt: async () => undefined } as never), 'passwordChange.admitt is not an option'],
    ['configurePasskeyHook', () => configurePasskeyHook({ enroled: async () => undefined } as never), 'passkey.enroled is not an option'],
    ['configurePasswordRule', () => configurePasswordRule({ validat: () => [] } as never), 'password.validat is not an option'],
    ['configureAuth', () => configureAuth({ oauthEmailMatchh: 'reject' } as never), 'configureAuth.oauthEmailMatchh is not an option'],
    ['configureAuth: csrf', () => configureAuth({ csrf: { mod: 'enforce' } } as never), 'configureAuth: csrf.mod is not an option'],
    ['configureAuth: oauthProviders', () => configureAuth({ oauthProviders: { kakoa: { signIn: false } } } as never), 'configureAuth: oauthProviders.kakoa is not a provider'],
    ['configureAuth: oauthProviders.kakao', () => configureAuth({ oauthProviders: { kakao: { signin: false } } } as never), 'configureAuth: oauthProviders.kakao.signin is not an option'],
    ['configureAuth: oauthProviders.kakao.recentAuth', () => configureAuth({ oauthProviders: { kakao: { recentAuth: { lnk: false } } } } as never), 'configureAuth: oauthProviders.kakao.recentAuth.lnk is not an option'],
    ['configureAuth: oauthLink', () => configureAuth({ oauthLink: { recentAuthMinute: 5 } } as never), 'configureAuth: oauthLink.recentAuthMinute is not an option'],
    ['configureAuth: oauthLink.recentAuth', () => configureAuth({ oauthLink: { recentAuth: { unlnk: false } } } as never), 'configureAuth: oauthLink.recentAuth.unlnk is not an option'],
    ['initializeAuth', () => initializeAuth({ role: [] } as never), 'initializeAuth.role is not an option'],
    ['initializeAuth: roles', () => initializeAuth({ roles: [{ name: 'editor', displayName: 'Editor', prority: 50 }] } as never), 'roles[0].prority is not an option'],
    ['initializeAuth: permissions', () => initializeAuth({ permissions: [{ name: 'post:create', displayName: 'Create', categry: 'custom' }] } as never), 'permissions[0].categry is not an option'],
    ['initOneTimeTokenManager', () => initOneTimeTokenManager({ tll: 5_000 } as never), 'oneTimeToken.tll is not an option'],
    ['createAuthJobRouter', () => createAuthJobRouter({ purgecron: '0 3 * * *' } as never), 'createAuthJobRouter.purgecron is not an option'],
    ['ClientProofState', () => new ClientProofState({ publicKeys: {}, replayWindowMilis: 1 } as never), 'ClientProofState.replayWindowMilis is not an option'],
    ['createClientProofDevHandler', () => createClientProofDevHandler({ publicKeys: {}, enableControll: false } as never), 'createClientProofDevHandler.enableControll is not an option'],
    ['createClientProofGuard', () => createClientProofGuard(new ClientProofState({ publicKeys: {} }), { contractpath: '/x' } as never), 'createClientProofGuard.contractpath is not an option'],
    ['defineUserSettings', () => defineUserSettings([{ key: 'review.setting', schema: Type.String(), defualt: 'kept' }] as never), 'defineUserSettings[0].defualt is not an option'],
    ['defineProfileFields', () => defineProfileFields([{ key: 'reviewField', schema: Type.String(), defualt: 'kept' }] as never), 'defineProfileFields[0].defualt is not an option'],
    ['signedTokenAuth', () => signedTokenAuth({ keysUrl: 'https://issuer.test/keys', iss: 'https://issuer.test', aud: 'app', clockSkew: 5 } as never), 'signedTokenAuth.clockSkew is not an option'],
    ['opsOrUser', () => opsOrUser({ opsScopes: ['read'], permisions: ['admin'] } as never), 'opsOrUser.permisions is not an option'],
    ['roleGuard', () => roleGuard({ alow: ['admin'] } as never), 'roleGuard.alow is not an option'],
    ['createRevokeAllLink', () => createRevokeAllLink(1, { ttlMinute: 5 } as never), 'createRevokeAllLink.ttlMinute is not an option'],
    ['registerMachineVerifier: match', () => registerMachineVerifier({ id: 'misspeltMatch', match: { kidprefix: 'misspelt:' }, verify: async () => undefined } as never), 'registerMachineVerifier: match.kidprefix is not an option'],
];

/** An object stating `rest`, and `key` as a getter answering `answers` in turn; `reads()` counts its reads. */
function answering(key: string, answers: unknown[], rest: object = {}): { options: object; reads: () => number }
{
    let reads = 0;
    const options = Object.defineProperty({ ...rest }, key, {
        get: () => answers[reads++],
        enumerable: true,
    });

    return { options, reads: () => reads };
}

const ADMIT_A = async () => undefined;
const ADMIT_B = async () => undefined;
const VALIDATE_A = () => [];
const VALIDATE_B = () => [];

/** A server with `guard` on GET /, every request signed in as an admin. */
function guarded(guard: { handler: (c: never, next: never) => unknown }): Hono
{
    const app = new Hono();

    app.onError((error, c) => c.text(error.message, (error as { statusCode?: 403 }).statusCode ?? 500));
    app.use('*', async (c, next) =>
    {
        c.set('auth' as never, { userId: '1', role: 'admin' } as never);
        await next();
    });
    app.get('/', guard.handler as never, c => c.text('ok'));

    return app;
}

/**
 * Each reader: the option given as a getter, what it answers in turn, the
 * other options it needs, how the getter's object is handed over and what
 * the reader then uses. The first answer is the one it must use.
 */
const GETTER: [string, string, unknown[], object, (options: never) => unknown][] = [
    ['createAuthLifecycle', 'channels', [{ signup: false }, { signup: true }], {}, (options) =>
    {
        createAuthLifecycle(options);

        return { signup: isChannelEnabled('signup') };
    }],
    ['configureDeletion', 'purgeStrategy', ['hard-delete', 'anonymize'], {}, (options) =>
    {
        configureDeletion(options);

        return getDeletionConfig().purgeStrategy;
    }],
    ['configureDeviceAuth', 'ttlMs', [60_000, 120_000], {}, (options) =>
    {
        configureDeviceAuth(options);

        return getDeviceAuthConfig().ttlMs;
    }],
    ['configureDeviceLink', 'ttlMs', [60_000, 120_000], {}, (options) =>
    {
        configureDeviceLink(options);

        return getDeviceLinkConfig().ttlMs;
    }],
    ['configureAuthorizationServer', 'codeTtlMs', [5_000, 7_000], { scopes: { read: 'Read' }, issuer: 'https://api.test', authorizeUrl: 'https://app.test/oauth/authorize' }, (options) =>
    {
        configureAuthorizationServer(options);

        return getAuthorizationServerConfig()?.codeTtlMs;
    }],
    ['configureAuthorizationServer: scopes', 'read', ['Read', 'Write'], {}, (options) =>
    {
        configureAuthorizationServer({ scopes: options, issuer: 'https://api.test', authorizeUrl: 'https://app.test/oauth/authorize' });

        return getAuthorizationServerConfig()?.scopes.read;
    }],
    ['configureChannels', 'signup', [false, true], {}, (options) =>
    {
        configureChannels(options);

        return isChannelEnabled('signup');
    }],
    ['configureSecondFactor', 'recoveryCodes', [false, true], {}, (options) =>
    {
        configureSecondFactor(options);

        return getSecondFactorPolicy().recoveryCodes;
    }],
    ['configureSignIn', 'admit', [ADMIT_A, ADMIT_B], {}, (options) =>
    {
        configureSignIn(options);

        return signInGuard()?.admit;
    }],
    ['configurePasswordChange', 'admit', [ADMIT_A, ADMIT_B], {}, (options) =>
    {
        configurePasswordChange(options);

        return passwordChangeGuard()?.admit;
    }],
    ['configurePasskeyHook', 'enrolled', [ADMIT_A, ADMIT_B], {}, (options) =>
    {
        configurePasskeyHook(options);

        return passkeyHook()?.enrolled;
    }],
    ['configurePasswordRule', 'validate', [VALIDATE_A, VALIDATE_B], {}, (options) =>
    {
        configurePasswordRule(options);

        return passwordRule()?.validate;
    }],
    ['configureAuth', 'oauthEmailMatch', ['reject', 'attach'], {}, (options) =>
    {
        configureAuth(options);

        return getOAuthEmailMatch();
    }],
    ['configureAuth: csrf', 'mode', ['enforce', 'off'], {}, (options) =>
    {
        configureAuth({ csrf: options });

        return getCsrfMode();
    }],
    ['configureAuth: oauthProviders', 'kakao', [{ signIn: false }, { signIn: true }], {}, (options) =>
    {
        configureAuth({ oauthProviders: options });

        return { signIn: isSignInProvider('kakao') };
    }],
    ['configureAuth: oauthProviders.kakao', 'signIn', [false, true], {}, (options) =>
    {
        configureAuth({ oauthProviders: { kakao: options } });

        return isSignInProvider('kakao');
    }],
    ['configureAuth: oauthProviders.kakao.recentAuth', 'link', [false, true], {}, (options) =>
    {
        configureAuth({ oauthProviders: { kakao: { recentAuth: options } } });

        return linkNeedsRecentAuth('kakao', 'link');
    }],
    ['configureAuth: oauthLink', 'recentAuthMinutes', [5, 9], {}, (options) =>
    {
        configureAuth({ oauthLink: options });

        return getOAuthLinkRecentAuthMs() / 60_000;
    }],
    ['configureAuth: oauthLink.recentAuth', 'unlink', [false, true], {}, (options) =>
    {
        configureAuth({ oauthLink: { recentAuth: options } });

        return linkNeedsRecentAuth('google', 'unlink');
    }],
    ['initOneTimeTokenManager', 'ttl', [5_000, 7_000], {}, (options) =>
    {
        initOneTimeTokenManager(options);

        return getOneTimeTokenManager().ttlMs;
    }],
    ['createAuthJobRouter', 'purgeCron', ['0 3 * * *', '0 9 * * *'], {}, options => collectJobs(createAuthJobRouter(options))[0].cronExpression],
    ['ClientProofState', 'replayWindowMillis', [1_234, 999], { publicKeys: {} }, options => new ClientProofState(options).replayWindowMillis],
    ['createClientProofDevHandler', 'controlToken', ['token-a', 'token-b'], { publicKeys: {} }, options => createClientProofDevHandler(options).controlToken],
    ['createClientProofDevHandler: the state it builds', 'replayWindowMillis', [1_234, 999], { publicKeys: {} }, options => createClientProofDevHandler(options).state.replayWindowMillis],
    ['defineUserSettings', 'key', ['review.digest', 'review.other'], { schema: Type.String(), default: 'daily' }, options => defineUserSettings([options]).keys[0]],
    ['defineProfileFields', 'key', ['reviewDigest', 'reviewOther'], { schema: Type.String() }, options => defineProfileFields([options]).keys[0]],
    ['registerMachineVerifier', 'id', ['getterVerifierA', 'getterVerifierB'], { match: { tokenPrefix: 'getter-row:' }, verify: async () => undefined }, (options) =>
    {
        registerMachineVerifier(options);

        return findMachineVerifier('getter-row:token')?.id;
    }],
    ['registerMachineVerifier: match', 'tokenPrefix', ['match-getter-row:', 'match-getter-other:'], {}, (options) =>
    {
        registerMachineVerifier({ id: 'matchGetterRow', match: options, verify: async () => undefined } as never);

        return findMachineVerifier('match-getter-row:token')?.prefix;
    }],
];

/**
 * Registrations whose `verify` getter answers a function, then not one: the
 * function checked must be the function bound. The other members they need,
 * and the call.
 */
const FUNCTION_GETTER: [string, object, (registration: never) => void][] = [
    ['registerMachineVerifier: verify', { id: 'functionGetterRow', match: { tokenPrefix: 'function-getter-row:' } }, registerMachineVerifier],
    ['registerAuthProfile: verify', {}, registration => registerAuthProfile('functionGetterRow', registration)],
];

/** Maps keyed by the application's own names, each with an inherited entry, and the refusal. */
const INHERITED_ENTRY: [string, () => unknown, string][] = [
    ['authorizationServer.scopes', () => configureAuthorizationServer({ scopes: inherited({ read: 'Read' }) } as never), 'authorizationServer.scopes must be a plain object'],
    ['rolePermissions', () => initializeAuth({ rolePermissions: inherited({ user: ['task:read'] }) } as never), 'rolePermissions must be a plain object'],
    ['ClientProofState.publicKeys', () => new ClientProofState({ publicKeys: inherited({}) as never }), 'ClientProofState.publicKeys must be a plain object'],
];

/** An ordinary array behind a Proxy, which `Array.isArray` sees through. */
function proxied(list: unknown[]): unknown[]
{
    return new Proxy(list, {});
}

/** Each list-valued option, a call that gives it as a Proxy array, and the refusal. */
const PROXY_LIST: [string, () => unknown, string][] = [
    ['authorizationServer.defaultScopes', () => configureAuthorizationServer({ scopes: { read: 'Read' }, issuer: 'https://api.test', authorizeUrl: 'https://app.test/oauth/authorize', defaultScopes: proxied(['read']) } as never), 'authorizationServer.defaultScopes must be an array'],
    ['authorizationServer.allowedRedirectOrigins', () => configureAuthorizationServer({ scopes: { read: 'Read' }, issuer: 'https://api.test', authorizeUrl: 'https://app.test/oauth/authorize', allowedRedirectOrigins: proxied(['https://app.test']) } as never), 'authorizationServer.allowedRedirectOrigins must be an array'],
    ['configureAuth: csrf.exemptPaths', () => configureAuth({ csrf: { exemptPaths: proxied(['/hooks/stripe']) } } as never), 'configureAuth: csrf.exemptPaths must be an array'],
    ['secondFactor.methods', () => configureSecondFactor({ methods: proxied(['totp']) } as never), 'secondFactor.methods must be an array'],
    ['opsOrUser.opsScopes', () => opsOrUser({ opsScopes: proxied(['read']), roles: ['admin'] } as never), 'opsOrUser.opsScopes must be an array'],
    ['roleGuard.allow', () => roleGuard({ allow: proxied(['admin']) } as never), 'roleGuard.allow must be an array'],
    ['roleGuard.deny', () => roleGuard({ deny: proxied(['user']) } as never), 'roleGuard.deny must be an array'],
    ['rolePermissions.user', () => initializeAuth({ rolePermissions: { user: proxied(['task:read']) } } as never), 'rolePermissions.user must be an array'],
];

describe('every reader reads through the shared rule (#477)', () =>
{
    afterEach(() =>
    {
        __resetChannelsForTests();
        __resetDeletionForTests();
        __resetSecondFactorPolicyForTests();
        resetSignInGuardForTests();
        resetPasswordChangeGuardForTests();
        resetPasskeyHookForTests();
        resetPasswordRuleForTests();
        configureDeviceAuth();
        configureDeviceLink();
        configureAuthorizationServer(undefined);
        configureAuth({ oauthEmailMatch: undefined, csrf: undefined, oauthProviders: undefined, oauthLink: undefined });
    });

    it.each(MISSPELT)('%s refuses a misspelt option, naming it', async (_reader, call, refusal) =>
    {
        await expect(async () => call()).rejects.toThrow(refusal);
    });

    it.each(GETTER)('%s reads %s once, and uses what that read answered', (_reader, key, answers, rest, use) =>
    {
        const { options, reads } = answering(key, answers, rest);

        expect(use(options as never)).toEqual(answers[0]);
        expect(reads()).toBe(1);
    });

    it.each(FUNCTION_GETTER)('%s is read once: a getter answering a function, then not one, registers', (_reader, rest, register) =>
    {
        const { options, reads } = answering('verify', [async () => undefined, 'not a function'], rest);

        expect(() => register(options as never)).not.toThrow();
        expect(reads()).toBe(1);
    });

    it('ClientProofState reads a publicKeys entry once: a getter answering a key, then not one, builds the state', () =>
    {
        const spki = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        const { options: publicKeys, reads } = answering('device-1', [spki, 'not a key']);

        expect(() => new ClientProofState({ publicKeys: publicKeys as never })).not.toThrow();
        expect(reads()).toBe(1);
    });

    it('createClientProofGuard reads contractPath once, when it is built, not on each request', async () =>
    {
        const { options, reads } = answering('contractPath', ['/contract', '/other']);
        const app = new Hono();

        app.post('/mounted', createClientProofGuard(new ClientProofState({ publicKeys: {} }), options), c => c.text('ok'));
        await app.request('/mounted', { method: 'POST', body: '{}' });
        await app.request('/mounted', { method: 'POST', body: '{}' });

        expect(reads()).toBe(1);
    });

    it('roleGuard reads allow once, when it is built, and every request is judged by that answer', async () =>
    {
        const { options, reads } = answering('allow', [['admin'], ['user']]);
        const app = guarded(roleGuard(options as never));

        expect((await app.request('/')).status).toBe(200);
        expect((await app.request('/')).status).toBe(200);
        expect(reads()).toBe(1);
    });

    it.each(INHERITED_ENTRY)('%s refuses an inherited entry rather than apply or drop it', async (_map, call, refusal) =>
    {
        await expect(async () => call()).rejects.toThrow(refusal);
    });

    it.each(PROXY_LIST)('%s refuses a Proxy array — it is read into a copy, not kept', async (_list, call, refusal) =>
    {
        await expect(async () => call()).rejects.toThrow(refusal);
    });
});
