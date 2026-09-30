/**
 * Conventions for where encrypted prod/staging secrets live and how `.sops.yaml` is
 * located.
 *
 * Each non-local environment maps to `secrets/<env>.enc.json` under the project, and
 * each named instance of one to `secrets/<env>.<instance>.enc.json`. The
 * `.sops.yaml` (which selects the age/KMS backend) is searched for from the project
 * directory upward, since it commonly sits at the repo root.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const SECRETS_DIR = 'secrets';

export interface SopsFile
{
    /** Absolute path to the encrypted file. */
    absFile: string;

    /** Project-relative path (used for `.sops.yaml` rule matching). */
    relFile: string;
}

/**
 * The encrypted secret file for an environment — `secrets/<env>.enc.json` — or,
 * with an instance, for that instance of it: `secrets/<env>.<instance>.enc.json`.
 * Both match the `secrets/.*\.enc\.json$` rule `spfn secret recipients` writes.
 */
export function getSopsFile(cwd: string, env: string, instance?: string): SopsFile
{
    const relFile = `${SECRETS_DIR}/${instance ? `${env}.${instance}` : env}.enc.json`;

    return { absFile: join(cwd, relFile), relFile };
}

/** Walk up from `cwd` to find a file, returning its directory or null. */
export function findUp(cwd: string, filename: string, maxDepth = 6): string | null
{
    let dir = cwd;

    for (let depth = 0; depth < maxDepth; depth++)
    {
        if (existsSync(join(dir, filename)))
        {
            return dir;
        }

        const parent = join(dir, '..');
        if (parent === dir)
        {
            break;
        }

        dir = parent;
    }

    return null;
}

/** Path to the nearest `.sops.yaml`, or null when none exists. */
export function findSopsConfig(cwd: string): string | null
{
    const dir = findUp(cwd, '.sops.yaml');

    return dir ? join(dir, '.sops.yaml') : null;
}

/** Whether a `.sops.yaml` is reachable from `cwd`. */
export function hasSopsConfig(cwd: string): boolean
{
    return findSopsConfig(cwd) !== null;
}

/** Absolute paths of all managed encrypted secret files (`secrets/*.enc.json`). */
export function listSopsFiles(cwd: string): string[]
{
    const dir = join(cwd, SECRETS_DIR);

    if (!existsSync(dir))
    {
        return [];
    }

    return readdirSync(dir)
        .filter((name) => name.endsWith('.enc.json'))
        .map((name) => join(dir, name));
}
