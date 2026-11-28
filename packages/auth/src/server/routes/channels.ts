/**
 * @spfn/auth - Which channel each route belongs to
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
import {
    isEnrolmentGate,
    restrictedRouteMarker,
    SESSION_REQUIREMENTS,
    type RestrictedRouteAdmission,
    type SessionRequirement,
} from '../lib/enrolment-routes';
import { requireMethod, type SecondFactorFeature, type SecondFactorMethod } from '../lib/second-factor-policy';
import { KEY_REACH, type KeyReach } from '../types';
import type { VerificationPurpose } from './schema';

/** A verification code belongs to the channel its `purpose` serves; other purposes are always on. */
type PurposeChannels = Partial<Record<VerificationPurpose, AuthChannel>>;

export type RouteChannel = AuthChannel | 'always' | PurposeChannels;

const CODE_PURPOSES: PurposeChannels = { registration: 'signup' };

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
    passkeyLoginOptions: 'passkeyLogin',
    passkeyLoginVerify: 'passkeyLogin',
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
    getAuthChannels: 'always',
    setSessionBinding: 'always',
    getSessionBinding: 'always',
    sessionBindingDisableOptions: 'always',
    passkeyProofOptions: 'always',
    sessionRenewOptions: 'always',
    sessionRenewVerify: 'always',
    issueOneTimeToken: 'always',
    requestAccountDeletion: 'selfDeletion',
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
    getInvitation: 'invitations',
    acceptInvitation: 'invitations',
    createInvitation: 'invitations',
    listInvitations: 'invitations',
    cancelInvitation: 'invitations',
    resendInvitation: 'invitations',
    deleteInvitation: 'invitations',
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

/**
 * Which routes a restricted session reaches: one column per requirement an
 * account can be held to (`SESSION_REQUIREMENTS`).
 *
 * The second classification beside `ROUTE_CHANNELS`, and kept to the same
 * guarantee: every key of `mainAuthRouter` is here with every column, the type
 * says so at compile time and `markEnrolmentRoutes` refuses an unclassified
 * route or column at import. A route added later and left out would otherwise
 * be one the global `authenticate` has no answer for.
 *
 * A session held to several requirements reaches a route when **any one** of
 * them admits it (`admitPrincipal`): requiring all would leave an account that
 * must both change its password and enrol a second factor no route at all,
 * since the change is not an enrolment route and no enrolment route changes
 * the password.
 *
 * `secondFactorEnrolment` — an enrolment-only session (`secondFactor.required`):
 *
 * - a method — an enrolment route while that method is listed
 * - `'always'` — an enrolment route under every policy
 * - `'none'` — not one: an enrolment-only session is refused it with 403
 *   `SECOND_FACTOR_ENROLMENT_REQUIRED`
 * - `'unchecked'` — admitted: the route is authenticated by a middleware of
 *   its own that does not hold a session to enrolment, so the global check
 *   never runs there. Session renewal is the one: it hands a bound key its
 *   successor, and that key is held to enrolment on its next request.
 */
export type RouteEnrolment = SecondFactorMethod | 'always' | 'none' | 'unchecked';

/**
 * `passwordChange` — an account that must change its password
 * (`passwordChangeRequired`, #362):
 *
 * - `'admit'` — the route leads to the change: the change itself, the step-up
 *   it may ask for, the session read, sign-out, and the two sign-in
 *   completions that hand such an account its session (`oauthFinalize`,
 *   `mfaVerify`)
 * - `'refuse'` — an account that must change its password is refused with 403
 *   `PASSWORD_CHANGE_REQUIRED`
 * - `'unchecked'` — as for enrolment: session renewal, whose own middleware
 *   holds no session to a requirement; the renewed key is held to it on its
 *   next request
 */
export type RoutePasswordChange = 'admit' | 'refuse' | 'unchecked';

interface RequirementClasses
{
    secondFactorEnrolment: RouteEnrolment;
    passwordChange: RoutePasswordChange;
}

/** A route's row: its class under each requirement, exhaustive by `SessionRequirement`. */
export type RouteRequirementClasses = { [R in SessionRequirement]: RequirementClasses[R] };

