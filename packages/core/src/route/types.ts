/**
 * Route Type Definitions
 */

/**
 * Supported HTTP methods for route definitions
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What invoking a route does, as a machine caller reads it before deciding to
 * call, retry, or ask for confirmation: `read` changes nothing, `write`
 * changes state, `destructive` changes it in a way that cannot be undone.
 */
export type RouteEffect = 'read' | 'write' | 'destructive';

/**
 * What a route declares about CSRF, as the Next.js RPC proxy reads it from the
 * generated route map: `required` is a route that changes state on the strength
 * of a cookie session, and must carry the CSRF header whatever mode the
 * application's CSRF check runs in.
 */
export type RouteCsrf = 'required';
