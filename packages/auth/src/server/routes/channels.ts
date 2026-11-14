/**
 * @spfn/auth - Which sign-in channel each route belongs to
 *
 * `ROUTE_CHANNELS` is the one list: every key of `mainAuthRouter` names its
 * channel, or `'always'`. `gateChannels` is handed it to put the channel check
 * in front of each route, and a test reads it to fail on a route nobody
 * classified — a route added later and left out would otherwise stay reachable
 * while its channel is off. `gateChannels`' parameter type says the same at
 * compile time, at the router.
 *
 * The check is a route-level middleware rather than a call in the handler,
 * because a handler is too late. The gate is the first of the route's own
 * middlewares, so a disabled channel answers 404 before anything else the route
 * runs: no rate-limit token is spent, no long poll opens a waiter, no
 * transaction begins.
 *
 * It does not reach in front of the server-level middlewares, which run before
 * every route-level one. On a public route nothing there refuses, so every
 * caller meets the 404. On a signed-in route the global `auth` middleware runs
 * first, as it does on every signed-in route: an anonymous caller is answered
 * its 401 and a signed-in one the 404 — the way the oauth2 signed-in routes
 * answer when no authorization server is configured. An app's server-level
 * middlewares see the principal exactly as they would without the gate.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { NamedMiddleware, RouteDef } from '@spfn/core/route';

import { requireChannel, type AuthChannel } from '../lib/channels-config';
import type { VerificationPurpose } from './schema';

/** A verification code belongs to the channel its `purpose` serves; other purposes are always on. */
type PurposeChannels = Partial<Record<VerificationPurpose, AuthChannel>>;

export type RouteChannel = AuthChannel | 'always' | PurposeChannels;

const CODE_PURPOSES: PurposeChannels = { registration: 'signup', password_reset: 'passwordReset' };

export const ROUTE_CHANNELS = {
    sendVerificationCode: CODE_PURPOSES,
    verifyCode: CODE_PURPOSES,
    register: 'signup',
    requestSignupLink: 'signup',
    confirmSignupLink: 'signup',
    completeSignup: 'signup',
    requestPasswordReset: 'passwordReset',
    confirmPasswordReset: 'passwordReset',
    completePasswordReset: 'passwordReset',
    login: 'always',
    startDeviceAuth: 'deviceCode',
    startDeviceAuthWeb: 'deviceCode',
    pollDeviceAuth: 'deviceCode',
    getDeviceAuthInfo: 'deviceCode',
    approveDeviceAuth: 'deviceCode',
    denyDeviceAuth: 'deviceCode',
    issueDeviceLink: 'deviceLink',
    redeemDeviceLink: 'deviceLink',
    redeemDeviceLinkWeb: 'deviceLink',
    getDeviceLinkStatus: 'deviceLink',
    confirmDeviceLink: 'deviceLink',
    denyDeviceLink: 'deviceLink',
    cancelDeviceLink: 'deviceLink',
    pollDeviceLink: 'deviceLink',
    passkeyRegisterOptions: 'always',
    passkeyRegisterVerify: 'always',
    passkeyLoginOptions: 'always',
    passkeyLoginVerify: 'always',
    listPasskeys: 'always',
    renamePasskey: 'always',
    revokePasskey: 'always',
    mfaTotpEnroll: 'always',
    mfaTotpConfirm: 'always',
    mfaDisable: 'always',
    mfaMarkPasskey: 'always',
    mfaRegenerateRecoveryCodes: 'always',
    mfaStatus: 'always',
    mfaStepUp: 'always',
    mfaStepUpOptions: 'always',
    mfaVerify: 'always',
    mfaVerifyOptions: 'always',
    logout: 'always',
    rotateKey: 'always',
    listKeys: 'always',
    revokeKey: 'always',
    revokeAllKeys: 'always',
    confirmRevokeAllLink: 'always',
    consumeRevokeAllLink: 'always',
    changePassword: 'always',
    getAuthSession: 'always',
    setSessionBinding: 'always',
    getSessionBinding: 'always',
    sessionBindingDisableOptions: 'always',
    sessionRenewOptions: 'always',
    sessionRenewVerify: 'always',
    issueOneTimeToken: 'always',
    requestAccountDeletion: 'always',
    cancelAccountDeletion: 'always',
    oauthGoogleStart: 'always',
    oauthGoogleCallback: 'always',
    oauthStart: 'always',
    oauthProviders: 'always',
    getGoogleOAuthUrl: 'always',
    oauthFinalize: 'always',
    oauthProviderStart: 'always',
    oauthProviderCallback: 'always',
    oauthProviderCallbackPost: 'always',
    getProviderOAuthUrl: 'always',
    oauthNative: 'always',
    oauthAppleNativeStart: 'always',
    oauthUnlinkNotify: 'always',
    oauthUnlinkNotifyGet: 'always',
    oauthLinkStart: 'always',
    oauthUnlink: 'always',
    androidAssetLinks: 'always',
    getInvitation: 'always',
    acceptInvitation: 'always',
    createInvitation: 'always',
    listInvitations: 'always',
    cancelInvitation: 'always',
    resendInvitation: 'always',
    deleteInvitation: 'always',
    getUserProfile: 'always',
    updateUserProfile: 'always',
    checkUsername: 'always',
    updateUsername: 'always',
    updateLocale: 'always',
    listSettings: 'always',
    getSetting: 'always',
    setSetting: 'always',
    resetSetting: 'always',
    listRoles: 'always',
    createAdminRole: 'always',
    updateAdminRole: 'always',
    deleteAdminRole: 'always',
    updateUserRole: 'always',
    issueOpsToken: 'always',
    listOpsTokens: 'always',
    revokeOpsToken: 'always',
    registerOAuth2Client: 'always',
    getOAuth2Authorize: 'always',
    createOAuth2AuthorizationCode: 'always',
    oauth2Token: 'always',
    oauth2Revoke: 'always',
    listOAuth2Grants: 'always',
    revokeOAuth2Grant: 'always',
    oauth2AuthorizationServerMetadata: 'always',
} as const satisfies Record<string, RouteChannel>;

