/**
 * Which workspace packages a pipeline has to build and test.
 *
 * Before this file every pull request built and tested everything. Pipeline
 * 521 changed one line — the `version` of packages/i18n/package.json — and ran
 * for 33.7 minutes: 18 builds, a full type-check and a 16-minute suite, when
 * i18n's own tests took 4.7 seconds and nothing in the workspace depends on
 * @spfn/i18n.
 *
 * The changed files come from one of two inputs, and the pipeline names which
 * (`scopeFromEnvironment()`):
 *
 * - Woodpecker hands the list over itself (`CI_PIPELINE_FILES`). Its clone
 *   fetches the pull request's commit alone, from a private repository, and no
 *   later step has credentials — there is no `origin/main` to diff against.
 * - Gitea Actions hands over no list, but its checkout can fetch the history.
 *   Its workflow sets `CI_SCOPE_EVENT` and, for a run asked to check a pull
 *   request's branch against its base, `CI_SCOPE_DIFF_BASE`; the files are
 *   `git diff <base>...HEAD`.
 *
 * Pure functions, so the tests need no Woodpecker and no turbo:
 * `ciScope()` and `diffScope()` take the event, the changed files and a map
 * from a package directory to its package name, and return either "all" with
 * the reason, or the names of the packages that own the changed paths. Turning
 * those names into "the packages and everything that depends on them" is
 * turbo's job (`--filter=...<name>`), not this file's. `changedFilesSince()`
 * is the one function here that runs git.
 *
 * Every doubt resolves to "all". A scoped run that leaves out a package the
 * change broke is a green check on a broken tree; a full run that did not need
 * to happen costs half an hour and nothing else.
 */

import { execFileSync } from "node:child_process";

/**
 * The directories that hold workspace packages, as in pnpm-workspace.yaml:
 * `packages/<d>/` and `examples/<d>/` hold one package each, `website/` is one.
 */
const PACKAGE_PARENTS = ["packages", "examples"];
const SINGLE_PACKAGES = ["website"];

/** `"./packages/i18n/"` and `"packages/i18n"` are the same path. */
export function normalizePath(path)
{
    return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The workspace package directory `path` sits in, or null when it sits in
 * none — a root file, `.woodpecker/`, `scripts/`, `docs/` and the like.
 *
 * Only the directory is derived here; whether a package actually lives there
 * at HEAD is the caller's question.
 */
export function packageDirectoryOf(path)
{
    const [first, second] = normalizePath(path).split("/");

    if (SINGLE_PACKAGES.includes(first))
    {
        return first;
    }

    if (PACKAGE_PARENTS.includes(first) && second)
    {
        return `${first}/${second}`;
    }

    return null;
}

/**
 * The changed files, or null when Woodpecker did not say.
 *
 * `CI_PIPELINE_FILES` is undefined when more than 500 files changed and empty
 * for events other than push and pull_request. Anything that is not a
 * non-empty JSON array of strings is treated the same way: as not knowing.
 */
export function parseChangedFiles(raw)
{
    if (typeof raw !== "string")
    {
        return null;
    }

    let files;

    try
    {
        files = JSON.parse(raw);
    }
    catch
    {
        return null;
    }

    return Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === "string")
        ? files
        : null;
}

/**
 * The package names owning `files`, or the reason they cannot be scoped.
 *
 * A path outside every package directory can change how anything builds — the
 * lockfile, a root tsconfig, the pipeline itself — so it means all. A path in
 * a package directory with no package.json at HEAD is a package that was
 * deleted or renamed, and its old dependents can only be found by building
 * everything.
 */
function owningPackages(files, packageDirs)
{
    const names = new Set();

    for (const file of files)
    {
        const directory = packageDirectoryOf(file);

        if (directory === null)
        {
            return { reason: `${file} is outside the workspace packages` };
        }

        if (!packageDirs.has(directory))
        {
            return { reason: `${file} is in ${directory}, which has no package.json at HEAD` };
        }

        names.add(packageDirs.get(directory));
    }

    return { names: [...names].sort() };
}

/** A run that is not a pull request is never scoped. */
function notPullRequest(event)
{
    return { all: true, reason: `event is ${event || "unset"}, not pull_request` };
}

/**
 * The scope of a pull request's changed `files`, or all with `missingReason`
 * when there are none to go by.
 */
