/**
 * Tenant-scoped select builder
 *
 * Wraps a drizzle select builder so the tenant condition reaches every
 * tenant-aware table in the query without the caller writing it:
 *
 * - the `from` table gets it in WHERE, and a later `.where(cond)` becomes
 *   `cond AND tenant`;
 * - each `innerJoin` / `leftJoin` on a tenant-aware table gets it in that
 *   join's ON clause. ON, not WHERE: in WHERE a left join's unmatched rows
 *   would be filtered out and it would behave as an inner join.
 *
 * `_selectOfUser(userId)` builds the same wrapper with the user scope: the
 * `from` table must be a `visibleTo` tenancy table and gets `user = userId`,
 * a joined `visibleTo` table gets it in ON, an ordinary table joins without a
 * condition, and any other tenant-aware table is refused at `from` or `join`.
 *
 * Joins and set operators that would let rows outside the tenant through are
 * refused. The TypeScript type stays drizzle's own builder type.
 *
 * Building the query runs no tenant rule; executing it does. `await`,
 * `.then/.catch/.finally` and `.execute()` hand the query to a `ScopedExecution`
 * with every table it reads, which checks the tenant and picks the connection —
 * a short read-only transaction when a tenancy table is among them — and the
 * query runs there. `.prepare()` returns a statement that would run later,
 * outside those checks, so it is refused on a query that reads a tenancy table.
 * `toSQL()` is unchanged.
 *
 * @internal
 */

import { is, View } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
    optionalTenantCondition,
    optionalUserCondition,
    tenantCondition,
    userCondition,
    withCondition,
    type ConditionInput,
} from './condition';
import { findTenancyMarker } from './registry';

/**
 * A right or full join keeps rows the `from` table's tenant condition would
 * drop, a cross or lateral join has no ON clause to carry the condition, and a
 * set operator appends a query this wrapper never saw.
 *
 * select-members.test.ts lists every function member drizzle's select query
 * builder has and fails when one is neither scoped, refused here, nor known to
 * be unable to add rows — so a drizzle upgrade cannot add a way around this list.
 */
export const REFUSED_SELECT_MEMBERS: ReadonlySet<string> = new Set([
    'rightJoin',
    'fullJoin',
    'crossJoin',
    'leftJoinLateral',
    'innerJoinLateral',
    'crossJoinLateral',
    'union',
    'unionAll',
    'intersect',
    'intersectAll',
    'except',
    'exceptAll',
    // The standalone union(a, b) / intersect / except functions from
    // drizzle-orm/pg-core call this on the left query instead of the methods above.
    'addSetOperators',
    // The factories behind the join and set operator methods. TypeScript marks
    // them private, but at runtime they are reachable and return drizzle's raw
    // closures, which would add a join or a query unscoped.
    'createJoin',
    'createSetOperator',
]);

/** Members that execute the query; they run it through the ScopedExecution. */
export const EXECUTE_SELECT_MEMBERS: ReadonlySet<string> = new Set(['then', 'catch', 'finally', 'execute']);

/**
 * Members that prepare a statement to execute later, where no tenant rule
 * would run: refused on a query that reads a tenancy table, passed through
 * otherwise (part 1 behaviour for `tenantKey()`-only tables).
 */
export const PREPARE_SELECT_MEMBERS: ReadonlySet<string> = new Set(['prepare', '_prepare']);

const SCOPED_JOINS = new Set(['innerJoin', 'leftJoin']);

type AnyBuilder = Record<PropertyKey, any>;

/**
 * Runs a scoped query under the tenant rules. `tables` are the tables the query
 * reads; `execute` runs it on the database or transaction it is given.
 */
export type ScopedExecution = (
    tables: readonly PgTable[],
    execute: (db: unknown) => Promise<unknown>,
) => Promise<unknown>;

/** What a select is scoped to: the conditions its tables get, and the method named in its errors. */
export interface SelectScope
{
    readonly method: '_select' | '_selectOfUser';
    /** The WHERE condition of the `from` table; throws for a table the scope cannot read from. */
    from(table: PgTable): SQL;
    /** The ON condition of a joined table, or undefined; throws for a table the scope cannot join. */
    join(table: unknown): SQL | undefined;
}

/** `_select(tenantId)`: every tenant-aware table carries `tenant = tenantId`. */
export function tenantScope(tenantId: number): SelectScope
{
    return {
        method: '_select',
        from: (table) => tenantCondition(table, tenantId),
        join: (table) => optionalTenantCondition(table, tenantId),
    };
}

/** `_selectOfUser(userId)`: every `visibleTo` table carries `user = userId`. */
export function userScope(userId: number): SelectScope
{
    return {
        method: '_selectOfUser',
        from: (table) => userCondition(table, userId),
        join: (table) => optionalUserCondition(table, userId),
    };
}

