/**
 * Development warning for queries that forget the tenant
 *
 * A drizzle logger that reads each SQL statement and warns when it references a
 * tenant-aware table without a condition on that table's tenant column. It is
 * attached only in local and development runs, so production pays nothing.
 *
 * Every statement is checked, TenantRepository's included: the queries it builds
 * always carry the tenant condition and pass, while a subquery a caller hands it
 * — in a where condition or as a join source — is checked like any other SQL.
 *
 * It reads SQL text, so it is a convenience, not a guarantee: a table alias it
 * cannot resolve, a subquery or a hand-written `sql` template can make it miss a
 * query or warn about one that is scoped. Isolation that holds regardless is
 * row-level security, which is a separate layer.
 *
 * drizzle 1.0.0-rc.4 writes a WHERE or ON column fully qualified —
 * `"schema"."table"."tenant_id" = $1`, or `"alias"."tenant_id" = $1` — while an
 * UPDATE's SET list names the bare column. Only the qualified form counts as a
 * condition, so `set "tenant_id" = $1` is not mistaken for one.
 *
 * @internal
 */

import type { Logger } from 'drizzle-orm';
import { listTenantTables, type TenantTableEntry } from './registry';

/** NODE_ENV values the warning runs under. */
const WARNING_ENVIRONMENTS = new Set(['local', 'development']);

export interface TenantQueryWarning
{
    readonly tables: string[];
    readonly sql: string;
}

export interface TenantQueryLoggerOptions
{
    warn: (message: string, warning: TenantQueryWarning) => void;
    tables?: () => readonly TenantTableEntry[];
}

/**
 * The drizzle logger for `nodeEnv`: a tenant query warner in local and
 * development runs, undefined everywhere else.
 */
export function createDevelopmentQueryLogger(
    nodeEnv: string | undefined,
    warn: TenantQueryLoggerOptions['warn'],
): Logger | undefined
{
    return nodeEnv && WARNING_ENVIRONMENTS.has(nodeEnv) ? createTenantQueryLogger({ warn }) : undefined;
}

/** A drizzle logger that warns once per SQL text about an unscoped tenant table. */
export function createTenantQueryLogger(options: TenantQueryLoggerOptions): Logger
{
    const warned = new Set<string>();
    const tables = options.tables ?? listTenantTables;

    return {
        logQuery(query: string)
        {
            if (warned.has(query))
            {
                return;
            }

            const unscoped = findUnscopedTenantTables(query, tables());

            if (unscoped.length > 0)
            {
                warned.add(query);
                options.warn('Query on a tenant-aware table without a tenant condition', { tables: unscoped, sql: query });
            }
        },
    };
}

/**
 * The tenant-aware tables `sql` references without a condition on their tenant
 * column, by the name the query uses for them (the alias when there is one).
 */
export function findUnscopedTenantTables(sql: string, tables: readonly TenantTableEntry[]): string[]
{
    if (/^\s*insert\b/i.test(sql))
    {
        return [];
    }

    return tables.flatMap((table) =>
        referencesOf(sql, table)
            .filter((reference) => !hasTenantCondition(sql, reference, table.columnName))
            .map((reference) => reference.label),
    );
}

interface TableReference
{
    readonly label: string;
    readonly qualifier: string;
}

/** Every name under which `sql` reads or writes `table`, with the prefix its columns carry. */
function referencesOf(sql: string, table: TenantTableEntry): TableReference[]
{
    const name = `"${escapeRegExp(table.name)}"`;
    const qualifier = table.schema ? `"${escapeRegExp(table.schema)}"\\.${name}` : `(?<![".])${name}`;
    const source = table.schema ? qualifier : `${qualifier}(?!\\.)`;
    const pattern = new RegExp(`\\b(?:from|join|update)\\s+${source}(?:\\s+(?:as\\s+)?"([^"]+)")?`, 'gi');
    const references = new Map<string, TableReference>();

    for (const match of sql.matchAll(pattern))
    {
        const alias = match[1];

        references.set(alias ?? table.name, {
            label: alias ?? table.name,
            qualifier: alias ? `"${escapeRegExp(alias)}"` : qualifier,
        });
    }

    return [...references.values()];
}

function hasTenantCondition(sql: string, reference: TableReference, columnName: string): boolean
{
    const condition = new RegExp(`${reference.qualifier}\\."${escapeRegExp(columnName)}"\\s*(?:=|in\\s*\\()`, 'i');

    return condition.test(sql);
}

function escapeRegExp(text: string): string
{
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
