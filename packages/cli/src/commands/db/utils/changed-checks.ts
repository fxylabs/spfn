/**
 * Checks `spfn db push` replaces (#442, spfn/spfn#167)
 *
 * drizzle-kit's push matches a check by name and never alters one whose
 * expression changed (`mode !== "push"` in its diff): PostgreSQL stores a check
 * normalised (`"s" in ('a', 'b')` is read back as
 * `("s" = ANY (ARRAY['a'::text, 'b'::text]))`), so the declared text and the
 * stored one cannot be compared as strings.
 *
 * Push compares them with PostgreSQL's own normalisation instead, and never
 * touches the table to do so. For each declared check the table holds under
 * its name, a temporary table is built from that table's declared columns —
 * the column types the push leaves, not the ones the table has now — the
 * declared check is added to it, and read back with `pg_get_expr` as the
 * stored one is: the same parse, the same deparse. It all happens in a
 * transaction that always rolls back, and the temporary table belongs to the
 * comparison alone: no lock on the live table, no name it could already use.
 * Equal strings mean PostgreSQL holds the declared expression; a check whose
 * strings differ is replaced by one statement,
 * `ALTER TABLE … DROP CONSTRAINT IF EXISTS …, ADD CONSTRAINT …`, appended after
 * drizzle-kit's statements; its `ADD` re-checks every row.
 *
 * A check that cannot be compared before the push is left as it is and named,
 * with the reason and PostgreSQL's message: the target refuses the temporary
 * table (a read-only database, a standby), or PostgreSQL refuses the declared
 * check while this push creates or changes a type. PostgreSQL has no temporary
 * type, and push cannot tell what a declared expression depends on (a column of
 * the type, a cast inside it), so the comparison is defined only once every type
 * exists as declared — the next push compares it. With no type to create or
 * change, a declared check PostgreSQL refuses is wrong as declared, and ends the
 * plan with its error.
 */

import { sql } from 'drizzle-orm';

import { qualifiedName, quoteIdent } from '../tenant/plan.js';
import { describeFailure, failingIn } from '../../../utils/database-failure.js';
import type { PushConnection } from './drizzle.js';

/** An object of the schema as drizzle-kit renders it for push */
export type DeclaredEntity = Awaited<ReturnType<typeof import('drizzle-kit/api-postgres')['generateDrizzleJson']>>['ddl'][number];

type DeclaredColumn = Extract<DeclaredEntity, { entityType: 'columns' }>;

type DeclaredEnum = Extract<DeclaredEntity, { entityType: 'enums' }>;

/** A check as drizzle-kit renders it from the schema, and as push would create it */
export interface DeclaredCheck
{
    schema: string;
    table: string;
    name: string;
    value: string;
}

/** A check the database holds that push could not compare before applying, so leaves as it is */
export interface UncomparedCheck
{
    schema: string;
    table: string;
    name: string;
    reason: string;
}

/** What comparing the declared checks with the stored ones gives the plan */
export interface CheckComparison
{
    /** One statement per check whose declared expression PostgreSQL stores differently */
    replacements: string[];
    uncompared: UncomparedCheck[];
}

/** One check compared: its declared expression as PostgreSQL stores it, or why it was not compared */
type Outcome = { value: string } | { reason: string };

type Db = PushConnection['db'];

type InRolledBackTransaction = PushConnection['inRolledBackTransaction'];

/** The table a declared check is compared on: in the session's temporary schema, rolled back with its transaction */
const COMPARED_TABLE = 'pg_temp.spfn_push_compared';

/** The objects the schema declares in `schemaFilter`'s schemas, rendered by drizzle-kit as push renders them */
export async function declaredEntities(imports: Record<string, unknown>, schemaFilter: string[]): Promise<DeclaredEntity[]>
{
    const { generateDrizzleJson } = await import('drizzle-kit/api-postgres');
    const { ddl } = await generateDrizzleJson(imports, undefined, schemaFilter);

    return ddl.filter(entity => 'schema' in entity && schemaFilter.includes(String(entity.schema)));
}

/**
 * Compare each declared check the database holds, on the same table under the
 * same name, with the stored one. A check the database lacks is not compared:
 * push creates it. A declared expression PostgreSQL refuses over the declared
 * columns ends the plan with its error, unless this push creates or changes a
 * type: then the check is not compared.
 */
export async function compareChecks(
    db: Db,
    inRolledBackTransaction: InRolledBackTransaction,
    entities: DeclaredEntity[],
): Promise<CheckComparison>
{
    const declared = entities.flatMap(entity => entity.entityType === 'checks'
        ? [{ schema: entity.schema, table: entity.table, name: entity.name, value: entity.value }]
        : []);
    const stored = declared.length === 0 ? new Map<string, string>() : await storedChecks(db, declared);
    const existing = declared.filter(check => stored.has(checkKey(check)));
    const changedTypes = existing.length === 0 ? [] : await typesThisPushChanges(db, entities);
    const comparison: CheckComparison = { replacements: [], uncompared: [] };

    for (const check of existing)
    {
        const columns = entities.filter((entity): entity is DeclaredColumn => entity.entityType === 'columns' && onTableOf(check, entity));
        const outcome = await compared(inRolledBackTransaction, check, columns, changedTypes);

        if ('reason' in outcome)
        {
            comparison.uncompared.push({ schema: check.schema, table: check.table, name: check.name, reason: outcome.reason });
        }
        else if (outcome.value !== stored.get(checkKey(check)))
        {
            comparison.replacements.push(replacementOf(check));
        }
    }

    return comparison;
}

