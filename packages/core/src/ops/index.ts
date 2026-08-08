/**
 * @spfn/core/ops - CLI-first operations surface
 *
 * Structure only: the app develops its ops as routes, `createOpsRouter` makes
 * them a mountable, always-authenticated package router with a manifest, and
 * the `spfn ops` CLI discovers and invokes them over HTTP. Token storage and
 * verification live in `@spfn/auth` (`opsTokenAuth`, `requireOpsScope`).
 */

export {
    createOpsRouter,
    OPS_PATH_PREFIX,
    OPS_MANIFEST_PATH,
    type OpsRouterOptions,
} from './create-ops-router';

export {
    opsRoute,
    OPS_PATH_ROOT,
} from './ops-route';

export {
    collectOpsCommands,
    OpsRouterError,
    type OpsCommand,
    type OpsManifest,
} from './manifest';
