/**
 * Device Login Interceptor (#143)
 *
 * The proxy half of a browser being the *new* device of device link, and the
 * waiting device of device-code login. Both flows park a public key with one
 * public call and hand out the login only on a later poll (`device/link/poll`,
 * `device/poll`), once someone signed in elsewhere has said yes. A mobile SDK or
 * a CLI holds its own key between the two and parks it on `device/link/redeem`
 * or `device/start`, which this rule leaves alone; behind this proxy the browser
 * cannot, because the proxy owns the key. So the browser parks on the `/web`
 * twins of those routes, and this rule mints the pair there, holds the private
 * half in a pending cookie until the approval, and seals the session then.
 *
 * **A separate rule on purpose.** `loginRegisterInterceptor` seals on the very
 * response its request phase injected a key into; here the key is injected on
 * one request and the session sealed on another, minutes later, so the private
 * half has to survive in between — which is the pending cookie `mfaVerify` keeps
 * and `loginRegister` does not. And the bodies differ: the parking routes are
 * bounded, so this rule sends exactly the fields they declare and no `keySize`.
 *
 * The pending cookie is its own name and its own audience, separate from the
 * second-factor and OAuth pending cookies, for their reason: flows coexist in
 * one browser, and one name would mean the second overwrote the first.
 *
 * And the binding is checked before anything is sealed. The cookie names the
 * device code its key was parked for, the poll names the device code it is
 * asking about, and a session is sealed only when the two agree. Without that
 * comparison a browser polling a code it never redeemed — one read off another
 * person's screen — would be handed a session around whatever key it happened to
 * be holding, for a device the account owner approved somewhere else.
 */

