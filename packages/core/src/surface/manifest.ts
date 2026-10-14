/**
 * Surface Manifest
 *
 * The server's self-description of a command surface: every command an app
 * exposes under the surface's namespace, with each command's input schemas as
 * plain JSON Schema. A client fetches this from the running server, so command
 * discovery needs neither the app's source nor a generated artifact on the
 * caller's machine.
 *
 * The router is loaded and walked (the contract collector's approach) rather
 * than parsed from source: route schemas built from imported values resolve,
 * and TypeBox schemas serialize to JSON Schema by construction.
 */

import type { JsonSchema } from '../contract/types';
import type { RouteDef } from '../route/route-builder';
import type { RouteInput } from '../route/route-input';
import type { Router } from '../route/router';
import type { HttpMethod } from '../route/types';
import { SurfaceError } from './error';
import type { SurfaceEffect } from './module';
import { SURFACE_WORDING, type SurfaceWording } from './wording';

/** One explicitly mounted capability module, as a client sees it. */
export interface SurfaceModuleDescriptor
{
    id: string;
    source: string;
    contractVersion: string;
    summary: string;
}

/** One invokable command, as a client sees it. */
export interface SurfaceCommand
{
    name: string;
    method: HttpMethod;
    path: string;

    /** Present for commands contributed by an explicitly mounted module. */
    module?: string;

    /**
     * A module command's from its declaration; an app command's from the
     * route's `.summary()` and `.effect()`, present only when declared.
     */
    summary?: string;
    effect?: SurfaceEffect;

    /** Present for module commands only. */
    scopes?: string[];

    /** Input sections the route declares, each as JSON Schema. */
    input: {
        params?: JsonSchema;
        query?: JsonSchema;
        body?: JsonSchema;
    };
}

/** What `GET <namespace>/_manifest` answers. */
export interface SurfaceManifest
{
    manifestVersion: 1;
    /** Additive module metadata. Omitted for an app-only v1 surface. */
    modules?: SurfaceModuleDescriptor[];
    commands: SurfaceCommand[];
}

function isRouter(value: unknown): value is Router<any>
{
    return value !== null
        && typeof value === 'object'
        && 'routes' in value
        && '_routes' in value;
}

function isRouteDef(value: unknown): value is RouteDef<any>
{
    return value !== null
        && typeof value === 'object'
        && 'handler' in value;
}

/**
 * Strip TypeBox's symbol-keyed metadata and hand back plain JSON — the same
 * round trip the contract collector uses.
 */
function toJsonSchema(schema: unknown): JsonSchema
{
    return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

const INPUT_SECTIONS = ['params', 'query', 'body'] as const;

function toCommandInput(input: RouteInput | undefined): SurfaceCommand['input']
{
    const sections: SurfaceCommand['input'] = {};

    if (!input)
    {
        return sections;
    }

    for (const section of INPUT_SECTIONS)
    {
        const schema = input[section];
        if (schema)
        {
            sections[section] = toJsonSchema(schema);
        }
    }

    return sections;
}

/**
 * Walk a routes record (nested routers included) and collect every RouteDef
 * as a command, with the summary and effect its route declared. Validation of
 * paths and of that metadata happens in the surface's `router()`, so nothing
 * here is checked but the uniqueness of names.
 */
export function collectSurfaceCommands(
    routes: Record<string, RouteDef<any> | Router<any>>,
    wording: SurfaceWording = SURFACE_WORDING,
): SurfaceCommand[]
{
    const commands: SurfaceCommand[] = [];
    visit(routes, commands, new Map<string, string>(), wording);
    commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return commands;
}

function visit(
    routes: Record<string, RouteDef<any> | Router<any>>,
    commands: SurfaceCommand[],
    claimed: Map<string, string>,
    wording: SurfaceWording,
): void
{
    for (const [name, entry] of Object.entries(routes))
    {
        if (isRouter(entry))
        {
            visit(entry.routes, commands, claimed, wording);
            continue;
        }

        if (!isRouteDef(entry) || !entry.method || !entry.path)
        {
            continue;
        }

        assertUnclaimedName(name, entry.path, claimed, wording);

        commands.push({
            name,
            method: entry.method,
            path: entry.path,
            ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
            ...(entry.effect !== undefined ? { effect: entry.effect } : {}),
            input: toCommandInput(entry.input as RouteInput | undefined),
        });
    }
}

/**
 * Nested routers flatten into one command list, so two routes keyed alike in
 * different routers would both be announced under the same command name. The
 * client resolves a name to the first match, which means a caller asking for
 * one command silently invokes the other — refuse it at definition time.
 */
function assertUnclaimedName(
    name: string,
    path: string,
    claimed: Map<string, string>,
    wording: SurfaceWording,
): void
{
    const existing = claimed.get(name);
    if (existing !== undefined)
    {
        throw new SurfaceError(
            `Two ${wording.noun} routes are named "${name}" ("${existing}" and "${path}"). `
            + 'Command names are flattened across nested routers, so each must be unique '
            + 'for a client to resolve the one its caller asked for.',
        );
    }

    claimed.set(name, path);
}
