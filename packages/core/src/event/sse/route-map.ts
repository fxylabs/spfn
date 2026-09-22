/**
 * SSE Event Route Map
 *
 * Static route map for SSE token endpoint.
 * Merge into RPC proxy routeMap so `eventsToken` resolves to `POST /events/token`.
 *
 * @example
 * ```typescript
 * // app/api/rpc/[routeName]/route.ts
 * import { createRpcProxy } from '@spfn/core/nextjs/server';
 * import { eventRouteMap } from '@spfn/core/event';
 * import { routeMap } from '@/generated/route-map';
 *
 * export const { GET, POST } = createRpcProxy({
 *     routeMap: { ...routeMap, ...eventRouteMap },
 * });
 * ```
 */
export const eventRouteMap = {
    eventsToken: { method: 'POST' as const, path: '/events/token' },
};