/**
 * The routes with each one's channel check first among its own middlewares.
 *
 * A route missing from `channels` is refused here too, at import, so an
 * unclassified route cannot reach a running server even past the type check.
 */
export function gateChannels<TRoutes extends Record<string, RouteDef<any, any, any>>>(
    routes: TRoutes,
    channels: Record<keyof TRoutes, RouteChannel>,
): TRoutes
{
    return Object.fromEntries(Object.entries(routes).map(([key, route]) =>
    {
        const channel: RouteChannel | undefined = channels[key];

        if (channel === undefined)
        {
            throw new Error(`Route "${key}" has no entry in ROUTE_CHANNELS. Classify it before mounting it.`);
        }

        return [key, channel === 'always'
            ? route
            : { ...route, middlewares: [channelGate(channel), ...route.middlewares ?? []] }];
    })) as TRoutes;
}

/** The gate for one route: the channel check, then the rest of the route. */
function channelGate(channel: Exclude<RouteChannel, 'always'>): NamedMiddleware<'authChannel'>
{
    const check = typeof channel === 'string'
        ? async () => requireChannel(channel)
        : purposeCheck(channel);

    const handler: MiddlewareHandler = async (c, next) =>
    {
        await check(c);
        await next();
    };

    return { name: 'authChannel', _name: 'authChannel', handler };
}

/**
 * The check for a verification code: the channel of the `purpose` in the body.
 *
 * Read off the JSON body, which Hono caches, so the rate limit and the route's
 * own validation still see it. A body that is not JSON, or names no purpose
 * this table lists, passes: validation refuses the first, and the second is a
 * purpose that belongs to no channel.
 */
function purposeCheck(purposes: PurposeChannels): (c: Context) => Promise<void>
{
    return async (c) =>
    {
        const purpose = await readPurpose(c);

        if (purpose !== undefined && Object.hasOwn(purposes, purpose))
        {
            requireChannel(purposes[purpose as VerificationPurpose]!);
        }
    };
}

async function readPurpose(c: Context): Promise<string | undefined>
{
    try
    {
        const body: unknown = await c.req.json();
        const purpose = body && typeof body === 'object' ? (body as { purpose?: unknown }).purpose : undefined;

        return typeof purpose === 'string' ? purpose : undefined;
    }
    catch
    {
        return undefined;
    }
}
