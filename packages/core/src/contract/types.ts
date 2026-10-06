/**
 * Contract Document Types
 *
 * The shape of `contracts/current.json` and of a released snapshot under
 * `contracts/released/<version>.json`.
 *
 * An operation is identified by its **name** — the key it holds in the router —
 * not by method and path. That is what lets a changed path be reported as a
 * broken promise instead of read as one operation disappearing and another
 * appearing.
 */

import type { RouteAuthProfile } from '../route/contract';
import type { HttpMethod } from '../route/types';

/** A JSON Schema object as TypeBox serializes it. */
export type JsonSchema = Record<string, unknown>;

/** Request schemas, one per part of the request. */
export interface ContractRequest
{
    params?: JsonSchema;
    query?: JsonSchema;
    body?: JsonSchema;
    /**
     * Never produced: a contracted route carrying multipart is refused at
     * collection. Kept because a snapshot released before that rule may still
     * have one, and the compatibility comparison has to read it.
     */
    formData?: JsonSchema;
    headers?: JsonSchema;
    cookies?: JsonSchema;
}

/** One contracted operation. */
export interface ContractOperation
{
    /** Router key. The operation's identity across versions. */
    name: string;

    method: HttpMethod;
    path: string;

    /** Contract version the operation first appeared in. */
    since: string;

    auth: RouteAuthProfile;
    requiresSession: boolean;

    /** Present only when the operation is announced for removal. */
    deprecatedIn?: string;

    /**
     * Present only when the operation is gone.
     *
     * A client generated before this version may still call it, so the record
     * outlives the route: without it a caller sees an operation that simply
     * stopped existing, with nothing saying when or that it was announced.
     */
    removedIn?: string;

    /** What the client sends. */
    request: ContractRequest;

    /**
     * What middleware injects into the request before the handler sees it.
     *
     * A web client never sends these — an interceptor fills them in. A client
     * that talks to the route directly does send them, so they are part of the
     * published request shape and are compared under the request rules.
     */
    interceptor: ContractRequest;

    /** What the client reads. */
    response: JsonSchema;
}

/**
 * One contracted SSE event.
 *
 * On the wire the frame's `event:` field is `name`, and its `data` is the JSON
 * `{ "event": name, "data": payload }` with `payload` matching `payload` here.
 */
export interface ContractEvent
{
    /**
     * Router key — what a client subscribes to with `events=` and what the
     * frame's `event:` field carries. Not `defineEvent`'s first argument, which
     * never reaches the wire.
     */
    name: string;

    /** Contract version the event first appeared in. */
    since: string;

    /** Present only when the event is announced for removal. */
    deprecatedIn?: string;

    /** Present only when the event is gone. */
    removedIn?: string;

    /** The payload schema. Compared under the response rules: events flow server → client. */
    payload: JsonSchema;
}

/** How a client reaches the contracted events, and which events it may receive. */
export interface ContractEvents
{
    /** The path a client opens the stream on. */
    streamPath: string;

    /** The path a client posts to for a one-time stream token when `auth` is `tokenExchange`. */
    tokenPath: string;

    auth: 'none' | 'tokenExchange';

    /** Sorted by name. */
    items: ContractEvent[];
}

/**
 * How a client's version is judged against the server's.
 *
 * - `allOrNothing` — one contract version is the whole surface's pass or
 *   refusal. Right for an auth primitive, where admitting a client that agrees
 *   about part of the admission sequence and not the rest is not a safe middle.
 * - `perOperation` — availability is recorded per operation, so the verdict
 *   narrows to the operations a client actually calls. Deleting a response field
 *   from one route then stops blocking a client that never calls it.
 *
 * Stated rather than inferred: an app contract and @spfn/auth's mobile contract
 * share this format under different rules, and a consumer must not have to guess
 * which one it is holding.
 */
export type CompatibilityPolicy = 'allOrNothing' | 'perOperation';

/** The generated contract. */
export interface ContractDocument
{
    /** Shape version of this document, not of the API it describes. */
    documentVersion: 1;

    /**
     * The version this document publishes, from `.contractVersion()` on the
     * router. Absent when the router declares none — the gate still runs, but
     * nothing can be released or announced.
     */
    contractVersion?: string;

    /** Always `perOperation` for an app contract. See the type. */
    compatibilityPolicy: CompatibilityPolicy;

    /** Sorted by name, so the file does not churn on router reordering. */
    operations: ContractOperation[];

    /**
     * Present only when the app's event router contracts at least one event,
     * so an app without contracted events writes the document it always did.
     */
    events?: ContractEvents;
}

/** A released snapshot: the document plus the digest that pins it. */
export interface ContractSnapshot
{
    version: string;

    /** SHA-256 over the canonical encoding of `document`. */
    sha256: string;

    document: ContractDocument;
}

/** What a gate violation is about. */
export type ContractViolationKind =
    | 'operation.removed'
    | 'operation.path-changed'
    | 'operation.method-changed'
    | 'request.required-field-added'
    | 'request.field-became-required'
    | 'request.type-changed'
    | 'response.field-removed'
    | 'response.field-became-optional'
    | 'response.type-changed'
    | 'event.removed'
    | 'events.stream-path-changed'
    | 'events.auth-changed'
    | 'event.payload.field-removed'
    | 'event.payload.field-became-optional'
    | 'event.payload.type-changed'
    | 'usage.undecidable'
    | 'usage.still-called'
    | 'usage.still-subscribed'
    | 'snapshot.digest-mismatch';

/** One reason the build refuses. */
export interface ContractViolation
{
    kind: ContractViolationKind;

    /** Operation name, when the violation belongs to one. */
    operation?: string;

    /** Event name, when the violation belongs to one. */
    event?: string;

    /** Where inside the operation or event, e.g. `request.body.email`, `payload.userId`. */
    location?: string;

    /** What went wrong, in one line. */
    detail: string;
}