import type { InterceptorRule, RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';
import type { HttpError } from '@spfn/core/errors';
import { SessionPendingExpiredError, SessionPendingMismatchError } from '@spfn/auth/errors';

import { generateKeyPair } from '../../server/lib/crypto';
import { hashCredential } from '../../server/lib/link-credentials';
import { sealSession } from '../../server/lib/session';
import { COOKIE_NAMES, getSessionTtl } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { sealPendingDeviceSession, unsealPendingDeviceSession, type PendingDeviceSessionData } from '../session-helpers';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';
import { refusalBody } from './error-envelope';
import { bindingSessionFields } from './session-binding';

/**
 * The two browser calls that park a key: device link's and device-code login's.
 * Only the `/web` routes — the mobile ones carry the caller's own key, and a
 * proxy in front of a mobile or CLI caller must pass that key through.
 */
const KEY_ISSUING_PATHS = new Set(['/_auth/device/link/redeem/web', '/_auth/device/start/web']);

/** The two polls whose approved answer is the login. */
const COMPLETING_PATHS = new Set(['/_auth/device/link/poll', '/_auth/device/poll']);

const DEVICE_PATH_PATTERN = /^\/_auth\/device\/(start\/web|poll|link\/redeem\/web|link\/poll)$/;

/**
 * Put the proxy's key into a parking call's body, and keep its private half.
 *
 * Whatever key material the page sent is overwritten: the proxy can seal a
 * session only around a private key it holds, so a client-made key would park a
 * device this browser could never sign in as. The metadata names are this rule's
 * own — `generalAuthInterceptor` writes `keyId` on every request it signs, and
 * sharing that name is how #99 sealed one key around another's id.
 */
function injectKey(ctx: RequestInterceptorContext): void
{
    const keyPair = generateKeyPair('ES256');

    ctx.body = {
        ...ctx.body,
        publicKey: keyPair.publicKey,
        keyId: keyPair.keyId,
        fingerprint: keyPair.fingerprint,
        algorithm: keyPair.algorithm,
        platform: 'web',
    };

    ctx.metadata.devicePendingPrivateKey = keyPair.privateKey;
    ctx.metadata.devicePendingKeyId = keyPair.keyId;
    ctx.metadata.devicePendingAlgorithm = keyPair.algorithm;
}

/**
 * Remember which device code a poll is asking about, by its hash.
 *
 * Read here because the approved answer is a `LoginResult` and names neither the
 * code nor the key. A missing or non-string code leaves nothing to compare, and
 * the response phase answers that as a mismatch.
 */
function rememberPolledCode(ctx: RequestInterceptorContext): void
{
    const deviceCode = (ctx.body as { deviceCode?: unknown } | undefined)?.deviceCode;

    ctx.metadata.devicePollCodeHash = typeof deviceCode === 'string' && deviceCode
        ? hashCredential(deviceCode)
        : undefined;
}

/** Seconds from now until `expiresAtMillis`, never less than one. */
function secondsUntil(expiresAtMillis: number): number
{
    return Math.max(1, Math.ceil((expiresAtMillis - Date.now()) / 1000));
}

/**
 * Hold the parked key until the poll that collects it.
 *
 * Only on a 200: a refused redeem parked nothing, and a pending cookie from an
 * earlier redeem that did succeed must survive it. The cookie lives exactly as
 * long as the device code does, since nothing can be collected after that.
 */
async function bakePendingCookie(ctx: ResponseInterceptorContext): Promise<void>
{
    const { deviceCode, expiresAtMillis } = (ctx.response.body ?? {}) as { deviceCode?: unknown; expiresAtMillis?: unknown };

    if (typeof deviceCode !== 'string' || typeof expiresAtMillis !== 'number' || !ctx.metadata.devicePendingKeyId)
    {
        return;
    }

    const ttl = secondsUntil(expiresAtMillis);
    const sealed = await sealPendingDeviceSession({
        privateKey: ctx.metadata.devicePendingPrivateKey,
        keyId: ctx.metadata.devicePendingKeyId,
        algorithm: ctx.metadata.devicePendingAlgorithm,
        deviceCodeHash: hashCredential(deviceCode),
    }, ttl);

    ctx.setCookies.push({
        name: COOKIE_NAMES.DEVICE_PENDING,
        value: sealed,
        options: { httpOnly: true, secure: cookieSecure, sameSite: 'lax', maxAge: ttl, path: '/' },
    });

    authLogger.interceptor.login.debug('Device pending cookie set', { keyId: ctx.metadata.devicePendingKeyId });
}

/**
 * Replace the backend's answer with a refusal this browser can act on.
 *
 * The approval really did happen and the key really is registered — what failed
 * is this browser's claim to be the one that parked it, so the device stays on
 * the account until its owner removes it. The pending cookie is not cleared: a
 * mismatch may mean it belongs to a flow still live in another tab, and it goes
 * on its own when its device code does.
 */
function refuse(ctx: ResponseInterceptorContext, error: HttpError): void
{
    authLogger.interceptor.login.warn('Device session not sealed', { reason: error.name });

    ctx.response.ok = false;
    ctx.response.status = error.statusCode;
    ctx.response.statusText = 'Unauthorized';
    ctx.response.body = refusalBody(error);
}

/**
 * Turn an approved poll into the session the parking call could not give.
 *
 * Sealed only when the pending cookie was parked for the very device code this
 * poll asked about; an absent cookie is an expired flow, never a licence to seal
 * whatever key some other request phase made.
 */
async function sealApprovedSession(ctx: ResponseInterceptorContext): Promise<void>
{
    const cookie = ctx.cookies.get(COOKIE_NAMES.DEVICE_PENDING);

    if (!cookie)
    {
        refuse(ctx, new SessionPendingExpiredError());

        return;
    }

    const pending = await unsealPendingDeviceSession(cookie);

    if (!ctx.metadata.devicePollCodeHash || pending.deviceCodeHash !== ctx.metadata.devicePollCodeHash)
    {
        refuse(ctx, new SessionPendingMismatchError());

        return;
    }

    ctx.setCookies.push(...await sessionCookies(ctx, pending));

    authLogger.interceptor.login.debug('Device session sealed', { keyId: pending.keyId });
}

/**
 * The session trio, plus the expiry of the pending cookie they replace — built
 * whole before any of it is queued.
 *
 * A throw while building (the CSRF derivation, the seal) then leaves nothing
 * behind: the catch answers a refusal, and a refusal that still carried a
 * session cookie would sign the browser in under a 401.
 */
async function sessionCookies(ctx: ResponseInterceptorContext, pending: PendingDeviceSessionData): Promise<SetCookie[]>
{
    const ttl = getSessionTtl();
    const options = { httpOnly: true, secure: cookieSecure, sameSite: 'lax' as const, path: '/' };
    const sealed = await sealSession({
        userId: ctx.response.body.userId,
        privateKey: pending.privateKey,
        keyId: pending.keyId,
        algorithm: pending.algorithm,
        ...bindingSessionFields(ctx.response.body, ctx.request.headers['user-agent']),
    }, ttl);
    const cookies: SetCookie[] = [
        { name: COOKIE_NAMES.SESSION, value: sealed, options: { ...options, maxAge: ttl } },
        { name: COOKIE_NAMES.SESSION_KEY_ID, value: pending.keyId, options: { ...options, maxAge: ttl } },
        { name: COOKIE_NAMES.DEVICE_PENDING, value: '', options: { ...options, maxAge: 0 } },
    ];

    await pushCsrfCookie(cookies, pending.keyId, ttl);

    return cookies;
}

/** Whether a poll's 200 is the login rather than "keep waiting". */
function isApproved(body: unknown): boolean
{
    return (body as { status?: unknown } | null)?.status === 'approved';
}

/**
 * Device Login Interceptor
 *
 * Request: on a parking call, injects the proxy's key; on a poll, hashes the
 * device code it asks about.
 * Response: bakes the pending cookie on a parked key, and seals the session on
 * an approved poll whose code the cookie was baked for. Registered among the
 * sign-in rules, ahead of `generalAuthInterceptor` — which skips these paths as
 * public, so nothing it writes lands over the session sealed here.
 */
export const deviceLoginInterceptor: InterceptorRule = {
    pathPattern: DEVICE_PATH_PATTERN,
    method: 'POST',

    request: async (ctx, next) =>
    {
        if (KEY_ISSUING_PATHS.has(ctx.path))
        {
            injectKey(ctx);
        }
        else if (COMPLETING_PATHS.has(ctx.path))
        {
            rememberPolledCode(ctx);
        }

        await next();
    },

    response: async (ctx, next) =>
    {
        try
        {
            if (ctx.response.status === 200 && KEY_ISSUING_PATHS.has(ctx.path))
            {
                await bakePendingCookie(ctx);
            }
            else if (ctx.response.status === 200 && COMPLETING_PATHS.has(ctx.path) && isApproved(ctx.response.body))
            {
                await sealApprovedSession(ctx);
            }
        }
        catch (error)
        {
            // An unreadable or expired pending cookie lands here, and so does a
            // sealing failure. On a poll both mean the window closed — the device
            // is registered either way, so signing in again is the remedy. On a
            // parking call the backend's answer stands; the poll will find no
            // cookie and say so.
            authLogger.interceptor.login.error('Device session handling failed', error as Error);

            if (COMPLETING_PATHS.has(ctx.path))
            {
                refuse(ctx, new SessionPendingExpiredError());
            }
        }

        await next();
    },
};
