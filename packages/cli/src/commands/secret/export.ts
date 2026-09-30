/**
 * `spfn secret export --env <env> [--instance <name>] [--with <file>]... --out <file>`
 * — assemble one deployment's env file from its layers.
 *
 * Decrypts `secrets/<env>.enc.json` (and `secrets/<env>.<instance>.enc.json` when
 * `--instance` names one that exists), reads each plaintext `--with` file, merges
 * them against the whole-app env list and writes a 0600 dotenv file. Values go to
 * `--out` only: the terminal gets names and the layer each came from. Decryption is
 * whatever `.sops.yaml` configures — this command holds no keys.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
import { logger } from '../../utils/logger.js';
import { parseEnvFile } from '../../utils/env-file.js';
import type { EnvSchema } from '../../utils/env-schema.js';
import { getSopsFile } from '../../utils/secret-config.js';
import { ensureSopsInstalled, sopsDecrypt } from '../../utils/sops.js';
import { mergeLayers, type LayerSource } from '../../utils/secret-layers.js';
import { formatDotenv, writePrivateFileAtomic } from '../../utils/dotenv-out.js';
import { loadSecretList, resolveTarget } from './options.js';
import { isLocalEnv, type SecretTarget } from './store-value.js';

export interface ExportOptions
{
    env?: string;
    instance?: string;
    with?: string[];
    out?: string;
}

export interface ExportRequest
{
    cwd: string;
    target: SecretTarget;
    schema: EnvSchema;

    /** Plaintext dotenv files, relative to `cwd` or absolute. */
    withFiles: string[];

    /** The dotenv file to write, relative to `cwd` or absolute. */
    out: string;
}

export interface ExportReport
{
    /** Whether `out` was written. */
    written: boolean;

    /** The written names and the layer each came from. */
    origins: Record<string, string>;

    errors: string[];
    warnings: string[];
}

export async function secretExport(options: ExportOptions): Promise<void>
{
    const target = resolveTarget(options);

    if (!options.out)
    {
        logger.error('--out <file> is required: export writes values to a file, never to the terminal.');
        process.exit(1);
    }

    if (isLocalEnv(target.env))
    {
        logger.error('export reads the encrypted files of a deployed environment; pass --env <env>.');
        process.exit(1);
    }

    await ensureSopsInstalled();

    const request = {
        cwd: process.cwd(),
        target,
        schema: (await loadSecretList({})).schema,
        withFiles: options.with ?? [],
        out: options.out,
    };
    const report = await exportEnvFile(request).catch((error: unknown) =>
    {
        logger.error(error instanceof Error ? error.message : String(error));

        return process.exit(1);
    });

    printReport(report, request.out);
}

/**
 * Read the layers, merge them and — only when nothing failed — write `out`.
 * Merge problems come back in the report with `out` untouched; unreadable
 * input (a missing file, failed decryption) rejects before anything is written.
 */
export async function exportEnvFile(request: ExportRequest): Promise<ExportReport>
{
    const out = resolve(request.cwd, request.out);
    assertDirectory(dirname(out), '--out');

    const merge = mergeLayers(request.schema, await readLayers(request));
    const report = { written: false, origins: merge.origins, errors: merge.errors, warnings: merge.warnings };

    if (merge.errors.length > 0)
    {
        return report;
    }

    writePrivateFileAtomic(out, formatDotenv(merge.values));

    return { ...report, written: true };
}

/**
 * The environment file, the instance file when one is named, then each `--with`
 * file in order.
 */
async function readLayers(request: ExportRequest): Promise<LayerSource[]>
{
    const { cwd, target } = request;
    const withFiles = request.withFiles.map((file) => readWithFile(cwd, file));
    const sources: LayerSource[] = [{
        label: 'environment',
        kind: 'environment',
        values: await sopsDecrypt(getSopsFile(cwd, target.env).absFile),
    }];

    if (target.instance)
    {
        sources.push({
            label: 'instance',
            kind: 'instance',
            values: await sopsDecrypt(getSopsFile(cwd, target.env, target.instance).absFile),
        });
    }

    return [...sources, ...withFiles];
}

function readWithFile(cwd: string, file: string): LayerSource
{
    const path = resolve(cwd, file);

    if (!existsSync(path))
    {
        throw new Error(`--with file not found: ${path}`);
    }

    return { label: `--with ${file}`, kind: 'instance', values: parseEnvFile(path) };
}

function assertDirectory(path: string, option: string): void
{
    if (!existsSync(path) || !statSync(path).isDirectory())
    {
        throw new Error(`${option}: directory ${path} does not exist. Create it first.`);
    }
}

/**
 * Names and layers only; warnings first, then errors or the written file.
 */
function printReport(report: ExportReport, out: string): void
{
    for (const warning of report.warnings)
    {
        logger.warn(warning);
    }

    if (!report.written)
    {
        logger.error(`Nothing written — ${report.errors.length} problem(s):`);
        report.errors.forEach((error) => console.log(`  ${chalk.red('✗')} ${error}`));
        process.exit(1);
    }

    for (const [name, layer] of Object.entries(report.origins))
    {
        console.log(`  ${chalk.cyan(name)} ${chalk.dim(`← ${layer}`)}`);
    }

    logger.success(`Wrote ${Object.keys(report.origins).length} name(s) to ${out} (mode 0600).`);
}
