/**
 * `manifest.json` of a tenant export folder: its type, reading, writing, checks
 *
 * The folder is input: everything in it is checked before a connection opens,
 * and no string of it reaches SQL or a file path. Tables, columns and file
 * names are compared against the plan the app schema gives, and the plan's are
 * what the commands use.
 */

import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { tableKey, type PlanTable, type TenantPlan } from './plan.js';
import type { BackupMetadata } from '../utils/metadata.js';

export const MANIFEST_FORMAT = 1;
export const MANIFEST_FILE = 'manifest.json';

export interface ManifestTable
{
    schema: string;
    name: string;
    tenantColumn: string;
    columns: string[];
    file: string;
    rows: number;
    sha256: string;
}

export interface Manifest
{
    format: typeof MANIFEST_FORMAT;
    tenantId: number;
    exportedAt: string;
    migrations?: BackupMetadata['migrations'];
    /** Referenced tables first. */
    tables: ManifestTable[];
}

/** Whether `value` is a valid tenant id: a positive safe integer, as core's `isTenantId`. */
export function isTenantId(value: unknown): value is number
{
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A tenant id argument as typed: digits only, then the tenant id rule. */
export function parseTenantId(raw: string): number
{
    const tenantId = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;

    if (!isTenantId(tenantId))
    {
        throw new Error(`Tenant id must be a positive integer, received "${raw}"`);
    }

    return tenantId;
}

export async function writeManifest(directory: string, manifest: Manifest): Promise<void>
{
    await fs.writeFile(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Read and check the manifest of `directory`; throws naming what is wrong. */
export async function readManifest(directory: string): Promise<Manifest>
{
    const text = await fs.readFile(path.join(directory, MANIFEST_FILE), 'utf-8');
    const manifest = JSON.parse(text) as Partial<Manifest>;

    if (manifest?.format !== MANIFEST_FORMAT)
    {
        throw new Error(`${MANIFEST_FILE} has format ${JSON.stringify(manifest?.format)}; this spfn reads format ${MANIFEST_FORMAT}`);
    }

    if (!isTenantId(manifest.tenantId))
    {
        throw new Error(`${MANIFEST_FILE} tenantId must be a positive integer, received ${JSON.stringify(manifest.tenantId)}`);
    }

    if (!Array.isArray(manifest.tables) || !manifest.tables.every(isManifestTable))
    {
        throw new Error(`${MANIFEST_FILE} tables must each have schema, name, tenantColumn, columns, file, rows and sha256`);
    }

    return manifest as Manifest;
}

function isManifestTable(value: unknown): value is ManifestTable
{
    const table = value as Partial<ManifestTable> | null;
    const strings = [table?.schema, table?.name, table?.tenantColumn, table?.file];

    return strings.every((field) => typeof field === 'string')
        && Array.isArray(table!.columns) && table!.columns.every((column) => typeof column === 'string')
        && Number.isSafeInteger(table!.rows) && table!.rows! >= 0
        && typeof table!.sha256 === 'string' && /^[0-9a-f]{64}$/.test(table!.sha256);
}

/**
 * The manifest's entry for each plan table, in plan order. Throws listing every
 * difference: a table on one side only, another tenant column, other columns, or
 * a file name other than the one the plan derives.
 */
export function matchPlan(manifest: Manifest, plan: TenantPlan): ManifestTable[]
{
    const byKey = new Map(manifest.tables.map((table) => [tableKey(table), table]));
    const planKeys = new Set(plan.tables.map((table) => tableKey(table)));
    const problems = [
        ...manifest.tables.filter((table) => !planKeys.has(tableKey(table)))
            .map((table) => `${tableKey(table)}: in ${MANIFEST_FILE}, not a tenant table of the app schema`),
        ...plan.tables.flatMap((table) => tableProblems(table, byKey.get(tableKey(table)))),
    ];

    if (manifest.tables.length !== byKey.size)
    {
        problems.push(`${MANIFEST_FILE} lists a table more than once`);
    }

    if (problems.length > 0)
    {
        throw new Error(`${MANIFEST_FILE} does not match the app schema:\n  ${problems.join('\n  ')}`);
    }

    return plan.tables.map((table) => byKey.get(tableKey(table))!);
}

function tableProblems(table: PlanTable, entry: ManifestTable | undefined): string[]
{
    const key = tableKey(table);

    if (!entry)
    {
        return [`${key}: a tenant table of the app schema, missing from ${MANIFEST_FILE}`];
    }

    return [
        entry.tenantColumn !== table.tenantColumn && `${key}: tenant column "${entry.tenantColumn}", the schema's is "${table.tenantColumn}"`,
        JSON.stringify(entry.columns) !== JSON.stringify(table.columns) && `${key}: columns ${entry.columns.join(', ')}; the schema's are ${table.columns.join(', ')}`,
        entry.file !== table.file && `${key}: file "${entry.file}", expected "${table.file}"`,
    ].filter((problem): problem is string => typeof problem === 'string');
}

/** The sha256 of every plan table's file must be the manifest's; throws naming the first that is not. */
export async function verifyChecksums(directory: string, plan: TenantPlan, entries: ManifestTable[]): Promise<void>
{
    for (const [index, table] of plan.tables.entries())
    {
        if (await sha256Of(path.join(directory, table.file)) !== entries[index].sha256)
        {
            throw new Error(`${table.file} does not match its sha256 in ${MANIFEST_FILE}; the folder was changed after the export`);
        }
    }
}

async function sha256Of(file: string): Promise<string>
{
    const hash = createHash('sha256');

    for await (const chunk of createReadStream(file))
    {
        hash.update(chunk);
    }

    return hash.digest('hex');
}
