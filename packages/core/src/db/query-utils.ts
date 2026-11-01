/**
 * Query Utility Functions
 *
 * Common utilities for building database queries.
 * Used by both helpers.ts and repository.ts to avoid code duplication.
 *
 * @internal
 */

import type { SQL } from 'drizzle-orm';
import { eq, and, sql, count as sqlCount } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { env } from '@spfn/core/config';

/**
 * Check if value is a Drizzle SQL wrapper
 *
 * @param value - Value to check
 * @returns true if value is a SQL wrapper
 *
 * @internal
 */
export function isSQLWrapper(value: unknown): value is SQL
{
    return value !== null &&
           typeof value === 'object' &&
           'queryChunks' in value;
}

/**
 * Build SQL WHERE clause from plain object
 *
 * Converts an object like `{ id: 1, name: 'test' }` into
 * SQL condition `id = 1 AND name = 'test'`.
 *
 * @param table - Drizzle table schema
 * @param where - Object with column-value pairs
 * @returns SQL condition or undefined if no valid conditions
 *
 * @internal
 */
export function buildWhereFromObject<T extends PgTable>(
    table: T,
    where: Record<string, unknown>,
): SQL | undefined
{
    const entries = Object.entries(where).filter(([_, value]) => value !== undefined);

    if (entries.length === 0)
    {
        return undefined;
    }

    const conditions = entries.map(([key, value]) =>
        eq((table as any)[key], value),
    );

    return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/**
 * Build a WHERE clause from either form a repository method accepts
 *
 * @param table - Drizzle table schema
 * @param where - Object with column-value pairs, or a SQL condition
 * @returns SQL condition or undefined when there is nothing to filter on
 *
 * @internal
 */
export function buildWhereClause<T extends PgTable>(
    table: T,
    where: Record<string, unknown> | SQL | undefined,
): SQL | undefined
{
    if (isSQLWrapper(where))
    {
        return where;
    }

    return where ? buildWhereFromObject(table, where) : undefined;
}

/** Options for a capped count. */
export interface CountOptions
{
    /**
     * Stop counting past this many rows. The result is at most `cap + 1`, and
     * `cap + 1` means "more than `cap`" — enough for a "1,000+" label without
     * counting the whole table on every list request.
     */
    cap?: number;
}

/**
 * Count rows, optionally stopping past `cap`
 *
 * A capped count reads at most `cap + 1` rows through a limited subquery:
 * `select count(*) from (select 1 from t where … limit cap + 1) capped`.
 *
 * @internal
 */
export async function countRows(
    db: { select: (...args: any[]) => any },
    table: PgTable,
    where: SQL | undefined,
    options?: CountOptions,
): Promise<number>
{
    const cap = options?.cap;

    if (cap === undefined)
    {
        const [result] = await db.select({ count: sqlCount() }).from(table).where(where);

        return Number(result?.count ?? 0);
    }

    assertCountCap(cap);

    const capped = db.select({ one: sql`1`.as('one') }).from(table).where(where).limit(cap + 1).as('capped');
    const [result] = await db.select({ count: sqlCount() }).from(capped);

    return Number(result?.count ?? 0);
}

function assertCountCap(cap: number): void
{
    if (!Number.isSafeInteger(cap) || cap <= 0)
    {
        throw new RangeError(`count cap must be a positive safe integer, received ${String(cap)}`);
    }
}

/**
 * Apply the DB_MAX_ROWS safety ceiling (0 = off) to a requested row limit
 *
 * With the ceiling set, an unbounded read is capped and an explicit limit is
 * clamped — guards against accidentally loading a whole large table.
 *
 * @internal
 */
export function clampRowLimit(requested: number | undefined): number | undefined
{
    const maxRows = env.DB_MAX_ROWS;

    return maxRows > 0 ? Math.min(requested ?? maxRows, maxRows) : requested;
}
