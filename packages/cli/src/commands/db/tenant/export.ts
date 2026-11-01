/**
 * `spfn db tenant export <tenantId>` — one tenant's rows out to a folder
 *
 * Writes `backups/tenant-<id>-<time>/` with one `COPY` text file per tenant
 * table and a `manifest.json` (rows and sha256 per file, the migration state).
 * Every table is read inside one `REPEATABLE READ READ ONLY` transaction on one
 * connection, so the files are one snapshot and their foreign keys agree.
 *
 * Connects as the app (`DATABASE_READ_URL`, else `DATABASE_URL`): a tenancy
 * table's row-level security then admits the tenant's rows only, behind the
 * `WHERE` this command writes.
 */

import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import { createHash } from 'crypto';
import chalk from 'chalk';
import { env } from '@spfn/core/config';
import { loadEnv } from '@spfn/core/server';
import { ensureBackupDir } from '../utils/backup-files.js';
import { formatTimestamp } from '../utils/formatters.js';
import { collectMigrationInfo } from '../utils/metadata.js';
import { describeError, openConnection, type TenantTransaction } from './connection.js';
import { MANIFEST_FORMAT, parseTenantId, writeManifest, type Manifest, type ManifestTable } from './manifest.js';
import { buildTenantPlan, columnList, qualifiedName, quoteIdent, type PlanTable, type TenantPlan } from './plan.js';
import { fail, loadAppSchema } from './schema.js';

const NEWLINE = 0x0a;

export interface TenantExportOptions
{
    tenantId: number;
    plan: TenantPlan;
    url: string;
    /** Created by the export; one that exists already fails it. */
    directory: string;
    /** @internal Runs inside the snapshot after each table's file is written — a test seam. */
    afterTable?: (table: PlanTable) => Promise<void>;
}

/** The command: check the id, plan, connect, export, report. */
export async function dbTenantExport(tenantIdArg: string): Promise<void>
{
    const tenantId = withFailure(() => parseTenantId(tenantIdArg));

    loadEnv();

    const plan = buildTenantPlanOrFail(await loadAppSchema().catch((error) => fail(describeError(error, undefined))));
    const url = env.DATABASE_READ_URL ?? env.DATABASE_URL ?? fail('Neither DATABASE_READ_URL nor DATABASE_URL is set');
    const directory = path.join(await ensureBackupDir(), `tenant-${tenantId}-${formatTimestamp()}`);

    console.log(chalk.blue(`📤 Exporting tenant ${tenantId} (${plan.tables.length} tables)...\n`));

    const manifest = await exportTenant({ tenantId, plan, url, directory })
        .catch((error) => fail(`Tenant export failed: ${describeError(error, url)}`));

    for (const table of manifest.tables)
    {
        console.log(chalk.gray(`   ${table.file}: ${table.rows} rows`));
    }

    console.log(chalk.green(`\n✅ Tenant ${tenantId} exported to ${path.relative(process.cwd(), directory)}`));
}

/**
 * Write the folder: the table files inside one snapshot, then the manifest. On
 * any failure the folder this call created is removed, so no half export stays.
 */
export async function exportTenant(options: TenantExportOptions): Promise<Manifest>
{
    await fs.mkdir(options.directory);

    let manifest: Manifest | undefined;

    try
    {
        const tables = await copyTables(options);

        manifest = {
            format: MANIFEST_FORMAT,
            tenantId: options.tenantId,
            exportedAt: new Date().toISOString(),
            migrations: await collectMigrationInfo(options.url),
            tables,
        };
        await writeManifest(options.directory, manifest);

        return manifest;
    }
    finally
    {
        if (!manifest)
        {
            await fs.rm(options.directory, { recursive: true, force: true });
        }
    }
}

function withFailure<T>(run: () => T): T
{
    try
    {
        return run();
    }
    catch (error)
    {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

function buildTenantPlanOrFail(imports: Record<string, unknown>): TenantPlan
{
    return withFailure(() => buildTenantPlan(imports));
}

async function copyTables(options: TenantExportOptions): Promise<ManifestTable[]>
{
    const sql = openConnection(options.url);

    try
    {
        return await sql.begin('isolation level repeatable read read only', async (tx) =>
        {
            const tables: ManifestTable[] = [];

            // The snapshot is taken at this first statement, before any COPY
            await tx`select set_config('app.tenant_id', ${String(options.tenantId)}, true)`;

            for (const table of options.plan.tables)
            {
                tables.push(await copyTable(tx, table, options));
                await options.afterTable?.(table);
            }

            return tables;
        });
    }
    finally
    {
        await sql.end();
    }
}

/**
 * `COPY (SELECT ...) TO STDOUT` into the table's file. COPY takes no bound
 * parameters, so the tenant id is a literal: the validated integer, rendered
 * by `String()`. Every identifier comes from the plan.
 */
async function copyTable(tx: TenantTransaction, table: PlanTable, options: TenantExportOptions): Promise<ManifestTable>
{
    const orderBy = table.primaryKey.length > 0 ? ` ORDER BY ${table.primaryKey.map(quoteIdent).join(', ')}` : '';
    const select = `SELECT ${columnList(table)} FROM ${qualifiedName(table)}`
        + ` WHERE ${quoteIdent(table.tenantColumn)} = ${String(options.tenantId)}${orderBy}`;
    const stream = await tx.unsafe(`COPY (${select}) TO STDOUT`).readable();
    const { rows, sha256 } = await writeCopyFile(stream, path.join(options.directory, table.file));

    return { schema: table.schema, name: table.name, tenantColumn: table.tenantColumn, columns: table.columns, file: table.file, rows, sha256 };
}

/** Stream COPY text output to `file`; its rows are its newlines — COPY escapes those inside values. */
async function writeCopyFile(stream: Readable, file: string): Promise<{ rows: number; sha256: string }>
{
    const hash = createHash('sha256');
    let rows = 0;

    await pipeline(stream, async function* (source: AsyncIterable<Buffer>)
    {
        for await (const chunk of source)
        {
            hash.update(chunk);
            rows += countNewlines(chunk);
            yield chunk;
        }
    }, createWriteStream(file, { flags: 'wx' }));
    resumeConnection(stream);

    return { rows, sha256: hash.digest('hex') };
}

/**
 * postgres.js 3.4 pauses the socket when a COPY stream's buffer is full and
 * resumes it only from the stream's `_read`. When the last rows arrive while it
 * is paused, the stream ends with the socket still paused: the server's
 * "command complete" is never read and the next statement on the connection
 * waits forever (seen exporting 100,000 rows). Resuming once the stream has
 * ended is a no-op when the socket was not paused.
 */
function resumeConnection(stream: Readable): void
{
    (stream as Readable & { _read(size: number): void })._read(0);
}

function countNewlines(chunk: Buffer): number
{
    let count = 0;

    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1))
    {
        count++;
    }

    return count;
}
