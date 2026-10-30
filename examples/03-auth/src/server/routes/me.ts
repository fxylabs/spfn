/**
 * Protected Route: GET /me
 *
 * The global `authenticate` middleware (router.ts) already gates this route — a request
 * without a valid client-signed JWT never reaches the handler. Read the authenticated
 * user from the context with `getAuth(c)`; never parse the raw context yourself.
 * The linked social accounts come from `socialAccountsRepository` — never their tokens.
 */

import { route } from '@spfn/core/route';
import { getAuth, socialAccountsRepository } from '@spfn/auth/server';

export const getMe = route.get('/me')
    .handler(async (c) =>
    {
        const { user, userId, role, locale } = getAuth(c);
        const socialAccounts = await socialAccountsRepository.findByUserId(Number(userId));

        return {
            id: userId,
            email: user.email,
            username: user.username,
            role,
            locale,
            // The identities this account can sign in with. `providerHandle` is the
            // current BattleTag for Battle.net, replaced on every sign-in and link.
            connections: socialAccounts.map(account => ({
                provider: account.provider,
                providerHandle: account.providerHandle,
            })),
        };
    });
