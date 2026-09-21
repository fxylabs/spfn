/**
 * @spfn/monitor - Main Router
 *
 * Combines all monitor-related routes into a single router
 */

import { defineUnmappedRouter } from '@spfn/core/route';
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
 * `defineUnmappedRouter`, not `defineRouter`: this package publishes no route
 * map — it has no codegen config and exports none — so an app that mounts it
 * with `.packages()` merges nothing over its own map, and an app route sharing
 * a name with one of these (`getStats`) loses nothing to it.
 */
export const monitorRouter = defineUnmappedRouter({
    listErrors,
    getErrorDetail,
    updateErrorStatus,
    listErrorEvents,
    listLogs,
    getStats,
});

export default monitorRouter;
