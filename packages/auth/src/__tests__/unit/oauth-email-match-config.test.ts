/**
 * How the email-match setting resolves (fxylabs/spfn#156).
 *
 * Rows S1-S3 of the #156 design §6-1. Rows E1-E11 and N1-N2 are in
 * integration/oauth-email-match.test.ts.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { configureAuth, getOAuthEmailMatch, type OAuthEmailMatch } from '@/server/lib/config';

describe('OAuth email-match setting', () =>
{
    afterEach(() =>
    {
        configureAuth({ oauthEmailMatch: undefined });
    });

    it('S1: with nothing set, a matching email attaches as in 0.3.0-beta.50', () =>
    {
        expect(getOAuthEmailMatch()).toBe('attach');
    });

    it('S2: reject and separate are read as set, on every call', () =>
    {
        configureAuth({ oauthEmailMatch: 'reject' });
        expect(getOAuthEmailMatch()).toBe('reject');

        configureAuth({ oauthEmailMatch: 'separate' });
        expect(getOAuthEmailMatch()).toBe('separate');

        configureAuth({ oauthEmailMatch: 'attach' });
        expect(getOAuthEmailMatch()).toBe('attach');
    });

    it('S3: a value the type does not allow is attach', () =>
    {
        configureAuth({ oauthEmailMatch: 'Reject' as OAuthEmailMatch });
        expect(getOAuthEmailMatch()).toBe('attach');

        configureAuth({ oauthEmailMatch: 'merge' as OAuthEmailMatch });
        expect(getOAuthEmailMatch()).toBe('attach');
    });
});
