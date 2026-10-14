/**
 * Capability ops module contract
 *
 * A package describes commands here, but an adopter application decides
 * whether to mount the resulting module. Definition-time validation keeps an
 * installed package from becoming an ops surface merely by existing, and
 * gives `createOpsRouter` enough metadata to enforce scopes and describe the
 * module to the CLI from one declaration.
 *
 * The contract is the command surface's (`@spfn/core/surface`);
 * `defineOpsModule` is its validator fixed to the `/_ops` namespace.
 */

import {
    validateSurfaceModule,
    type SurfaceEffect,
    type SurfaceModule,
    type SurfaceModuleCommand,
} from '../surface/module';
import type { RouteDef } from '../route/route-builder';
import { OPS_PATH_ROOT } from './ops-route';
import { OPS_WORDING } from './wording';

export type OpsEffect = SurfaceEffect;

export type OpsModuleCommand<TRoute extends RouteDef<any> = RouteDef<any>> = SurfaceModuleCommand<TRoute>;

export type OpsModule<
    TCommands extends Record<string, OpsModuleCommand<any>> = Record<string, OpsModuleCommand<any>>,
> = SurfaceModule<TCommands>;

/**
 * Validate and return a capability ops module — every command under
 * `/_ops/<id>/`.
 *
 * This function intentionally does not register anything. Only an adopter's
 * explicit `createOpsRouter({ modules: [...] })` composition exposes it.
 */
export function defineOpsModule<
    TCommands extends Record<string, OpsModuleCommand<any>>,
>(module: OpsModule<TCommands>): OpsModule<TCommands>
{
    return validateSurfaceModule(module, OPS_PATH_ROOT, OPS_WORDING);
}
