/**
 * State Routes
 *
 * The read, write and snapshot routes a state router derives. They are
 * ordinary `RouteDef`s registered through `registerRoutes`, so a state's
 * `.use()` middleware runs inside the route's own chain after the app's
 * global middleware.
 */

import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import type { Context } from 'hono';
import { ForbiddenError, UnauthorizedError } from '@spfn/core/errors';
import { route } from '@spfn/core/route';
import type { RouteContract, RouteDef, RouteInput } from '@spfn/core/route';
import {
    permissionContext,
    pickKey,
    readAndPublish,
    readContext,
    readSnapshot,
} from './state-event';
import type { RoutableState, StateCallContext, StateDefinition } from './types';

/** Who a request is for. `null` answers 401. */
export type SubjectResolver = (c: Context) => string | null;

/** The SSE `getSubject` default: the `userId` the app's auth middleware set. */
export const defaultSubject: SubjectResolver = c =>
    (c.get('auth') as Record<string, string> | undefined)?.userId ?? null;

type Key = Record<string, string>;

/** `get<Id>State` / `put<Id>State`. */
export function stateRouteName(method: 'get' | 'put', id: string): string
{
    return `${method}${id[0].toUpperCase()}${id.slice(1)}State`;
}

function requireSubject(c: Context, resolveSubject: SubjectResolver): string
{
    const subject = resolveSubject(c);

    if (!subject)
    {
        throw new UnauthorizedError({ message: 'A state is read for a subject, and this request carries none' });
    }

    return subject;
}

async function assertPermitted(def: StateDefinition, can: 'canRead' | 'canWrite', ctx: StateCallContext): Promise<void>
{
    const predicate = can === 'canWrite' ? def.canWrite ?? def.canRead : def.canRead;

    if (predicate && !await predicate(ctx))
    {
        throw new ForbiddenError({ message: `${can === 'canWrite' ? 'Writing' : 'Reading'} state "${def.id}" is not permitted` });
    }
}

function responseSchema(def: StateDefinition): TObject
{
    return Type.Object({
        at: Type.String(),
        value: def.value!,
        ...(def.data ? { data: def.data } : {}),
    });
}

/**
 * The route contract, or none when the state declares no `.contract()`. A
 * write's own version markers win over the state's, field by field.
 */
function routeContract(def: StateDefinition, write: boolean): RouteContract | undefined
{
    if (!def.contract)
    {
        return undefined;
    }

    const own = write ? stripUndefined(def.write!.options) : {};

    return stripUndefined({ ...def.contract, ...own, response: responseSchema(def) }) as RouteContract;
}

function stripUndefined<T extends object>(value: T): Partial<T>
{
    return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}

/** `route.<method>(path)` with the state's input, middleware, skips and contract. */
function stateRoute(def: StateDefinition, method: 'get' | 'put', path: string, input: RouteInput)
{
    const contract = routeContract(def, method === 'put');
    const builder = route[method](path).input(input).use(def.middlewares);
    const skipped = def.skipMiddlewares ? builder.skip(def.skipMiddlewares) : builder;

    return contract ? skipped.contract(contract) : skipped;
}

function keyInput(def: StateDefinition): { query?: TObject }
{
    return def.key ? { query: def.key } : {};
}

/** `GET <path>/<id>`: subject → key → `canRead` → `at` → `read()`. */
export function readRoute(state: RoutableState, path: string, resolveSubject: SubjectResolver): RouteDef<any, any, any>
{
    const def = state._definition;

    return stateRoute(def, 'get', `${path}/${def.id}`, keyInput(def)).handler(async (c) =>
    {
        const subject = requireSubject(c.raw, resolveSubject);
        const principal = c.raw.get('auth');
        const key = def.key ? pickKey(def.key, (await c.data()).query) : undefined;
        await assertPermitted(def, 'canRead', permissionContext(def, subject, principal, key));

        return readSnapshot(def, readContext(def, subject, principal, key));
    });
}

/** `PUT <path>/<id>`: subject → key → `canWrite ?? canRead` → `write()` → `at` → `read()` → one frame. */
export function writeRoute(state: RoutableState, path: string, resolveSubject: SubjectResolver): RouteDef<any, any, any>
{
    const def = state._definition;
    const write = def.write!;

    return stateRoute(def, 'put', `${path}/${def.id}`, { body: write.input, ...keyInput(def) }).handler(async (c) =>
    {
        const subject = requireSubject(c.raw, resolveSubject);
        const principal = c.raw.get('auth');
        const { body, query } = await c.data();
        const key = def.key ? pickKey(def.key, query) : undefined;
        await assertPermitted(def, 'canWrite', permissionContext(def, subject, principal, key));
        await write.fn({ ...readContext(def, subject, principal, key), input: body });

        return readAndPublish(def, state._event, subject, key, principal);
    });
}

/**
 * The snapshot's query: every key field of every keyed state, each optional —
 * a state whose key is incomplete is left out, not refused.
 */
function snapshotQuery(states: RoutableState[]): TObject
{
    const fields: Record<string, TSchema> = {};

    for (const state of states)
    {
        for (const [field, schema] of Object.entries(state._definition.key?.properties ?? {}))
        {
            fields[field] = Type.Optional(schema);
        }
    }

    return Type.Object(fields);
}

/** One state's entry in the snapshot, or `undefined` when its key is incomplete or `canRead` refuses. */
async function snapshotEntry(def: StateDefinition, subject: string, principal: unknown, query: Record<string, unknown>, at: string)
{
    const key: Key | undefined = def.key ? pickKey(def.key, query) : undefined;

    if (def.key && !key)
    {
        return undefined;
    }

    if (def.canRead && !await def.canRead(permissionContext(def, subject, principal, key)))
    {
        return undefined;
    }

    const { value, data } = await readSnapshot(def, readContext(def, subject, principal, key), at);

    return def.data ? { value, data } : { value };
}

/** `GET <path>`: one `at`, then every readable state in declaration order. A `read()` that throws fails it all. */
export function snapshotRoute(states: RoutableState[], path: string, resolveSubject: SubjectResolver): RouteDef<any, any, any>
{
    return route.get(path).input({ query: snapshotQuery(states) }).handler(async (c) =>
    {
        const subject = requireSubject(c.raw, resolveSubject);
        const principal = c.raw.get('auth');
        const { query } = await c.data();
        const at = new Date().toISOString();
        const entries = await Promise.all(states.map(state => snapshotEntry(state._definition, subject, principal, query, at)));

        return {
            at,
            states: Object.fromEntries(states
                .map((state, index) => [state.id, entries[index]])
                .filter(([, entry]) => entry !== undefined)),
        };
    });
}
