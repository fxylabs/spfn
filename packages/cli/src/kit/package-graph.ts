/**
 * Making the project's dependency declaration say what the release says, and
 * proving afterwards that the tree agrees.
 *
 * An update changes which versions the release pins. Nothing puts those
 * versions into the project unless something writes them: `package.json` still
 * names the old ones, the lockfile still resolves them, and a frozen install
 * against that lockfile succeeds — installing the previous release perfectly.
 * The Kit lock is then written with the new release number over a `node_modules`
 * that holds the old one, and the update reports success. That failure is
 * silent in every direction, which is why both halves live here:
 *
 *   - `applyManifestVersions` writes the versions, and only for the names the
 *     manifest lists. Unit 05 §6.2 makes `package.json` shared — the Kit owns
 *     its dependency keys and the customer owns everything else in the file —
 *     so a name the manifest does not carry is not touched, and neither is any
 *     other field, key order or formatting;
 *   - `installedGraphMismatches` reads what is actually on disk afterwards. The
 *     registry verification proves the *registry* would serve the right bytes;
 *     this proves the project *has* them.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KitReleaseManifestView } from './manifest.js';

/** The `package.json` blocks a Kit release may pin a version in. */
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export interface DependencyChange
{
    name: string;
    block: string;
    from: string;
    to: string;
}

export interface GraphMismatch
{
    name: string;
    expected: string;
    /** What is installed, or null when the package is not there at all. */
    actual: string | null;
}

/**
 * Point every Kit-owned dependency key at the version this release pins.
 *
 * Returns what changed, so a caller can tell "the declaration already agreed"
 * from "the declaration was rewritten" — the first needs no re-resolution and
 * the second does.
 */
export function applyManifestVersions(projectDir: string, manifest: KitReleaseManifestView): DependencyChange[]
{
    const file = join(projectDir, 'package.json');

    if (!existsSync(file))
    {
        return [];
    }

    const raw = readFileSync(file, 'utf8');
    const document = JSON.parse(raw) as Record<string, Record<string, string> | unknown>;
    const wanted = new Map(manifest.packages.map(entry => [entry.name, entry.version]));
    const changes: DependencyChange[] = [];

    for (const block of DEPENDENCY_BLOCKS)
    {
        const entries = document[block];

        if (typeof entries !== 'object' || entries === null || Array.isArray(entries))
        {
            continue;
        }

        for (const [name, current] of Object.entries(entries as Record<string, string>))
        {
            const target = wanted.get(name);

            /* An exact pin, because the release is an exact graph. A range
               here would let the next resolution drift off the release the
               manifest signed while every check still passed. */
            if (target === undefined || current === target)
            {
                continue;
            }

            (entries as Record<string, string>)[name] = target;
            changes.push({ name, block, from: current, to: target });
        }
    }

    if (changes.length > 0)
    {
        /* Written back in the file's own layout, because `package.json` is
           shared: the customer owns its scripts and its formatting, and an
           update that repins two versions and reindents seventy lines has
           rewritten a customer file to change a Kit one. */
        writeFileSync(file, `${JSON.stringify(document, null, indentationOf(raw))}${trailingNewline(raw)}`);
    }

    return changes;
}

/**
 * The indentation the file already uses.
 *
 * Read from the first indented line rather than guessed. A tab counts as a
 * tab; anything unreadable falls back to two spaces, which is what a package
 * manager writes.
 */
function indentationOf(raw: string): string | number
{
    const match = /\n([ \t]+)"/.exec(raw);

    if (match === undefined || match === null)
    {
        return 2;
    }

    return match[1].startsWith('\t') ? '\t' : match[1].length;
}

function trailingNewline(raw: string): string
{
    return raw.endsWith('\n') ? '\n' : '';
}

/**
 * Every manifest package the installed tree does not hold at its pinned version.
 *
 * Read from `node_modules` rather than from the lockfile: a lockfile says what
 * *would* be installed, and the question after an install is what *is*. A
 * package the release names and the tree does not have counts as a mismatch
 * with `actual: null`, because "absent" and "present at the wrong version" are
 * the same failure for an exact graph.
 */
export function installedGraphMismatches(
    projectDir: string,
    manifest: Pick<KitReleaseManifestView, 'packages'>,
    skip: (name: string) => boolean = () => false,
): GraphMismatch[]
{
    const mismatches: GraphMismatch[] = [];

    for (const entry of manifest.packages)
    {
        if (skip(entry.name))
        {
            continue;
        }

        const installed = installedVersion(projectDir, entry.name);

        if (installed !== entry.version)
        {
            mismatches.push({ name: entry.name, expected: entry.version, actual: installed });
        }
    }

    return mismatches;
}

function installedVersion(projectDir: string, name: string): string | null
{
    const file = join(projectDir, 'node_modules', ...name.split('/'), 'package.json');

    if (!existsSync(file))
    {
        return null;
    }

    try
    {
        const version = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;

        return typeof version === 'string' ? version : null;
    }
    catch
    {
        return null;
    }
}
