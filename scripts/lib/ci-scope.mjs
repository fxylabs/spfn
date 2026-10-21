/**
 * Which workspace packages a pipeline has to build and test.
 *
 * Before this file every pull request built and tested everything. Pipeline
 * 521 changed one line — the `version` of packages/i18n/package.json — and ran
 * for 33.7 minutes: 18 builds, a full type-check and a 16-minute suite, when
 * i18n's own tests took 4.7 seconds and nothing in the workspace depends on
 * @spfn/i18n.
 *
 * The scope is read from the changed files Woodpecker hands the pipeline
 * (`CI_PIPELINE_FILES`), not from a diff. The clone step fetches the pull
 * request's commit alone, from a private repository, and no later step has
 * credentials — there is no `origin/main` to diff against.
 *
 * One pure function, so the tests need no filesystem and no Woodpecker:
 * `ciScope()` takes the event, the raw environment string and a map from a
 * package directory to its package name, and returns either "all" with the
 * reason, or the names of the packages that own the changed paths. Turning
 * those names into "the packages and everything that depends on them" is
 * turbo's job (`--filter=...<name>`), not this file's.
 *
 * Every doubt resolves to "all". A scoped run that leaves out a package the
 * change broke is a green check on a broken tree; a full run that did not need
 * to happen costs half an hour and nothing else.
 */

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

/**
 * The scope of one pipeline.
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
        return { all: true, reason: `event is ${event || "unset"}, not pull_request` };
    }

    const files = parseChangedFiles(rawFiles);

    if (files === null)
    {
        return { all: true, reason: "CI_PIPELINE_FILES is missing, empty or not a JSON array" };
    }

    const owners = owningPackages(files, packageDirs);

    if (owners.reason)
    {
        return { all: true, reason: owners.reason };
    }

    return { all: false, names: owners.names, fileCount: files.length };
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