/** Every check constraint in the declared checks' schemas, its expression as PostgreSQL stores it, by schema, table and name */
async function storedChecks(db: Db, declared: DeclaredCheck[]): Promise<Map<string, string>>
{
    const { rows } = await db.execute(sql`
        SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
               pg_catalog.pg_get_expr(con.conbin, con.conrelid) AS value
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'c' AND n.nspname = ANY(${sql.param([...new Set(declared.map(check => check.schema))])})`);

    return new Map(rows.map((row: Record<string, unknown>) => [checkKey(row as unknown as DeclaredCheck), String(row.value)]));
}

function checkKey(check: Pick<DeclaredCheck, 'schema' | 'table' | 'name'>): string
{
    return JSON.stringify([check.schema, check.table, check.name]);
}

function onTableOf(check: DeclaredCheck, entity: { schema: string; table: string }): boolean
{
    return entity.schema === check.schema && entity.table === check.table;
}

/** The declared enums the database lacks, or holds with other values, each as `"schema"."name"` */
async function typesThisPushChanges(db: Db, entities: DeclaredEntity[]): Promise<string[]>
{
    const enums = entities.filter((entity): entity is DeclaredEnum => entity.entityType === 'enums');
    const { rows } = enums.length === 0 ? { rows: [] } : await db.execute(sql`
        SELECT n.nspname AS schema, t.typname AS name, json_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = ANY(${sql.param([...new Set(enums.map(declared => declared.schema))])})
        GROUP BY n.nspname, t.typname`);
    const storedValues = new Map(rows.map((row: Record<string, unknown>) => [typeKey(row.schema, row.name), JSON.stringify(row.values)]));

    return enums
        .filter(declared => storedValues.get(typeKey(declared.schema, declared.name)) !== JSON.stringify(declared.values))
        .map(declared => qualifiedName(declared));
}

function typeKey(schema: unknown, name: unknown): string
{
    return JSON.stringify([schema, name]);
}

/**
 * `check`'s expression as PostgreSQL stores it over its table's declared
 * `columns`, or why it cannot be read before the push.
 */
async function compared(
    inRolledBackTransaction: InRolledBackTransaction,
    check: DeclaredCheck,
    columns: DeclaredColumn[],
    changedTypes: string[],
): Promise<Outcome>
{
    return inRolledBackTransaction(async tx =>
    {
        const refusal = await tx.execute(sql.raw(`CREATE TEMPORARY TABLE ${COMPARED_TABLE} (${columns.map(columnDefinition).join(', ')})`))
            .then(() => undefined, (error: unknown) => `the comparison table could not be created: ${messageOf(error)}${typesNote(changedTypes)}`);

        return refusal ? { reason: refusal } : declaredRendering(tx, check, changedTypes);
    });
}

/**
 * `check` added to the comparison table, read back as PostgreSQL stores it.
 * PostgreSQL refusing it is the plan's error, naming the check (`In: …`) above
 * the statement that carries its expression — unless this push creates or
 * changes a type the check may need: then it is not compared.
 */
async function declaredRendering(tx: Db, check: DeclaredCheck, changedTypes: string[]): Promise<Outcome>
{
    const adding = tx.execute(sql.raw(`ALTER TABLE ${COMPARED_TABLE} ADD CONSTRAINT ${quoteIdent(check.name)} CHECK (${check.value})`));
    const refusal = changedTypes.length === 0
        ? await failingIn(`check ${quoteIdent(check.name)} on ${qualifiedName({ schema: check.schema, name: check.table })}, as declared`, adding)
            .then(() => undefined)
        : await adding.then(() => undefined, (error: unknown) => `PostgreSQL refused it as declared: ${messageOf(error)}${typesNote(changedTypes)}`);

    if (refusal)
    {
        return { reason: refusal };
    }

    const { rows: [row] } = await tx.execute(sql.raw(`
        SELECT pg_catalog.pg_get_expr(conbin, conrelid) AS value FROM pg_catalog.pg_constraint
        WHERE conrelid = '${COMPARED_TABLE}'::regclass AND contype = 'c'`));

    return { value: String(row.value) };
}

function messageOf(error: unknown): string
{
    return describeFailure(error, undefined).split('\n')[0];
}

/** Why a refusal may be this push's own doing: the types it creates or changes do not exist as declared yet */
function typesNote(changedTypes: string[]): string
{
    return changedTypes.length === 0
        ? ''
        : `; this push creates or changes ${changedTypes.join(', ')}, which the check may need — the next push compares it`;
}

function columnDefinition(column: DeclaredColumn): string
{
    return `${quoteIdent(column.name)} ${typeOf(column)}`;
}

/** A column's type as drizzle-kit writes it in `CREATE TABLE` (createTableConvertor, api-postgres.mjs) */
function typeOf(column: DeclaredColumn): string
{
    const schema = column.typeSchema && column.typeSchema !== 'public' ? `${quoteIdent(column.typeSchema)}.` : '';

    return `${schema}${column.typeSchema ? quoteIdent(column.type) : column.type}${'[]'.repeat(column.dimensions)}`;
}

/**
 * One statement, so the drop never applies without the add (see
 * sql-classifier). It runs after drizzle-kit's statements, one of which may
 * have removed the old check already (a dropped column takes its checks with
 * it), so it states the end state: the old check absent, the declared present.
 */
function replacementOf(check: DeclaredCheck): string
{
    const name = quoteIdent(check.name);

    return `ALTER TABLE ${qualifiedName({ schema: check.schema, name: check.table })} `
        + `DROP CONSTRAINT IF EXISTS ${name}, ADD CONSTRAINT ${name} CHECK (${check.value});`;
}
