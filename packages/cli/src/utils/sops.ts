/**
 * Thin wrapper around the `sops` CLI for managing encrypted secret files.
 *
 * SOPS encrypts the *values* in a file and leaves keys readable; the backend (age /
 * GCP KMS / AWS KMS) is chosen by `.sops.yaml` creation rules matched on the file
 * path, so this wrapper never touches keys or cloud SDKs directly. Secret files are
 * flat JSON maps (`{ "KEY": "value" }`) under `secrets/<env>.enc.json`.
 *
 * SOPS interactions assume a Unix host and sops 3.10+ (`encrypt` from stdin,
 * `set --value-stdin`, `--filename-override`, `updatekeys -y`), so plaintext is
 * never written to disk or passed as an argument.
 */

import { execa } from 'execa';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Ensure the `sops` binary is on PATH; throw a friendly error otherwise.
 */
export async function ensureSopsInstalled(): Promise<void>
{
    try
    {
        await execa('sops', ['--version']);
    }
    catch
    {
        throw new Error('`sops` not found on PATH. Install it: https://github.com/getsops/sops');
    }
}

/**
 * Decrypt a secret file into a key→value record. Returns {} when the file is absent.
 *
 * A failure is reported by file and exit code only: neither the sops error (which
 * carries its stdout) nor a JSON parse error (which quotes its input) may reach a
 * log, since either could hold a decrypted value.
 */
export async function sopsDecrypt(absFile: string): Promise<Record<string, string>>
{
    if (!existsSync(absFile))
    {
        return {};
    }

    const { stdout } = await execa('sops', ['--decrypt', '--output-type', 'json', absFile]).catch((error: unknown) =>
    {
        const exitCode = (error as { exitCode?: number }).exitCode ?? 'unknown';

        return Promise.reject(new Error(
            `sops could not decrypt ${absFile} (exit code ${exitCode}). Check that this machine has key access `
            + `for the backend .sops.yaml selects; \`sops --decrypt ${absFile} > /dev/null\` shows sops' reason.`,
        ));
    });

    return toStringRecord(absFile, parseJsonObject(absFile, stdout));
}

/**
 * The names in an encrypted file, read without decrypting — SOPS leaves keys in the
 * clear. Returns [] when the file is absent.
 */
export function sopsKeyNames(absFile: string): string[]
{
    if (!existsSync(absFile))
    {
        return [];
    }

    return Object.keys(parseJsonObject(absFile, readFileSync(absFile, 'utf-8'))).filter((key) => key !== 'sops');
}

/**
 * Parse a flat JSON object without letting the parser's message — which quotes
 * the input — escape.
 */
function parseJsonObject(absFile: string, text: string): Record<string, unknown>
{
    let parsed: unknown;

    try
    {
        parsed = JSON.parse(text);
    }
    catch
    {
        parsed = undefined;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    {
        throw new Error(`${absFile} is not a flat JSON object of secrets.`);
    }

    return parsed as Record<string, unknown>;
}

/**
 * Scalars become their string form; a nested value cannot be an env value.
 */
function toStringRecord(absFile: string, parsed: Record<string, unknown>): Record<string, string>
{
    const record: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed))
    {
        if (typeof value === 'object' && value !== null)
        {
            throw new Error(`${absFile}: ${key} holds a nested value; secret files are flat KEY → string maps.`);
        }

        record[key] = String(value);
    }

    return record;
}

/**
 * Set (or replace) a single key in the encrypted file, creating the file with the
 * `.sops.yaml` rules for `relFile` when it does not yet exist.
 */
export async function sopsSetValue(
    absFile: string,
    relFile: string,
    key: string,
    value: string,
): Promise<void>
{
    if (existsSync(absFile))
    {
        // The value goes in on stdin: as an argument it would sit in the process
        // table and in execa's error message.
        await execa('sops', ['set', '--value-stdin', absFile, `["${key}"]`], { input: JSON.stringify(value) })
            .catch((error: unknown) => Promise.reject(sopsWriteError(relFile, key, error)));

        return;
    }

    mkdirSync(dirname(absFile), { recursive: true });

    // Encrypt from stdin so the plaintext never lands on disk; --filename-override
    // makes .sops.yaml creation rules match the intended path. `sops encrypt` with
    // no file reads stdin itself — opening `/dev/stdin` fails on Linux, where the
    // child's stdin is a socket.
    const { stdout } = await execa(
        'sops',
        [
            'encrypt',
            '--input-type', 'json',
            '--output-type', 'json',
            '--filename-override', relFile,
        ],
        { input: JSON.stringify({ [key]: value }) },
    ).catch((error: unknown) => Promise.reject(sopsWriteError(relFile, key, error)));

    writeFileSync(absFile, stdout);
}

/**
 * A write failure by file, key and exit code — never execa's message, which
 * carries the command's input and output.
 */
function sopsWriteError(relFile: string, key: string, error: unknown): Error
{
    const exitCode = (error as { exitCode?: number }).exitCode ?? 'unknown';

    return new Error(`sops could not write ${key} to ${relFile} (exit code ${exitCode}). `
        + 'Check .sops.yaml has a creation rule for the file and this machine has key access.');
}

/**
 * Re-encrypt the file's data key for the current `.sops.yaml` recipient set.
 */
export async function sopsUpdateKeys(absFile: string): Promise<void>
{
    await execa('sops', ['updatekeys', '-y', absFile]);
}
