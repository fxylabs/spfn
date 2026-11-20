/**
 * Checks `spfn db push` leaves as they are (spfn/spfn#167)
 *
 * drizzle-kit's push matches a check by name and never alters one whose
 * expression changed (`mode !== "push"` in its diff): the database goes on
 * enforcing the old expression. These functions find such checks so push can
 * say so. They read only.
 *
 * PostgreSQL stores a check normalised (`"s" in ('a', 'b')` comes back as
 * `(s = ANY (ARRAY['a'::text, 'b'::text]))`), so the declared text and the
 * stored one never match as strings. Both are handed to PostgreSQL's own
 * parser and deparser instead: `EXPLAIN (VERBOSE, COSTS OFF) SELECT (<expr>)
 * FROM ONLY <table>` plans without running and prints the expression as one
 * normalised tree. Equal prints are the same expression; the plan around it is
 * the same for both, as only the selected expression differs.
 */

import { sql, type SQL } from 'drizzle-orm';

import { qualifiedName } from '../tenant/plan.js';
import type { PushConnection } from './drizzle.js';

/** A check as drizzle-kit renders it from the schema, and as push would create it */
export interface DeclaredCheck
{
    schema: string;
    table: string;
    name: string;
    value: string;
}

/** A declared check the database holds under its name with another expression, or one that could not be compared */
export interface UnchangedCheck extends DeclaredCheck
{
    /** PostgreSQL's error when the declared expression could not be compared; absent when it differs */
    error?: string;
}

type Db = PushConnection['db'];

/** Every check constraint in `schemas`, its expression as PostgreSQL stores it */
function storedChecks(schemas: string[]): SQL
{
    return sql`
        SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
               pg_catalog.pg_get_expr(con.conbin, con.conrelid) AS value
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'c' AND n.nspname = ANY(${sql.param(schemas)})`;
}

async function rows(db: Db, query: SQL): Promise<Record<string, unknown>[]>
{
    return (await db.execute(query)).rows;
}

/**
 * The checks the schema declares in `schemaFilter`'s schemas, rendered by
 * drizzle-kit as push renders them.
 */
export async function declaredChecks(imports: Record<string, unknown>, schemaFilter: string[]): Promise<DeclaredCheck[]>
{
    const { generateDrizzleJson } = await import('drizzle-kit/api-postgres');
    const { ddl } = await generateDrizzleJson(imports, undefined, schemaFilter);

    return ddl.flatMap(entity => entity.entityType === 'checks' && schemaFilter.includes(entity.schema)
        ? [{ schema: entity.schema, table: entity.table, name: entity.name, value: entity.value }]
        : []);
}

/**
 * The declared checks the database holds, on the same table under the same
 * name, with another expression — the ones push leaves as they are. A check the
 * database lacks is not among them: push creates it.
 */
export async function unchangedChecks(db: Db, declared: DeclaredCheck[]): Promise<UnchangedCheck[]>
{
    if (declared.length === 0)
    {
        return [];
    }

    const stored = await rows(db, storedChecks([...new Set(declared.map(check => check.schema))]));
    const storedValues = new Map(stored.map(row => [checkKey(row as unknown as DeclaredCheck), String(row.value)]));
    const unchanged: UnchangedCheck[] = [];

    for (const check of declared)
    {
        const storedValue = storedValues.get(checkKey(check));
        const comparison = storedValue === undefined ? undefined : await compare(db, check, storedValue);

        if (comparison)
        {
            unchanged.push(comparison);
        }
    }

    return unchanged;
}

function checkKey(check: Pick<DeclaredCheck, 'schema' | 'table' | 'name'>): string
{
    return JSON.stringify([check.schema, check.table, check.name]);
}

/** `check` as an unchanged check when its expression and `storedValue` differ or cannot be compared */
async function compare(db: Db, check: DeclaredCheck, storedValue: string): Promise<UnchangedCheck | undefined>
{
    const declared = await normalised(db, check, check.value);
    const stored = await normalised(db, check, storedValue);
    const error = declared.error ?? stored.error;

    if (error !== undefined)
    {
        return { ...check, error };
    }

    return declared.text === stored.text ? undefined : check;
}

/** `expression` as PostgreSQL prints it once parsed against `check`'s table, or the error it raised */
async function normalised(db: Db, check: DeclaredCheck, expression: string): Promise<{ text?: string; error?: string }>
{
    const table = qualifiedName({ schema: check.schema, name: check.table });

    return rows(db, sql.raw(`EXPLAIN (VERBOSE, COSTS OFF) SELECT (${expression}) FROM ONLY ${table}`))
        .then(
            lines => ({ text: lines.map(line => String(Object.values(line)[0])).join('\n') }),
            (error: Error & { cause?: Error }) => ({ error: (error.cause ?? error).message }),
        );
}
