/**
 * State Types
 *
 * A state's shape is tracked as one phantom record, `StateShape`, which each
 * builder call rewrites. Every derived type — the read context, the result,
 * the change signal's payload, the frame, the routes — is computed from it.
 */

import type { Static, TObject, TSchema } from '@sinclair/typebox';
import type { MiddlewareHandler } from 'hono';
import type { EventDef } from '@spfn/core/event';
import type { NamedMiddleware, RouteAuthProfile } from '@spfn/core/route';

/**
 * What a builder has declared so far, at the type level only.
 */
export interface StateShape
{
    key: TObject | undefined;
    shared: boolean;
    value: TSchema | undefined;
    data: TSchema | undefined;
    input: TSchema | undefined;
    read: boolean;

    /** Who the callbacks' `principal` is, from `.principal<P>()`; `unknown` until declared. */
    principal: unknown;
}

/** The shape of `defineState(id)` before any call. */
export interface EmptyStateShape extends StateShape
{
    key: undefined;
    shared: false;
    value: undefined;
    data: undefined;
    input: undefined;
    read: false;
    principal: unknown;
}

/** `T` with the fields of `U` replaced. */
export type WithShape<T extends StateShape, U extends Partial<StateShape>> = {
    [K in keyof StateShape]: K extends keyof U ? U[K] : T[K];
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The key object of a keyed state, `undefined` for a keyless one. */
export type StateKey<T extends StateShape> = T['key'] extends TObject ? Static<T['key']> : undefined;

/** The value type, `unknown` until `.value()` is declared. */
export type StateValue<T extends StateShape> = T['value'] extends TSchema ? Static<T['value']> : unknown;

/**
 * What `read()` returns: always an object, so a value can never be mistaken
 * for `{ value, data }`. With `.data()` declared, `data` is part of every
 * result — the router checks each one against the declaration.
 */
export type StateResult<T extends StateShape> = T['data'] extends TSchema
    ? { value: StateValue<T>; data: Static<T['data']> }
    : { value: StateValue<T> };

/** What the read and write routes answer: the result and the time its read started. */
export type StateSnapshot<T extends StateShape> = Simplify<{ at: string } & StateResult<T>>;

/**
 * What `.canRead()` decides on. `principal` may be `undefined`: at SSE connect
 * it is what `resolvePrincipal` returned.
 */
export type PermissionContext<T extends StateShape> = T['key'] extends TObject
    ? { subject: string; principal: T['principal'] | undefined; key: Static<T['key']> }
    : { subject: string; principal: T['principal'] | undefined };

/**
 * What `.canWrite()` decides on. Only the write route asks it, and with
 * `.principal()` declared that route refuses a request whose `auth` is
 * `undefined` or `null` (401).
 */
export type WritePermissionContext<T extends StateShape> = Simplify<Omit<PermissionContext<T>, 'principal'> & { principal: T['principal'] }>;

/**
 * What `read()` receives. A shared state's value does not depend on the
 * subject, so it gets none. `principal` may be `undefined`: the change
 * signal's re-read has no request.
 */
export type ReadContext<T extends StateShape> = T['key'] extends TObject
    ? T['shared'] extends true
        ? { principal: T['principal'] | undefined; key: Static<T['key']> }
        : PermissionContext<T>
    : PermissionContext<T>;

/** What `write()` receives: the read context, the write route's principal and the validated input. */
export type WriteContext<T extends StateShape, I extends TSchema> = Simplify<
    Omit<ReadContext<T>, 'principal'> & { principal: T['principal']; input: Static<I> }
>;

/** The payload of `state.changed.emit()`: exactly what names the value to re-read. */
export type ChangedPayload<T extends StateShape> = T['key'] extends TObject
    ? T['shared'] extends true
        ? Simplify<Static<T['key']>>
        : Simplify<Static<T['key']> & { subject: string }>
    : { subject: string };

/** The payload of the derived SSE event `state.<id>.changed`. */
export type StateFrame<T extends StateShape> = Simplify<
    StateSnapshot<T>
    & (T['key'] extends TObject ? { key: Static<T['key']> } : {})
    & (T['key'] extends TObject ? (T['shared'] extends true ? {} : { subject: string }) : { subject: string })
>;

/** Whom `grant()` reaches, and for a keyed state the one key it opens and sends the current value of. */
export type GrantTarget<T extends StateShape> = T['key'] extends TObject
    ? { subject: string; key: Static<T['key']> }
    : { subject: string };

/** Whom `revoke()` reaches: for a keyed state, the connections on `key`, or every one without it. */
export type RevokeTarget<T extends StateShape> = T['key'] extends TObject
    ? { subject: string; key?: Static<T['key']> }
    : { subject: string };

/**
 * The contract one `.contract()` declares for the read route, the write route
 * and the derived event. The response schema is derived, never declared.
 */
export interface StateContract
{
    since: string;
    auth?: RouteAuthProfile;
    requiresSession?: boolean;
    deprecatedIn?: string;
    removedIn?: string;
}

/** Version markers of a write added, deprecated or removed apart from its read. */
export interface StateWriteOptions
{
    since?: string;
    deprecatedIn?: string;
    removedIn?: string;
}

/** Any read / permission / write context, as the runtime handles it. */
export interface StateCallContext
{
    subject?: string;
    principal: unknown;
    key?: Record<string, string>;
    input?: unknown;
}

export type StatePredicate = (ctx: StateCallContext) => boolean | Promise<boolean>;

export type StateReader = (ctx: StateCallContext) => unknown;

export type StateWriter = (ctx: StateCallContext) => void | Promise<void>;

/**
 * Everything one builder declared, as the router reads it.
 */
export interface StateDefinition
{
    id: string;
    key?: TObject;
    shared: boolean;
    /** Whether `.principal()` was declared: the write route then refuses a request whose `auth` is `undefined` or `null`. */
    principal: boolean;
    value?: TSchema;
    data?: TSchema;
    middlewares: (MiddlewareHandler | NamedMiddleware<string>)[];
    skipMiddlewares?: string[] | '*';
    contract?: StateContract;
    canRead?: StatePredicate;
    canWrite?: StatePredicate;
    read?: StateReader;
    write?: { input: TSchema; fn: StateWriter; options: StateWriteOptions };
    changedBy?: EventDef<any>[];
}

/**
 * What `defineStateRouter` accepts: a builder with `.value()` and `.read()`
 * declared. A builder without either is not assignable here.
 */
export interface RoutableState
{
    readonly id: string;
    readonly _types: StateShape & { value: TSchema; read: true };
    readonly _definition: Readonly<StateDefinition>;
    readonly _event: EventDef<any>;
    readonly changed: EventDef<any>;
}
