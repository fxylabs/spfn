/**
 * The app's jobs declaration — `"spfn": { "jobs": … }` in the project's
 * package.json
 *
 * The database owner's side cannot load the app's source (`.jobs()` lives in
 * server.config), so an app that runs jobs says so where function packages
 * declare their migrations (`spfn.migrations`, discovery.ts): `"jobs": true`
 * for the queue schema `spfn_queue`, `"jobs": { "schema": "<name>" }` for
 * another. Without the key the app declares no jobs.
 *
 * The queue schema is pg-boss's and nothing else's: the app privileges plan
 * holds every object there to the queue rule. The two schemas every project
 * has — `public` and `drizzle` — are refused here. Which other schemas are
 * another's the file cannot tell: a package's name does not say whether it
 * creates a schema, and a package installed through another is not listed.
 * The plan refuses a schema its target manages (`plan.queue.managedSchema`),
 * but a command's target need not name every schema a project has — without
 * `privileges.json` no project schema is managed. What tells another's schema
 * apart in every command is the schema itself: `readQueueSchemaState` reads
 * one holding objects that are not pg-boss's as `notPgBoss`, and the grant
 * step must refuse it before granting.
 *
 * Inside `spfn.jobs` every key is known, so an unknown one is an error. A
 * misspelt `jobs` — `"job"` under `spfn`, a top-level `"jobs"` — is read as
 * no declaration: `spfn` holds other keys (`migrations`) and the file other
 * tools', and no rule tells a typo from a key of theirs, so none is guessed.
 * A key written twice is read as `JSON.parse` reads it, the last one winning
 * — as npm, pnpm and every tool reading the file do — so the declaration
 * spfn reads is the one they see; nothing detects duplicates.
 *
 * This module only reads the file.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { BOOKKEEPING_SCHEMA } from '../privileges/plan';

/** The queue schema `initBoss` uses when `.jobs()` names none, and `"jobs": true` declares. */
export const DEFAULT_QUEUE_SCHEMA = 'spfn_queue';

/**
 * A queue schema name both pg-boss and the catalog read as written: pg-boss
 * puts it in its SQL unquoted (at most 50 word characters, no leading digit),
 * where PostgreSQL folds upper case, so lower case only.
 */
const QUEUE_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,49}$/;

/**
 * The PostgreSQL keywords pg-boss's unquoted SQL breaks on as the schema
 * name: every keyword but the unreserved ones — reserved, type or function
 * name, and column name (`pg_get_keywords()`, `catcode` R, T and C) — as
 * PostgreSQL 16 lists them. Each fails pg-boss's construction plan there; no
 * unreserved keyword does.
 */
const NON_UNRESERVED_KEYWORDS = new Set(`
    all analyse analyze and any array as asc asymmetric authorization between bigint binary bit
    boolean both case cast char character check coalesce collate collation column concurrently
    constraint create cross current_catalog current_date current_role current_schema
    current_time current_timestamp current_user dec decimal default deferrable desc distinct do
    else end except exists extract false fetch float for foreign freeze from full grant greatest
    group grouping having ilike in initially inner inout int integer intersect interval into is
    isnull join json_array json_arrayagg json_object json_objectagg lateral leading least left
    like limit localtime localtimestamp national natural nchar none normalize not notnull null
    nullif numeric offset on only or order out outer overlaps overlay placing position precision
    primary real references returning right row select session_user setof similar smallint some
    substring symmetric system_user table tablesample then time timestamp to trailing treat trim
    true union unique user using values varchar variadic verbose when where window with
    xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot
    xmlserialize xmltable
`.split(/\s+/).filter(Boolean));

/** What the app declares: the schema pg-boss keeps its queue in. */
export interface JobsDeclaration
{
    readonly schema: string;
}

/** A `spfn.jobs` value that is no declaration, or a package.json that cannot be read. */
export class JobsDeclarationError extends Error
{
    constructor(readonly file: string, reason: string)
    {
        super(`${file}: ${reason}`);
        this.name = 'JobsDeclarationError';
    }
}

/**
 * Whether `name` is a queue schema name pg-boss's SQL and the catalog agree
 * on: lower case, and neither a PostgreSQL keyword pg-boss's unquoted SQL
 * breaks on nor `pg_…`, which PostgreSQL reserves for system schemas.
 */
export function isQueueSchemaName(name: string): boolean
{
    return QUEUE_SCHEMA_NAME.test(name) && !NON_UNRESERVED_KEYWORDS.has(name) && !name.startsWith('pg_');
}

/**
 * The jobs declaration of the project at `cwd`, or undefined when its
 * package.json has no `spfn.jobs`.
 *
 * @throws JobsDeclarationError naming the file — and the key, for a value
 *     that is neither `true` nor `{ "schema": "<name>" }`, or a schema that
 *     is the project's — when the file cannot be read or parsed, or the value
 *     is malformed or names `public` or `drizzle`
 */
export function readJobsDeclaration(cwd: string = process.cwd()): JobsDeclaration | undefined
{
    const file = join(cwd, 'package.json');
    const spfn = readPackageJson(file).spfn;

    if (spfn === undefined)
    {
        return undefined;
    }

    if (!isPlainObject(spfn))
    {
        throw new JobsDeclarationError(file, '"spfn" must be an object');
    }

    if (spfn.jobs === undefined)
    {
        return undefined;
    }

    const declaration = jobsDeclaration(file, spfn.jobs);

    if (declaration.schema === 'public' || declaration.schema === BOOKKEEPING_SCHEMA)
    {
        throw new JobsDeclarationError(file, `"spfn.jobs.schema" cannot be the queue schema: "${declaration.schema}" holds the project's `
            + `${declaration.schema === 'public' ? 'tables' : 'migration bookkeeping'}, and the queue schema is pg-boss's alone`);
    }

    return declaration;
}

/** `value`, the `spfn.jobs` of `file`, as a declaration. */
function jobsDeclaration(file: string, value: unknown): JobsDeclaration
{
    if (value === true)
    {
        return { schema: DEFAULT_QUEUE_SCHEMA };
    }

    const malformed = `"spfn.jobs" must be true or { "schema": "<name>" }, got ${JSON.stringify(value)}`;

    if (!isPlainObject(value) || Object.keys(value).some(key => key !== 'schema') || typeof value.schema !== 'string')
    {
        throw new JobsDeclarationError(file, malformed);
    }

    if (!isQueueSchemaName(value.schema))
    {
        throw new JobsDeclarationError(file, `"spfn.jobs.schema" ${JSON.stringify(value.schema)} is no queue schema name: lower-case letters, digits and _, at most 50, not starting with a digit or pg_, and no PostgreSQL keyword but an unreserved one`);
    }

    return { schema: value.schema };
}

function readPackageJson(file: string): Record<string, unknown>
{
    const parsed = parseJsonFile(file);

    if (parsed instanceof Error || !isPlainObject(parsed))
    {
        throw new JobsDeclarationError(file, `cannot be read as a package.json${parsed instanceof Error ? ` (${parsed.message})` : ''}`);
    }

    return parsed;
}

/** The parsed contents of `file`, or why it could not be read or parsed. */
function parseJsonFile(file: string): unknown
{
    try
    {
        return JSON.parse(readFileSync(file, 'utf-8'));
    }
    catch (error)
    {
        return error instanceof Error ? error : new Error(String(error));
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
