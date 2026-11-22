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
 *   node scripts/ci-scope.mjs built
 *       Prints the directory of every package whose `build` turbo runs with
 *       those filters (`turbo run build --dry=json`, dependencies included),
 *       space-separated — what the build step built, for the bundle check.
 *
 * All three print the decision as one line on stderr, for the log.
 *
 * The changed files come from Woodpecker's `CI_PIPELINE_EVENT` and
 * `CI_PIPELINE_FILES`, or — when the Gitea Actions workflow sets
 * `CI_SCOPE_EVENT` — from `git diff --name-only <CI_SCOPE_DIFF_BASE>...HEAD`
 * (scripts/lib/ci-scope.mjs, `scopeFromEnvironment`).
 *
 * The selection for `includes` comes from turbo's own graph (`turbo ls`), the
 * same graph `turbo run` will use with the same filters. A second, hand-written
 * graph here would be one more thing to drift.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesSince, describeScope, scopeFromEnvironment, turboFilters } from "./lib/ci-scope.mjs";

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

/** The directories of the packages whose `build` task `turbo run build` runs with these filters. */
function builtDirectories(filters)
{
    const plan = execFileSync("pnpm", ["exec", "turbo", "run", "build", ...filters, "--dry=json"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
    });

    return JSON.parse(plan).tasks
        .filter((task) => task.task === "build" && task.command !== "<NONEXISTENT>")
        .map((task) => task.directory);
}

function includes(scope, name)
{
    return scope.all || selectedPackages(turboFilters(scope)).includes(name);
}

function main([command, name])
{
    const scope = scopeFromEnvironment(process.env, (base) => changedFilesSince(base, ROOT), readPackageDirs());

    console.error(describeScope(scope));

    if (command === "filters")
    {
        process.stdout.write(`${turboFilters(scope).join(" ")}\n`);

        return 0;
    }

    if (command === "built")
    {
        process.stdout.write(`${builtDirectories(turboFilters(scope)).join(" ")}\n`);

        return 0;
    }

    if (command === "includes" && name)
    {
        return includes(scope, name) ? 0 : 1;
    }

    console.error("usage: node scripts/ci-scope.mjs filters | built | includes <package-name>");

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
