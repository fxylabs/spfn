/**
 * Capability module contract
 *
 * A package describes commands here, but an adopter application decides
 * whether to mount the resulting module, and on which surface. Validation
 * keeps an installed package from becoming a command surface merely by
 * existing, and gives the surface enough metadata to enforce scopes and
 * describe the module to a client from one declaration.
 *
 * A module's paths are written for one namespace — `/_ops/<id>/...` for an
 * ops module — so it is validated against the namespace of the surface that
 * mounts it. A module written for `/_ops` mounted on `/_app` is refused rather
 * than registered at paths outside the surface that is supposed to guard them.
 */

import type { RouteDef } from '../route/route-builder';
import { SurfaceError } from './error';
import { routePatternsOverlap } from './route-overlap';
import { capitalized, SURFACE_WORDING, type SurfaceWording } from './wording';

export type SurfaceEffect = 'read' | 'write' | 'destructive';

export interface SurfaceModuleCommand<TRoute extends RouteDef<any> = RouteDef<any>>
{
    summary: string;
    effect: SurfaceEffect;
    scopes: readonly string[];
    route: TRoute;
}

export interface SurfaceModule<
    TCommands extends Record<string, SurfaceModuleCommand<any>> = Record<string, SurfaceModuleCommand<any>>,
>
{
    id: string;
    source: string;
    contractVersion: string;
    summary: string;
    commands: TCommands;
}

const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COMMAND_NAME = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
const CONTRACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const EFFECTS = new Set<SurfaceEffect>(['read', 'write', 'destructive']);
const PATH_BASE = 'https://spfn.invalid';

function assertText(label: string, value: unknown): asserts value is string
{
    if (typeof value !== 'string' || value.trim().length === 0)
    {
        throw new SurfaceError(`${label} must be a non-empty string.`);
    }
}

/** Where a module is being mounted, and what its refusals call it. */
interface MountPoint
{
    namespace: string;
    label: string;
}

