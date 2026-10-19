/**
 * State Router
 *
 * Groups states, derives their routes into one `Router` the app mounts with
 * `.packages()`, collects their SSE events for the app's event router, and
 * subscribes each state's change signal — once, here.
 */

import type { Static, TObject, TSchema } from '@sinclair/typebox';
import type { EventDef } from '@spfn/core/event';
import { defineRouter } from '@spfn/core/route';
import type { RouteDef, Router } from '@spfn/core/route';
import { bindState, stateBinding } from './state-binding';
import { changedPayloadSchema, stateEventName, subscribeChangeSignals } from './state-event';
import { defaultSubject, readRoute, snapshotRoute, stateManifest, stateRouteName, writeRoute } from './state-routes';
import type { SnapshotRouteOptions, StatesManifest, SubjectResolver } from './state-routes';
import type { RoutableState, StateFrame, StateKey, StateResult, StateSnapshot, StateValue } from './types';

/**
 * Where the router mounts, whom a request is for, and the snapshot route's own
 * `use` / `skip` / `contract` (`SnapshotRouteOptions`) — those reach `GET <path>`
 * only, never a per-state route or the SSE stream.
 */
export interface StateRouterOptions extends SnapshotRouteOptions
{
    /**
     * Where the routes are mounted: `GET <path>`, `GET|PUT <path>/<id>`.
     * @default '/state'
     */
    path?: string;

    /**
     * Who an HTTP request is for. `null` answers 401.
     * @default (c) => c.get('auth')?.userId ?? null
     */
    subject?: SubjectResolver;
}

type Shape<S extends RoutableState> = S['_types'];

type KeyQuery<S extends RoutableState> = Shape<S>['key'] extends TObject ? { query: Shape<S>['key'] } : {};

type ReadRoutes<S extends Record<string, RoutableState>> = {
    [K in keyof S as `get${Capitalize<S[K]['id']>}State`]: RouteDef<KeyQuery<S[K]>, {}, StateSnapshot<Shape<S[K]>>>;
};

type WriteInput<S extends RoutableState> = KeyQuery<S> & { body: Shape<S>['input'] };

type WriteRoutes<S extends Record<string, RoutableState>> = {
    [K in keyof S as Shape<S[K]>['input'] extends TSchema ? `put${Capitalize<S[K]['id']>}State` : never]: RouteDef<WriteInput<S[K]>, {}, StateSnapshot<Shape<S[K]>>>;
};

/**
 * What `GET <path>` answers: every state the subject may read and whose key
 * the query carries, and the manifest of every state — its key fields and
 * whether it has a write — in declaration order.
 */
export type StatesSnapshot<S extends Record<string, RoutableState>> = {
    at: string;
    states: { [K in keyof S as S[K]['id']]?: StateResult<Shape<S[K]>> };
    manifest: { [K in keyof S as S[K]['id']]: { key: string[]; write: boolean } };
};

/** The routes one state router derives, typed for `createApi` and the route map. */
export type StateRoutes<S extends Record<string, RoutableState>> = ReadRoutes<S> & WriteRoutes<S> & {
    getStates: RouteDef<{ query: TObject }, {}, StatesSnapshot<S>>;
};

/** The SSE events, keyed by their wire names, for the app's `defineEventRouter`. */
export type StateEvents<S extends Record<string, RoutableState>> = {
    [K in keyof S as `state.${S[K]['id']}.changed`]: EventDef<StateFrame<Shape<S[K]>>>;
};

export interface StateRouter<S extends Record<string, RoutableState>>
{
    /** The derived routes. Mount with `appRouter.packages([states.router])`. */
    router: Router<StateRoutes<S>>;

    /** The derived SSE events. Spread into `defineEventRouter({ ...appEvents, ...states.events })`. */
    events: StateEvents<S>;

    /** The declarations, as given. */
    states: S;
}

type StateById<R extends StateRouter<any>, TId extends string> = Extract<R['states'][keyof R['states']], { id: TId }>;

