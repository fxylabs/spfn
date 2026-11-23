/**
 * The commit that set a package's current version — the one the release was
 * made from, and the one its git tag `<name>@<version>` names (#463). A
 * workflow_dispatch runs from whatever `main` head is current, so the run's
 * own commit is not the answer; the package.json history is.
 *
 * Walks the first-parent history of the manifest back from HEAD — the line the
 * Gitea release ran on, not a merged branch's own commits — and returns the
 * oldest commit of the unbroken run that still holds HEAD's version: the
 * latest move to it, so a push that moves a reverted version again tags a
 * commit of its own.
 */
import { execFileSync } from "node:child_process";

function git(args, cwd)
{
    return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function versionAt(commit, manifest, cwd)
{
    return JSON.parse(git(["show", `${commit}:${manifest}`], cwd)).version;
}

/** `manifest` is the package.json path relative to the repository root. */
export function versionCommit(manifest, cwd = process.cwd())
{
    const version = versionAt("HEAD", manifest, cwd);
    const history = git(["log", "--first-parent", "--format=%H", "HEAD", "--", manifest], cwd).split("\n").filter(Boolean);
    let setter = null;

    for (const commit of history)
    {
        if (versionAt(commit, manifest, cwd) !== version)
        {
            break;
        }
        setter = commit;
    }

    return setter;
}
