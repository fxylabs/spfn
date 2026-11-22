/**
 * `node --test scripts/lib/` — no Woodpecker, no turbo.
 *
 * `ciScope()` and `diffScope()` take the workspace as a directory → name map,
 * so every row of the scope rule is one call with literal inputs. One test per
 * row, named with the row's id from the pull request that introduced the rule:
 * S for the rule and Woodpecker's input, G for the Gitea Actions input (#433).
 * G6 alone runs git, in a scratch repository, because what it guards is the
 * diff's own arguments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFilesSince, ciScope, describeScope, diffScope, scopeFromEnvironment, turboFilters } from "./ci-scope.mjs";

/** The workspace as it stands, minus the packages no row mentions. */
const WORKSPACE = new Map([
    ["packages/auth", "@spfn/auth"],
    ["packages/core", "@spfn/core"],
    ["packages/i18n", "@spfn/i18n"],
    ["examples/01-minimal-api", "01-minimal-api"],
    ["website", "superfunction-website"],
]);

const pr = (files) => ciScope("pull_request", JSON.stringify(files), WORKSPACE);

function assertNames(scope, names)
{
    assert.equal(scope.all, false, describeScope(scope));
    assert.deepEqual(scope.names, names);
}

function assertAll(scope)
{
    assert.equal(scope.all, true, describeScope(scope));
    assert.deepEqual(turboFilters(scope), []);
}

test("S1: a pull request changing one package's manifest scopes to that package", () =>
{
    const scope = pr(["packages/i18n/package.json"]);

    assertNames(scope, ["@spfn/i18n"]);
    assert.deepEqual(turboFilters(scope), ["--filter=...@spfn/i18n"]);
    assert.equal(describeScope(scope), "ci-scope: @spfn/i18n (1 files)");
});

test("S2: two packages changed scope to both names, sorted", () =>
{
    assertNames(pr(["packages/core/src/a.ts", "packages/auth/README.md"]), ["@spfn/auth", "@spfn/core"]);
});

test("S3: a change inside an example scopes to that example", () =>
{
    assertNames(pr(["examples/01-minimal-api/src/x.ts"]), ["01-minimal-api"]);
});

test("S4: a change inside website/ scopes to the website", () =>
{
    assertNames(pr(["website/app/page.tsx"]), ["superfunction-website"]);
});

test("S5: a root file beside a package change means all", () =>
{
    assertAll(pr(["packages/i18n/src/x.ts", "pnpm-lock.yaml"]));
});

test("S6: the pipeline, scripts, docs or a root file alone mean all", () =>
{
    for (const files of [[".woodpecker/pr.yml"], ["scripts/x.mjs"], ["docs/a.md"], ["README.md"]])
    {
        assertAll(pr(files));
    }
});

test("S7: a missing, unparseable, non-array or empty file list means all", () =>
{
    for (const raw of [undefined, "not json", "{}", "[]"])
    {
        assertAll(ciScope("pull_request", raw, WORKSPACE));
    }
});

test("S8: a push is never scoped, even with a file list", () =>
{
    assertAll(ciScope("push", JSON.stringify(["packages/i18n/package.json"]), WORKSPACE));
});

test("S9: a path in a package directory with no package.json at HEAD means all", () =>
{
    const scope = pr(["packages/gone/src/x.ts"]);

    assertAll(scope);
    assert.match(scope.reason, /packages\/gone/);
});

test("S10: a bare package directory path scopes to that package", () =>
{
    assertNames(pr(["packages/i18n"]), ["@spfn/i18n"]);
});

test("a leading ./ or a trailing / does not break the directory match", () =>
{
    assertNames(pr(["./packages/i18n/src/x.ts", "packages/core/"]), ["@spfn/core", "@spfn/i18n"]);
});

test("a file directly under packages/ or examples/ is not a package and means all", () =>
{
    assertAll(pr(["examples/README.md"]));
    assertAll(pr(["packages"]));
});

/** A diff that must not be taken: the row's input has to decide without one. */
function noDiff()
{
    throw new Error("the diff was taken");
}

test("G1: a pull request diff scopes to the owning packages, against the base it was given", () =>
{
    const bases = [];
    const diff = (base) =>
    {
        bases.push(base);
        return ["packages/core/src/a.ts", "examples/01-minimal-api/src/x.ts"];
    };

    assertNames(diffScope("pull_request", "abc123", diff, WORKSPACE), ["01-minimal-api", "@spfn/core"]);
    assert.deepEqual(bases, ["abc123"]);
});

test("G2: a diff with a path outside the packages — the workflow itself — means all", () =>
{
    assertAll(diffScope("pull_request", "abc123", () => ["packages/i18n/src/x.ts", ".gitea/workflows/check.yml"], WORKSPACE));
});

test("G3: a run that is not a pull request is never scoped, base or not", () =>
{
    for (const event of ["workflow_dispatch", "push", ""])
    {
        assertAll(diffScope(event, "abc123", noDiff, WORKSPACE));
    }
});

test("G4: a pull request without a base, or whose diff lists nothing, means all", () =>
{
    assertAll(diffScope("pull_request", "", noDiff, WORKSPACE));
    assertAll(diffScope("pull_request", undefined, noDiff, WORKSPACE));
    assertAll(diffScope("pull_request", "abc123", () => [], WORKSPACE));
});

test("G5: CI_SCOPE_EVENT selects the diff; without it Woodpecker's variables are read as before", () =>
{
    const woodpecker = { CI_PIPELINE_EVENT: "pull_request", CI_PIPELINE_FILES: JSON.stringify(["packages/i18n/src/x.ts"]) };
    const actions = { CI_SCOPE_EVENT: "pull_request", CI_SCOPE_DIFF_BASE: "abc123" };

    assertNames(scopeFromEnvironment(woodpecker, noDiff, WORKSPACE), ["@spfn/i18n"]);
    assertNames(scopeFromEnvironment(actions, () => ["packages/auth/src/x.ts"], WORKSPACE), ["@spfn/auth"]);
    assertAll(scopeFromEnvironment({ ...woodpecker, CI_SCOPE_EVENT: "workflow_dispatch" }, noDiff, WORKSPACE));
});

function git(cwd, ...args)
{
    return execFileSync("git", ["-c", "user.name=ci-scope", "-c", "user.email=ci-scope@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

test("G6: a file moved from one package to another lists both, so both packages are in scope", () =>
{
    const repository = mkdtempSync(join(tmpdir(), "ci-scope-"));

    try
    {
        git(repository, "init", "--quiet", "--initial-branch=main");
        mkdirSync(join(repository, "packages/core/src"), { recursive: true });
        writeFileSync(join(repository, "packages/core/src/moved.ts"), "export const moved = 'a file long enough to be found as a rename';\n");
        git(repository, "add", ".");
        git(repository, "commit", "--quiet", "-m", "base");
        const base = git(repository, "rev-parse", "HEAD").trim();
        mkdirSync(join(repository, "packages/auth/src"), { recursive: true });
        git(repository, "mv", "packages/core/src/moved.ts", "packages/auth/src/moved.ts");
        git(repository, "commit", "--quiet", "-m", "move");

        const files = changedFilesSince(base, repository);

        assert.deepEqual(files.sort(), ["packages/auth/src/moved.ts", "packages/core/src/moved.ts"]);
        assertNames(diffScope("pull_request", base, () => files, WORKSPACE), ["@spfn/auth", "@spfn/core"]);
    }
    finally
    {
        rmSync(repository, { recursive: true, force: true });
    }
});
