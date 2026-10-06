/**
 * Contract Collection
 *
 * Walks a loaded router and turns every route carrying `.contract()` into a
 * contract operation, and every event of an event router carrying
 * `.contract()` into a contract event.
 *
 * The router is loaded and walked rather than parsed from source. Real routes
 * build their schemas from imported values — `EmailSchema`, `FileSchema()`,
 * `KEY_DEVICE_NAME_MAX_LENGTH` — which a source parser cannot resolve. Loading
 * costs a module import and no infrastructure: route modules have no
 * import-time side effects, so nothing here opens a database connection.
 */

import type { EventRouterDef } from '../event/router';
import { DEFAULT_SSE_STREAM_PATH, sseTokenPath } from '../event/sse/paths';
import type { EventDef } from '../event/types';
import type { RouteDef } from '../route/route-builder';
import type { RouteInput } from '../route/route-input';
import type { Router } from '../route/router';
import type {
    ContractDocument,
    ContractEvent,
    ContractEvents,
    ContractOperation,
    ContractRequest,
    JsonSchema,
} from './types';

/** Thrown when the router cannot produce a contract at all. */
export class ContractCollectionError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'ContractCollectionError';
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
 * Strip TypeBox's symbol-keyed metadata and hand back plain JSON.
 *
 * The symbols carry no information the wire shape depends on, and they cannot
 * survive the round trip to a committed file.
 */
function toJsonSchema(schema: unknown): JsonSchema
{
    return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

/**
 * `formData` is absent on purpose — a contracted route carrying it is refused
 * before it gets here (see `assertNoFormData`). Emitting its schema alongside
 * the JSON sections described a multipart route as if it were JSON-shaped, and a
 * generated client built from that reads as correct right up to the request.
 */
const REQUEST_SECTIONS = ['params', 'query', 'body', 'headers', 'cookies'] as const;

function toContractRequest(input: RouteInput | undefined): ContractRequest
{
    const request: ContractRequest = {};

    if (!input)
    {
        return request;
    }

    for (const section of REQUEST_SECTIONS)
    {
        const schema = input[section];
        if (schema)
        {
            request[section] = toJsonSchema(schema);
        }
    }

    return request;
}

interface Found
{
    operation: ContractOperation;

    /** Where the route was found, for a collision message. */
    trail: string;
}

function visitRouter(router: Router<any>, trail: string[], found: Map<string, Found>): void
{
    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            visitRouter(entry, [...trail, name], found);
            continue;
        }

        if (!isRouteDef(entry))
        {
            continue;
        }

        const routeDef = entry as RouteDef<any>;
        if (!routeDef.contract)
        {
            continue;
        }

        addOperation(name, routeDef, [...trail, name], found);
    }

    for (const packageRouter of router._packageRouters ?? [])
    {
        visitRouter(packageRouter, [...trail, '(package)'], found);
    }
}

/**
 * Refuse a contracted route that takes multipart form data.
 *
 * Multipart is a transport-format problem, not a type problem: the contract's
 * grammar describes JSON values, and a file part has no spelling in it. The
 * refusal is loud rather than a quiet omission — a contract that silently
 * dropped the section would still claim to describe the operation, and an app
 * generated from it would break against the running server instead of at build.
 */
function assertNoFormData(where: string, routeDef: RouteDef<any>): void
{
    const input = routeDef.input as RouteInput | undefined;
    const interceptor = routeDef.interceptor as RouteInput | undefined;
    const section = input?.formData ? 'input' : interceptor?.formData ? 'interceptor' : undefined;

    if (!section)
    {
        return;
    }

    throw new ContractCollectionError(
        `Contracted route "${where}" declares ${section}.formData, which a contract cannot describe. `
        + 'The contract grammar covers JSON values, and multipart carries file parts that have no spelling in it. '
        + 'Drop .contract() from this route, or move the operation to a JSON body.',
    );
}

