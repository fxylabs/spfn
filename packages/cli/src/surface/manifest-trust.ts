/**
 * Manifest trust
 *
 * The manifest is the app's own description of itself, and the client turns
 * it into requests carrying a credential. So it is read as untrusted input:
 * every command is checked against the surface's namespace before it can
 * become a request, and what cannot be used is dropped with a warning rather
 * than costing the caller every other command on the surface.
 *
 * Warnings go to the caller's sink with a structured description beside the
 * message, so a CLI can word them in its own terms; nothing here writes to a
 * terminal.
 */

import { unstablePathBecause } from './command-path.js';
import { plain } from './plain.js';
import type { SurfaceCommandDescriptor, SurfaceManifest, SurfaceModuleDescriptor } from './types.js';

/**
 * What the client dropped from a manifest, and why. A `metadata` warning says
 * whose rules refused it: a module command's, or an app command's own
 * `effect` and `summary`.
 */
export type SurfaceWarning =
    | { kind: 'command'; reason: string }
    | { kind: 'metadata'; command: string; metadata?: 'module' | 'command'; reason: string }
    | { kind: 'modules'; reason: string }
    | { kind: 'module'; reason: string };

export type SurfaceWarningSink = (message: string, warning: SurfaceWarning) => void;

/** The surface a manifest is read for, and where its warnings go. */
export interface ManifestReader
{
    namespace: string;
    prefix: string;
    warn: SurfaceWarningSink;
}

/**
 * Check a manifest answer's shape and keep what the client can use. Throws
 * when the answer is not a version-1 manifest at all.
 */