/** The value type of state `TId` of a state router. */
export type InferStateValue<R extends StateRouter<any>, TId extends string> = StateValue<Shape<StateById<R, TId>>>;

/** The key type of state `TId`, `undefined` when it is keyless. */
export type InferStateKey<R extends StateRouter<any>, TId extends string> = StateKey<Shape<StateById<R, TId>>>;

/** The write input of state `TId`, `never` when it declares no `.write()`. */
export type InferStateInput<R extends StateRouter<any>, TId extends string> =
    Shape<StateById<R, TId>>['input'] extends TSchema ? Static<Shape<StateById<R, TId>>['input']> : never;

/**
 * Group states, derive their routes and SSE events, and subscribe their change
 * signals.
 *
 * @example
 * ```typescript
 * export const states = defineStateRouter({ consent, runtime, member });
 *
 * // server.config.ts
 * //   .routes(appRouter.packages([states.router]))
 * //   .events(defineEventRouter({ ...appEvents, ...states.events }), { auth: { enabled: true } })
 * ```
 */
export function defineStateRouter<S extends Record<string, RoutableState>>(
    states: S,
    options: StateRouterOptions = {},
): StateRouter<S>
{
    const path = options.path ?? '/state';
    const list = Object.values(states);

    assertPath(path);
    list.forEach(assertRoutable);
    assertSnapshotMiddlewareIsNotAuthorization(list, options);
    assertDistinctIds(list);
    list.forEach(state => assertNotRouted(state, path));

    list.forEach(state => bindState(state._definition, path));
    list.forEach(subscribeChangeSignals);

    const manifest = stateManifest(list);

    // Non-enumerable, as `_surfaceNamespace` is: the router compares and
    // spreads as any other, and `@spfn/core:states` reads the same object the
    // snapshot route answers, so the generated ids and the served manifest
    // cannot differ.
    const router = Object.defineProperty(defineRouter(deriveRoutes(list, manifest, path, options)), '_stateManifest', {
        value: manifest,
        enumerable: false,
    });

    return {
        router: router as Router<StateRoutes<S>>,
        events: Object.fromEntries(list.map(state => [stateEventName(state.id), state._event])) as StateEvents<S>,
        states,
    };
}

function deriveRoutes(
    states: RoutableState[],
    manifest: StatesManifest,
    path: string,
    options: StateRouterOptions,
): Record<string, RouteDef<any, any, any>>
{
    const resolveSubject = options.subject ?? defaultSubject;
    const routes: Record<string, RouteDef<any, any, any>> = {};

    for (const state of states)
    {
        routes[stateRouteName('get', state.id)] = readRoute(state, path, resolveSubject);

        if (state._definition.write)
        {
            routes[stateRouteName('put', state.id)] = writeRoute(state, path, resolveSubject);
        }
    }

    routes.getStates = snapshotRoute(states, manifest, path, resolveSubject, options);

    return routes;
}

function assertPath(path: string): void
{
    if (!path.startsWith('/') || (path.length > 1 && path.endsWith('/')))
    {
        throw new Error(
            `defineStateRouter(..., { path: "${path}" }) is not an absolute path without a trailing slash. `
            + 'The routes are mounted at <path> and <path>/<id>. Write it as "/state".',
        );
    }
}

/** Refuse a state the router could not serve, naming it. */
function assertRoutable(state: RoutableState): void
{
    const def = state._definition;
    const missing = !def.value ? '.value()' : !def.read ? '.read()' : undefined;

    if (missing)
    {
        throw new Error(
            `defineStateRouter: state "${state.id}" declares no ${missing}. `
            + 'A state answers with the value its read returns, so both are required. '
            + `Add ${missing} to defineState('${state.id}').`,
        );
    }

    if (def.key && !def.canRead)
    {
        throw new Error(
            `defineStateRouter: keyed state "${state.id}" declares no .canRead(). `
            + 'The key comes from the request, so without it any subject could read any key. '
            + 'Add .canRead(({ subject, key }) => ...).',
        );
    }

    assertMiddlewareIsNotAuthorization(state);
    def.changedBy?.forEach(event => assertChangedBy(state, event));

    if (def.write && !def.contract && def.write.options.since)
    {
        throw new Error(
            `defineStateRouter: state "${state.id}" gives .write(..., { since: '${def.write.options.since}' }) `
            + 'but declares no .contract(), so there is nothing to fall back from: the write route would have a version '
            + 'but no auth profile, and the read route and the event would not be contracted at all. '
            + 'Add .contract({ since, ... }) to the state, or drop since from the write.',
        );
    }
}

