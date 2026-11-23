/**
 * The app privileges manifest — `privileges.json` in a migrations folder
 *
 * `spfn db migrate` loads no app source, and a production image may hold only
 * `dist` and the migrations folder, so the `appPrivileges` declarations travel
 * as a generated file beside the migrations: `spfn db generate` writes the
 * project's, and each function package's `pnpm db:generate` writes its own.
 *
 * Every table of the schema is listed — its schema and name as two fields, a
 * quoted identifier may hold a dot — sorted by schema, then table, with its
 * declared list or `"default"`; the default set itself is recorded once.
 * So a reader tells a table with the default set from a table the manifest
 * does not know. A file is never hand-edited: regenerating it from unchanged
 * entities writes the same bytes.
 *
 * Version 2 adds column lists: a table entry may carry `"columns"`, per
 * privilege its column names, beside its table-level `"privileges"` (then
 * possibly empty). A manifest is written as version 2 only when a table
 * declares a column list; without one it is version 1, byte for byte as
 * 0.4.0-beta.4 wrote it. A reader of version 1 only refuses a version 2 file,
 * so it can never grant table-wide what is declared on columns.
 *
 * ```json
 * {
 *     "$comment": "Generated from the entities' appPrivileges() declarations. Do not edit: regenerate.",
 *     "version": 1,
 *     "default": ["select", "insert", "update", "delete"],
 *     "tables": [
 *         { "schema": "acme", "table": "audit_log", "privileges": ["select", "insert"] },
 *         { "schema": "acme", "table": "notes", "privileges": "default" }
 *     ]
 * }
 * ```
 *
 * ```json
 *     "version": 2,
 *     …
 *         { "schema": "acme", "table": "outbox", "privileges": ["select", "insert"], "columns": { "update": ["message_id", "status"] } }
 * ```
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
    APP_COLUMN_PRIVILEGES,
    APP_PRIVILEGES,
    DEFAULT_APP_PRIVILEGES,
    declaredAppPrivileges,
    isAppPrivilege,
    type AppPrivilege,
    type AppTablePrivileges,
} from './declaration';

/** The manifest's file name in a migrations folder. */
export const APP_PRIVILEGES_MANIFEST_FILE = 'privileges.json';

/**
 * The newest manifest format, which this release writes when a table declares
 * a column list; it reads it and every earlier one (1: table-level lists only).
 */
export const APP_PRIVILEGES_MANIFEST_VERSION = 2;

/** The format of a manifest without a column list. */
const TABLE_LEVEL_VERSION = 1;

const GENERATED_NOTE = 'Generated from the entities\' appPrivileges() declarations. Do not edit: regenerate.';

/** A manifest as `readAppPrivilegesManifest` returns it. */
export interface AppPrivilegesManifest
{
    /** 1, or 2 when a table carries column lists */
    readonly version: typeof TABLE_LEVEL_VERSION | typeof APP_PRIVILEGES_MANIFEST_VERSION;
    /** The set a `"default"` table has. */
    readonly default: readonly AppPrivilege[];
    /** Every table of the schema, as the file lists them. */
    readonly tables: readonly AppTablePrivileges[];
}

/**
 * What a migrations folder declares for the app role: its manifest, or — the
 * folder has no `privileges.json` — nothing, in which case every table its
 * migrations create has the default set. A package published before this
 * format, or one that never declares a privilege, has no file.
 */
export type MigrationsAppPrivileges =
    | { readonly kind: 'manifest'; readonly file: string; readonly manifest: AppPrivilegesManifest }
    | { readonly kind: 'none'; readonly default: readonly AppPrivilege[] };

/** A manifest file that cannot be read, is not a manifest, or has a version this release does not know. */
export class AppPrivilegesManifestError extends Error
{
    /** The manifest file. */
    readonly file: string;

    constructor(file: string, detail: string)
    {
        super(`${file}: ${detail}`);

        this.name = 'AppPrivilegesManifestError';
        this.file = file;
    }
}

/**
 * The manifest of the tables among `values` (a schema module's exports), as
 * the text written to `privileges.json`: 4-space JSON, tables in sorted order,
 * a final newline; version 2 when a table declares a column list, else 1.
 *
 * @throws AppPrivilegesError when two tables of one name declare different sets
 */
