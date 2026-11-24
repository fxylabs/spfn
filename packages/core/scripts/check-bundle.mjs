/**
 * Probes on the built entries, run by scripts/check-bundle-identity.mjs at the repository root
 * after the build.
 *
 * Identity: a class reached through two entries must be one class: the text check finds a
 * module emitted twice, these show what a caller would see.
 *
 * Isomorphic entries: `@spfn/core/options` is imported by browser and edge bundles, so no file
 * it loads may import a Node module — a bundler replaces `node:util` with a userland `util`
 * whose `types.isProxy` throws (#492). Not a vitest row: vitest resolves under Node, where such
 * an import works. Read from the build record (`scripts/lib/bundle-identity.mjs`), which names
 * every import of every output file.
 */

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

import { requireOwner } from '@spfn/core/authz';
import { HttpError, NotFoundError } from '@spfn/core/errors';
import { OpsRouterError } from '@spfn/core/ops';
import { SurfaceError } from '@spfn/core/surface';

const failures = [];

const ISOMORPHIC_ENTRIES = ['dist/options/index.js'];

/** Each Node module `entry` loads, through every chunk it imports, as the build record names them. */
function nodeImportsOf(entry, outputs)
{
    const seen = new Set();
    const pending = [entry];
    const nodeImports = [];

    while (pending.length > 0)
    {
        const file = pending.pop();
        seen.add(file);
        for (const { path, external } of outputs[file].imports)
        {
            if (external && (path.startsWith('node:') || builtinModules.includes(path)))
            {
                nodeImports.push(`${file} imports ${path}`);
            }
            else if (!external && !seen.has(path))
            {
                pending.push(path);
            }
        }
    }

    return nodeImports;
}

const { outputs } = JSON.parse(readFileSync(new URL('../dist/main.metafile.json', import.meta.url), 'utf8'));

for (const entry of ISOMORPHIC_ENTRIES)
{
    failures.push(...nodeImportsOf(entry, outputs).map(found => `${entry} is isomorphic, and ${found}`));
}

const thrown = (() =>
{
    try
    {
        requireOwner(null, 'owner');
    }
    catch (error)
    {
        return error;
    }
})();

if (!(thrown instanceof NotFoundError) || !(thrown instanceof HttpError))
{
    failures.push('requireOwner throws a NotFoundError that is not instanceof the one from @spfn/core/errors');
}

if (OpsRouterError !== SurfaceError)
{
    failures.push('OpsRouterError from @spfn/core/ops is not SurfaceError from @spfn/core/surface');
}

if (failures.length > 0)
{
    console.error(`Bundle probes failed:\n${failures.map(failure => `  - ${failure}`).join('\n')}`);
    process.exit(1);
}

console.log('Identity probes passed: requireOwner throws @spfn/core/errors\' NotFoundError; OpsRouterError is SurfaceError.');
console.log(`Isomorphic entries import no Node module: ${ISOMORPHIC_ENTRIES.join(', ')}.`);