/** Wrap `db.select(...)` so its `.from(table)` returns a query scoped by `scope`. */
export function scopeSelectBuilder<TBuilder extends object>(builder: TBuilder, scope: SelectScope, execution: ScopedExecution): TBuilder
{
    return new Proxy(builder, {
        get(target, prop, receiver)
        {
            if (prop !== 'from')
            {
                return Reflect.get(target, prop, receiver);
            }

            return (source: PgTable) => scopeSelectQuery((target as AnyBuilder).from(source), source, scope, execution);
        },
    });
}

function scopeSelectQuery(query: AnyBuilder, fromTable: PgTable, scope: SelectScope, execution: ScopedExecution): AnyBuilder
{
    const fromCondition = scope.from(fromTable);

    query.where(fromCondition);

    const proxy: AnyBuilder = new Proxy(query, {
        get: (target, prop) => scopedMember(target, prop, state),
    });
    const state: ScopeState = { proxy, fromCondition, scope, tables: [fromTable], execution };

    return proxy;
}

interface ScopeState
{
    readonly proxy: AnyBuilder;
    readonly fromCondition: SQL;
    readonly scope: SelectScope;
    /** The `from` table and every joined table, in order. */
    readonly tables: PgTable[];
    readonly execution: ScopedExecution;
}

function scopedMember(target: AnyBuilder, prop: PropertyKey, state: ScopeState): unknown
{
    if (typeof prop === 'string' && REFUSED_SELECT_MEMBERS.has(prop))
    {
        return () =>
        {
            throw new Error(`${prop}() is not supported on a TenantRepository ${state.scope.method}; write this query on this.readDb`);
        };
    }

    if (typeof prop === 'string' && EXECUTE_SELECT_MEMBERS.has(prop))
    {
        return executingMember(target, prop, state);
    }

    if (typeof prop === 'string' && PREPARE_SELECT_MEMBERS.has(prop) && state.tables.some(isTenancyTable))
    {
        return () =>
        {
            throw new Error(
                `${prop}() is not supported on a TenantRepository ${state.scope.method} that reads a tenancy table: the statement would run outside the tenant transaction; await the query instead`,
            );
        };
    }

    if (prop === 'where')
    {
        return (condition: ConditionInput) => chain(target.where(withCondition(condition, state.fromCondition)), target, state);
    }

    if (typeof prop === 'string' && SCOPED_JOINS.has(prop))
    {
        return (table: unknown, on: ConditionInput) =>
        {
            assertNotView(table, state.scope);

            const condition = state.scope.join(table);

            state.tables.push(table as PgTable);

            return chain(target[prop](table, withCondition(on, condition)), target, state);
        };
    }

    return passThrough(target, prop, state);
}

/**
 * A view looks like a table at the call site, but its columns are its own, so
 * the wrapper cannot tell which of them holds the tenant — a view over a
 * tenant-aware table would join every tenant's rows. `from(view)` already throws.
 */
function assertNotView(source: unknown, scope: SelectScope): void
{
    if (is(source, View))
    {
        throw new Error(
            `A view cannot be joined on a TenantRepository ${scope.method}; join the underlying table, or write this query on this.readDb`,
        );
    }
}

/**
 * `await query`, `.then`, `.catch`, `.finally` and `.execute()`: the query runs
 * where the ScopedExecution says, on a clone of the builder that differs only in
 * its session. drizzle reads the session from `this` when it executes, so the
 * clone runs the same SQL on that connection and the original stays untouched.
 */
function executingMember(target: AnyBuilder, prop: string, state: ScopeState): unknown
{
    const run = (placeholders?: Record<string, unknown>) =>
        state.execution(state.tables, (db) => onSessionOf(target, db).execute(placeholders));

    if (prop === 'execute')
    {
        return run;
    }

    if (prop === 'then')
    {
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            run().then(onFulfilled, onRejected);
    }

    if (prop === 'catch')
    {
        return (onRejected?: (reason: unknown) => unknown) => run().catch(onRejected);
    }

    return (onFinally?: () => void) => run().finally(onFinally);
}

function onSessionOf(query: AnyBuilder, db: unknown): AnyBuilder
{
    const session = (db as { session?: { prepareQuery?: unknown } }).session;

    if (typeof session?.prepareQuery !== 'function')
    {
        throw new Error('TenantRepository cannot find the session of the database a scoped select runs on; drizzle internals changed');
    }

    return Object.create(query, { session: { value: session } });
}

function isTenancyTable(table: PgTable): boolean
{
    return findTenancyMarker(table) !== undefined;
}

/** Keep chaining on the proxy when drizzle returns the builder itself. */
function chain(result: unknown, target: AnyBuilder, state: ScopeState): unknown
{
    return result === target ? state.proxy : result;
}

function passThrough(target: AnyBuilder, prop: PropertyKey, state: ScopeState): unknown
{
    const value = Reflect.get(target, prop, target);

    if (typeof value !== 'function')
    {
        return value;
    }

    return (...args: unknown[]) => chain(value.apply(target, args), target, state);
}
