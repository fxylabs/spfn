/**
 * Ops Manifest
 *
 * The server's self-description of its ops surface: every command an app
 * exposes under `/_ops`, with each command's input schemas as plain JSON
 * Schema. The ops CLI fetches this from the running server, so command
 * discovery needs neither the app's source nor a generated artifact on the
 * operator's machine.
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

/** One invokable ops command, as the CLI sees it. */
export interface OpsCommand
{
    name: string;
    method: HttpMethod;
    path: string;

    /** Input sections the route declares, each as JSON Schema. */
    input: {
        params?: JsonSchema;
        query?: JsonSchema;
        body?: JsonSchema;
    };
}

/** What `GET /_ops/_manifest` answers. */
export interface OpsManifest
{
    manifestVersion: 1;
    commands: OpsCommand[];
}

/** Thrown when a route cannot be part of an ops surface. */
export class OpsRouterError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'OpsRouterError';
    }
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

function toCommandInput(input: RouteInput | undefined): OpsCommand['input']
{
    const sections: OpsCommand['input'] = {};

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
 * as an ops command. Validation of paths and names happens in
 * `createOpsRouter` before this runs.
 */
export function collectOpsCommands(
    routes: Record<string, RouteDef<any> | Router<any>>,
): OpsCommand[]
{
    const commands: OpsCommand[] = [];
    visit(routes, commands, new Map<string, string>());
    commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return commands;
}

function visit(
    routes: Record<string, RouteDef<any> | Router<any>>,
    commands: OpsCommand[],
    claimed: Map<string, string>,
): void
{
    for (const [name, entry] of Object.entries(routes))
    {
        if (isRouter(entry))
        {
            visit(entry.routes, commands, claimed);
            continue;
        }

        if (!isRouteDef(entry) || !entry.method || !entry.path)
        {
            continue;
        }

        assertUnclaimedName(name, entry.path, claimed);

        commands.push({
            name,
            method: entry.method,
            path: entry.path,
            input: toCommandInput(entry.input as RouteInput | undefined),
        });
    }
}

/**
 * Nested routers flatten into one command list, so two routes keyed alike in
 * different routers would both be announced under the same command name. The
 * CLI resolves a name to the first match, which means an operator asking for
 * one command silently invokes the other — refuse it at definition time.
 */
function assertUnclaimedName(name: string, path: string, claimed: Map<string, string>): void
{
    const existing = claimed.get(name);
    if (existing !== undefined)
    {
        throw new OpsRouterError(
            `Two ops routes are named "${name}" ("${existing}" and "${path}"). `
            + 'Command names are flattened across nested routers, so each must be unique '
            + 'for the CLI to resolve the one an operator asked for.',
        );
    }

    claimed.set(name, path);
}