function addOperation(name: string, routeDef: RouteDef<any>, trail: string[], found: Map<string, Found>): void
{
    const where = trail.join('.');
    const contract = routeDef.contract!;

    assertNoFormData(where, routeDef);

    if (!routeDef.method || !routeDef.path)
    {
        throw new ContractCollectionError(
            `Contracted route "${where}" has no method or path. `
            + 'A contract describes an operation on the wire, so both are required.',
        );
    }

    if (!contract.since)
    {
        throw new ContractCollectionError(
            `Contracted route "${where}" has no "since" version. `
            + 'The version an operation first appeared in is part of the promise.',
        );
    }

    if (!contract.response)
    {
        throw new ContractCollectionError(
            `Contracted route "${where}" declares no response schema. `
            + 'An operation with no body declares Type.Null().',
        );
    }

    const existing = found.get(name);
    if (existing)
    {
        throw new ContractCollectionError(
            `Two contracted routes are both named "${name}" (${existing.trail} and ${where}). `
            + 'An operation is identified by its name across versions, so names must be unique.',
        );
    }

    found.set(name, {
        trail: where,
        operation: {
            name,
            method: routeDef.method,
            path: routeDef.path,
            since: contract.since,
            auth: contract.auth ?? 'none',
            requiresSession: contract.requiresSession ?? false,
            ...(contract.deprecatedIn ? { deprecatedIn: contract.deprecatedIn } : {}),
            ...(contract.removedIn ? { removedIn: contract.removedIn } : {}),
            request: toContractRequest(routeDef.input),
            interceptor: toContractRequest(routeDef.interceptor),
            response: toJsonSchema(contract.response),
        },
    });
}

/**
 * Frame names the stream sends on its own: `connected` once the stream opens,
 * `ping` as keep-alive. An event under either key would be indistinguishable
 * from them on the wire.
 */
const RESERVED_EVENT_NAMES = new Set(['connected', 'ping']);

function byName<T extends { name: string }>(a: T, b: T): number
{
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function toContractEvent(name: string, eventDef: EventDef<any>): ContractEvent
{
    const contract = eventDef._contract!;

    if (RESERVED_EVENT_NAMES.has(name))
    {
        throw new ContractCollectionError(
            `Contracted event "${name}" uses a reserved frame name. `
            + 'The stream itself sends "connected" and "ping" frames, so a client could not tell this event from them. '
            + 'Register the event under another key.',
        );
    }

    if (!contract.since)
    {
        throw new ContractCollectionError(
            `Contracted event "${name}" has no "since" version. `
            + 'The version an event first appeared in is part of the promise.',
        );
    }

    if (!eventDef.schema)
    {
        throw new ContractCollectionError(
            `Contracted event "${name}" declares no payload schema. `
            + 'Its frame carries no data, so there is nothing for the contract to describe. '
            + 'Declare Type.Object({}) and emit {} instead.',
        );
    }

    return {
        name,
        since: contract.since,
        ...(contract.deprecatedIn ? { deprecatedIn: contract.deprecatedIn } : {}),
        ...(contract.removedIn ? { removedIn: contract.removedIn } : {}),
        payload: toJsonSchema(eventDef.schema),
    };
}

/**
 * The events section, or `undefined` when nothing in the router is contracted.
 *
 * An item is named by its router key, the name on the wire. The same `EventDef`
 * registered under two keys therefore becomes two items with two names — keys
 * are unique by construction, so no collision check is needed here.
 */
function collectEvents(eventRouter: EventRouterDef<any> | undefined): ContractEvents | undefined
{
    const contracted = Object.entries<EventDef<any>>(eventRouter?.events ?? {})
        .filter(([, eventDef]) => eventDef._contract);

    if (contracted.length === 0)
    {
        return undefined;
    }

    const routerContract = eventRouter!._contract;

    if (!routerContract)
    {
        throw new ContractCollectionError(
            `Event router defineEventRouter({ ${eventRouter!.eventNames.join(', ')} }) contracts events but declares `
            + 'no .contract() of its own. '
            + 'Without it the contract cannot say whether a client must exchange a token before opening the stream. '
            + 'Add .contract({ auth: \'none\' }) or .contract({ auth: \'tokenExchange\' }) to the router.',
        );
    }

    const streamPath = routerContract.streamPath ?? DEFAULT_SSE_STREAM_PATH;

    return {
        streamPath,
        tokenPath: sseTokenPath(streamPath),
        auth: routerContract.auth,
        items: contracted.map(([name, eventDef]) => toContractEvent(name, eventDef)).sort(byName),
    };
}

/**
 * Build the contract document from a loaded router and, optionally, the app's
 * event router.
 *
 * Routes and events without `.contract()` are skipped — they are not part of
 * the promise. A document with no contracted event carries no `events` key, so
 * it is byte-identical to one collected without an event router.
 */
export function collectContractDocument(router: Router<any>, eventRouter?: EventRouterDef<any>): ContractDocument
{
    const found = new Map<string, Found>();
    visitRouter(router, ['router'], found);

    const operations = [...found.values()]
        .map(entry => entry.operation)
        .sort(byName);

    const events = collectEvents(eventRouter);

    return {
        documentVersion: 1,
        ...(router._contractVersion ? { contractVersion: router._contractVersion } : {}),
        compatibilityPolicy: 'perOperation',
        operations,
        ...(events ? { events } : {}),
    };
}
