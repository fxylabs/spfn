/**
 * HTTP client for an app's ops surface
 *
 * The surface client (`spfn/surface`) on `/_ops`, worded for `spfn ops`: the
 * warnings it raises are printed here in the CLI's own terms, and a refused
 * manifest request names the flags and variables an operator can fix it with.
 */

import { createSurfaceClient, SurfaceManifestError, type SurfaceClient } from '../../surface/client.js';
import { buildCommandPath as buildSurfaceCommandPath, unstablePathBecause } from '../../surface/command-path.js';
import type { SurfaceWarning } from '../../surface/manifest-trust.js';
import { plain } from '../../surface/plain.js';
import type {
    SurfaceCallInput,
    SurfaceCommandDescriptor,
    SurfaceEffect,
    SurfaceManifest,
    SurfaceModuleDescriptor,
    SurfaceResponse,
} from '../../surface/types.js';

export { joinUrl } from '../../surface/client.js';

export type OpsEffect = SurfaceEffect;
export type OpsModuleDescriptor = SurfaceModuleDescriptor;
export type OpsCommandDescriptor = SurfaceCommandDescriptor;
export type OpsManifest = SurfaceManifest;
export type OpsCallInput = SurfaceCallInput;
export type OpsResponse = SurfaceResponse;

const OPS_NAMESPACE = '/_ops';

/** What the surface client dropped, as `spfn ops` has always said it. */
function printOpsWarning(_message: string, warning: SurfaceWarning): void
{
    switch (warning.kind)
    {
        case 'command':
            console.error(`⚠️  Ignoring an ops command the manifest announced: ${warning.reason}.`);
            break;
        case 'metadata':
            console.error(
                `⚠️  Ignoring module metadata for ops command "${plain(warning.command)}": ${warning.reason}. `
                + 'Calling it will require --yes.',
            );
            break;
        case 'modules':
            console.error(`⚠️  Ignoring ops module metadata: ${warning.reason}.`);
            break;
        case 'module':
            console.error(`⚠️  Ignoring an ops module the manifest announced: ${warning.reason}.`);
            break;
    }
}

function opsClient(appUrl: string, token: string): SurfaceClient
{
    return createSurfaceClient({ appUrl, namespace: OPS_NAMESPACE, token, onWarning: printOpsWarning });
}

/** A refused manifest request, in the terms an operator can act on. */
function inOpsTerms(error: unknown): unknown
{
    if (!(error instanceof SurfaceManifestError))
    {
        return error;
    }
    if (error.status === 401 || error.status === 403)
    {
        return new Error('The app refused the ops token (check --token / SPFN_OPS_TOKEN / keychain).');
    }
    if (error.status === 404)
    {
        return new Error('No ops surface at this app (GET /_ops/_manifest answered 404). '
            + 'Mount one with createOpsRouter() and .packages([opsRouter]).');
    }

    return error;
}

export async function fetchOpsManifest(appUrl: string, token: string): Promise<OpsManifest>
{
    return await opsClient(appUrl, token).manifest()
        .catch((error: unknown) => Promise.reject(inOpsTerms(error)));
}

/**
 * Refuse a path template outside `/_ops/` in the words `spfn ops` has always
 * used. Checked ahead of the surface client, which refuses the same template
 * in neutral words.
 */
function assertOpsCommandPath(command: OpsCommandDescriptor): void
{
    const templateReason = unstablePathBecause(command.path, `${OPS_NAMESPACE}/`);
    if (templateReason !== null)
    {
        throw new Error(`Refusing ops command path ${JSON.stringify(command.path)} because it ${templateReason}.`);
    }
}

/**
 * Substitute `:name` segments from params and append the query — the surface
 * client's path builder on `/_ops`.
 */
export function buildCommandPath(
    command: OpsCommandDescriptor,
    params: Record<string, string>,
    query: Record<string, string>,
): string
{
    assertOpsCommandPath(command);

    return buildSurfaceCommandPath(command, params, query, OPS_NAMESPACE);
}

export async function invokeOpsCommand(
    appUrl: string,
    token: string,
    command: OpsCommandDescriptor,
    input: OpsCallInput,
): Promise<OpsResponse>
{
    assertOpsCommandPath(command);

    return await opsClient(appUrl, token).invoke(command, input);
}
