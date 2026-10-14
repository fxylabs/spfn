/**
 * Ops Route Builder
 *
 * `route` with the ops namespace already applied. An ops route lives under
 * `/_ops/` without exception, so the prefix is the helper's business rather
 * than something every definition retypes and the factory then checks:
 *
 * ```ts
 * const countExamples = opsRoute.get('/examples/count')   // GET /_ops/examples/count
 *     .handler(async () => ({ count: await repo.countAll() }));
 * ```
 *
 * Everything after the prefix belongs to the app. What the paths look like,
 * how they nest, which segments are parameters — those are the app author's
 * decisions, made when the ops route is written.
 *
 * The builder returned is an ordinary `RouteBuilder`, so `.use()`, `.input()`
 * and `.handler()` work exactly as they do elsewhere. It is the `/_ops`
 * surface's `route` (`@spfn/core/surface`).
 */

import { surfaceRouteBuilder } from '../surface/namespace';
import { OPS_WORDING } from './wording';

/** The ops namespace, without the trailing slash. */
export const OPS_PATH_ROOT = '/_ops';

/**
 * Ops route builder entry point — `route`, namespaced under `/_ops`.
 *
 * @example
 * ```ts
 * const listRecent = opsRoute.get('/examples')
 *     .use([requireOpsScope('example:read')])
 *     .input({ query: Type.Object({ limit: Type.Optional(Type.Number()) }) })
 *     .handler(async (c) => ({ items: await repo.findAll((await c.data()).query.limit ?? 10, 0) }));
 * ```
 */
export const opsRoute = surfaceRouteBuilder(OPS_PATH_ROOT, OPS_WORDING);
