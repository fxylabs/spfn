/**
 * Ops Manifest
 *
 * The ops surface's self-description: every command an app exposes under
 * `/_ops`, with each command's input schemas as plain JSON Schema. The
 * `spfn ops` CLI fetches it from the running server. The collector and the
 * shapes are the command surface's (`@spfn/core/surface`); these are their
 * ops names, kept so existing imports read as they always did.
 */

import type { RouteDef } from '../route/route-builder';
import type { Router } from '../route/router';
import {
    collectSurfaceCommands,
    type SurfaceCommand,
    type SurfaceManifest,
    type SurfaceModuleDescriptor,
} from '../surface/manifest';
import { OPS_WORDING } from './wording';
export { OpsRouterError } from './error';

/** One explicitly mounted capability module, as the CLI sees it. */
export type OpsModuleDescriptor = SurfaceModuleDescriptor;

/** One invokable ops command, as the CLI sees it. */
export type OpsCommand = SurfaceCommand;

/** What `GET /_ops/_manifest` answers. */
export type OpsManifest = SurfaceManifest;

/**
 * Walk a routes record (nested routers included) and collect every RouteDef
 * as an ops command. Validation of paths and names happens in
 * `createOpsRouter` before this runs.
 */
export function collectOpsCommands(
    routes: Record<string, RouteDef<any> | Router<any>>,
): OpsCommand[]
{
    return collectSurfaceCommands(routes, OPS_WORDING);
}
