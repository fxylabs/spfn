/**
 * spfn/surface - a client for an app's command surfaces
 *
 * Lists and calls the commands a `defineSurface` (`@spfn/core/surface`)
 * serves, on any namespace — `spfn ops` is this client on `/_ops`. Library
 * code: it prints nothing, and never imports the CLI's terminal stack.
 */

export {
    createSurfaceClient,
    joinUrl,
    SurfaceManifestError,
    type SurfaceClient,
    type SurfaceClientOptions,
} from './client.js';

export { buildCommandPath } from './command-path.js';

export { renderCommandUsage } from './describe.js';

export type { SurfaceWarning, SurfaceWarningSink } from './manifest-trust.js';

export { plain } from './plain.js';

export { assertTransportSafe, isLoopback, transportRefusalOf, type TransportRefusal } from './transport.js';

export type {
    SurfaceCallInput,
    SurfaceCommandDescriptor,
    SurfaceEffect,
    SurfaceManifest,
    SurfaceModuleDescriptor,
    SurfaceResponse,
} from './types.js';
