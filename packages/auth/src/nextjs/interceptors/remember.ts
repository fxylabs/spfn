/**
 * "Keep me signed in": taken once, on the request that starts a sign-in
 *
 * `remember` says whether the session is kept, never for how long — both
 * lifetimes are the operator's (`SPFN_AUTH_SESSION_TTL`,
 * `SPFN_AUTH_SESSION_TTL_REMEMBER`). It belongs to the sign-in being completed,
 * so it is read where that sign-in starts and nowhere else. A sign-in that
 * completes on a later request — a second factor, a social callback, a device
 * approval — carries it in its own sealed pending cookie; the completing request
 * cannot add it or change it.
 */

import type { RequestInterceptorContext } from '@spfn/core/nextjs/server';
import { ValidationError } from '@spfn/core/errors';

import { refusalEnvelope } from './error-envelope';

/**
 * Take `remember` off a starting request's body.
 *
 * A boolean is the choice; absent is `false`. Anything else — a string such as
 * `'3650d'` used to set the lifetime itself — is refused with 400 before any key
 * is minted or the backend is called, and `null` is answered.
 *
 * @returns the choice, or `null` when the request was refused (`ctx.abort` set)
 */
export function takeRemember(ctx: RequestInterceptorContext): boolean | null
{
    const remember = ctx.body?.remember;

    if (remember !== undefined && typeof remember !== 'boolean')
    {
        ctx.abort = refusalEnvelope(new ValidationError({ message: 'remember must be a boolean' }));

        return null;
    }

    // Not part of any backend contract: the proxy decides the lifetime from it
    if (ctx.body)
    {
        delete ctx.body.remember;
    }

    return remember === true;
}

/** The session field a kept choice seals: `{ remember: true }`, or nothing. */
export function rememberField(remember: unknown): { remember?: true }
{
    return remember === true ? { remember: true } : {};
}
