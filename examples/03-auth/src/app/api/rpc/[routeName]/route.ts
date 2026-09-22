/**
 * SPFN RPC Proxy Route (with auth)
 *
 * The `@spfn/auth/nextjs/api` import is a side-effect: it self-registers the auth
 * interceptor that reads the session cookie, signs outbound RPC JWTs, and manages keys.
 * It MUST be imported before the proxy is created — without it, every protected call 401s.
 *
 * The generated routeMap already holds the /_auth/* routes: it carries the routes of every
 * package router the app router mounts with `.packages()`, and this app mounts `authRouter`.
 * `eventRouteMap` is merged by hand because it is a hand-written constant rather than a
 * mounted router — nothing generates it.
 */

import '@spfn/auth/nextjs/api';
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { eventRouteMap } from '@spfn/core/event';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({
    routeMap: { ...routeMap, ...eventRouteMap },
});