function scopeOfFiles(files, missingReason, packageDirs)
{
    if (files === null || files.length === 0)
    {
        return { all: true, reason: missingReason };
    }

    const owners = owningPackages(files, packageDirs);

    if (owners.reason)
    {
        return { all: true, reason: owners.reason };
    }

    return { all: false, names: owners.names, fileCount: files.length };
}

/**
 * The scope of one Woodpecker pipeline.
 *
 * - `event` is `CI_PIPELINE_EVENT`. Only a pull request is ever scoped. A main
 *   push reaches this pipeline only when it changes a package manifest, which
 *   is the push that publishes; it sets `CI_PIPELINE_FILES` too, but main has
 *   to be known good as a whole before a release, so it runs everything
 *   regardless.
 * - `rawFiles` is `CI_PIPELINE_FILES` exactly as found in the environment,
 *   undefined included.
 * - `packageDirs` maps a package directory (`packages/i18n`, `website`) to the
 *   `name` in its package.json, for every package present at HEAD.
 *
 * Returns `{ all: true, reason }` or `{ all: false, names, fileCount }`, with
 * `names` sorted and never empty.
 */
export function ciScope(event, rawFiles, packageDirs)
{
    if (event !== "pull_request")
    {
        return notPullRequest(event);
    }

    return scopeOfFiles(parseChangedFiles(rawFiles), "CI_PIPELINE_FILES is missing, empty or not a JSON array", packageDirs);
}

/**
 * The scope of one Gitea Actions run, by the same rule as `ciScope()`.
 *
 * - `event` is `CI_SCOPE_EVENT`: `pull_request` when the run was given a base
 *   to diff against, the workflow's `github.event_name` otherwise.
 * - `base` is `CI_SCOPE_DIFF_BASE`, the base branch as fetched
 *   (`origin/<base>`). Empty or unset, there is nothing to diff against, and
 *   that means all.
 * - `diffFiles(base)` returns the paths `git diff <base>...HEAD` lists — in
 *   the pipeline `changedFilesSince()`. It is called only for a pull request
 *   with a base.
 */
export function diffScope(event, base, diffFiles, packageDirs)
{
    if (event !== "pull_request")
    {
        return notPullRequest(event);
    }

    if (!base)
    {
        return { all: true, reason: "CI_SCOPE_DIFF_BASE is unset or empty" };
    }

    return scopeOfFiles(diffFiles(base), `git diff ${base}...HEAD lists no files`, packageDirs);
}

/**
 * The scope from the input the pipeline names: the diff when `CI_SCOPE_EVENT`
 * is set — the Gitea Actions workflow sets it, Woodpecker never does — and
 * Woodpecker's own variables otherwise. Which CI this is is never guessed.
 */
export function scopeFromEnvironment(env, diffFiles, packageDirs)
{
    if (env.CI_SCOPE_EVENT === undefined)
    {
        return ciScope(env.CI_PIPELINE_EVENT, env.CI_PIPELINE_FILES, packageDirs);
    }

    return diffScope(env.CI_SCOPE_EVENT, env.CI_SCOPE_DIFF_BASE, diffFiles, packageDirs);
}

/**
 * The paths changed between the merge base of `base` and HEAD, in the
 * repository at `cwd`.
 *
 * `--no-renames`, because a rename is otherwise listed under its new path
 * alone: a file moved out of packages/core into packages/auth would scope the
 * run to auth and leave core, which lost the file, unbuilt and untested. `-z`,
 * so a path git would quote is read as it is. `--end-of-options`, so a base
 * that begins with a dash is read as a revision.
 */
export function changedFilesSince(base, cwd)
{
    return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", "--end-of-options", `${base}...HEAD`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
    })
        .split("\0")
        .filter((path) => path !== "");
}

/** One `--filter=...<name>` per package: the package and all its dependents. */
export function turboFilters(scope)
{
    return scope.all ? [] : scope.names.map((name) => `--filter=...${name}`);
}

/** The one line the log gets, so a reader can see why a run was full or narrow. */
export function describeScope(scope)
{
    return scope.all
        ? `ci-scope: all (${scope.reason})`
        : `ci-scope: ${scope.names.join(" ")} (${scope.fileCount} files)`;
}