export const ROUTE_ENROLMENT = {
    sendVerificationCode: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    verifyCode: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    register: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    requestSignupLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    confirmSignupLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    completeSignup: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    requestPasswordReset: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    confirmPasswordReset: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    completePasswordReset: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    login: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    startDeviceAuth: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    startDeviceAuthWeb: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    pollDeviceAuth: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getDeviceAuthInfo: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    approveDeviceAuth: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    denyDeviceAuth: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    issueDeviceLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    redeemDeviceLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    redeemDeviceLinkWeb: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getDeviceLinkStatus: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    confirmDeviceLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    denyDeviceLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    cancelDeviceLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    pollDeviceLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    passkeyRegisterOptions: { secondFactorEnrolment: 'passkey', passwordChange: 'refuse' },
    passkeyRegisterVerify: { secondFactorEnrolment: 'passkey', passwordChange: 'refuse' },
    passkeyLoginOptions: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    passkeyLoginVerify: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listPasskeys: { secondFactorEnrolment: 'passkey', passwordChange: 'refuse' },
    renamePasskey: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    revokePasskey: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    mfaTotpEnroll: { secondFactorEnrolment: 'totp', passwordChange: 'refuse' },
    mfaTotpConfirm: { secondFactorEnrolment: 'totp', passwordChange: 'refuse' },
    mfaDisable: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    mfaMarkPasskey: { secondFactorEnrolment: 'passkey', passwordChange: 'refuse' },
    mfaRegenerateRecoveryCodes: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    mfaStatus: { secondFactorEnrolment: 'always', passwordChange: 'admit' },
    mfaStepUp: { secondFactorEnrolment: 'always', passwordChange: 'admit' },
    mfaStepUpOptions: { secondFactorEnrolment: 'always', passwordChange: 'admit' },
    mfaVerify: { secondFactorEnrolment: 'none', passwordChange: 'admit' },
    mfaVerifyOptions: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    logout: { secondFactorEnrolment: 'always', passwordChange: 'admit' },
    rotateKey: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listKeys: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    revokeKey: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    revokeAllKeys: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    confirmRevokeAllLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    consumeRevokeAllLink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    changePassword: { secondFactorEnrolment: 'none', passwordChange: 'admit' },
    getAuthSession: { secondFactorEnrolment: 'always', passwordChange: 'admit' },
    getAuthChannels: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    setSessionBinding: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    // enrollPasskey reads it to learn whether the registration needs a
    // passkeyAdd proof; a read about the caller's own session (#400).
    getSessionBinding: { secondFactorEnrolment: 'passkey', passwordChange: 'refuse' },
    sessionBindingDisableOptions: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    passkeyProofOptions: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    sessionRenewOptions: { secondFactorEnrolment: 'unchecked', passwordChange: 'unchecked' },
    sessionRenewVerify: { secondFactorEnrolment: 'unchecked', passwordChange: 'unchecked' },
    issueOneTimeToken: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    requestAccountDeletion: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    cancelAccountDeletion: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthGoogleStart: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthGoogleCallback: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthStart: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthProviders: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getGoogleOAuthUrl: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthFinalize: { secondFactorEnrolment: 'always', passwordChange: 'admit' },
    oauthProviderStart: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthProviderCallback: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthProviderCallbackPost: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getProviderOAuthUrl: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthNative: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthAppleNativeStart: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthUnlinkNotify: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthUnlinkNotifyGet: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthLinkStart: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauthUnlink: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    androidAssetLinks: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getInvitation: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    acceptInvitation: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    createInvitation: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listInvitations: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    cancelInvitation: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    resendInvitation: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    deleteInvitation: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getUserProfile: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    updateUserProfile: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    checkUsername: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    updateUsername: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    updateLocale: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listSettings: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getSetting: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    setSetting: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    resetSetting: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listRoles: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    createAdminRole: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    updateAdminRole: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    deleteAdminRole: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    updateUserRole: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    issueOpsToken: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listOpsTokens: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    revokeOpsToken: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    registerOAuth2Client: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    getOAuth2Authorize: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    createOAuth2AuthorizationCode: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauth2Token: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauth2Revoke: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    listOAuth2Grants: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    revokeOAuth2Grant: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
    oauth2AuthorizationServerMetadata: { secondFactorEnrolment: 'none', passwordChange: 'refuse' },
} as const satisfies Record<keyof typeof ROUTE_CHANNELS, RouteRequirementClasses>;

/**
 * Which routes a key held to each reach (`user_public_keys.reach`) is let in
 * on — and so, a permissive table: a route not named here admits no narrowed
 * key. Every route an application declares is one, and so is every door that
 * produces a principal without the global `authenticate` (`optionalAuth`,
 * `opsOrUser`, a one-time token): none of them carries a marker this table
 * put there.
 *
 * A narrowed key is held to its reach **and** to the account's requirements
 * (`admitPrincipal`): a route here still refuses it while the account must
 * change its password or enrol a second factor, unless `ROUTE_ENROLMENT`
 * admits it under that requirement too, as it does `logout`.
 *
 * `opsTokens` — what a terminal is let in for: issuing, listing and revoking
 * ops tokens, and signing out, which is how it removes its key on every path.
 */
export const ROUTE_REACH = {
    opsTokens: ['issueOpsToken', 'listOpsTokens', 'revokeOpsToken', 'logout'],
} as const satisfies Record<KeyReach, readonly (keyof typeof ROUTE_CHANNELS)[]>;
// Every name is a route: `ROUTE_CHANNELS` holds every key of `mainAuthRouter`,
// and `gateChannels` refuses a route it lacks at import.

/**
 * The second-factor routes of one method, answered 404
 * `SECOND_FACTOR_METHOD_DISABLED` while the policy does not list it.
 *
 * Passkey sign-in registration is not here: a passkey is also a way to sign
 * in, so only the second-factor mark goes with `'passkey'`.
 */
