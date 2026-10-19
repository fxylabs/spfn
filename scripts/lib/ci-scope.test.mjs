/**
 * `node --test scripts/lib/` — no filesystem, no Woodpecker, no turbo.
 *
 * `ciScope()` takes the workspace as a directory → name map, so every row of
 * the scope rule is one call with literal inputs. One test per row, named with
 * the row's id from the pull request that introduced the rule.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ciScope, describeScope, turboFilters } from "./ci-scope.mjs";

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
