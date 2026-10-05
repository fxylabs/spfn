// ============================================================================
// Client Error
// ============================================================================

/**
 * Typed client error
 *
 * `errorType` tells apart why a call failed:
 * - `'http'`: the server answered with a non-2xx status
 * - `'network'`: the fetch or the body read failed (status 0)
 * - `'timeout'`: the call's timeout elapsed before response headers arrived (status 408)
 * - `'aborted'`: the caller's own signal aborted the call (status 0); `cause` is the signal's reason
 */
export class ApiError extends Error
{
    constructor(
        message: string,
        public readonly status: number,
        public readonly url: string,
        public readonly response?: unknown,
        public readonly errorType?: 'http' | 'network' | 'timeout' | 'aborted',
        options?: { cause?: unknown },
    )
    {
        super(message, options);
        this.name = 'ApiError';
    }
}
