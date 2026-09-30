/**
 * Shared access to a package's env schema (the `envSchema` export of its
 * `<pkg>/config` entrypoint), plus secret-oriented helpers.
 *
 * Extracted from `commands/env.ts` so `spfn env` and `spfn secret` read the schema
 * the same way.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Valid NODE_ENV values accepted by `--env`. */
export const VALID_ENVS = ['local', 'development', 'staging', 'production', 'test'] as const;

export type EnvName = (typeof VALID_ENVS)[number];

/** Generation strategies declared by `envSecret({ generate })` in the schema. */
export type GenerateSpec = 'hex32' | 'hex64' | 'uuid' | 'base64url32';

/** The deployment layer a value comes from; an entry without one may come from any layer. */
export type EnvLayer = 'environment' | 'instance';

/** A single env-var schema entry (the shape `@spfn/core/env` produces). */
export interface EnvSchemaEntry
{
    key: string;
    type: 'string' | 'number' | 'boolean' | 'url' | 'enum' | 'json';
    description: string;
    required?: boolean;
    default?: unknown;
    sensitive?: boolean;
    generate?: GenerateSpec;
    nextjs?: boolean;
    examples?: unknown[];
    layer?: EnvLayer;
    readBy?: string[];
    minLength?: number;
    validator?: (value: string) => unknown;
}

export type EnvSchema = Record<string, EnvSchemaEntry>;

/**
 * Load the `envSchema` export from a package's `/config` entrypoint.
 *
 * The package is resolved from the project root first, so the app's installed
 * copy is the one read even when the CLI runs from elsewhere (`npx`); the
 * CLI's own resolution is the fallback.
 */
export async function loadEnvSchema(packageName: string, cwd: string = process.cwd()): Promise<EnvSchema>
{
    const specifier = `${packageName}/config`;
    const path = resolveFrom(join(cwd, 'noop.js'), specifier);
    const module = await import(path ? pathToFileURL(path).href : specifier).catch((error: unknown) =>
    {
        const message = error instanceof Error ? error.message : String(error);

        return Promise.reject(new Error(`Failed to load package ${packageName}: ${message}`));
    });

    if (!module.envSchema)
    {
        throw new Error(`Package ${packageName} does not export envSchema from config`);
    }

    return module.envSchema as EnvSchema;
}

/**
 * Resolve a specifier as if imported from `parent`, or `undefined` when it
 * does not resolve there (not installed, or the subpath is not exported).
 */
export function resolveFrom(parent: string, specifier: string): string | undefined
{
    try
    {
        return createRequire(parent).resolve(specifier);
    }
    catch
    {
        return undefined;
    }
}

/**
 * Determine which env file a variable belongs in (Next.js-facing vs server-only).
 */
export function getTargetFile(schema: EnvSchemaEntry): string
{
    const isNextjs = schema.nextjs ?? schema.key?.startsWith('NEXT_PUBLIC_');

    if (isNextjs)
    {
        return schema.sensitive ? '.env.local' : '.env';
    }

    return '.env.server';
}

/** All secret (sensitive) entries of a schema. */
export function secretEntries(schema: EnvSchema): EnvSchemaEntry[]
{
    return Object.values(schema).filter((entry) => entry.sensitive);
}

/** Secret entries that declare a `generate` strategy (we can mint these). */
export function generatableSecrets(schema: EnvSchema): EnvSchemaEntry[]
{
    return secretEntries(schema).filter((entry) => !!entry.generate);
}

/**
 * Whether an entry's value may come from `layer` — only an entry that declares
 * `layer` is pinned to it.
 */
export function allowsLayer(entry: EnvSchemaEntry, layer: EnvLayer): boolean
{
    return entry.layer === undefined || entry.layer === layer;
}
