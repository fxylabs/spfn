/**
 * Second-Factor Verify Interceptor (#95)
 *
 * The proxy half of new-device step-up. A sign-in on an enrolled account from a
 * device it has never seen answers 202 with a challenge and no session; this
 * rule holds the browser's half of that flow until `POST /_auth/mfa/verify`
 * succeeds, and then seals the session the 202 did not.
 *
 * **Response phase only, and a separate rule on purpose.**
 * `loginRegisterInterceptor`'s request phase mints a fresh ES256 pair and injects
 * it into every body it matches, which is exactly what `verify` must not get —
 * the key being activated already exists, and a second one would be a device
 * nobody asked for. Its response phase already returns early on any non-200, so
 * the 202 passes through it untouched and nothing in that file changes.
 *
 * The pending cookie is its own name and its own audience, separate from
 * `OAUTH_PENDING`. The two coexist: a person who starts a social login in one tab
 * while a step-up is outstanding in another has both live, and one name would
 * mean the second overwrote the first — sealing a session with a private key
 * that does not match the key the verification activated.
 *
 * And the binding is checked before anything is sealed. The cookie names the
 * challenge and the key it was baked for, the verified response names both back,
 * and a session is sealed only when the two agree. Without that comparison the
 * proxy would seal whatever private key it happened to be holding around
 * whatever key the backend activated.
 */

