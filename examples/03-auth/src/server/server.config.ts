/**
 * Server Configuration
 *
 * `createAuthLifecycle()` validates auth env before the DB connects, then seeds admin
 * accounts and initializes RBAC once the DB is ready.
 */
import { Type } from '@sinclair/typebox';
import { defineServerConfig } from '@spfn/core/server';
import { configureAuth, createAuthLifecycle, defineUserSettings } from '@spfn/auth/server';
import { appRouter } from '@/server/router';

// Battle.net is connected from the dashboard and never used to sign in, so its
// link needs no recent sign-in. See "Link-only providers and recent
// authentication" in the @spfn/auth README.
configureAuth({
    oauthProviders: {
        battlenet: { signIn: false, recentAuth: { link: false } },
    },
});

// How a person uses the app, beside the built-in locale and timezone. Read and
// written with getUserSetting/setUserSetting, or authApi.setSetting from a client.
// See "How do I declare per-person settings and profile fields?" in the README.
const USER_SETTINGS = defineUserSettings([
    {
        key: 'notifications.digest',
        schema: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('off')]),
        default: 'daily',
    },
]);

export default defineServerConfig()
    .routes(appRouter)
    .lifecycle(createAuthLifecycle({ userSettings: USER_SETTINGS }))
    .build();
