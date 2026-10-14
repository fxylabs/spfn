/**
 * Thrown when a namespace, route, or module cannot be part of a command
 * surface. `@spfn/core/ops` exports the same class as `OpsRouterError`.
 */
export class SurfaceError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'SurfaceError';
    }
}
