#!/usr/bin/env node
/**
 * Publish every packages/* version the private Gitea registry does not have yet,
 * in an order that puts each package after the ones it depends on.
 *
 * Runs in Woodpecker on a main push (see .woodpecker/publish.yml). The registry
 * itself is the idempotency guard: a version already published is skipped, so
 * re-running the pipeline is safe and a push that changed a package.json without
 * bumping the version publishes nothing.
 *
 * The order matters because registry versions are immutable. `readdirSync`
 * order would let a package go out while a sibling it declares a dependency on
 * is still absent, and that version can never be made installable afterwards —
 * only replaced, with everyone who resolved it in between keeping the broken
 * one. So the run is ordered by `scripts/lib/publish-order.mjs`, and the order
 * is then checked rather than trusted: before each publish, every internal
 * dependency's target version has to be on the registry already or to have gone
 * out earlier in this same run.
 *
 * The channel comes from the version string the same way the GitHub npmjs
 * workflows derive it: `-alpha` -> alpha, `-beta` -> beta, otherwise latest.
 * The actual publish goes through scripts/publish-package.mjs, which also moves
 * the `latest` dist-tag onto the published version.
 *
 * Auth is the caller's job: an .npmrc mapping the @spfn scope to the Gitea
 * registry with a token must exist before this runs.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { missingDependencies, orderPackages } from "./lib/publish-order.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES_DIR = join(ROOT, "packages");

function channelOf(version)
{
    if (version.includes("-alpha"))
    {
        return "alpha";
    }
    if (version.includes("-beta"))
    {
        return "beta";
    }
    return "latest";
}

/**
 * `publishConfig.registry` only steers `npm publish`, so every read has to be
 * pointed at the same registry explicitly or it asks the public one.
 */
function registryArgs(pkg)
{
    return pkg?.publishConfig?.registry ? ["--registry", pkg.publishConfig.registry] : [];
}

/**
 * What the registry serves for `name@spec`, or `null` when it definitively has
 * nothing.
 *
 * Three answers and not two. `npm view` exits non-zero both for a version that
 * does not exist (E404) and for a registry that did not answer — a timeout, a
 * refused token, a 500 — and collapsing those into "not published" is what
 * turns an outage into a publish nobody checked. Only E404 is an answer;
 * anything else stops the run before a single package goes out.
 *
 * `npm view` of a missing version can also exit 0 with empty output on some npm
 * versions, so success is judged on the output and not on the exit code.
 */
function registryVersion(name, spec, pkg)
{
    try
    {
        const out = execFileSync(
            "npm",
            ["view", `${name}@${spec}`, "version", ...registryArgs(pkg)],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
        return out.toString().trim() || null;
    }
    catch (error)
    {
        const stderr = (error.stderr ?? "").toString();

        if (/\bE404\b/.test(stderr))
        {
            return null;
        }

        throw new Error(
            `Asking the registry about ${name}@${spec} failed, and not with a 404 — `
            + "it did not answer, so nothing about what is published is known and "
            + `nothing will be published:\n${stderr.trim()}`,
        );
    }
}

function readPackages()
{
    return readdirSync(PACKAGES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const dir = join(PACKAGES_DIR, entry.name);
            const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
            return { dir, pkg };
        });
}

/**
 * Build, then publish in order, refusing any package whose siblings are not
 * there yet.
 *
 * A private package is never published but is still a name a dependency can
 * refer to, so it stays in `byName`: a runtime dependency on one is a hole the
 * check below should report, not one it should fail to notice.
 */
function main()
{
    const workspace = readPackages();
    const byName = new Map(workspace.map(({ pkg }) => [pkg.name, pkg]));
    const dirOf = new Map(workspace.map(({ dir, pkg }) => [pkg.name, dir]));
    const isPublished = (name, spec) => registryVersion(name, spec, byName.get(name)) !== null;

    const ordered = orderPackages([...byName.values()]).filter((pkg) => !pkg.private);
    const pending = ordered.filter((pkg) => !isPublished(pkg.name, pkg.version));

    if (pending.length === 0)
    {
        console.log("every package version is already on the registry — nothing to publish");
        return 0;
    }

    for (const pkg of pending)
    {
        console.log(`pending: ${pkg.name}@${pkg.version} (${channelOf(pkg.version)})`);
    }

    // Build only packages/* — turbo pulls their workspace dependencies in and orders
    // them. Examples and the website are not published, and their Next.js builds
    // need runtime env (SPFN_API_URL) this pipeline rightly does not have.
    execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: ROOT, stdio: "inherit" });
    execFileSync(
        "pnpm",
        ["exec", "turbo", "run", "build", "--filter=./packages/*"],
        { cwd: ROOT, stdio: "inherit" },
    );

    const publishedInThisRun = new Set();
    const failed = [];

    for (const pkg of pending)
    {
        const missing = missingDependencies(pkg, byName, isPublished, publishedInThisRun);

        if (missing.length > 0)
        {
            missing.forEach((problem) => console.error(problem));
            failed.push(`${pkg.name}@${pkg.version}`);
            continue;
        }

        try
        {
            execFileSync(
                "node",
                [join(ROOT, "scripts", "publish-package.mjs"), channelOf(pkg.version)],
                { cwd: dirOf.get(pkg.name), stdio: "inherit" },
            );
            publishedInThisRun.add(`${pkg.name}@${pkg.version}`);
        }
        catch
        {
            // Two main pushes minutes apart run this pipeline twice at once, and
            // both see the version missing before either publishes: the second
            // `npm publish` answers E409 for a version the first one just put
            // there. Ask the registry again — if the version is there now, the
            // outcome this run wanted has happened and it is not a failure.
            if (registryVersion(pkg.name, pkg.version, pkg))
            {
                console.log(`${pkg.name}@${pkg.version} reached the registry from a concurrent run — nothing left to do`);
                publishedInThisRun.add(`${pkg.name}@${pkg.version}`);
                continue;
            }

            failed.push(`${pkg.name}@${pkg.version}`);
        }
    }

    if (failed.length > 0)
    {
        console.error(`failed to publish: ${failed.join(", ")}`);
        return 1;
    }

    return 0;
}

try
{
    process.exit(main());
}
catch (error)
{
    // Every throw reaching here is a cycle or a registry that did not answer,
    // and both arrive with the whole explanation in the message. A stack trace
    // above it in a CI log only buries the sentence someone has to read.
    console.error(error.message);
    process.exit(1);
}
