#!/usr/bin/env node
/**
 * The pipeline's side of scripts/lib/ci-scope.mjs: reads the environment and
 * the workspace, and answers in a form a shell step can use.
 *
 *   node scripts/ci-scope.mjs filters
 *       Prints one `--filter=...<name>` per changed package, space-separated,
 *       or nothing at all when the scope is "all" — so an unquoted
 *       `$FILTERS` adds no argument and turbo runs everything.
 *
 *   node scripts/ci-scope.mjs includes <package-name>
 *       Exits 0 when the scope is "all" or the scoped selection (the changed
 *       packages and everything that depends on them) contains the package,
 *       1 when it does not, and 2 on any error — so a step can tell "skip"
 *       apart from "the check itself broke".
 *
 * Both print the decision as one line on stderr, for the log.
 *
 * The selection for `includes` comes from turbo's own graph (`turbo ls`), the
 * same graph `turbo run` will use with the same filters. A second, hand-written
 * graph here would be one more thing to drift.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ciScope, describeScope, turboFilters } from "./lib/ci-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every package directory under the layout in pnpm-workspace.yaml. */
function candidateDirectories()
{
    const children = (parent) => readdirSync(join(ROOT, parent)).map((child) => `${parent}/${child}`);

    return [...children("packages"), ...children("examples"), "website"];
}

/** Package directory → package name, for every directory with a package.json at HEAD. */
function readPackageDirs()
{
    return new Map(candidateDirectories()
        .filter((directory) => existsSync(join(ROOT, directory, "package.json")))
        .map((directory) => [directory, JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8")).name]));
}

/** The package names `turbo run` would select with these filters. */
function selectedPackages(filters)
{
    const listing = execFileSync("pnpm", ["exec", "turbo", "ls", ...filters, "--output=json"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
    });

    return JSON.parse(listing).packages.items.map((item) => item.name);
}

function includes(scope, name)
{
    return scope.all || selectedPackages(turboFilters(scope)).includes(name);
}

function main([command, name])
{
    const scope = ciScope(process.env.CI_PIPELINE_EVENT, process.env.CI_PIPELINE_FILES, readPackageDirs());

    console.error(describeScope(scope));

    if (command === "filters")
    {
        process.stdout.write(`${turboFilters(scope).join(" ")}\n`);

        return 0;
    }

    if (command === "includes" && name)
    {
        return includes(scope, name) ? 0 : 1;
    }

    console.error("usage: node scripts/ci-scope.mjs filters | includes <package-name>");

    return 2;
}

try
{
    process.exitCode = main(process.argv.slice(2));
}
catch (error)
{
    console.error(error);
    process.exitCode = 2;
}