import type { InterceptorRule, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import type { HttpError } from '@spfn/core/errors';
import { SessionPendingExpiredError, SessionPendingMismatchError } from '@spfn/auth/errors';

import { hashCredential } from '../../server/lib/link-credentials';
import { sealSession } from '../../server/lib/session';
import { COOKIE_NAMES, getSessionTtl } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import {
    sealPendingMfaSession,
    unsealPendingMfaSession,
    unsealPendingSession,
    type PendingSessionData,
} from '../session-helpers';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';
import { refusalBody } from './error-envelope';
import { bindingSessionFields } from './session-binding';

/**
 * The four paths that can answer 202, plus the one that resolves it.
 *
 * `oauth/{provider}/native` is on the list for completeness rather than for the
 * cookie: a native client holds its own key and never reaches this proxy. When
 * it does come through one there is no pending key to seal, and the rule leaves
 * the 202 alone.
 */
const MFA_PATH_PATTERN =
    /^\/_auth\/(login|password\/reset\/complete|oauth\/[\w-]+\/native|oauth\/finalize|mfa\/verify)$/;

/** How long the pending cookie lives — the challenge's own ten minutes. */
const PENDING_TTL_SECONDS = 600;

/**
 * The challenge secret out of a 202 body, whichever of the two shapes it is in.
 *
 * A sign-in answers `LoginResult`, whose `challenge` is `{ secret,
 * expiresAtMillis }`. `oauth/finalize` echoes back the string the callback query
 * carried, because the page is handing over a value it was given and the route
 * has no row to read an expiry from.
 */
function challengeSecretOf(body: unknown): string | undefined
{
    const challenge = (body as { challenge?: unknown } | null)?.challenge;

    if (typeof challenge === 'string')
    {
        return challenge;
    }

    const secret = (challenge as { secret?: unknown } | undefined)?.secret;

    return typeof secret === 'string' ? secret : undefined;
}

/**
 * The device key this browser is holding, whichever flow produced it.
 *
 * A password sign-in or a password reset ran through `loginRegisterInterceptor`
 * a moment ago, so the pair it minted is in shared metadata, under the `new`
 * names that rule reserves for the credentials it is installing (#99). The OAuth
 * page flow has no such request phase — its key was minted at
 * `oauth/{provider}/url` and sealed into `OAUTH_PENDING` — so that cookie is the
 * fallback.
 */
async function pendingKeyFor(ctx: ResponseInterceptorContext): Promise<PendingSessionData | null>
{
    if (ctx.metadata.newPrivateKey && ctx.metadata.newKeyId)
    {
        return {
            privateKey: ctx.metadata.newPrivateKey,
            keyId: ctx.metadata.newKeyId,
            algorithm: ctx.metadata.newAlgorithm,
        };
    }

    const oauthPending = ctx.cookies.get(COOKIE_NAMES.OAUTH_PENDING);

    return oauthPending ? await unsealPendingSession(oauthPending) : null;
}

/**
 * Hold the browser's half of a 202 until the second factor is proved.
 *
 * Nothing is sealed and nothing is cleared: the person is mid-sign-in, and the
 * session they had before — if they had one — is still theirs. The OAuth pending
 * cookie is left in place too, since the page flow may still be reading it.
 */
async function bakePendingCookie(ctx: ResponseInterceptorContext): Promise<void>
{
    const secret = challengeSecretOf(ctx.response.body);
    const pending = secret ? await pendingKeyFor(ctx) : null;

    if (!secret || !pending)
    {
        return;
    }

    ctx.setCookies.push({
        name: COOKIE_NAMES.MFA_PENDING,
        value: await sealPendingMfaSession({ ...pending, challengeHash: hashCredential(secret) }, PENDING_TTL_SECONDS),
        options: {
            httpOnly: true,
            secure: cookieSecure,
            sameSite: 'lax',
            maxAge: PENDING_TTL_SECONDS,
            path: '/',
        },
    });

    authLogger.interceptor.login.debug('Second-factor pending cookie set', { keyId: pending.keyId });
}

/**
 * Replace the backend's answer with a refusal this browser can act on.
 *
 * The verification really did succeed and the key really is active — what failed
 * is this browser's claim to be the one that started the sign-in. The refusal
 * carries the registered envelope, so an app reads it as the error class it
 * names rather than as an anonymous 401.
 *
 * The pending cookie is deliberately not cleared. Only one of them can exist at
 * a time, so a mismatch may well mean it belongs to a second flow that is still
 * live in another tab, and expiring it here would break that one too. It goes on
 * its own after ten minutes.
 */
function refuse(ctx: ResponseInterceptorContext, error: HttpError): void
{
    authLogger.interceptor.login.warn('Second-factor session not sealed', { reason: error.name });

    ctx.response.ok = false;
    ctx.response.status = error.statusCode;
    ctx.response.statusText = 'Unauthorized';
    ctx.response.body = refusalBody(error);
}

/**
 * Turn a verified challenge into the session the 202 withheld.
 *
 * Both halves of the binding are checked, and both matter. `challengeHash` says
 * this cookie was baked for this challenge; `keyId` says the key the backend
 * activated is the key whose private half this cookie holds. A session sealed
 * with a mismatched pair authenticates nothing — `authenticate` verifies the
 * signature against the stored public key — so the account would simply look
 * broken until the person signed in again.
 */
async function sealVerifiedSession(ctx: ResponseInterceptorContext): Promise<void>
{
    const cookie = ctx.cookies.get(COOKIE_NAMES.MFA_PENDING);

    if (!cookie)
    {
        refuse(ctx, new SessionPendingExpiredError());

        return;
    }

    const pending = await unsealPendingMfaSession(cookie);
    const { userId, keyId, challengeHash } = ctx.response.body || {};

    if (pending.challengeHash !== challengeHash || pending.keyId !== keyId)
    {
        refuse(ctx, new SessionPendingMismatchError());

        return;
    }

    const ttl = getSessionTtl();
    const sealed = await sealSession({
        userId,
        privateKey: pending.privateKey,
        keyId: pending.keyId,
        algorithm: pending.algorithm,
        ...bindingSessionFields(ctx.response.body, ctx.request.headers['user-agent']),
    }, ttl);

    pushSessionCookies(ctx, sealed, pending.keyId, ttl);
    await pushCsrfCookie(ctx.setCookies, pending.keyId, ttl);
}

/** The session trio, plus the expiry of the pending cookie they replace. */
function pushSessionCookies(ctx: ResponseInterceptorContext, sealed: string, keyId: string, ttl: number): void
{
    const options = { httpOnly: true, secure: cookieSecure, sameSite: 'lax' as const, path: '/' };

    ctx.setCookies.push({ name: COOKIE_NAMES.SESSION, value: sealed, options: { ...options, maxAge: ttl } });
    ctx.setCookies.push({ name: COOKIE_NAMES.SESSION_KEY_ID, value: keyId, options: { ...options, maxAge: ttl } });
    ctx.setCookies.push({ name: COOKIE_NAMES.MFA_PENDING, value: '', options: { ...options, maxAge: 0 } });
}

/**
 * Second-Factor Verify Interceptor
 *
 * Response: bakes the pending cookie on a 202, and seals the session on a
 * verified challenge. Registered after `loginRegisterInterceptor`, whose 202
 * pass-through is what leaves the body for this rule to read.
 */
export const mfaVerifyInterceptor: InterceptorRule = {
    pathPattern: MFA_PATH_PATTERN,
    method: 'POST',

    response: async (ctx, next) =>
    {
        try
        {
            if (ctx.response.status === 202)
            {
                await bakePendingCookie(ctx);
            }
            else if (ctx.response.status === 200 && ctx.path === '/_auth/mfa/verify')
            {
                await sealVerifiedSession(ctx);
            }
        }
        catch (error)
        {
            // An unreadable or expired pending cookie lands here, and so does a
            // sealing failure. Both mean the same thing to the person in front of
            // the browser — the window closed — and the key is active either way,
            // so signing in again is the whole remedy.
            authLogger.interceptor.login.error('Second-factor session handling failed', error as Error);

            if (ctx.path === '/_auth/mfa/verify')
            {
                refuse(ctx, new SessionPendingExpiredError());
            }
        }

        await next();
    },
};
