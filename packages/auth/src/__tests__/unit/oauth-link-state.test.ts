/**
 * The link state (fxylabs/spfn#154) and the sign-in state never open as each other.
 *
 * Row C8 of artifacts/issue-154-battlenet-design.md §7-3: one callback route
 * serves both, and the key a state opens under is what decides whether it is a
 * sign-in or a link.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { OAuthStateExpiredError, OAuthStateInvalidError } from '@spfn/auth/errors';
import {
    createOAuthLinkState,
    createOAuthState,
    openOAuthLinkState,
    verifyOAuthState,
    type OAuthLinkState,
} from '@/server/lib/oauth/state';

const LINK: OAuthLinkState = {
    provider: 'battlenet',
    userId: '42',
    returnUrl: '/settings/connections',
    nonce: 'a'.repeat(32),
    startId: 'b'.repeat(32),
};

describe('OAuth link state', () =>
{
    beforeAll(() =>
    {
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
    });

    afterEach(() =>
    {
        vi.useRealTimers();
    });

    it('opens what it sealed', async () =>
    {
        expect(await openOAuthLinkState(await createOAuthLinkState(LINK))).toEqual(LINK);
    });

    it('C8: a sign-in state does not open as a link', async () =>
    {
        const signIn = await createOAuthState({
            provider: 'battlenet',
            returnUrl: '/',
            publicKey: 'pk',
            keyId: 'key-1',
            fingerprint: 'fp',
            algorithm: 'ES256',
            nonce: 'n',
        });

        expect(await openOAuthLinkState(signIn)).toBeNull();
    });

    it('C8: a link state does not open as a sign-in', async () =>
    {
        await expect(verifyOAuthState(await createOAuthLinkState(LINK))).rejects.toBeInstanceOf(OAuthStateInvalidError);
    });

    it('is null for garbage, a truncated state and a malformed percent-escape', async () =>
    {
        const sealed = await createOAuthLinkState(LINK);

        expect(await openOAuthLinkState('not-a-state')).toBeNull();
        expect(await openOAuthLinkState(sealed.slice(0, -10))).toBeNull();
        expect(await openOAuthLinkState('%E0%A4%A')).toBeNull();
    });

    it('C7: an expired link state is refused as expired, not passed on as a sign-in state', async () =>
    {
        const sealed = await createOAuthLinkState(LINK);

        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);

        await expect(openOAuthLinkState(sealed)).rejects.toBeInstanceOf(OAuthStateExpiredError);
    });
});
