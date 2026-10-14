/**
 * @spfn/core/surface - command surfaces
 *
 * A namespace of authenticated commands an app exposes to a machine caller,
 * with a manifest a client discovers them from. `@spfn/core/ops` is the
 * surface on `/_ops`; an app mounts others beside it on namespaces of its own.
 * Credentials live in `@spfn/auth` (`opsTokenAuth`, `signedTokenAuth`); the
 * client is `spfn/surface`.
 */

export {
    defineSurface,
    type Surface,
    type SurfaceAuthorize,
    type SurfaceOptions,
} from './define-surface';

export { SurfaceError } from './error';

export {
    collectSurfaceCommands,
    type SurfaceCommand,
    type SurfaceManifest,
    type SurfaceModuleDescriptor,
} from './manifest';

export {
    defineSurfaceModule,
    type SurfaceEffect,
    type SurfaceModule,
    type SurfaceModuleCommand,
} from './module';

export type { SurfaceRouteBuilder } from './namespace';
