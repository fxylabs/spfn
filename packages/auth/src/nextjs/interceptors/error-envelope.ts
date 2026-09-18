/**
 * The body a proxy-minted refusal carries.
 *
 * Exactly the shape a backend refusal has: `__type` and `message` at the top
 * level, plus the `{ code, message, requestId }` envelope `ErrorHandler` attaches
 * beside them. That is what makes an interceptor's 401 arrive at the app as the
 * error class it names — `handleErrorResponse` restores a class only when the
 * body has `__type` and `authErrorRegistry` knows it — so `err instanceof
 * SessionRenewalRequiredError` reads the same whether the refusal came from here
 * or from a route.
 *
 * `interceptors/csrf.ts` mints a refusal that is *not* this shape. It predates
 * this helper and its 403 carries a deliberately uninformative `{ error, message }`
 * body; it is not the precedent to follow, and it is named here so that the
 * difference reads as a decision rather than as drift.
 */

import type { ProxyAbort } from '@spfn/core/nextjs/server';
import type { HttpError } from '@spfn/core/errors';

/**
 * Serialize a registered error as the refusal an interceptor aborts with.
 *
 * @param error - an error class listed in `authErrorRegistry`; anything else
 *   reaches the client as a bare `ApiError`, which is the thing this avoids
 * @param setCookies - cookies to put on the refusal itself. A refusal skips the
 *   backend and every response interceptor, so this is the only chance to touch
 *   the browser's jar — and leaving it empty is how a refusal keeps the cookies
 *   the caller already had.
 */
export function refusalEnvelope(error: HttpError, setCookies: ProxyAbort['setCookies'] = []): ProxyAbort
{
    const body = error.toJSON() as { __type: string; message: string };

    return {
        status: error.statusCode,
        body: {
            ...body,
            error: {
                code: body.__type,
                message: body.message,
                requestId: mintRequestId(),
            },
        },
        setCookies,
    };
}

/**
 * A request id for a response no request logger ever saw.
 *
 * The backend's own envelope carries the id `RequestLogger` set, or mints one for
 * that response alone when there is none. A refusal minted here never reached the
 * backend, so there is nothing to correlate with and the same fallback applies —
 * 16 random bytes as hex, so a person reading one out to support is reading the
 * same shape of value either way.
 */
function mintRequestId(): string
{
    const bytes = crypto.getRandomValues(new Uint8Array(16));

    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
