/**
 * State Builder
 *
 * `defineState(id)` starts an immutable builder: every call returns a new one,
 * order is free and there is no terminal method. `defineStateRouter` reads
 * what a builder declared and derives its routes and SSE event from it.
 */

import { Kind, Type, type TObject, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { MiddlewareHandler } from 'hono';
import type { EventDef } from '@spfn/core/event';
import type { NamedMiddleware } from '@spfn/core/route';
import { createChangedSignal, createStateEvent, pickKey, readAndPublish, requireBinding } from './state-event';
import type {
    ChangedPayload,
    EmptyStateShape,
    GrantTarget,
    PermissionContext,
    ReadContext,
    RevokeTarget,
    StateContract,
    StateDefinition,
    StateFrame,
    StatePredicate,
    StateReader,
    StateResult,
    StateShape,
    StateWriteOptions,
    StateWriter,
    WithShape,
    WriteContext,
} from './types';

/** A state id becomes part of a route name (`get<Id>State`) and of an event name (`state.<id>.changed`). */
const STATE_ID = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Query names the SSE stream reads itself. Key fields share the connect query
 * with them, so a key field under one of these names would be read as both.
 */
const RESERVED_KEY_FIELDS = ['events', 'token'];

/**
 * A server-owned value declared once. See the module README.
 */
export class StateBuilder<TId extends string, T extends StateShape>
{
    /** Type inference helper: what this builder declared. Never set at runtime. */
    declare readonly _types: T;

    private changedSignal?: EventDef<any>;
    private stateEvent?: EventDef<any>;

    constructor(
        readonly id: TId,
        readonly _definition: Readonly<StateDefinition>,
    )
    {
    }

    /**
     * Declare the key: one value per key (and per subject, unless `shared`).
     * Fields are required strings: they travel as query parameters.
     */
    key<K extends TObject, S extends boolean = false>(
        schema: K,
        options: { shared?: S } = {},
    ): StateBuilder<TId, WithShape<T, { key: K; shared: S }>>
    {
        this.assertOnce('key', !!this._definition.key);
        assertKeySchema(this.id, schema);

        return this.with({ key: schema, shared: options.shared === true });
    }

    /** Declare the value schema. Required. */
    value<V extends TSchema>(schema: V): StateBuilder<TId, WithShape<T, { value: V }>>
    {
        this.assertOnce('value', !!this._definition.value);

        return this.with({ value: schema });
    }

    /** Declare data attached to the value. Optional. */
    data<D extends TSchema>(schema: D): StateBuilder<TId, WithShape<T, { data: D }>>
    {
        this.assertOnce('data', !!this._definition.data);

        return this.with({ data: schema });
    }

    /**
     * Middleware for the two per-state routes, `get<Id>State` / `put<Id>State`.
     * Not authorization: the snapshot and the SSE stream cannot run it, so a
     * state with `.use()` must declare `.canRead()`. Calls add up.
     */
    use(middlewares: (MiddlewareHandler | NamedMiddleware<string>)[]): StateBuilder<TId, T>
    {
        return this.with({ middlewares: [...this._definition.middlewares, ...middlewares] });
    }

    /** Server-level named middlewares the two per-state routes skip. Calls add up; `'*'` wins. Needs `.canRead()`, as `.use()`. */
    skip(middlewareNames: string[] | '*'): StateBuilder<TId, T>
    {
        const current = this._definition.skipMiddlewares ?? [];
        const skipMiddlewares = current === '*' || middlewareNames === '*'
            ? '*'
            : [...current, ...middlewareNames];

        return this.with({ skipMiddlewares });
    }

    /** Publish the read route, the write route and the event in the contract. */
    contract(contract: StateContract): StateBuilder<TId, T>
    {
        this.assertOnce('contract', !!this._definition.contract);

        return this.with({ contract });
    }

    /** Who may read. Required on a keyed state; checked on HTTP and at SSE connect. */
    canRead(predicate: (ctx: PermissionContext<T>) => boolean | Promise<boolean>): StateBuilder<TId, T>
    {
        this.assertOnce('canRead', !!this._definition.canRead);

        return this.with({ canRead: predicate as StatePredicate });
    }

    /** Who may write. Absent → `canRead` decides. */
    canWrite(predicate: (ctx: PermissionContext<T>) => boolean | Promise<boolean>): StateBuilder<TId, T>
    {
        this.assertOnce('canWrite', !!this._definition.canWrite);

        return this.with({ canWrite: predicate as StatePredicate });
    }

    /** The only source of a value. Required. */
    read(
        fn: (ctx: ReadContext<T>) => StateResult<T> | Promise<StateResult<T>>,
    ): StateBuilder<TId, WithShape<T, { read: true }>>
    {
        this.assertOnce('read', !!this._definition.read);

        return this.with({ read: fn as StateReader });
    }

    /**
     * Derive `PUT <path>/<id>`. `fn` runs the command; the value the route
     * answers and broadcasts is re-read afterwards, never taken from `input`.
     */
    write<I extends TSchema>(
        input: I,
        fn: (ctx: WriteContext<T, I>) => void | Promise<void>,
        options: StateWriteOptions = {},
    ): StateBuilder<TId, WithShape<T, { input: I }>>
    {
        this.assertOnce('write', !!this._definition.write);

        return this.with({ write: { input, fn: fn as StateWriter, options } });
    }

    /**
     * Domain events whose payload names a changed value of this state, treated
     * like `changed.emit` with that payload: keyless `subject`, keyed the key
     * fields and `subject`, shared the key fields. The router subscribes them
     * and refuses one whose payload schema lacks a field.
     */
    changedBy(events: EventDef<any>[]): StateBuilder<TId, T>
    {
        this.assertOnce('changedBy', !!this._definition.changedBy);

        return this.with({ changedBy: [...events] });
    }

    /**
     * The change signal. Emit it after the change is committed; the module
     * re-reads the value and sends the frame. Refused on a builder no router
     * grouped — export the instance you passed to `defineStateRouter`.
     */
    get changed(): EventDef<ChangedPayload<T>>
    {
        this.changedSignal ??= createChangedSignal(this._definition);

        return this.changedSignal;
    }

    /** Internal: the SSE event `state.<id>.changed` (`defineStateRouter(...).events`). */
    get _event(): EventDef<StateFrame<T>>
    {
        this.stateEvent ??= createStateEvent(this._definition);

        return this.stateEvent;
    }

    /**
     * Activate the state's event on `subject`'s open connections and send it
     * the current value at once. On a keyed state only the connections that
     * declared `key` are opened. Does not consult `canRead`.
     */
    async grant(target: GrantTarget<T>): Promise<void>
    {
        const { subject, key } = target as { subject: string; key?: Record<string, string> };
        requireBinding(this._definition, `${this.id}.grant()`);
        this.assertGrantKey(key);
        const declared = this.declaredKey('grant', key);
        await this._event.grant(subject, declared && { query: declared });
        await readAndPublish(this._definition, this._event, subject, declared, undefined);
    }

    /**
     * Deactivate the state's event on `subject`'s open connections: on a keyed
     * state those that declared `key`, or every one when no key is given.
     */
    async revoke(target: RevokeTarget<T>): Promise<void>
    {
        const { subject, key } = target as { subject: string; key?: Record<string, string> };
        const declared = this.declaredKey('revoke', key);
        await this._event.revoke(subject, declared && { query: declared });
    }

    /** A keyed grant opens one key: without it there is no key to open and no value to send. */
    private assertGrantKey(key: Record<string, string> | undefined): void
    {
        if (this._definition.key && !key)
        {
            throw new Error(
                `State "${this.id}" .grant() was called without a key. `
                + 'A keyed grant opens exactly one key — every connection of the subject on any key would otherwise be '
                + 'opened, including keys canRead refused. Pass { subject, key }.',
            );
        }
    }

    /**
     * The declared key fields of `key`, checked against `.key()`: an empty or
     * partial key would match every connection of the subject. A field the
     * declaration does not name is dropped, never matched on — so the check
     * runs on a fresh object of the declared fields, never `.key()` itself: a
     * key declared `additionalProperties: false` would otherwise refuse it.
     * The fresh object keeps `.key()`'s `required`, and a key that still picks
     * to nothing is refused: `undefined` here would mean every connection.
     */
    private declaredKey(method: 'grant' | 'revoke', key: Record<string, string> | undefined): Record<string, string> | undefined
    {
        const schema = this._definition.key;
        if (!schema || key === undefined)
        {
            return undefined;
        }

        const error = Value.Errors({ ...Type.Object(schema.properties), required: schema.required }, key).First();
        if (error)
        {
            this.refuseKey(method, `${error.path || '(root)'} ${error.message}`);
        }

        return pickKey(schema, key) ?? this.refuseKey(method, '(root) a declared key field is missing or not a string');
    }

    private refuseKey(method: 'grant' | 'revoke', reason: string): never
    {
        throw new Error(
            `State "${this.id}" .${method}() refused its key: ${reason}. `
            + `A keyed ${method} reaches exactly the connections on one key, so every key field must be named.`,
        );
    }

    private with(changes: Partial<StateDefinition>): StateBuilder<TId, any>
    {
        return new StateBuilder(this.id, { ...this._definition, ...changes });
    }

    private assertOnce(method: string, declared: boolean): void
    {
        if (declared)
        {
            throw new Error(
                `State "${this.id}" already declares .${method}(). `
                + 'A state is declared once, so a second declaration would silently replace the first. '
                + `Declare .${method}() once.`,
            );
        }
    }
}

/**
 * Refuse a key the module could not carry: it must be an object of required
 * string fields, none named like a query parameter the SSE stream reads.
 */
function assertKeySchema(id: string, schema: TSchema): void
{
    if (schema[Kind] !== 'Object')
    {
        throw new Error(
            `State "${id}" .key() takes an object schema, got ${String(schema[Kind])}. `
            + 'Each key field becomes a named query parameter and a field of the frame\'s key. '
            + 'Wrap the field: .key(Type.Object({ workspaceId: Type.String() })).',
        );
    }

    const fields = Object.entries((schema as TObject).properties);

    if (fields.length === 0)
    {
        throw new Error(
            `State "${id}" .key() declares no field. A key with no field names nothing to read by. `
            + 'Drop .key() for one value per subject.',
        );
    }

    fields.forEach(([field, fieldSchema]) => assertKeyField(id, schema as TObject, field, fieldSchema));
}

function assertKeyField(id: string, schema: TObject, field: string, fieldSchema: TSchema): void
{
    if (RESERVED_KEY_FIELDS.includes(field))
    {
        throw new Error(
            `State "${id}" key field "${field}" is reserved. `
            + `The SSE stream reads ${RESERVED_KEY_FIELDS.map(name => `"${name}"`).join(' and ')} from the connect query `
            + 'that also carries the key, so the field would be read as both. Rename the field.',
        );
    }

    if (fieldSchema.type !== 'string' || !(schema.required ?? []).includes(field))
    {
        throw new Error(
            `State "${id}" key field "${field}" is not a required string. `
            + 'A key travels as a query parameter, which is always a string, and the SSE filter compares it with the '
            + 'connect query as one — a number would never match, and a missing field names no value. '
            + `Declare it ${field}: Type.String().`,
        );
    }
}

/**
 * Declare a server-owned state.
 *
 * @example
 * ```typescript
 * export const consent = defineState('consent')
 *     .value(Type.Union([Type.Literal('pending'), Type.Literal('agreed')]))
 *     .read(({ subject }) => consents.current(subject));
 * ```
 */
export function defineState<TId extends string>(id: TId): StateBuilder<TId, EmptyStateShape>
{
    if (!STATE_ID.test(id))
    {
        throw new Error(
            `defineState("${id}"): a state id must match ${STATE_ID}. `
            + 'It becomes part of the route names get<Id>State / put<Id>State and of the event name state.<id>.changed. '
            + 'Use a lowerCamel identifier, e.g. "myState".',
        );
    }

    return new StateBuilder(id, { id, shared: false, middlewares: [] });
}
