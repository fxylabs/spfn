#!/usr/bin/env node
/**
 * Print the commit that set the current version of one package
 * (`scripts/lib/version-commit.mjs`). `publish-from-gitea.yml` tags that
 * commit, and only from the run for it (#463).
 *
 * Usage: node scripts/version-commit.mjs <package-dir>
 *
 * Run from the repository root, in a clone with the full history.
 */

import { versionCommit } from "./lib/version-commit.mjs";

const dirs = process.argv.slice(2);

if (dirs.length !== 1)
{
    console.error("Usage: node scripts/version-commit.mjs <package-dir>");
    process.exit(1);
}

console.log(versionCommit(`${dirs[0].replace(/\/+$/, "")}/package.json`));
