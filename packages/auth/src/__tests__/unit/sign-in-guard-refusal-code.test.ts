/**
 * @spfn/auth - the shape of the app's refusal code (#361)
 *
 * One row: `admit`'s `code` crosses from app code into a response. Without a
 * stated shape nothing fails until an app returns a message, or interpolated
 * data, as the code — and it goes out in `details.code`, a megabyte as easily
 * as a word.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { configureSignIn, resetSignInGuardForTests } from '@/server/lib/sign-in-guard';
import { admitSignIn } from '@/server/services/sign-in-guard.service';

const ATTEMPT = { user: null, channel: 'password', stage: 'credential', webProxy: false } as const;

function refusing(code: string): Promise<unknown>
{
    configureSignIn({ admit: () => ({ refuse: { code } }) });

    return admitSignIn(ATTEMPT, 'deciding');
}

describe('signIn.admit refusal code (#361)', () =>
{
    afterEach(() =>
    {
        resetSignInGuardForTests();
    });

    it('1 to 64 letters, digits, _, - or . pass; one more character, or any other character, is a malformed answer', async () =>
    {
        for (const code of ['ACCOUNT_LOCKED', 'temporary-password-expired', 'policy.locked', 'X', 'L'.repeat(64)])
        {
            resetSignInGuardForTests();
            await expect(refusing(code)).resolves.toEqual({ code });
        }

        for (const code of ['L'.repeat(65), 'LOCKED ', 'locked:42', 'é', 'a/b'])
        {
            resetSignInGuardForTests();
            await expect(refusing(code)).rejects.toThrow(/1 to 64 letters/);
        }
    });
});
