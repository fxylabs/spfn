/**
 * @spfn/auth - A policy value outside its declared set is a configuration error (au5-B2)
 *
 * T5, for every option the sweep found reading an unknown value as the loosest
 * behaviour. `oauthEmailMatch: 'Reject'` is row S3 of
 * oauth-email-match-config.test.ts. Each value below used to configure without
 * complaint: a misspelt provider or flag was ignored (sign-in stayed on), the
 * string `'false'` was truthy, `0` turned the recent-authentication rule off.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { configureAuth, getAuthConfig, type AuthConfig } from '@/server/lib/config';
import { createAuthLifecycle, type AuthLifecycleOptions } from '@/server/lifecycle';
import { configureDeletion, getDeletionConfig } from '@/server/lib/deletion-config';

/** An option with a value outside its set, and what the refusal must name. */
const AUTH_CONFIG_REFUSALS: [string, unknown, RegExp][] = [
    ['csrf.mode', { csrf: { mode: 'enforced' } }, /csrf\.mode does not accept 'enforced'\. Allowed: 'off', 'warn', 'enforce'/],
    ['oauthProviders.<provider>.signIn', { oauthProviders: { kakao: { signIn: 'false' } } }, /oauthProviders\.kakao\.signIn does not accept 'false'\. Allowed: true, false/],
    ['oauthProviders.<unknown provider>', { oauthProviders: { kakoa: { signIn: false } } }, /oauthProviders has no provider 'kakoa'\. Allowed: .*'kakao'/],
    ['oauthProviders.<provider>.<unknown key>', { oauthProviders: { kakao: { signin: false } } }, /oauthProviders\.kakao has no option 'signin'\. Allowed: signIn, recentAuth/],
    ['oauthProviders.<provider>.recentAuth.link', { oauthProviders: { kakao: { recentAuth: { link: 0 } } } }, /oauthProviders\.kakao\.recentAuth\.link does not accept 0 \(number\)\. Allowed: true, false/],
    ['oauthLink.recentAuth.unlink', { oauthLink: { recentAuth: { unlink: 'no' } } }, /oauthLink\.recentAuth\.unlink does not accept 'no'\. Allowed: true, false/],
    ['oauthLink.<unknown key>', { oauthLink: { recentAuthMinute: 5 } }, /oauthLink has no option 'recentAuthMinute'\. Allowed: recentAuth, recentAuthMinutes/],
];

const LIFECYCLE_REFUSALS: [string, AuthLifecycleOptions['deletion'], RegExp][] = [
    ['deletion.purgeStrategy', { purgeStrategy: 'hard_delete' as never }, /deletion\.purgeStrategy does not accept "hard_delete"\. Allowed: anonymize, hard-delete/],
    ['deletion.allowSelfImmediate', { allowSelfImmediate: 'false' as never }, /deletion\.allowSelfImmediate does not accept "false"\. Allowed: true, false/],
    // Removed (#170): an app upgrading with it set must learn at boot that nothing is mailed any more.
    ['deletion.sendNotifications', { sendNotifications: true } as never, /deletion\.sendNotifications was removed: @spfn\/auth sends no account-deletion notice\..*README, "Account Deletion & Recovery"/],
    // A misspelt hook would otherwise never be called, and its notice never sent.
    ['deletion.<unknown key>', { onPurged: async () => undefined } as never, /deletion has no option 'onPurged'\. Allowed: gracePeriodDays, purgeStrategy, allowSelfImmediate, purgeCron, onBeforePurge, onPurge/],
];

describe('T5: unknown policy values refuse at configuration', () =>
{
    afterEach(() =>
    {
        configureAuth({ csrf: undefined, oauthProviders: undefined, oauthLink: undefined });
        configureDeletion(undefined);
    });

    it.each(AUTH_CONFIG_REFUSALS)('configureAuth %s', (_option, config, refusal) =>
    {
        const before = getAuthConfig();

        expect(() => configureAuth(config as AuthConfig)).toThrow(refusal);
        expect(getAuthConfig()).toEqual(before);
    });

    it.each(LIFECYCLE_REFUSALS)('createAuthLifecycle %s', (_option, deletion, refusal) =>
    {
        expect(() => createAuthLifecycle({ deletion })).toThrow(refusal);
        expect(getDeletionConfig().allowSelfImmediate).toBe(false);
    });
});
