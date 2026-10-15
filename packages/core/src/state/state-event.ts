/**
 * State Event
 *
 * The two events a state derives: the change signal the app emits
 * (`state.changed`, in-process) and the SSE event the browser receives
 * (`state.<id>.changed`). Between them sits the one rule of the module — a
 * value is only ever what `read()` returned, re-read here, never computed from
 * the signal.
 */

import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { defineEvent } from '@spfn/core/event';
import type { EventDef, FramePredicate, SubscribePredicate } from '@spfn/core/event';
import { logger } from '@spfn/core/logger';
import { stateBinding, type StateBinding } from './state-binding';
import type { RoutableState, StateCallContext, StateDefinition } from './types';

const stateLogger = logger.child('@spfn/core:state');

/** `{ at, value, data? }` as a response and a frame carry it. */
export interface Snapshot
{
    at: string;
    value: unknown;
    data?: unknown;
}

type Key = Record<string, string>;

type FramePayload = Snapshot & { key?: Key; subject?: string };

/** The wire name of a state's SSE event. */
export function stateEventName(id: string): string
{
    return `state.${id}.changed`;
}

/**
 * The key fields of `keySchema` taken from `source`, or `undefined` when any
 * is absent. Key fields are strings by construction (`.key()` refuses others),
 * so a query value and a payload field compare as they are.
 */
export function pickKey(keySchema: TObject, source: Record<string, unknown>): Key | undefined
{
    const key: Key = {};

    for (const field of Object.keys(keySchema.properties))
    {
        const value = source[field];
        if (typeof value !== 'string')
        {
            return undefined;
        }
        key[field] = value;
    }

    return key;
}

/** What `read()` receives: a shared state's value does not depend on the subject, so it gets none. */
export function readContext(def: StateDefinition, subject: string | undefined, principal: unknown, key?: Key): StateCallContext
{
    if (!def.key)
    {
        return { subject, principal };
    }

    return def.shared ? { principal, key } : { subject, principal, key };
}

/** What `.canRead()` / `.canWrite()` receive. */
export function permissionContext(def: StateDefinition, subject: string, principal: unknown, key?: Key): StateCallContext
{
    return def.key ? { subject, principal, key } : { subject, principal };
}

/**
 * The router binding of a state, or a refusal: an unrouted builder has no
 * subscriber for its signal and no schema to check a read against.
 */
export function requireBinding(def: StateDefinition, what: string): StateBinding
{
    const binding = stateBinding(def);

    if (!binding)
    {
        throw new Error(
            `State "${def.id}" is in no defineStateRouter, so ${what} reaches nothing. `
            + 'The router subscribes the change signal and checks every read, and every builder call returns a new '
            + 'builder — an earlier one is never routed. Group the state with defineStateRouter and export the builder '
            + 'instance you grouped.',
        );
    }

    return binding;
}

/** Refuse a `read()` result that is not what the state declares, naming the state, never the value. */
function assertResult(def: StateDefinition, binding: StateBinding, result: unknown): asserts result is Omit<Snapshot, 'at'>
{
    const error = Value.Errors(binding.resultSchema, result).First();

    if (error)
    {
        throw new Error(
            `State "${def.id}" read() returned a result its declaration does not allow: ${error.path || '(root)'} ${error.message}. `
            + 'Every response and frame is checked against .value() and .data(), so a client never receives a value the '
            + 'contract does not describe. Return { value'
            + `${def.data ? ', data' : ''} } as declared.`,
        );
    }
}

/**
 * Read the current value and check it against the declaration. `at` is taken
 * before `read()` starts, so a frame is never stamped later than the data it
 * carries.
 */
export async function readSnapshot(def: StateDefinition, ctx: StateCallContext, at = new Date().toISOString()): Promise<Snapshot>
{
    const binding = requireBinding(def, 'a read');
    const result = await def.read!(ctx);
    assertResult(def, binding, result);

    return { at, ...result };
}

/**
 * The frame for a snapshot. A copy: the response keeps the snapshot itself, so
 * neither a handler mutating what it returned nor a subscriber mutating the
 * payload changes the other.
 */
function toFrame(def: StateDefinition, snapshot: Snapshot, subject: string | undefined, key: Key | undefined): FramePayload
{
    const frame: FramePayload = structuredClone(snapshot);

    if (def.key)
    {
        frame.key = { ...key };
    }

    if (!(def.key && def.shared))
    {
        frame.subject = subject;
    }

    return frame;
}

/** Read the value for one subject and key, send it as one frame, and return the snapshot. */
export async function readAndPublish(
    def: StateDefinition,
    event: EventDef<any>,
    subject: string | undefined,
    key: Key | undefined,
    principal: unknown,
): Promise<Snapshot>
{
    const snapshot = await readSnapshot(def, readContext(def, subject, principal, key));
    await event.emit(toFrame(def, snapshot, subject, key));

    return snapshot;
}

// ============================================================================
// The derived SSE event
// ============================================================================

function framePayloadSchema(def: StateDefinition): TObject
{
    return Type.Object({
        at: Type.String(),
        value: def.value ?? Type.Unknown(),
        ...(def.data ? { data: def.data } : {}),
        ...(def.key ? { key: def.key } : {}),
        ...(def.key && def.shared ? {} : { subject: Type.String() }),
    });
}

/**
 * `canRead` translated to the connect: the connection declares its key in the
 * connect query. A key field absent from it denies, without asking `canRead` —
 * there is no key to ask about.
 */
