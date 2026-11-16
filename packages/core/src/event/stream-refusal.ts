/**
 * How a stream server refuses a client for good, shared by the WebSocket
 * handler that sends a refusal and both browser clients (`sse/client`,
 * `ws/client`) so they read it the same way
 *
 * Imports nothing, so every module that reads or sends a refusal takes it
 * without a cycle, and a client bundle takes no server code with it.
 */

/**
 * The WebSocket close code (policy violation) a server ends a socket with when
 * reconnecting would only be refused again. A network drop (1006) or a server
 * shutdown (1001) never sends it; the reason says which refusal it is.
 */
export const POLICY_VIOLATION_CLOSE_CODE = 1008;

/** The close reason of a socket whose device key was revoked: the credential is gone. */
export const KEY_REVOKED_CLOSE_REASON = 'Key revoked';

/**
 * The close reason of a socket whose `Origin` is not on the server's
 * allow-list: a deployment misconfiguration, not a credential gone.
 */
export const ORIGIN_NOT_ALLOWED_CLOSE_REASON = 'Origin not allowed';

/**
 * Whether a failed stream token request was answered 401: the session behind
 * it is gone (its key revoked), so no later request will succeed and the
 * client stops. Anything else — a 403 included — is retried after the delay.
 * Both shapes the api client throws carry the status — a registered error
 * class (`UnauthorizedError`) as `statusCode`, the generic `ApiError` as
 * `status`.
 */
export function isTokenRequestUnauthorized(error: unknown): boolean
{
    const answered = error as { statusCode?: unknown; status?: unknown } | null;

    return answered?.statusCode === 401 || answered?.status === 401;
}
