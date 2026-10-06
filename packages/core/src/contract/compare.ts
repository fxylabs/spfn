/**
 * Backward-compatibility comparison
 *
 * Compares the contract a build produces against the newest released snapshot.
 *
 * The rule that shapes everything here: **optional runs in opposite directions
 * on the two sides.** A request is safe when the server grows more tolerant —
 * a new optional field, a dropped field, a requirement relaxed. A response is
 * safe when the server grows more certain — a new field, a value that used to
 * be optional now always present. Collapsing both into one rule would
 * necessarily get one of them backwards.
 *
 * | change                  | request | response |
 * |-------------------------|---------|----------|
 * | field added (optional)  | pass    | pass     |
 * | field added (required)  | refuse  | pass     |
 * | field removed           | pass    | refuse   |
 * | required → optional     | pass    | refuse   |
 * | optional → required     | refuse  | pass     |
 * | type changed            | refuse  | refuse   |
 *
 * An event payload flows server → client like a response, so it is compared
 * under the response rules by the same walk, and only the violation kinds are
 * renamed.
 */

import { stableStringify } from './stable-json';
import type {
    ContractDocument,
    ContractEvent,
    ContractEvents,
    ContractOperation,
    ContractRequest,
    ContractViolation,
    ContractViolationKind,
    JsonSchema,
} from './types';

/** Which side of the wire a schema sits on. The direction optional runs. */
type Side = 'request' | 'response';

export interface DocumentComparison
{
    violations: ContractViolation[];

    /**
     * Operations present in the baseline and gone from the current contract.
     *
     * Removal is not decided here: whether an operation may go depends on
     * whether any released app still calls it, which is a separate check.
     */
    removedOperations: string[];

    /**
     * Events present in the baseline and gone from the current contract —
     * decided against usage files exactly as a removed operation is.
     */
    removedEvents: string[];
}

const REQUEST_SECTIONS = ['params', 'query', 'body', 'formData', 'headers', 'cookies'] as const;

/**
 * The schema's own keywords, with the structural ones removed.
 *
 * Everything left — `type`, `format`, `enum`, `anyOf`, `minLength` — is
 * compared verbatim, so a narrowed constraint counts as a type change. That
 * refuses more than the table's "type changed" row strictly requires, and it
 * refuses in the recoverable direction: a build that stops is fixed by cutting
 * a new contract version, while a break that passes reaches a shipped app.
 */
function leafSignature(schema: JsonSchema): string
{
    const { properties, required, items, ...rest } = schema;

    return stableStringify(rest);
}

function propertiesOf(schema: JsonSchema): Record<string, JsonSchema>
{
    const properties = schema.properties;

    if (!properties || typeof properties !== 'object')
    {
        return {};
    }

    return properties as Record<string, JsonSchema>;
}

function requiredOf(schema: JsonSchema): Set<string>
{
    const required = schema.required;

    if (!Array.isArray(required))
    {
        return new Set();
    }

    return new Set(required.filter((name): name is string => typeof name === 'string'));
}

/**
 * Would a client that sends nothing here now be refused?
 *
 * Only this level counts. A required field nested inside an optional object is
 * required *if* that object is sent, and a client that never sends it is fine.
 */
function requiresClientToSend(schema: JsonSchema): boolean
{
    if (schema.type !== 'object')
    {
        return true;
    }

    return requiredOf(schema).size > 0;
}

interface CompareContext
{
    operation: string;
    side: Side;
    violations: ContractViolation[];
}

function report(
    ctx: CompareContext,
    kind: ContractViolation['kind'],
    location: string,
    detail: string,
): void
{
    ctx.violations.push({ kind, operation: ctx.operation, location, detail });
}

/**
 * Compare one schema position across versions.
 *
 * `before`/`after` may be absent: a whole request section can appear or vanish,
 * and so can a nested field.
 */
function compareSchema(
    before: JsonSchema | undefined,
    after: JsonSchema | undefined,
    location: string,
    ctx: CompareContext,
): void
{
    if (!before && !after)
    {
        return;
    }

    if (before && !after)
    {
        if (ctx.side === 'response')
        {
            report(ctx, 'response.field-removed', location, 'the response no longer carries this, and old clients read it');
        }

        // A request the server stopped reading is a request old clients may still send.
        return;
    }

    if (!before && after)
    {
        if (ctx.side === 'request' && requiresClientToSend(after))
        {
            report(
                ctx,
                'request.required-field-added',
                location,
                'this is new and mandatory, so every already-released client is refused',
            );
        }

        // A response that carries more is a response old clients ignore the rest of.
        return;
    }

    const from = before!;
    const to = after!;

    if (leafSignature(from) !== leafSignature(to))
    {
        report(
            ctx,
            ctx.side === 'request' ? 'request.type-changed' : 'response.type-changed',
            location,
            `the declared type changed: ${leafSignature(from)} → ${leafSignature(to)}`,
        );

        return;
    }

    compareProperties(from, to, location, ctx);
    compareSchema(
        from.items as JsonSchema | undefined,
        to.items as JsonSchema | undefined,
        `${location}[]`,
        ctx,
    );
}

