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
 * stored one never match as strings. Both are handed to PostgreSQL instead, in
 * one statement per check: `EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) SELECT
 * (<declared>), (<stored>) FROM ONLY <table>` plans without running and prints
 * each expression as the planner holds it. A check is named when the two
 * prints differ: PostgreSQL reads the two expressions differently.
 *
 * That is the planner's reading, not the meaning. A numeric literal written
 * with another scale (`amount > 1` against a stored `amount > 1.0`) prints
 * differently although it means the same, and is named on every push; a
 * rewrite the planner folds (`x > 0 AND true` against a stored `x > 0`) prints
 * the same, and is not named, which is right as it means the same. No exact
 * normal form is to be had without a write: PostgreSQL deparses the stored
 * expression from its catalog node tree (`pg_get_expr`), and a declared one
 * gets a node tree only by creating an object (a view, a constraint), which a
 * read-only dry run refuses; `pg_node_tree` accepts no input. Nor would one
 * help the literal: `1` and `1.0` are different constants in the tree.
 *
 * For an `enumCheck` whose stored check enumCheck also wrote, the comparison
 * is exact: both sides print as the column against one text-array constant of
 * the values, sorted and once each, so the prints differ exactly when the
 * value sets do. A stored check listing the same values in another order is
 * named.
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

/** A declared check the database holds under its name with an expression PostgreSQL reads differently, or one that could not be compared */
export interface UnchangedCheck extends DeclaredCheck
{
    /** PostgreSQL's error when the declared expression names a column the table does not have (yet): it differs */
    absentColumn?: string;
    /** PostgreSQL's error when the declared expression could not be compared for another reason */
    error?: string;
}

/** SQLSTATE undefined_column */
const UNDEFINED_COLUMN = '42703';

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
 * name, with an expression PostgreSQL reads differently — the ones push leaves
 * as they are — and those it could not compare. A check the database lacks is
 * not among them: push creates it. One statement lists the stored checks, then
 * one per stored check compares it, so a check that cannot be compared hides
 * no other.
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

type PgError = Error & { code?: string };

/** The planner's print of each selected expression, from `EXPLAIN (FORMAT JSON)`'s one row */
type ExplainJson = [{ Plan: { Output: string[] } }];

/**
 * `check` as an unchanged check when PostgreSQL reads its expression and
 * `storedValue` differently, or cannot read the declared one against the table
 */
async function compare(db: Db, check: DeclaredCheck, storedValue: string): Promise<UnchangedCheck | undefined>
{
    return rows(db, sql.raw(`EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) SELECT (${check.value}), (${storedValue}) `
        + `FROM ONLY ${qualifiedName({ schema: check.schema, name: check.table })}`)).then(
        ([row]) =>
        {
            const [declared, stored] = (Object.values(row)[0] as ExplainJson)[0].Plan.Output;

            return declared === stored ? undefined : check;
        },
        (error: PgError & { cause?: PgError }) => uncompared(check, error.cause ?? error),
    );
}

/**
 * `check` with the error PostgreSQL raised on the declared expression (the
 * stored one is read back from this table). A column the table does not have
 * means the two differ: the stored expression cannot name it.
 */
function uncompared(check: DeclaredCheck, error: PgError): UnchangedCheck
{
    return error.code === UNDEFINED_COLUMN
        ? { ...check, absentColumn: error.message }
        : { ...check, error: error.message };
}
