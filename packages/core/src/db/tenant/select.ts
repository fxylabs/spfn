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
 * Joins and set operators that would let rows outside the tenant through are
 * refused. The TypeScript type stays drizzle's own builder type.
 *
 * @internal
 */

import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { optionalTenantCondition, tenantCondition, withCondition, type ConditionInput } from './condition';

/**
 * A right or full join keeps rows the `from` table's tenant condition would
 * drop, a cross or lateral join has no ON clause to carry the condition, and a
 * set operator appends a query this wrapper never saw.
 */
const REFUSED_METHODS = new Set([
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
]);

const SCOPED_JOINS = new Set(['innerJoin', 'leftJoin']);

type AnyBuilder = Record<PropertyKey, any>;

/** Wrap `db.select(...)` so its `.from(table)` returns a tenant-scoped query. */
export function scopeSelectBuilder<TBuilder extends object>(builder: TBuilder, tenantId: number): TBuilder
{
    return new Proxy(builder, {
        get(target, prop, receiver)
        {
            if (prop !== 'from')
            {
                return Reflect.get(target, prop, receiver);
            }

            return (source: PgTable) => scopeSelectQuery((target as AnyBuilder).from(source), source, tenantId);
        },
    });
}

function scopeSelectQuery(query: AnyBuilder, fromTable: PgTable, tenantId: number): AnyBuilder
{
    const fromCondition = tenantCondition(fromTable, tenantId);

    query.where(fromCondition);

    const proxy: AnyBuilder = new Proxy(query, {
        get: (target, prop) => scopedMember(target, prop, { proxy, fromCondition, tenantId }),
    });

    return proxy;
}

interface ScopeState
{
    readonly proxy: AnyBuilder;
    readonly fromCondition: SQL;
    readonly tenantId: number;
}

function scopedMember(target: AnyBuilder, prop: PropertyKey, state: ScopeState): unknown
{
    if (typeof prop === 'string' && REFUSED_METHODS.has(prop))
    {
        return () =>
        {
            throw new Error(`${prop}() is not supported on a TenantRepository _select; write this query on this.readDb`);
        };
    }

    if (prop === 'where')
    {
        return (condition: ConditionInput) => chain(target.where(withCondition(condition, state.fromCondition)), target, state);
    }

    if (typeof prop === 'string' && SCOPED_JOINS.has(prop))
    {
        return (table: unknown, on: ConditionInput) =>
            chain(target[prop](table, withCondition(on, optionalTenantCondition(table, state.tenantId))), target, state);
    }

    return passThrough(target, prop, state);
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
