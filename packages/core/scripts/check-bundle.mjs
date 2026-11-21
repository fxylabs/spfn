/**
 * Identity probes on the built entries, run by scripts/check-bundle-identity.mjs at the
 * repository root after the build. A class reached through two entries must be one class:
 * the text check finds a module emitted twice, these show what a caller would see.
 */

import { requireOwner } from '@spfn/core/authz';
import { HttpError, NotFoundError } from '@spfn/core/errors';
import { OpsRouterError } from '@spfn/core/ops';
import { SurfaceError } from '@spfn/core/surface';

const failures = [];

const thrown = (() =>
{
    try
    {
        requireOwner(null, 'owner');
    }
    catch (error)
    {
        return error;
    }
})();

if (!(thrown instanceof NotFoundError) || !(thrown instanceof HttpError))
{
    failures.push('requireOwner throws a NotFoundError that is not instanceof the one from @spfn/core/errors');
}

if (OpsRouterError !== SurfaceError)
{
    failures.push('OpsRouterError from @spfn/core/ops is not SurfaceError from @spfn/core/surface');
}

if (failures.length > 0)
{
    console.error(`Identity probes failed:\n${failures.map(failure => `  - ${failure}`).join('\n')}`);
    process.exit(1);
}

console.log('Identity probes passed: requireOwner throws @spfn/core/errors\' NotFoundError; OpsRouterError is SurfaceError.');
