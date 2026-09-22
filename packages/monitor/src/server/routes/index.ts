/**
 * @spfn/monitor - Main Router
 *
 * Combines all monitor-related routes into a single router
 */

import { defineRouter } from '@spfn/core/route';
import {
    listErrors,
    getErrorDetail,
    updateErrorStatus,
    listErrorEvents,
    listLogs,
    getStats,
} from './admin';

/**
 * Monitor router
 *
 * Routes:
 * - Errors: /_monitor/admin/errors (list, detail, status update, events)
 * - Logs: /_monitor/admin/logs
 * - Stats: /_monitor/admin/stats
 *
 * `defineRouter`, because a client addresses these routes by name: `monitorApi`
 * is `createApi<typeof monitorRouter>`, and every dashboard component calls
 * through it (`monitorApi.getStats.call({})`). The name is resolved in the app's
 * route map, which carries the routes of every package router the app mounts
 * with `.packages()` — so `defineRouter` is what puts these there, and what
 * makes an app route of the same name (`getStats`) a collision the app's build
 * refuses instead of a call that silently reaches the app's route.
 */
export const monitorRouter = defineRouter({
    listErrors,
    getErrorDetail,
    updateErrorStatus,
    listErrorEvents,
    listLogs,
    getStats,
});

export default monitorRouter;