export function renderAppPrivilegesManifest(values: Iterable<unknown>): string
{
    const tables = declaredAppPrivileges(values);
    const manifest = {
        $comment: GENERATED_NOTE,
        version: tables.some(entry => entry.columns !== undefined) ? APP_PRIVILEGES_MANIFEST_VERSION : TABLE_LEVEL_VERSION,
        default: DEFAULT_APP_PRIVILEGES,
        tables,
    };

    return `${JSON.stringify(manifest, null, 4)}\n`;
}

/**
 * Write the manifest of the tables among `values` into `migrationsDir`,
 * creating the folder when missing.
 *
 * @returns the file written
 */
export function writeAppPrivilegesManifest(migrationsDir: string, values: Iterable<unknown>): string
{
    const file = join(migrationsDir, APP_PRIVILEGES_MANIFEST_FILE);

    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(file, renderAppPrivilegesManifest(values));

    return file;
}

/**
 * Read and check a manifest file.
 *
 * @throws AppPrivilegesManifestError, naming the file, when it cannot be read,
 * is not JSON, has a version other than 1 and 2, or holds a table entry that
 * is not a schema, a table and a privilege list or `"default"` — in version
 * 2, with column lists or not — or lists one table twice
 */
export function readAppPrivilegesManifest(file: string): AppPrivilegesManifest
{
    const read = readJson(file);

    if ('error' in read)
    {
        throw new AppPrivilegesManifestError(file, `cannot be read as JSON: ${read.error}`);
    }

    const problem = manifestProblem(read.value);

    if (problem)
    {
        throw new AppPrivilegesManifestError(file, problem);
    }

    const { version, default: defaults, tables } = read.value as AppPrivilegesManifest;

    return { version, default: defaults, tables: tables.map(({ schema, table, privileges, columns }) =>
        (version === TABLE_LEVEL_VERSION || columns === undefined ? { schema, table, privileges } : { schema, table, privileges, columns })) };
}

/**
 * The app privileges a migrations folder declares — the project's, or a
 * function package's `spfn.migrations.dir`. No `privileges.json` there is not
 * an error: it means every table the folder's migrations create has
 * `DEFAULT_APP_PRIVILEGES` (`kind: 'none'`). "No file" is decided from the
 * folder's listing, never from a failed read: a dangling symlink, a loop or a
 * file it may not read is a `privileges.json` that is there. A file that is
 * there must be a manifest.
 *
 * A folder that does not exist is an error too, not `'none'`: the caller
 * names the folder it migrates from, so a missing one is a wrong path or an
 * image built without it, and its defaults would be granted on a guess.
 *
 * @throws AppPrivilegesManifestError, naming the file, when the folder cannot
 * be listed (missing, unreadable, not a folder), or it lists a
 * `privileges.json` that `readAppPrivilegesManifest` refuses
 */
export function readMigrationsAppPrivileges(migrationsDir: string): MigrationsAppPrivileges
{
    const file = join(migrationsDir, APP_PRIVILEGES_MANIFEST_FILE);
    const listing = listFolder(migrationsDir);

    if ('error' in listing)
    {
        throw new AppPrivilegesManifestError(file, `cannot tell whether it exists: its migrations folder cannot be listed: ${listing.error}`);
    }

    if (!listing.entries.includes(APP_PRIVILEGES_MANIFEST_FILE))
    {
        return { kind: 'none', default: DEFAULT_APP_PRIVILEGES };
    }

    return { kind: 'manifest', file, manifest: readAppPrivilegesManifest(file) };
}

