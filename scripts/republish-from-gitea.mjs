#!/usr/bin/env node
/**
 * Publish one package's current version to npmjs from the tarball the Gitea
 * registry already has — the same bytes, never a second build (#463).
 *
 * Run by `.github/workflows/publish-from-gitea.yml`, which every
 * `.github/workflows/publish-<pkg>.yml` calls. The flow is in
 * `scripts/lib/republish.mjs`: wait for the Gitea release to publish the
 * version, compare with what npmjs has, download and verify, `npm publish`
 * the file, wait for npmjs to serve it and read its integrity back, move the
 * dist-tags that may move.
 *
 * Usage: node scripts/republish-from-gitea.mjs <package-dir> [--dry-run]
 *
 *   --dry-run  everything except the publish: `npm publish --dry-run` on the
 *              downloaded file, no dist-tag change
 *
 * Needs GITEA_PACKAGES_READ_TOKEN in the environment: a Gitea token that can
 * read the superfunction organisation's packages. It is sent only to the Gitea
 * registry. NPM_TOKEN, when set, is the npmjs token `npm publish` and
 * `npm dist-tag` authenticate with; only they receive it (`runDependencies`),
 * and the workflow refuses to run without it. With GITHUB_OUTPUT set, writes
 * `outcome=<result>` there — also `outcome=not-served` for a run that failed
 * because npmjs did not serve the version in time.
 */

import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { republish, runDependencies } from "./lib/republish.mjs";

const USAGE = "Usage: node scripts/republish-from-gitea.mjs <package-dir> [--dry-run]";

function parseArgs(argv)
{
    const flags = argv.filter((arg) => arg.startsWith("--"));
    const dirs = argv.filter((arg) => !arg.startsWith("--"));
    const unknown = flags.filter((flag) => flag !== "--dry-run");

    if (dirs.length !== 1 || unknown.length > 0)
    {
        return null;
    }

    return { dir: dirs[0], dryRun: flags.includes("--dry-run") };
}

async function main()
{
    const args = parseArgs(process.argv.slice(2));

    if (!args)
    {
        console.error(USAGE);

        return 1;
    }
    if (!process.env.GITEA_PACKAGES_READ_TOKEN)
    {
        console.error("GITEA_PACKAGES_READ_TOKEN is not set: the Gitea registry cannot be read without it.");

        return 1;
    }

    const pkg = JSON.parse(readFileSync(resolve(args.dir, "package.json"), "utf8"));
    const deps = runDependencies({
        name: pkg.name,
        version: pkg.version,
        env: process.env,
        workDir: mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "republish-")),
        dryRun: args.dryRun,
    });
    const outcome = await republish(deps);

    console.log(`${deps.name}@${deps.version}: ${outcome}`);
    writeOutcome(outcome);

    return 0;
}

function writeOutcome(outcome)
{
    if (process.env.GITHUB_OUTPUT && outcome)
    {
        appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
    }
}

main().then(
    (code) => process.exit(code),
    (error) =>
    {
        // Every refusal carries its whole explanation in the message; a stack
        // above it in a CI log only buries the sentence someone has to read.
        console.error(error.message);
        writeOutcome(error.outcome);
        process.exit(1);
    },
);
