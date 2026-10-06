/**
 * SSE endpoint paths
 *
 * `createServer` registers the token endpoint beside the stream, and the
 * contract publishes both paths to clients compiled separately from the
 * server. Both read them from here so the path a client is told about and the
 * path the server serves cannot drift apart.
 */

/** The stream path `.events()` registers when it is given none. */
export const DEFAULT_SSE_STREAM_PATH = '/events/stream';

/** The token path beside a stream: its last segment replaced, `/events/stream` → `/events/token`. */
export function sseTokenPath(streamPath: string): string
{
    return streamPath.replace(/\/[^/]+$/, '/token');
}
