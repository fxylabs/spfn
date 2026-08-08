/**
 * Application Router
 *
 * `defineRouter` composes route definitions into one router. Its type is the
 * single source of truth the typed client is generated from.
 *
 * Run `pnpm codegen` to (re)generate src/generated/route-map.ts after changing routes.
 */

import { defineRouter } from '@spfn/core/route';
import { getGreeting } from './routes/greeting';

// One route. `GET /health` is not here on purpose: the server serves it itself,
// and an app route on that path would be shadowed by it.
export const appRouter = defineRouter({
    getGreeting,
});

export type AppRouter = typeof appRouter;