function listFolder(folder: string): { entries: string[] } | { error: string }
{
    try
    {
        return { entries: readdirSync(folder) };
    }
    catch (error)
    {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function readJson(file: string): { value: unknown } | { error: string }
{
    try
    {
        return { value: JSON.parse(readFileSync(file, 'utf8')) };
    }
    catch (error)
    {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

/** What makes `value` no manifest of this version, or undefined when it is one. */
function manifestProblem(value: unknown): string | undefined
{
    if (!isRecord(value))
    {
        return 'is not a JSON object';
    }

    if (value.version !== TABLE_LEVEL_VERSION && value.version !== APP_PRIVILEGES_MANIFEST_VERSION)
    {
        return `has version ${JSON.stringify(value.version)}; this @spfn/core reads versions ${TABLE_LEVEL_VERSION} and ${APP_PRIVILEGES_MANIFEST_VERSION} — regenerate it, or update @spfn/core`;
    }

    if (!isPrivilegeList(value.default))
    {
        return `"default" is not a privilege list (${APP_PRIVILEGES.join(', ')}, in that order, without repeats)`;
    }

    if (!Array.isArray(value.tables))
    {
        return '"tables" is not a list';
    }

    return tablesProblem(value.tables, value.version === APP_PRIVILEGES_MANIFEST_VERSION);
}

/** What makes `tables` no manifest's table list: a malformed entry, or a table listed twice; `withColumns` in version 2. */
function tablesProblem(tables: unknown[], withColumns: boolean): string | undefined
{
    const malformed = tables.findIndex(entry => !(withColumns ? isColumnsTableEntry(entry) : isTableEntry(entry)));

    if (malformed >= 0)
    {
        return `table entry ${malformed} is malformed: expected { "schema", "table", "privileges"${withColumns ? ', "columns"?' : ''} } with non-empty names and a privilege list or "default"`
            + (withColumns ? '; "columns" a list of column names per privilege of select, insert, update, references not in "privileges"' : '');
    }

    const keys = (tables as AppTablePrivileges[]).map(entry => JSON.stringify([entry.schema, entry.table]));
    const repeated = keys.findIndex((key, index) => keys.indexOf(key) !== index);

    return repeated < 0 ? undefined : `table entry ${repeated} lists ${keys[repeated]} a second time`;
}

function isTableEntry(entry: unknown): entry is AppTablePrivileges
{
    return isRecord(entry)
        && isName(entry.schema)
        && isName(entry.table)
        && (entry.privileges === 'default' || isPrivilegeList(entry.privileges));
}

/**
 * A version 2 entry: a version 1 entry, or one whose `columns` holds, per
 * privilege of `APP_COLUMN_PRIVILEGES` in that order, a non-empty sorted list
 * of column names without repeats, its privilege not also table-level — then
 * its `privileges` may be empty.
 */
function isColumnsTableEntry(entry: unknown): boolean
{
    if (!isRecord(entry) || entry.columns === undefined)
    {
        return isTableEntry(entry);
    }

    const { schema, table, privileges, columns } = entry;

    return isName(schema)
        && isName(table)
        && ((Array.isArray(privileges) && privileges.length === 0) || isPrivilegeList(privileges))
        && isRecord(columns)
        && isColumnLists(columns)
        && Object.keys(columns).every(privilege => !privileges.includes(privilege));
}

/** Non-empty, in `APP_COLUMN_PRIVILEGES` order, each a non-empty list of names sorted by UTF-16 code unit without repeats. */
function isColumnLists(columns: Record<string, unknown>): boolean
{
    const keys = Object.keys(columns);

    return keys.length > 0
        && keys.every((key, index) => (APP_COLUMN_PRIVILEGES as readonly string[]).includes(key)
            && (index === 0 || APP_COLUMN_PRIVILEGES.indexOf(keys[index - 1] as never) < APP_COLUMN_PRIVILEGES.indexOf(key as never)))
        && Object.values(columns).every(list => Array.isArray(list) && list.length > 0
            && list.every((name, index) => isName(name) && (index === 0 || list[index - 1] < name)));
}

function isName(value: unknown): value is string
{
    return typeof value === 'string' && value.length > 0;
}

/** A non-empty list of privileges in `APP_PRIVILEGES` order without repeats, as the writer normalises it. */
function isPrivilegeList(value: unknown): value is AppPrivilege[]
{
    return Array.isArray(value)
        && value.length > 0
        && value.every(isAppPrivilege)
        && value.every((privilege, index) => index === 0 || APP_PRIVILEGES.indexOf(value[index - 1]) < APP_PRIVILEGES.indexOf(privilege));
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
