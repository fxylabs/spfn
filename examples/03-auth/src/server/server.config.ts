/**
 * Server Configuration
 *
 * `createAuthLifecycle()` validates auth env before the DB connects, then seeds admin
 * accounts and initializes RBAC once the DB is ready.
 */
import { defineServerConfig } from '@spfn/core/server';
import { configureAuth, createAuthLifecycle } from '@spfn/auth/server';
import { appRouter } from '@/server/router';

// Battle.net is connected from the dashboard and never used to sign in, so its
// link needs no recent sign-in. See "Link-only providers and recent
// authentication" in the @spfn/auth README.
configureAuth({
    oauthProviders: {
        battlenet: { signIn: false, recentAuth: { link: false } },
    },
});

export default defineServerConfig()
    .routes(appRouter)
    .lifecycle(createAuthLifecycle())
    .build();
