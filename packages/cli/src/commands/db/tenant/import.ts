/**
 * `spfn db tenant import <dir> [--replace]` — one tenant's rows back in, in one transaction
 *
 * The folder is checked before a connection opens: the manifest's format and
 * tenant id, its tables against the app schema's plan, every file against its
 * sha256. Then, on one connection inside one transaction — any failure leaves
 * the database as it was:
 *
 * 1. the target tables' columns are the manifest's
 * 2. the tenant is in its tenant list table (an app with `tenantKey()`-only
 *    tables has none, and skips this)
 * 3. without `--replace`, the tenant has no rows yet; with it, its rows are
 *    deleted, referencing tables first
 * 4. each file is copied into a temporary table, refused if a row belongs to
 *    another tenant, and inserted, referenced tables first
 * 5. each table received the manifest's row count
 * 6. every sequence behind a tenant table column moves forward to the largest
 *    id imported — never backwards: other tenants draw from it too
 *
 * Connects as the table owner (`DATABASE_OWNER_URL`, else `DATABASE_URL`), as
 * `restore` does: `setval` needs a privilege the app role lacks. Row-level
 * security does not apply to the owner, which is why step 4 checks the tenant
 * column itself.
 */

import { createReadStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import chalk from 'chalk';
import { loadEnv } from '@spfn/core/server';
import { confirmDangerousTarget, OWNER_URL_MISSING, ownerDatabaseUrl, parseDatabaseUrl } from '../utils/database.js';
import { describeError, openConnection, type TenantTransaction } from './connection.js';
import { matchPlan, readManifest, verifyChecksums, type Manifest, type ManifestTable } from './manifest.js';
import { buildTenantPlan, columnList, qualifiedName, quoteIdent, tableKey, type PlanTable, type TenantPlan } from './plan.js';
import { fail, loadAppSchema } from './schema.js';

/** A folder that passed every check that needs no database. */
export interface PreparedImport
{
    directory: string;
    manifest: Manifest;
    plan: TenantPlan;
    /** The manifest's entry of each plan table, in plan order. */
    entries: ManifestTable[];
}

export interface ImportedTable
{
    table: PlanTable;
    rows: number;
}

/** The command: check the folder, connect as the owner, confirm a remote target, import, report. */
export async function dbTenantImport(directory: string, options: { replace?: boolean } = {}): Promise<void>
{
    loadEnv();

    const imports = await loadAppSchema().catch((error) => fail(describeError(error, undefined)));
    const prepared = await Promise.resolve()
        .then(() => prepareImport(directory, buildTenantPlan(imports)))
        .catch((error) => fail(describeError(error, undefined)));
    const url = ownerDatabaseUrl() ?? fail(OWNER_URL_MISSING);
    const tenantId = prepared.manifest.tenantId;

    await confirmDangerousTarget(parseDatabaseUrl(url));
    console.log(chalk.blue(`📥 Importing tenant ${tenantId}${options.replace ? ', replacing its rows' : ''}...\n`));

    const imported = await importTenant(prepared, { url, replace: options.replace === true })
        .catch((error) => fail(`Tenant import failed, nothing was written: ${describeError(error, url)}`));

    for (const { table, rows } of imported)
    {
        console.log(chalk.gray(`   ${tableKey(table)}: ${rows} rows`));
    }

    console.log(chalk.green(`\n✅ Tenant ${tenantId} imported`));
}

/** Read the folder and check it against the plan; throws naming the first problem. */
export async function prepareImport(directory: string, plan: TenantPlan): Promise<PreparedImport>
{
    const manifest = await readManifest(directory);
    const entries = matchPlan(manifest, plan);

    await verifyChecksums(directory, plan, entries);

    return { directory, manifest, plan, entries };
}

/** Run the import in one transaction on one connection. */
export async function importTenant(prepared: PreparedImport, options: { url: string; replace: boolean }): Promise<ImportedTable[]>
{
    const sql = openConnection(options.url);

    try
    {
        return await sql.begin((tx) => runImport(tx, prepared, options.replace));
    }
    finally
    {
        await sql.end();
    }
}

async function runImport(tx: TenantTransaction, prepared: PreparedImport, replace: boolean): Promise<ImportedTable[]>
{
    const tenantId = prepared.manifest.tenantId;

    await assertColumns(tx, prepared);
    await assertTenantListed(tx, prepared.plan, tenantId);

    if (replace)
    {
        await deleteTenantRows(tx, prepared.plan, tenantId);
    }
    else
    {
        await assertNoTenantRows(tx, prepared.plan, tenantId);
    }

    await tx`select set_config('app.tenant_id', ${String(tenantId)}, true)`;

    const imported: ImportedTable[] = [];

    for (const [index, table] of prepared.plan.tables.entries())
    {
        imported.push({ table, rows: await importTable(tx, prepared, index) });
    }

    for (const table of prepared.plan.tables)
    {
        await advanceSequences(tx, table, tenantId);
    }

    return imported;
}

/** Each target table's stored columns must be the manifest's, as a set. */
async function assertColumns(tx: TenantTransaction, prepared: PreparedImport): Promise<void>
{
    const problems: string[] = [];

    for (const [index, table] of prepared.plan.tables.entries())
    {
        const rows = await tx.unsafe<{ name: string }[]>(
            `SELECT attname AS name FROM pg_attribute
             WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`,
            [qualifiedName(table)],
        );
        const actual = new Set(rows.map((row) => row.name));
        const expected = new Set(prepared.entries[index].columns);
        const extra = [...actual].filter((column) => !expected.has(column));
        const missing = [...expected].filter((column) => !actual.has(column));

        if (actual.size === 0)
        {
            problems.push(`${tableKey(table)}: no such table in the target database`);
        }
        else if (extra.length > 0 || missing.length > 0)
        {
            problems.push(`${tableKey(table)}: ${describeColumnDifference(extra, missing)}`);
        }
    }

    if (problems.length > 0)
    {
        throw new Error(`The target database's tables differ from the export:\n  ${problems.join('\n  ')}`);
    }
}

function describeColumnDifference(extra: string[], missing: string[]): string
{
    return [
        extra.length > 0 && `column(s) ${extra.join(', ')} only in the target database`,
        missing.length > 0 && `column(s) ${missing.join(', ')} only in the export`,
    ].filter(Boolean).join('; ');
}

/** The tenant must be a row of every tenant list table its tenancy tables point at. */
async function assertTenantListed(tx: TenantTransaction, plan: TenantPlan, tenantId: number): Promise<void>
{
    for (const list of plan.tenantLists)
    {
        const rows = await tx.unsafe(`SELECT 1 FROM ${qualifiedName(list)} WHERE ${quoteIdent(list.idColumn)} = $1`, [tenantId]);

        if (rows.length === 0)
        {
            throw new Error(`Tenant ${tenantId} is not in ${tableKey(list)}; create tenant ${tenantId} there first`);
        }
    }
}

async function assertNoTenantRows(tx: TenantTransaction, plan: TenantPlan, tenantId: number): Promise<void>
{
    const occupied: string[] = [];

    for (const table of plan.tables)
    {
        const [{ count }] = await tx.unsafe<{ count: number }[]>(
            `SELECT count(*)::int AS count FROM ${qualifiedName(table)} WHERE ${quoteIdent(table.tenantColumn)} = $1`,
            [tenantId],
        );

        if (count > 0)
        {
            occupied.push(`${tableKey(table)} (${count} rows)`);
        }
    }

    if (occupied.length > 0)
    {
        throw new Error(`Tenant ${tenantId} already has rows in ${occupied.join(', ')}; use --replace to replace them`);
    }
}

/** Referencing tables first, so a foreign key between tenant tables never blocks a delete. */
async function deleteTenantRows(tx: TenantTransaction, plan: TenantPlan, tenantId: number): Promise<void>
{
    for (const table of [...plan.tables].reverse())
    {
        await tx.unsafe(`DELETE FROM ${qualifiedName(table)} WHERE ${quoteIdent(table.tenantColumn)} = $1`, [tenantId]);
    }
}

/**
 * The file into a temporary table, a check that every row is the tenant's,
 * then into the table, with the manifest's row count. `OVERRIDING SYSTEM VALUE`
 * keeps the exported ids of a `GENERATED ALWAYS AS IDENTITY` column; it changes
 * nothing for other columns.
 */
async function importTable(tx: TenantTransaction, prepared: PreparedImport, index: number): Promise<number>
{
    const table = prepared.plan.tables[index];
    const staging = quoteIdent(`spfn_tenant_import_${index}`);

    await stageFile(tx, prepared, table, staging);

    const inserted = await tx.unsafe(
        `INSERT INTO ${qualifiedName(table)} (${columnList(table)}) OVERRIDING SYSTEM VALUE SELECT ${columnList(table)} FROM ${staging}`,
    );

    if (inserted.count !== prepared.entries[index].rows)
    {
        throw new Error(`${tableKey(table)} received ${inserted.count} rows; ${table.file} should hold ${prepared.entries[index].rows}`);
    }

    return inserted.count;
}

/**
 * `COPY FROM` the table's file into a temporary table shaped like it, refused
 * when a row's tenant column is not the manifest's tenant.
 */
async function stageFile(tx: TenantTransaction, prepared: PreparedImport, table: PlanTable, staging: string): Promise<void>
{
    const tenantId = prepared.manifest.tenantId;

    await tx.unsafe(`CREATE TEMP TABLE ${staging} (LIKE ${qualifiedName(table)}) ON COMMIT DROP`);
    await pipeline(
        createReadStream(path.join(prepared.directory, table.file)),
        await tx.unsafe(`COPY ${staging} (${columnList(table)}) FROM STDIN`).writable(),
    );

    const [{ count }] = await tx.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM ${staging} WHERE ${quoteIdent(table.tenantColumn)} IS DISTINCT FROM $1`,
        [tenantId],
    );

    if (count > 0)
    {
        throw new Error(`${table.file} holds ${count} row(s) of a tenant other than ${tenantId}`);
    }
}

/**
 * Move each sequence behind a column of `table` to the largest value the
 * tenant now has there, unless it is already past it. A table the tenant has
 * no rows in is left alone.
 */
async function advanceSequences(tx: TenantTransaction, table: PlanTable, tenantId: number): Promise<void>
{
    for (const column of table.columns)
    {
        const [{ sequence }] = await tx.unsafe<{ sequence: string | null }[]>(
            'SELECT pg_get_serial_sequence($1, $2) AS sequence',
            [qualifiedName(table), column],
        );

        if (sequence)
        {
            await tx.unsafe(
                `SELECT setval(sequence, greatest(max_value, pg_sequence_last_value(sequence)))
                 FROM (SELECT $1::regclass AS sequence,
                              (SELECT max(${quoteIdent(column)}) FROM ${qualifiedName(table)} WHERE ${quoteIdent(table.tenantColumn)} = $2) AS max_value) AS current
                 WHERE max_value IS NOT NULL`,
                [sequence, tenantId],
            );
        }
    }
}
