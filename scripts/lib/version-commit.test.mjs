/**
 * `node --test scripts/lib/` — each case is a scratch repository whose
 * package.json history puts a wrong commit within reach of the search. A wrong
 * answer is silent: the workflow pushes the git tag onto that commit (#463).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionCommit } from "./version-commit.mjs";

const MANIFEST = "packages/core/package.json";

function git(cwd, ...args)
{
    return execFileSync("git", ["-c", "user.name=version-commit", "-c", "user.email=version-commit@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Commit `files` (path → content) and return the new commit. */
function commit(cwd, message, files)
{
    for (const [path, content] of Object.entries(files))
    {
        mkdirSync(join(cwd, path, ".."), { recursive: true });
        writeFileSync(join(cwd, path), content);
    }
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", message);

    return git(cwd, "rev-parse", "HEAD");
}

const manifest = (version, description = "") => ({ [MANIFEST]: JSON.stringify({ name: "@spfn/core", version, description }) });

function inScratchRepository(body)
{
    const repository = mkdtempSync(join(tmpdir(), "version-commit-"));

    try
    {
        git(repository, "init", "--quiet", "--initial-branch=main");
        body(repository);
    }
    finally
    {
        rmSync(repository, { recursive: true, force: true });
    }
}

test("V1: a dispatch from a later head finds the commit that moved the version, not a later edit of package.json", () =>
{
    inScratchRepository((repository) =>
    {
        commit(repository, "release 1.0.0", manifest("1.0.0"));
        const release = commit(repository, "release 1.1.0", manifest("1.1.0"));
        commit(repository, "edit the description", manifest("1.1.0", "edited"));
        commit(repository, "unrelated", { "README.md": "later\n" });

        assert.equal(versionCommit(MANIFEST, repository), release);
    });
});

test("V2: a version moved on a merged branch is found at main's merge commit, the one the Gitea release ran on", () =>
{
    inScratchRepository((repository) =>
    {
        commit(repository, "release 1.0.0", manifest("1.0.0"));
        git(repository, "checkout", "--quiet", "-b", "release");
        commit(repository, "bump to 1.1.0 on the branch", manifest("1.1.0"));
        git(repository, "checkout", "--quiet", "main");
        commit(repository, "work on main", { "README.md": "main\n" });
        git(repository, "merge", "--quiet", "--no-ff", "--no-edit", "release");
        const merge = git(repository, "rev-parse", "HEAD");

        assert.equal(versionCommit(MANIFEST, repository), merge);
    });
});

test("V3: a version reverted and moved again is found at the later move, the commit inside the push that moved it", () =>
{
    inScratchRepository((repository) =>
    {
        commit(repository, "release 1.0.0", manifest("1.0.0"));
        commit(repository, "release 1.1.0", manifest("1.1.0"));
        commit(repository, "revert the release", manifest("1.0.0"));
        const again = commit(repository, "release 1.1.0 again", manifest("1.1.0"));

        assert.equal(versionCommit(MANIFEST, repository), again);
    });
});