export const ROUTE_SECOND_FACTOR_METHODS = {
    mfaTotpEnroll: 'totp',
    mfaTotpConfirm: 'totp',
    mfaMarkPasskey: 'passkey',
    mfaRegenerateRecoveryCodes: 'recoveryCodes',
} as const satisfies Partial<Record<keyof typeof ROUTE_CHANNELS, SecondFactorFeature>>;

/**
 * The routes with each route a restricted session reaches carrying its marker,
 * which the global `authenticate` looks for in the route chain it runs in
 * (lib/enrolment-routes).
 *
 * A method-gated route is an enrolment route whatever the policy lists: while
 * its method is unlisted its own gate answers the 404, which is the answer
 * that route owes every caller, and a 403 from `authenticate` would hide it.
 *
 * The marker also carries the reaches whose keys the route admits
 * (`ROUTE_REACH`).
 *
 * @throws when a route has no entry in `ROUTE_ENROLMENT`, or no class in one of its columns
 */
export function markEnrolmentRoutes<TRoutes extends Record<string, RouteDef<any, any, any>>>(
    routes: TRoutes,
    classes: Record<keyof TRoutes, RouteRequirementClasses>,
): TRoutes
{
    return Object.fromEntries(Object.entries(routes).map(([key, route]) =>
    {
        const admits = { ...restrictedRouteAdmission(key, classes[key]), ...reachAdmission(key) };

        if (Object.keys(admits).length === 0)
        {
            return [key, route];
        }

        return [key, { ...route, middlewares: withMarker(route.middlewares ?? [], restrictedRouteMarker(admits)) }];
    })) as TRoutes;
}

/**
 * What a route's marker admits, from its row: nothing for a `'none'` or
 * `'refuse'` class, and nothing for an `'unchecked'` one, whose route never
 * runs the global `authenticate`.
 *
 * @throws when the route has no row, or its row no class for a requirement
 */
function restrictedRouteAdmission(key: string, row: RouteRequirementClasses | undefined): RestrictedRouteAdmission
{
    if (row === undefined)
    {
        throw new Error(`Route "${key}" has no entry in ROUTE_ENROLMENT. Classify it before mounting it.`);
    }

    const unclassified = SESSION_REQUIREMENTS.find(requirement => row[requirement] === undefined);

    if (unclassified !== undefined)
    {
        throw new Error(`Route "${key}" has no ${unclassified} class in ROUTE_ENROLMENT. Classify it before mounting it.`);
    }

    const enrolment = row.secondFactorEnrolment;
    const gated = (ROUTE_SECOND_FACTOR_METHODS as Record<string, SecondFactorFeature>)[key] !== undefined;

    return {
        ...enrolment === 'none' || enrolment === 'unchecked'
            ? {}
            : { secondFactorEnrolment: enrolment === 'always' || gated ? null : enrolment },
        ...row.passwordChange === 'admit' ? { passwordChange: true } : {},
    };
}

/** The reaches whose keys a route admits, from `ROUTE_REACH`; nothing for a route it does not name. */
function reachAdmission(key: string): RestrictedRouteAdmission
{
    const reach = KEY_REACH.filter(candidate => (ROUTE_REACH[candidate] as readonly string[]).includes(key));

    return reach.length === 0 ? {} : { reach };
}

type RouteMiddleware = MiddlewareHandler | NamedMiddleware<string>;

/**
 * A route's middlewares with its marker in front — or, for a route that runs a
 * registered gate of its own (`oauthFinalizeAuth`), right after that gate:
 * `restrictedRouteAdmits` searches the chain after the gate that asks.
 */
function withMarker(middlewares: RouteMiddleware[], marker: MiddlewareHandler): RouteMiddleware[]
{
    const gate = middlewares.findIndex(middleware => isEnrolmentGate(typeof middleware === 'function' ? middleware : middleware.handler));

    return [...middlewares.slice(0, gate + 1), marker, ...middlewares.slice(gate + 1)];
}

/**
 * The routes with the second-factor method check first among their own
 * middlewares — after the global `auth`, before the rate limit and the
 * transaction, as the channel gate is.
 */
export function gateSecondFactorMethods<TRoutes extends Record<string, RouteDef<any, any, any>>>(
    routes: TRoutes,
    methods: Partial<Record<keyof TRoutes, SecondFactorFeature>>,
): TRoutes
{
    return Object.fromEntries(Object.entries(routes).map(([key, route]) =>
    {
        const feature: SecondFactorFeature | undefined = methods[key];

        return [key, feature === undefined
            ? route
            : { ...route, middlewares: [methodGate(feature), ...route.middlewares ?? []] }];
    })) as TRoutes;
}

function methodGate(feature: SecondFactorFeature): NamedMiddleware<'authSecondFactorMethod'>
{
    const handler: MiddlewareHandler = async (_c, next) =>
    {
        requireMethod(feature);
        await next();
    };

    return { name: 'authSecondFactorMethod', _name: 'authSecondFactorMethod', handler };
}
