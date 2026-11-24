/**
 * Hono middleware adapter for clientProofV1 — the `requiresSession` guard for
 * SPFN servers that mount contract operations as ordinary routes.
 *
 * Runs the full admission sequence over the raw request bytes and, on
 * acceptance, tags the request `clientType: 'mobile'` (the attestation slot
 * PROXY-BACKEND-AUTH-SPEC reserved) and exposes the parsed canonical body and
 * credentials under the `clientProof` context key.
 *
 * hono is imported as types only — the middleware itself is a plain async
 * function, so this module adds no runtime dependency.
 *
 * @module server/client-proof/guard
 */
import type { Context, MiddlewareHandler, Next } from 'hono';

import { admitClientProofRequest, type ClientProofCredentials } from './admission';
import type { CanonicalValue } from './canonical-json';
import { clientProofRefusalResponse } from './refusal-response';
import type { ClientProofState } from './state';
import { optionKeys, readOptions } from '@spfn/core/options';

/** What the guard leaves in the context for the route handler. */
export interface ClientProofContext
{
    credentials: ClientProofCredentials;

    /** The request body as a canonical value (already byte-verified). */
    value: CanonicalValue;
}

export interface ClientProofGuardOptions
{
    /**
     * The contract path the client signed, when it differs from the mounted
     * path (e.g. behind a stripped ingress prefix). Defaults to the request
     * path.
     */
    contractPath?: string;
}

/**
 * A guard for operations with `requiresSession: true`.
 *
 * Refusals are answered with the contract envelope and never reach the route.
 *
 * @throws Error when `options` is not a plain object or carries a name that
 *   is not an option — a misspelt `contractpath` would otherwise check every
 *   proof against the request path. It is read once, here, by `readOptions`,
 *   not on each request (#477)
 */
export function createClientProofGuard(
    state: ClientProofState,
    options: ClientProofGuardOptions = {},
): MiddlewareHandler
{
    const { contractPath } = readOptions<ClientProofGuardOptions>(
        'createClientProofGuard',
        options,
        optionKeys<ClientProofGuardOptions>({ contractPath: true }),
    );

    return async (c: Context, next: Next) =>
    {
        const body = new Uint8Array(await c.req.arrayBuffer());
        const admission = admitClientProofRequest({
            state,
            headers: c.req.raw.headers,
            method: c.req.method,
            path: contractPath ?? c.req.path,
            requiresSession: true,
            body,
        });
        if (!admission.admitted)
        {
            state.recordRefusal();

            return clientProofRefusalResponse(c, admission.refusal);
        }
        c.set('clientType', 'mobile');
        c.set('clientProof', {
            credentials: admission.credentials,
            value: admission.value,
        } satisfies ClientProofContext);
        await next();

        return undefined;
    };
}