/**
 * `.use()` / `.skip()` reach the two per-state routes only: the snapshot and
 * the SSE stream cannot run HTTP middleware. A guard there would hold on one
 * route and leak through the others, so authorization must be `canRead`.
 */
function assertMiddlewareIsNotAuthorization(state: RoutableState): void
{
    const def = state._definition;

    if ((def.middlewares.length > 0 || def.skipMiddlewares) && !def.canRead)
    {
        throw new Error(
            `defineStateRouter: state "${state.id}" declares .use() or .skip() but no .canRead(). `
            + `Middleware reaches only ${stateRouteName('get', state.id)} / ${stateRouteName('put', state.id)} — never the `
            + 'snapshot route or the SSE stream — so it cannot authorize. Authorization belongs in .canRead(), which is '
            + 'enforced on the read route, the snapshot and the stream. A state that needs middleware only for, say, rate '
            + 'limiting declares .canRead(() => true) to say so.',
        );
    }
}

/**
 * The router's `use` / `skip` reach the snapshot route only — never the SSE
 * stream, which serves the same states — so, as for a state's own `.use()`,
 * every state must authorize with `canRead`. A `contract` alone runs nothing.
 */
function assertSnapshotMiddlewareIsNotAuthorization(states: RoutableState[], options: StateRouterOptions): void
{
    const unguarded = states.find(state => !state._definition.canRead);

    if (((options.use?.length ?? 0) > 0 || options.skip) && unguarded)
    {
        throw new Error(
            `defineStateRouter: the router gives the snapshot route use or skip, but state "${unguarded.id}" declares no `
            + '.canRead(). The snapshot\'s middleware never reaches the SSE stream, which serves the same state, so it '
            + 'cannot authorize. Authorization belongs in .canRead(); a state readable by every subject declares '
            + '.canRead(() => true) to say so.',
        );
    }
}

/** A `.changedBy()` event must carry every field the state's change signal names, as a required property. */
function assertChangedBy(state: RoutableState, event: EventDef<any>): void
{
    const payload = event.schema as TObject | undefined;
    const signal = changedPayloadSchema(state._definition);
    const missing = Object.keys(signal.properties).find(field =>
        !payload?.properties?.[field] || !(payload.required ?? []).includes(field));

    if (missing)
    {
        throw new Error(
            `defineStateRouter: state "${state.id}" lists event "${event.name}" in .changedBy(), but its payload schema `
            + `has no required field "${missing}". Its payload is read like ${state.id}.changed.emit(), which names `
            + `${Object.keys(signal.properties).join(', ')}. Add the field to the event, or emit ${state.id}.changed instead.`,
        );
    }
}

function assertDistinctIds(states: RoutableState[]): void
{
    const seen = new Set<string>();

    for (const state of states)
    {
        if (seen.has(state.id))
        {
            throw new Error(
                `defineStateRouter: two states have the id "${state.id}". `
                + `Both would derive the routes ${stateRouteName('get', state.id)} and the event `
                + `${stateEventName(state.id)}, and one would shadow the other. Rename one.`,
            );
        }
        seen.add(state.id);
    }
}

function assertNotRouted(state: RoutableState, path: string): void
{
    const other = stateBinding(state._definition)?.path;

    if (other !== undefined)
    {
        throw new Error(
            `defineStateRouter: state "${state.id}" is already in another state router (path ${other}, this one ${path}). `
            + 'Each router subscribes the state\'s change signal, so every change would be read and sent twice. '
            + 'Group each state in one router.',
        );
    }
}
