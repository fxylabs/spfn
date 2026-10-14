/**
 * The ops surface's error is the command surface's own: one class, so
 * `instanceof OpsRouterError` and `instanceof SurfaceError` agree.
 */
export { SurfaceError as OpsRouterError } from '../surface/error';
