/**
 * Merge the layers of one deployment's env into the values it runs with.
 *
 * A deployment's values come from three layers: the environment's encrypted file
 * (shared by every instance), the instance's encrypted file, and plaintext files a
 * deploy script computes (`--with`). Each name comes from exactly one layer; a
 * schema entry that sets `layer` pins which kind, one without it may come from any.
 * A name found twice, or found in a layer of the wrong kind, is an error rather
 * than an override. Messages carry names,
 * layers and reasons — never a value.
 */

import { allowsLayer, type EnvLayer, type EnvSchema, type EnvSchemaEntry } from './env-schema.js';

/** One layer's values and how output names it. */
export interface LayerSource
{
    /** `environment`, `instance`, or the `--with` path. */
    label: string;

    /** The kind of layer — which declared schema `layer` it may supply. */
    kind: EnvLayer;

    values: Record<string, string>;
}

export interface LayerMerge
{
    /** The values to write, by name. */
    values: Record<string, string>;

    /** The label of the layer each written name came from. */
    origins: Record<string, string>;

    errors: string[];
    warnings: string[];
}

/**
 * Merge layers against the env list. Only listed names are kept; every problem
 * is collected so one run reports them all.
 */
export function mergeLayers(schema: EnvSchema, sources: LayerSource[]): LayerMerge
{
    const merge: LayerMerge = { values: {}, origins: {}, errors: [], warnings: [] };

    for (const [name, found] of collectListed(schema, sources, merge.warnings))
    {
        const reason = placementError(schema[name], found) ?? valueError(schema[name], found[0].values[name]);

        if (reason)
        {
            merge.errors.push(`${name}: ${reason}`);
            continue;
        }

        merge.values[name] = found[0].values[name];
        merge.origins[name] = found[0].label;
    }

    for (const entry of Object.values(schema))
    {
        if (isRequired(entry) && !sources.some((source) => Object.hasOwn(source.values, entry.key)))
        {
            merge.errors.push(`${entry.key}: required, and in none of the layers`);
        }
    }

    return merge;
}

/**
 * The layers each listed name appears in. A name the list does not know is
 * warned about by name and dropped.
 */
function collectListed(schema: EnvSchema, sources: LayerSource[], warnings: string[]): Map<string, LayerSource[]>
{
    const found = new Map<string, LayerSource[]>();

    for (const source of sources)
    {
        for (const name of Object.keys(source.values))
        {
            if (!Object.hasOwn(schema, name))
            {
                warnings.push(`${name} (in ${source.label}) is not in the env list — not written`);
                continue;
            }

            found.set(name, [...found.get(name) ?? [], source]);
        }
    }

    return found;
}

/**
 * Why a name's layers are wrong: found in more than one, or in a layer of
 * another kind than its schema declares. A name without a declared layer fits any.
 */
function placementError(entry: EnvSchemaEntry, found: LayerSource[]): string | undefined
{
    if (found.length > 1)
    {
        return `in more than one layer: ${found.map((source) => source.label).join(' and ')}`;
    }

    if (!allowsLayer(entry, found[0].kind))
    {
        return `declared with layer "${entry.layer}", but found in ${found[0].label}`;
    }

    return undefined;
}

/**
 * Why a value fails its declaration — `minLength`, then `validator` — or
 * undefined when it passes.
 */
export function valueError(entry: EnvSchemaEntry, value: string): string | undefined
{
    if (entry.minLength !== undefined && value.length < entry.minLength)
    {
        return `must be at least ${entry.minLength} characters long`;
    }

    if (!entry.validator)
    {
        return undefined;
    }

    try
    {
        entry.validator(value);

        return undefined;
    }
    catch (error)
    {
        return withoutValue(error instanceof Error ? error.message : String(error), value);
    }
}

/**
 * A validator's message, unless it quotes the value — a custom validator may
 * well do that, and the value must not reach the terminal.
 */
function withoutValue(reason: string, value: string): string
{
    if (value.length > 0 && reason.includes(value))
    {
        return 'rejected by its validator (the message is withheld because it contains the value)';
    }

    return reason;
}

/**
 * Required and without a default — a name the deployment cannot start without.
 */
function isRequired(entry: EnvSchemaEntry): boolean
{
    return entry.required === true && entry.default === undefined;
}
