/**
 * Render a surface command's input schemas as usage text.
 *
 * The manifest carries each command's TypeBox schemas as plain JSON Schema,
 * so the terminal can tell an operator what a command takes without the app's
 * source. This turns that JSON into the shape a `--help` reader expects:
 * one line per field, with its type, whether it is required, and whatever
 * constraints the schema states.
 *
 * The server remains the authority on what is valid — this only reports what
 * the server said.
 */

import type { SurfaceCommandDescriptor } from './types.js';
import { plain } from './plain.js';

export { plain };

/** The input sections a command can declare, in the order they are shown. */
const SECTIONS = [
    { key: 'params', label: 'path parameters', flag: '--param' },
    { key: 'query', label: 'query parameters', flag: '--query' },
    { key: 'body', label: 'body fields', flag: '--data' },
] as const;

interface FieldRow
{
    /** Dotted path for a nested field, so one flat list stays unambiguous. */
    name: string;
    type: string;
    requirement: string;
    notes: string;
}

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How deep a schema is followed before its fields stop being listed.
 *
 * `collectFields` recurses once per level of nesting, so a schema deep enough
 * exhausts the stack and the command dies with `Maximum call stack size
 * exceeded` instead of printing usage. The limit is far past anything an
 * operator would read as a flat list anyway.
 */
const MAX_SCHEMA_DEPTH = 12;

/**
 * The type as an operator should read it: `string`, `number[]`, `a|b` for a
 * union, `object` for anything with its own fields.
 */
function typeName(schema: Schema): string
{
    if (Array.isArray(schema.enum))
    {
        return schema.enum.every(v => typeof v === 'string') ? 'string' : 'value';
    }

    const variants = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(variants))
    {
        const names = variants
            .filter(isSchema)
            .map(typeName)
            .filter(name => name !== 'null');

        return [...new Set(names)].join('|') || 'value';
    }

    const type = schema.type;
    if (Array.isArray(type))
    {
        return type.filter(t => t !== 'null').join('|') || 'value';
    }

    if (type === 'array')
    {
        return isSchema(schema.items) ? `${typeName(schema.items)}[]` : 'array';
    }

    return typeof type === 'string' ? type : 'value';
}

/** Constraints worth stating next to the field, in the schema's own terms. */
function constraintNotes(schema: Schema): string[]
{
    const notes: string[] = [];

    if (Array.isArray(schema.enum))
    {
        notes.push(`one of: ${schema.enum.map(v => String(v)).join(', ')}`);
    }

    const min = schema.minimum ?? schema.minLength ?? schema.minItems;
    const max = schema.maximum ?? schema.maxLength ?? schema.maxItems;
    if (min !== undefined && max !== undefined)
    {
        notes.push(`${min}–${max}`);
    }
    else if (min !== undefined)
    {
        notes.push(`min ${min}`);
    }
    else if (max !== undefined)
    {
        notes.push(`max ${max}`);
    }

    if (typeof schema.format === 'string')
    {
        notes.push(schema.format);
    }
    if (typeof schema.pattern === 'string')
    {
        notes.push(`matches ${schema.pattern}`);
    }
    if (schema.default !== undefined)
    {
        notes.push(`default ${JSON.stringify(schema.default)}`);
    }
    if (typeof schema.description === 'string' && schema.description.length > 0)
    {
        notes.push(schema.description);
    }

    return notes;
}

/**
 * Flatten a section's object schema into one row per field. A nested object
 * contributes its own fields under a dotted name rather than a row saying
 * `object` and nothing else.
 */
function collectFields(schema: Schema, prefix = '', depth = 0): FieldRow[]
{
    const properties = isSchema(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const rows: FieldRow[] = [];

    for (const [name, raw] of Object.entries(properties))
    {
        if (!isSchema(raw))
        {
            continue;
        }

        const path = prefix ? `${prefix}.${plain(name)}` : plain(name);
        const nested = isSchema(raw.properties) && depth < MAX_SCHEMA_DEPTH
            ? collectFields(raw, path, depth + 1)
            : [];

        if (nested.length > 0)
        {
            rows.push(...nested);
            continue;
        }

        rows.push({
            name: path,
            type: plain(typeName(raw)),
            requirement: required.includes(name) ? 'required' : 'optional',
            notes: plain(constraintNotes(raw).join(', ')),
        });
    }

    return rows;
}

function pad(value: string, width: number): string
{
    return value + ' '.repeat(Math.max(0, width - value.length));
}

function renderSection(label: string, flag: string, rows: FieldRow[]): string[]
{
    const nameWidth = Math.max(...rows.map(r => r.name.length));
    const typeWidth = Math.max(...rows.map(r => r.type.length));
    const lines = [`  ${label} (${flag})`];

    for (const row of rows)
    {
        const notes = row.notes.length > 0 ? `  ${row.notes}` : '';
        lines.push(`    ${pad(row.name, nameWidth)}  ${pad(row.type, typeWidth)}  ${pad(row.requirement, 8)}${notes}`.trimEnd());
    }

    return lines;
}

/**
 * The whole usage block for one command: its method and path, then a section
 * per input kind. A command taking no input says so rather than printing
 * nothing.
 *
 * `invoke` is the command line that calls it — `spfn ops call` for the ops
 * CLI — and adds an example invocation line; a library caller has none.
 */
export function renderCommandUsage(command: SurfaceCommandDescriptor, invoke?: string): string
{
    const lines = [`${plain(command.name)}  ${command.method} ${plain(command.path)}`, ''];
    let described = false;

    if (command.summary)
    {
        lines.push(`  ${plain(command.summary)}`, '');
    }
    lines.push(...metadataLines(command));

    for (const section of SECTIONS)
    {
        const schema = command.input[section.key];
        if (!isSchema(schema))
        {
            continue;
        }

        const rows = collectFields(schema);
        if (rows.length === 0)
        {
            continue;
        }

        lines.push(...renderSection(section.label, section.flag, rows), '');
        described = true;
    }

    if (!described)
    {
        lines.push('  Takes no input.', '');
    }

    if (invoke !== undefined)
    {
        lines.push(`  Invoke: ${invoke} ${plain(command.name)}${exampleFlags(command)}`);
    }

    return lines.join('\n').replace(/\n+$/, '');
}

/**
 * The effect, and for a module command its scopes. An app command declares
 * no scopes — its guards are its own middlewares — so it gets no `Scopes:`
 * line claiming they were "not declared".
 */
function metadataLines(command: SurfaceCommandDescriptor): string[]
{
    if (!command.effect && !command.scopes)
    {
        return [];
    }

    const lines = [`  Effect: ${command.effect ?? 'unknown'}`];
    if (command.module !== undefined || command.scopes !== undefined)
    {
        lines.push(`  Scopes: ${command.scopes?.map(plain).join(', ') || '(not declared)'}`);
    }

    return [...lines, ''];
}

function exampleFlags(command: SurfaceCommandDescriptor): string
{
    const parts: string[] = [];

    for (const section of SECTIONS)
    {
        const schema = command.input[section.key];
        if (!isSchema(schema))
        {
            continue;
        }

        const [first] = collectFields(schema);
        if (!first)
        {
            continue;
        }

        parts.push(section.key === 'body'
            ? ` --data '{"${first.name}": ...}'`
            : ` ${section.flag} ${first.name}=<value>`);
    }

    return parts.join('');
}
