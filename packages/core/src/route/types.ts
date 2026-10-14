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