export function trustedManifest(body: unknown, reader: ManifestReader): SurfaceManifest
{
    const manifest = body as SurfaceManifest;
    if (manifest?.manifestVersion !== 1 || !Array.isArray(manifest.commands))
    {
        throw new Error('The manifest answer has an unknown shape.');
    }

    const modules = usableModules(manifest.modules, reader);

    return {
        manifestVersion: 1,
        ...(manifest.modules !== undefined ? { modules } : {}),
        commands: usableCommands(manifest.commands, new Set(modules.map(module => module.id)), reader),
    };
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const EFFECTS = new Set(['read', 'write', 'destructive']);
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTRACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const MAX_ID_LENGTH = 64;
const MAX_SOURCE_LENGTH = 128;
const MAX_SUMMARY_LENGTH = 500;
const MAX_SCOPES = 64;
const MAX_SCOPE_LENGTH = 128;

/**
 * Why a command cannot be used, or null when it can.
 *
 * The manifest is the app's own description of itself, and the CLI turns it
 * into a request carrying a credential — so a command is checked before it can
 * become one, rather than trusted and allowed to fail as a stack trace deep in
 * `fetch`. The path rule is the server's own: `defineSurface` refuses a route
 * outside its namespace, so anything else here did not come from it.
 */
function unusableBecause(command: SurfaceCommandDescriptor, reader: ManifestReader): string | null
{
    if (typeof command?.name !== 'string' || command.name.length === 0)
    {
        return 'it has no name';
    }
    if (typeof command.method !== 'string' || !METHODS.has(command.method))
    {
        return `its method is ${JSON.stringify(command.method)}`;
    }
    if (typeof command.path !== 'string')
    {
        return `its path ${JSON.stringify(command.path)} is not a string`;
    }
    const pathReason = unstablePathBecause(command.path, reader.prefix);
    if (pathReason !== null)
    {
        return `its path ${JSON.stringify(command.path)} ${pathReason}`;
    }

    return null;
}

/**
 * Keep the commands the CLI can invoke and say which it dropped.
 *
 * Dropping rather than refusing the whole manifest: a newer server may announce
 * something this CLI has no way to call, and one such command must not cost the
 * operator every other command on the surface. Silence would be worse than
 * either — an operator would read a short list as the app's whole surface.
 */
function usableCommands(
    commands: SurfaceCommandDescriptor[],
    moduleIds: ReadonlySet<string>,
    reader: ManifestReader,
): SurfaceCommandDescriptor[]
{
    const usable: SurfaceCommandDescriptor[] = [];

    for (const command of commands)
    {
        const reason = unusableBecause(command, reader);

        if (reason !== null)
        {
            reader.warn(
                `Ignoring a command the ${reader.namespace} manifest announced: ${reason}.`,
                { kind: 'command', reason },
            );
            continue;
        }

        usable.push(withMetadata(command, moduleIds, reader));
    }

    return usable;
}

/**
 * The command as the client keeps it: its wire fields, and its metadata when
 * that metadata passes the rules for its kind.
 *
 * A command naming a module or scopes is read as a module command; one
 * carrying only `effect` or `summary` as an app's own command, which declares
 * them on its route. Refused metadata is dropped whole, and the command still
 * lists — hiding it would read as an app with a smaller surface than it has.
 * But its effect came from the same metadata just refused, so it is no longer
 * known, and `destructive` is what it may have been. Confirmation is required
 * rather than inferred from a field that is now absent.
 */
function withMetadata(
    command: SurfaceCommandDescriptor,
    moduleIds: ReadonlySet<string>,
    reader: ManifestReader,
): SurfaceCommandDescriptor
{
    const normalized: SurfaceCommandDescriptor = {
        name: command.name,
        method: command.method,
        path: command.path,
        input: isPlainObject(command.input) ? command.input : {},
    };

    if (command.module !== undefined || command.scopes !== undefined)
    {
        return withModuleMetadata(normalized, command, moduleIds, reader);
    }

    return withAppMetadata(normalized, command, reader);
}

function withModuleMetadata(
    normalized: SurfaceCommandDescriptor,
    command: SurfaceCommandDescriptor,
    moduleIds: ReadonlySet<string>,
    reader: ManifestReader,
): SurfaceCommandDescriptor
{
    const reason = unusableModuleMetadataBecause(command, moduleIds, reader);

    if (reason !== null)
    {
        return rejectedMetadata(normalized, 'module', reason, reader);
    }

    return {
        ...normalized,
        module: command.module,
        summary: command.summary,
        effect: command.effect,
        scopes: [...command.scopes!],
    };
}

function withAppMetadata(
    normalized: SurfaceCommandDescriptor,
    command: SurfaceCommandDescriptor,
    reader: ManifestReader,
): SurfaceCommandDescriptor
{
    const reason = unusableAppMetadataBecause(command);

    if (reason !== null)
    {
        return rejectedMetadata(normalized, 'command', reason, reader);
    }

    return {
        ...normalized,
        ...(command.summary !== undefined ? { summary: command.summary } : {}),
        ...(command.effect !== undefined ? { effect: command.effect } : {}),
    };
}

function rejectedMetadata(
    normalized: SurfaceCommandDescriptor,
    metadata: 'module' | 'command',
    reason: string,
    reader: ManifestReader,
): SurfaceCommandDescriptor
{
    reader.warn(
        `Ignoring ${metadata} metadata for command "${plain(normalized.name)}": ${reason}. `
        + 'Its effect is unknown, so treat it as destructive.',
        { kind: 'metadata', command: normalized.name, metadata, reason },
    );

    return { ...normalized, metadataRejected: true };
}

/**
 * Why an app command's own metadata cannot be used, or null when it can. Both
 * fields are optional — an app command on `/_ops` may declare neither — but
 * one that is present is held to the limits a module command's is.
 */
function unusableAppMetadataBecause(command: SurfaceCommandDescriptor): string | null
{
    if (command.summary !== undefined && !isUsableSummary(command.summary))
    {
        return 'its summary is empty or too long';
    }
    if (command.effect !== undefined && !EFFECTS.has(command.effect))
    {
        return 'its effect is unknown';
    }

    return null;
}

function isUsableSummary(summary: unknown): boolean
{
    return typeof summary === 'string' && summary.length > 0 && summary.length <= MAX_SUMMARY_LENGTH;
}

function unusableModuleMetadataBecause(
    command: SurfaceCommandDescriptor,
    moduleIds: ReadonlySet<string>,
    reader: ManifestReader,
): string | null
{
    if (typeof command.module !== 'string' || !moduleIds.has(command.module))
    {
        return 'it names no usable module';
    }
    if (!command.name.startsWith(`${command.module}.`))
    {
        return 'its qualified name does not start with the module id';
    }
    if (!command.path.startsWith(`${reader.prefix}${command.module}/`))
    {
        return 'its path is outside the module namespace';
    }
    if (!isUsableSummary(command.summary))
    {
        return 'its summary is missing or too long';
    }
    if (typeof command.effect !== 'string' || !EFFECTS.has(command.effect))
    {
        return 'its effect is unknown';
    }
    if (!Array.isArray(command.scopes) || command.scopes.length === 0
        || command.scopes.length > MAX_SCOPES
        || command.scopes.some(scope => typeof scope !== 'string'
            || scope.length === 0 || scope.length > MAX_SCOPE_LENGTH))
    {
        return 'its scopes are missing or invalid';
    }

    return null;
}

function usableModules(value: unknown, reader: ManifestReader): SurfaceModuleDescriptor[]
{
    if (value === undefined)
    {
        return [];
    }
    if (!Array.isArray(value))
    {
        reader.warn('Ignoring module metadata: modules is not an array.', {
            kind: 'modules',
            reason: 'modules is not an array',
        });

        return [];
    }

    const modules: SurfaceModuleDescriptor[] = [];
    const claimed = new Set<string>();

    for (const raw of value)
    {
        const reason = unusableModuleBecause(raw, claimed);
        if (reason !== null)
        {
            reader.warn(
                `Ignoring a module the ${reader.namespace} manifest announced: ${reason}.`,
                { kind: 'module', reason },
            );
            continue;
        }

        const module = raw as SurfaceModuleDescriptor;
        claimed.add(module.id);
        modules.push({
            id: module.id,
            source: module.source,
            contractVersion: module.contractVersion,
            summary: module.summary,
        });
    }

    return modules;
}

function unusableModuleBecause(value: unknown, claimed: ReadonlySet<string>): string | null
{
    if (!isPlainObject(value))
    {
        return 'it is not an object';
    }

    const id = value.id;
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !MODULE_ID.test(id))
    {
        return 'its id is invalid';
    }
    if (claimed.has(id))
    {
        return `id "${id}" is duplicated`;
    }
    if (typeof value.source !== 'string' || value.source.length === 0
        || value.source.length > MAX_SOURCE_LENGTH)
    {
        return `module "${id}" has an invalid source`;
    }
    if (typeof value.contractVersion !== 'string' || !CONTRACT_VERSION.test(value.contractVersion))
    {
        return `module "${id}" has an invalid contract version`;
    }
    if (typeof value.summary !== 'string' || value.summary.length === 0
        || value.summary.length > MAX_SUMMARY_LENGTH)
    {
        return `module "${id}" has an invalid summary`;
    }

    return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown>
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
