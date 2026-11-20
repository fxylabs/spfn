#!/usr/bin/env node
// A package whose `build` skips the bundle identity check can ship one module twice — two
// copies of a class, a singleton or a registry, one per entry point — and nothing fails
// (#398). `scripts/check-bundle-identity.mjs` only runs where a build calls it, so this
// check holds every workspace package to calling it: its `build` script runs
// `node ../../scripts/check-bundle-identity.mjs` as a `&&` step after its last `tsup` step.
//
// Run by `pnpm check:exports`, which the pull request pipeline runs.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = 'node ../../scripts/check-bundle-identity.mjs';

/** Why the build script does not run the check after its bundling, or undefined when it does. */
function buildScriptProblem(build)
{
    if (build === undefined)
    {
        return 'has no `build` script';
    }
    const steps = build.split('&&').map(step => step.trim());
    const check = steps.lastIndexOf(CHECK);
    if (check === -1)
    {
        return `\`build\` does not run \`${CHECK}\` as a \`&&\` step`;
    }
    if (steps.findLastIndex(step => /\btsup\b/.test(step)) > check)
    {
        return `\`build\` runs \`${CHECK}\` before its last \`tsup\` step`;
    }
    return undefined;
}

const failures = readdirSync(join(ROOT, 'packages'))
    .map(name => join('packages', name, 'package.json'))
    .filter(manifest => existsSync(join(ROOT, manifest)))
    .map(manifest => [manifest, buildScriptProblem(JSON.parse(readFileSync(join(ROOT, manifest), 'utf-8')).scripts?.build)])
    .filter(([, problem]) => problem !== undefined);

if (failures.length > 0)
{
    console.error('A package build that skips the bundle identity check can ship a module twice (#398):\n');
    for (const [manifest, problem] of failures)
    {
        console.error(`  ${manifest}: ${problem}`);
    }
    console.error(`\nEnd the package's \`build\` with \`&& ${CHECK}\`.`);
    process.exit(1);
}

console.log('build scripts check: every package build runs the bundle identity check.');
