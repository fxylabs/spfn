#!/usr/bin/env node
// An ESM-only exports map passes install, typecheck and the IDE, then breaks the first
// consumer that resolves it through a require path — a CommonJS consumer under plain
// Node, or any app code a TypeScript loader runs as CommonJS — with
// ERR_PACKAGE_PATH_NOT_EXPORTED (issue #102: @spfn/i18n and @spfn/mcp shipped this way
// and every fresh `spfn create --mode full` scaffold failed its first run, back when
// `spfn dev` ran the app's server.config.ts as CommonJS).
//
// One mechanical rule: every conditional exports subpath in every published package
// declares a `require` condition. Pointing it at the same ESM file is fine for plain
// Node 20.19+, whose require(esm) shares the one instance `import` gets. tsx does not:
// its CommonJS handler transforms the ESM file into a second instance with its own
// module state (issue #329) — which is why `spfn dev` now runs the app as ESM, not a
// reason to drop the condition. The condition just has to exist.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function missingRequire(exports)
{
    if (typeof exports !== 'object' || exports === null) return [];

    // A flat conditions object (no "./" keys) is a single-subpath map.
    const subpaths = Object.keys(exports).some(k => k.startsWith('.'))
        ? Object.entries(exports)
        : [['.', exports]];

    const missing = [];
    for (const [subpath, conditions] of subpaths)
    {
        // A string target ("./file.js") resolves for every condition; only a
        // conditions object can exclude require. Non-code subpaths stay out.
        if (typeof conditions !== 'object' || conditions === null) continue;
        if (subpath.endsWith('.json') || subpath.endsWith('.css')) continue;

        if (!('require' in conditions) && !('default' in conditions))
        {
            missing.push(subpath);
        }
    }
    return missing;
}

const failures = [];
for (const name of readdirSync(join(ROOT, 'packages')))
{
    const manifest = join(ROOT, 'packages', name, 'package.json');
    if (!existsSync(manifest)) continue;

    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.private) continue;

    for (const subpath of missingRequire(pkg.exports))
    {
        failures.push(`${pkg.name}: exports["${subpath}"] has no "require" (or "default") condition`);
    }
}

if (failures.length > 0)
{
    console.error('ESM-only exports break require-path consumers (spfn dev config loader, issue #102):\n');
    for (const line of failures) console.error(`  ${line}`);
    console.error('\nAdd a "require" condition to each subpath — the same ESM file is fine.');
    process.exit(1);
}

console.log('exports check: every published subpath is require-resolvable.');
