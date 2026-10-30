/**
 * How the link-only and recent-authentication settings resolve (fxylabs/spfn#155, #157).
 *
 * Rows R1-R7 of artifacts/issue-155-157-link-policy-design.md §8-1. A provider's
 * own setting wins over `oauthLink`, which wins over the default; the link
 * window falls back to the passkey variable as a plain number, never through
 * `getPasskeyConfig()`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PasskeyConfigError } from '@spfn/auth/errors';
import {
    configureAuth,
    getOAuthLinkRecentAuthMs,
    getPasskeyConfig,
    isSignInProvider,
    linkNeedsRecentAuth,
} from '@/server/lib/config';

const MINUTE = 60_000;

describe('OAuth link policy settings', () =>
{
    afterEach(() =>
    {
        vi.unstubAllEnvs();
        configureAuth({ oauthProviders: undefined, oauthLink: undefined });
    });

    it('R1: with nothing set, every provider signs in, both rules apply, and the window is ten minutes', () =>
    {
        vi.stubEnv('SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES', undefined);

        expect(isSignInProvider('battlenet')).toBe(true);
        expect(isSignInProvider('google')).toBe(true);
        expect(linkNeedsRecentAuth('battlenet', 'link')).toBe(true);
        expect(linkNeedsRecentAuth('battlenet', 'unlink')).toBe(true);
        expect(getOAuthLinkRecentAuthMs()).toBe(10 * MINUTE);
    });

    it('R2: oauthLink.recentAuth.link false turns the link rule off for every provider, not the unlink rule', () =>
    {
        configureAuth({ oauthLink: { recentAuth: { link: false } } });

        expect(linkNeedsRecentAuth('battlenet', 'link')).toBe(false);
        expect(linkNeedsRecentAuth('google', 'link')).toBe(false);
        expect(linkNeedsRecentAuth('battlenet', 'unlink')).toBe(true);
    });

    it('R3: a provider\'s own setting turns the rule off for that provider only', () =>
    {
        configureAuth({ oauthProviders: { battlenet: { recentAuth: { link: false } } } });

        expect(linkNeedsRecentAuth('battlenet', 'link')).toBe(false);
        expect(linkNeedsRecentAuth('google', 'link')).toBe(true);
    });

    it('R4: a provider\'s own setting wins over oauthLink', () =>
    {
        configureAuth({
            oauthLink: { recentAuth: { link: false } },
            oauthProviders: { battlenet: { recentAuth: { link: true } } },
        });

        expect(linkNeedsRecentAuth('battlenet', 'link')).toBe(true);
        expect(linkNeedsRecentAuth('google', 'link')).toBe(false);
    });

    it('R5: with no link window set, the passkey variable decides it, read without the passkey configuration', () =>
    {
        vi.stubEnv('SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES', '30');
        vi.stubEnv('SPFN_AUTH_PASSKEY_RP_ID', undefined);
        vi.stubEnv('SPFN_APP_URL', undefined);
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', undefined);

        expect(() => getPasskeyConfig()).toThrow(PasskeyConfigError);
        expect(getOAuthLinkRecentAuthMs()).toBe(30 * MINUTE);
    });

    it('R6: oauthLink.recentAuthMinutes sets the link window and leaves the passkey window alone', () =>
    {
        vi.stubEnv('SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES', undefined);
        vi.stubEnv('SPFN_AUTH_PASSKEY_RP_ID', 'localhost');
        vi.stubEnv('SPFN_AUTH_PASSKEY_ORIGINS', 'http://localhost:3000');
        configureAuth({ oauthLink: { recentAuthMinutes: 30 } });

        expect(getOAuthLinkRecentAuthMs()).toBe(30 * MINUTE);
        expect(getPasskeyConfig().recentAuthMs).toBe(10 * MINUTE);
    });

    it('R6b: a link window that is not a positive number falls back, as the step-up window does', () =>
    {
        vi.stubEnv('SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES', undefined);
        configureAuth({ oauthLink: { recentAuthMinutes: 0 } });

        expect(getOAuthLinkRecentAuthMs()).toBe(10 * MINUTE);
    });

    it('R7: signIn false makes that provider link-only and no other', () =>
    {
        configureAuth({ oauthProviders: { battlenet: { signIn: false } } });

        expect(isSignInProvider('battlenet')).toBe(false);
        expect(isSignInProvider('google')).toBe(true);
        expect(isSignInProvider('kakao')).toBe(true);
    });
});