function subscribePredicate(def: StateDefinition): SubscribePredicate
{
    return async ({ subject, principal, request }) =>
    {
        if (!def.key)
        {
            return def.canRead ? def.canRead({ subject, principal }) : true;
        }

        const key = pickKey(def.key, request.query);

        return key !== undefined && def.canRead !== undefined && def.canRead({ subject, principal, key });
    };
}

/**
 * A frame reaches a connection on the key it declared, and only its own
 * subject's value unless shared. Never a connection without a subject: on a
 * stream without auth `canSubscribe` is never asked, so `canRead` would be
 * skipped.
 */
function framePredicate(def: StateDefinition): FramePredicate<FramePayload>
{
    const fields = def.key ? Object.keys(def.key.properties) : [];

    return (payload, { subject, request }) =>
        subject !== undefined
        && fields.every(field => payload.key?.[field] === request.query[field])
        && (payload.subject === undefined || payload.subject === subject);
}

/** The SSE event `state.<id>.changed`, its permissions and contract set once, here. */
export function createStateEvent(def: StateDefinition): EventDef<any>
{
    const event = defineEvent(stateEventName(def.id), framePayloadSchema(def))
        .canSubscribe(subscribePredicate(def))
        .filter(framePredicate(def) as FramePredicate<unknown>);

    if (def.contract)
    {
        const { since, deprecatedIn, removedIn } = def.contract;
        event.contract({
            since,
            ...(deprecatedIn ? { deprecatedIn } : {}),
            ...(removedIn ? { removedIn } : {}),
        });
    }

    return event;
}

// ============================================================================
// The change signal
// ============================================================================

/**
 * What a change signal must name: keyless `subject`; keyed the key fields, and
 * `subject` unless shared. Always a fresh object, never `def.key` itself: a key
 * declared `additionalProperties: false` would otherwise refuse every
 * `.changedBy()` payload carrying one more field. Extra fields are ignored.
 */
export function changedPayloadSchema(def: StateDefinition): TObject
{
    return Type.Object({
        ...def.key?.properties,
        ...(def.key && def.shared ? {} : { subject: Type.String() }),
    });
}

function assertChangedPayload(def: StateDefinition, schema: TSchema, payload: unknown): void
{
    const error = Value.Errors(schema, payload).First();

    if (error)
    {
        throw new Error(
            `${def.id}.changed.emit() refused its payload: ${error.path || '(root)'} ${error.message}. `
            + 'The module re-reads exactly the subject and key the payload names, so a missing field cannot be guessed. '
            + `Pass ${def.key ? 'every key field' : 'the subject'}${def.key && !def.shared ? ' and the subject' : ''}.`,
        );
    }
}

/**
 * The change signal `state.changed`: a plain in-process event whose `emit`
 * refuses a builder no router grouped, and validates its payload, since the
 * module reads the state the payload names.
 */
export function createChangedSignal(def: StateDefinition): EventDef<any>
{
    const schema = changedPayloadSchema(def);
    const event = defineEvent(`state.${def.id}.signal`, schema);
    const emit = event.emit;

    event.emit = (async (payload: unknown) =>
    {
        requireBinding(def, `${def.id}.changed.emit()`);
        assertChangedPayload(def, schema, payload);
        await emit(payload as Record<string, unknown>);
    }) as EventDef<any>['emit'];

    return event;
}

/** Subject and key a signal payload names; a shared state's names no subject. */
function signalTarget(def: StateDefinition, payload: Record<string, unknown>): { subject?: string; key?: Key }
{
    const subject = def.key && def.shared ? undefined : payload.subject as string;

    return { subject, key: def.key ? pickKey(def.key, payload) : undefined };
}

/**
 * Re-read and publish for one signal. A `read()` that throws or returns an
 * undeclared result sends nothing and is logged — the signal came after a
 * commit the app already made, so there is nobody to throw to.
 */
async function onSignal(state: RoutableState, payload: Record<string, unknown>): Promise<void>
{
    const { subject, key } = signalTarget(state._definition, payload);

    try
    {
        await readAndPublish(state._definition, state._event, subject, key, undefined);
    }
    catch (error)
    {
        stateLogger.warn(`State "${state.id}" could not be re-read on its change signal; no frame was sent`, {
            state: state.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * A `.changedBy()` event's payload, checked as the state's own `emit` checks
 * its signal. The app emitted it, so a payload missing a field is logged and
 * skipped rather than thrown.
 */
async function onChangedBy(state: RoutableState, event: EventDef<any>, schema: TObject, payload: unknown): Promise<void>
{
    const error = Value.Errors(schema, payload).First();

    if (error)
    {
        stateLogger.warn(`State "${state.id}" skipped an "${event.name}" payload that names no value to re-read`, {
            state: state.id,
            event: event.name,
            error: `${error.path || '(root)'} ${error.message}`,
        });

        return;
    }

    await onSignal(state, payload as Record<string, unknown>);
}

/**
 * Re-read and publish on every signal of `state` and every event it lists in
 * `.changedBy()`, on the pod that emitted it only. A `.changedBy()` event in an
 * event router is cached, so a plain subscriber would re-read on every pod and
 * each would send its own frame; the derived state event is cached too, so the
 * emitting pod's one frame already reaches every pod. The `changed` signal
 * needs no such option: it is in no event router and never cached.
 */
export function subscribeChangeSignals(state: RoutableState): void
{
    const schema = changedPayloadSchema(state._definition);

    state.changed.subscribe(payload => onSignal(state, payload));
    state._definition.changedBy?.forEach(event =>
        event.subscribe(payload => onChangedBy(state, event, schema, payload), { localOnly: true }));
}