function assertStableModulePath(at: MountPoint, moduleId: string, commandName: string, path: string): void
{
    const label = `${at.label} command "${moduleId}.${commandName}" path "${path}"`;
    // Hono path patterns use braces for regex parameters and a trailing `?`
    // for optional ones. Escape those route-language characters before asking
    // WHATWG URL normalization whether the transport-level path moves.
    const transportPath = path.replace(/[{}?#]/g, character =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    let url: URL;
    try
    {
        url = new URL(transportPath, PATH_BASE);
    }
    catch
    {
        throw new SurfaceError(`${label} is not a valid URL path.`);
    }

    if (url.origin !== PATH_BASE || url.search !== '' || url.hash !== '' || url.pathname !== transportPath)
    {
        throw new SurfaceError(`${label} is not a stable plain absolute path.`);
    }

    const slashCount = (path.match(/\//g) ?? []).length;
    let decoded = path;
    for (let depth = 0; depth < 8; depth++)
    {
        let next: string;
        try
        {
            next = decodeURIComponent(decoded);
        }
        catch
        {
            throw new SurfaceError(`${label} contains malformed percent encoding.`);
        }

        if (next.includes('\\') || (next.match(/\//g) ?? []).length !== slashCount
            || next.split('/').some(segment => segment === '.' || segment === '..'))
        {
            throw new SurfaceError(`${label} contains encoded path separators or dot segments.`);
        }
        if (next === decoded)
        {
            return;
        }
        decoded = next;
    }

    throw new SurfaceError(`${label} uses too many percent-encoding layers.`);
}

function assertCliCallableModulePath(at: MountPoint, moduleId: string, commandName: string, path: string): void
{
    const unsupported = path.split('/').slice(1).find(segment =>
        segment === '*'
        || segment.includes('*')
        || (segment.startsWith(':')
            ? !/^:[A-Za-z0-9_]+$/.test(segment)
            : !/^[A-Za-z0-9._~-]+$/.test(segment)));

    if (unsupported !== undefined)
    {
        throw new SurfaceError(
            `${at.label} command "${moduleId}.${commandName}" path segment "${unsupported}" is not CLI-callable. `
            + 'Module routes support URL-safe static segments and simple :name parameters only; '
            + 'optional, wildcard, and custom-regex parameters are not supported.',
        );
    }
}

function assertCommand(at: MountPoint, moduleId: string, name: string, command: SurfaceModuleCommand<any>): void
{
    if (!COMMAND_NAME.test(name))
    {
        throw new SurfaceError(
            `${at.label} module "${moduleId}" has invalid command name "${name}". `
            + 'Use dot-separated alphanumeric names.',
        );
    }

    assertText(`${at.label} command "${moduleId}.${name}" summary`, command?.summary);

    if (!EFFECTS.has(command?.effect))
    {
        throw new SurfaceError(
            `${at.label} command "${moduleId}.${name}" has invalid effect ${JSON.stringify(command?.effect)}.`,
        );
    }

    if (!Array.isArray(command?.scopes) || command.scopes.length === 0
        || command.scopes.some(scope => typeof scope !== 'string' || scope.trim().length === 0))
    {
        throw new SurfaceError(`${at.label} command "${moduleId}.${name}" must declare at least one non-empty scope.`);
    }

    const route = command?.route;
    if (!route || typeof route.handler !== 'function' || !route.method || !route.path)
    {
        throw new SurfaceError(`${at.label} command "${moduleId}.${name}" must carry a complete route.`);
    }

    assertStableModulePath(at, moduleId, name, route.path);
    assertCliCallableModulePath(at, moduleId, name, route.path);

    const modulePath = `${at.namespace}/${moduleId}/`;
    if (!route.path.startsWith(modulePath))
    {
        throw new SurfaceError(
            `${at.label} command "${moduleId}.${name}" is at "${route.path}", outside "${modulePath}". `
            + `A module mounted on "${at.namespace}" keeps every command under "${modulePath}".`,
        );
    }
    if (route.path.split('/').includes('..'))
    {
        throw new SurfaceError(`${at.label} command "${moduleId}.${name}" path climbs out of its module namespace.`);
    }
}

/**
 * Validate a capability module against the namespace it is mounted on.
 *
 * This function intentionally does not register anything. Only an adopter's
 * explicit `modules: [...]` composition exposes the module, and the surface
 * calls this for each one when its router is built.
 */
export function validateSurfaceModule<
    TCommands extends Record<string, SurfaceModuleCommand<any>>,
>(
    module: SurfaceModule<TCommands>,
    namespace: string,
    wording: SurfaceWording = SURFACE_WORDING,
): SurfaceModule<TCommands>
{
    const at: MountPoint = { namespace, label: capitalized(wording.noun) };

    if (!MODULE_ID.test(module?.id ?? ''))
    {
        throw new SurfaceError(
            `${at.label} module id ${JSON.stringify(module?.id)} is invalid. Use lower-kebab-case.`,
        );
    }

    assertText(`${at.label} module "${module.id}" source`, module.source);
    assertText(`${at.label} module "${module.id}" summary`, module.summary);

    if (!CONTRACT_VERSION.test(module.contractVersion))
    {
        throw new SurfaceError(
            `${at.label} module "${module.id}" contractVersion must be a semantic version.`,
        );
    }

    if (!module.commands || typeof module.commands !== 'object' || Array.isArray(module.commands))
    {
        throw new SurfaceError(`${at.label} module "${module.id}" commands must be an object.`);
    }

    const signatures = new Map<string, string>();
    const claimedRoutes: Array<{ name: string; method: string; path: string }> = [];
    for (const [name, command] of Object.entries(module.commands))
    {
        assertCommand(at, module.id, name, command);

        const signature = `${command.route.method} ${command.route.path}`;
        const existing = signatures.get(signature);
        if (existing)
        {
            throw new SurfaceError(
                `${at.label} module "${module.id}" commands "${existing}" and "${name}" both use ${signature}.`,
            );
        }
        signatures.set(signature, name);

        const overlapping = claimedRoutes.find(claim =>
            claim.method === command.route.method
            && routePatternsOverlap(claim.path, command.route.path!));
        if (overlapping)
        {
            throw new SurfaceError(
                `${at.label} module "${module.id}" commands "${overlapping.name}" and "${name}" `
                + `have overlapping ${command.route.method} routes `
                + `("${overlapping.path}" and "${command.route.path}").`,
            );
        }
        claimedRoutes.push({
            name,
            method: command.route.method!,
            path: command.route.path!,
        });
    }

    return module;
}

/**
 * Validate and return a capability module written for a surface on
 * `namespace` — every command under `<namespace>/<id>/`. The surface checks
 * it again against its own namespace when it mounts it, so a module defined
 * for one namespace and mounted on another is still refused.
 */
export function defineSurfaceModule<
    TCommands extends Record<string, SurfaceModuleCommand<any>>,
>(module: SurfaceModule<TCommands>, namespace: string): SurfaceModule<TCommands>
{
    return validateSurfaceModule(module, namespace);
}