function compareProperties(from: JsonSchema, to: JsonSchema, location: string, ctx: CompareContext): void
{
    const beforeProperties = propertiesOf(from);
    const afterProperties = propertiesOf(to);
    const beforeRequired = requiredOf(from);
    const afterRequired = requiredOf(to);

    for (const [name, beforeSchema] of Object.entries(beforeProperties))
    {
        const where = `${location}.${name}`;
        const afterSchema = afterProperties[name];

        compareSchema(beforeSchema, afterSchema, where, ctx);

        if (!afterSchema)
        {
            continue;
        }

        const wasRequired = beforeRequired.has(name);
        const isRequired = afterRequired.has(name);

        if (ctx.side === 'request' && !wasRequired && isRequired)
        {
            report(ctx, 'request.field-became-required', where, 'clients that never sent this are now refused');
        }

        if (ctx.side === 'response' && wasRequired && !isRequired)
        {
            report(ctx, 'response.field-became-optional', where, 'clients that counted on this always arriving now break');
        }
    }

    // An added field is judged at its own level only. Optional means an old
    // client that omits it still passes, whatever the field contains.
    for (const name of Object.keys(afterProperties))
    {
        if (beforeProperties[name])
        {
            continue;
        }

        if (ctx.side === 'request' && afterRequired.has(name))
        {
            report(
                ctx,
                'request.required-field-added',
                `${location}.${name}`,
                'this is new and mandatory, so every already-released client is refused',
            );
        }
    }
}

function compareRequestSections(
    before: ContractRequest,
    after: ContractRequest,
    prefix: string,
    ctx: CompareContext,
): void
{
    for (const section of REQUEST_SECTIONS)
    {
        compareSchema(before[section], after[section], `${prefix}.${section}`, ctx);
    }
}

/** Compare one operation that exists on both sides. */
export function compareOperation(before: ContractOperation, after: ContractOperation): ContractViolation[]
{
    const violations: ContractViolation[] = [];

    if (before.path !== after.path)
    {
        violations.push({
            kind: 'operation.path-changed',
            operation: before.name,
            detail: `path moved ${before.path} → ${after.path}; released clients call the old one`,
        });
    }

    if (before.method !== after.method)
    {
        violations.push({
            kind: 'operation.method-changed',
            operation: before.name,
            detail: `method changed ${before.method} → ${after.method}; released clients send the old one`,
        });
    }

    const requestCtx: CompareContext = { operation: before.name, side: 'request', violations };
    compareRequestSections(before.request, after.request, 'request', requestCtx);
    compareRequestSections(before.interceptor, after.interceptor, 'interceptor', requestCtx);

    compareSchema(
        before.response,
        after.response,
        'response',
        { operation: before.name, side: 'response', violations },
    );

    return violations;
}

/** What a response-side violation is called when the schema is an event payload. */
const PAYLOAD_KINDS: Partial<Record<ContractViolationKind, ContractViolationKind>> = {
    'response.field-removed': 'event.payload.field-removed',
    'response.field-became-optional': 'event.payload.field-became-optional',
    'response.type-changed': 'event.payload.type-changed',
};

/** Compare one event that exists on both sides, under the response rules. */
function compareEvent(before: ContractEvent, after: ContractEvent): ContractViolation[]
{
    const found: ContractViolation[] = [];

    compareSchema(before.payload, after.payload, 'payload', { operation: before.name, side: 'response', violations: found });

    return found.map(({ kind, operation, ...rest }) => ({ ...rest, kind: PAYLOAD_KINDS[kind] ?? kind, event: operation }));
}

/** A stream path or auth mode that moved breaks every released subscriber at once. */
function compareStream(before: ContractEvents, after: ContractEvents): ContractViolation[]
{
    const violations: ContractViolation[] = [];

    if (before.streamPath !== after.streamPath)
    {
        violations.push({
            kind: 'events.stream-path-changed',
            detail: `stream path moved ${before.streamPath} → ${after.streamPath}; released clients open the old one`,
        });
    }

    if (before.auth !== after.auth)
    {
        violations.push({
            kind: 'events.auth-changed',
            detail: `stream auth changed ${before.auth} → ${after.auth}; released clients connect the old way`,
        });
    }

    return violations;
}

/**
 * Compare the events sections.
 *
 * A baseline without one promised no events, so nothing in `after` can break
 * it. A current document without one removed every event the baseline had.
 */
function compareEvents(
    before: ContractEvents | undefined,
    after: ContractEvents | undefined,
): Pick<DocumentComparison, 'violations' | 'removedEvents'>
{
    if (!before)
    {
        return { violations: [], removedEvents: [] };
    }

    if (!after)
    {
        return { violations: [], removedEvents: before.items.map(item => item.name) };
    }

    const current = new Map(after.items.map(item => [item.name, item]));
    const violations = compareStream(before, after);
    const removedEvents: string[] = [];

    for (const item of before.items)
    {
        const now = current.get(item.name);

        if (!now)
        {
            removedEvents.push(item.name);
            continue;
        }

        violations.push(...compareEvent(item, now));
    }

    return { violations, removedEvents };
}

/**
 * Compare a released contract against the one this build produced.
 *
 * Operations and events that are new in `after` need no check — nothing has
 * been promised about them yet.
 */
export function compareDocuments(before: ContractDocument, after: ContractDocument): DocumentComparison
{
    const current = new Map(after.operations.map(operation => [operation.name, operation]));
    const violations: ContractViolation[] = [];
    const removedOperations: string[] = [];

    for (const operation of before.operations)
    {
        const now = current.get(operation.name);

        if (!now)
        {
            removedOperations.push(operation.name);
            continue;
        }

        violations.push(...compareOperation(operation, now));
    }

    const events = compareEvents(before.events, after.events);

    return {
        violations: [...violations, ...events.violations],
        removedOperations,
        removedEvents: events.removedEvents,
    };
}
