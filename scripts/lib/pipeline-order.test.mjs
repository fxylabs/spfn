/**
 * `node --test scripts/lib/` — the Gitea publish waits for the main check (w-xacm7).
 *
 * | #  | event, branch, changed files                   | expected                                          |
 * |----|------------------------------------------------|---------------------------------------------------|
 * | P1 | push, main, a package manifest                 | `pr` and `publish` match; `publish` requires `pr` |
 * | P2 | manual, main, no file list                     | both match, so the dependency is present and kept |
 * | P3 | pull_request, any, more than manifests         | `pr` matches, `publish` does not                  |
 * | P4 | push, feature branch                           | neither matches                                   |
 * | P5 | every publish trigger                          | `pr` matches it too                               |
 * | P6 | —                                              | `publish-gitea` asks for memory on the build pool |
 * | P7 | push, main, no package manifest                | neither matches — a feature merge (w-b5vxj)       |
 * | P8 | pull_request, only package manifests           | neither matches — a release PR (w-b5vxj)          |
 * | P9 | push, main, a manifest outside `packages/<d>/` | neither matches; a pull request still runs `pr`   |
 *
 * Woodpecker drops a workflow whose required `depends_on` names a workflow that
 * did not match the event, so P2 and P5 are what keep the publish from silently
 * never starting. The matcher covers the `when` forms these two files use: a
 * list or a single map, `event` a string or a list, an optional `branch` string,
 * and an optional `path` with `include` and `exclude` globs. It follows
 * Woodpecker 3.17.0 (pipeline/frontend/yaml/constraint/): `path` applies to push
 * and pull-request events only, an empty file list matches, `exclude` rejects
 * when every file matches it, `include` accepts when any file does, and `*`
 * does not cross a `/`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function readWorkflow(name)
{
    return parse(readFileSync(join(repositoryRoot, ".woodpecker", `${name}.yml`), "utf8"));
}

const pr = readWorkflow("pr");
const publish = readWorkflow("publish");

function asList(value)
{
    return Array.isArray(value) ? value : [value];
}

const RELEASE_FILES = ["packages/i18n/package.json"];
const FEATURE_FILES = ["packages/i18n/src/index.ts", "packages/i18n/package.json"];
const SOURCE_FILES = ["packages/i18n/src/index.ts"];

/** The files use `*` alone, which matches within one path segment. */
function globMatches(pattern, file)
{
    const segments = pattern.split("*").map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${segments.join("[^/]*")}$`).test(file);
}

function anyGlobMatches(patterns, file)
{
    return asList(patterns).some((pattern) => globMatches(pattern, file));
}

function pathMatches(path, event, files)
{
    if (path === undefined || !["push", "pull_request"].includes(event) || files.length === 0)
    {
        return true;
    }
    if (path.exclude !== undefined && files.every((file) => anyGlobMatches(path.exclude, file)))
    {
        return false;
    }
    return path.include === undefined || files.some((file) => anyGlobMatches(path.include, file));
}

function entryMatches(entry, event, branch, files)
{
    return asList(entry.event).includes(event)
        && (entry.branch === undefined || entry.branch === branch)
        && pathMatches(entry.path, event, files);
}

function matches(workflow, event, branch, files)
{
    return asList(workflow.when).some((entry) => entryMatches(entry, event, branch, files));
}

/** Every event/branch pair a `when` names; an entry without a branch stands for main and a feature branch. */
function triggers(workflow)
{
    return asList(workflow.when).flatMap((entry) =>
        asList(entry.event).flatMap((event) =>
            (entry.branch === undefined ? ["main", "feature/x"] : [entry.branch])
                .map((branch) => ({ event, branch }))));
}

/** A required dependency is a bare name; `{ name, optional: true }` would not hold the publish back. */
function requiredDependencies(workflow)
{
    return asList(workflow.depends_on ?? [])
        .filter((dependency) => typeof dependency === "string" || dependency.optional !== true)
        .map((dependency) => (typeof dependency === "string" ? dependency : dependency.name));
}

test("P1: a main push that changes a package manifest matches pr and publish, and publish requires pr", () =>
{
    assert.equal(matches(pr, "push", "main", RELEASE_FILES), true);
    assert.equal(matches(publish, "push", "main", RELEASE_FILES), true);
    assert.equal(matches(pr, "push", "main", FEATURE_FILES), true);
    assert.equal(matches(publish, "push", "main", FEATURE_FILES), true);
    assert.ok(requiredDependencies(publish).includes("pr"), `depends_on: ${JSON.stringify(publish.depends_on)}`);
});

test("P2: a manual run on main matches pr and publish, so the dependency is kept", () =>
{
    assert.equal(matches(pr, "manual", "main", []), true);
    assert.equal(matches(publish, "manual", "main", []), true);
});

test("P3: a pull request that changes more than manifests matches pr and not publish", () =>
{
    assert.equal(matches(pr, "pull_request", "feature/x", SOURCE_FILES), true);
    assert.equal(matches(pr, "pull_request", "feature/x", FEATURE_FILES), true);
    assert.equal(matches(publish, "pull_request", "feature/x", FEATURE_FILES), false);
});

test("P4: a push to a feature branch matches neither", () =>
{
    assert.equal(matches(pr, "push", "feature/x", RELEASE_FILES), false);
    assert.equal(matches(publish, "push", "feature/x", RELEASE_FILES), false);
});

test("P5: every event and branch publish matches, pr matches too", () =>
{
    for (const files of [RELEASE_FILES, FEATURE_FILES, SOURCE_FILES, []])
    {
        const published = triggers(publish).filter(({ event, branch }) => matches(publish, event, branch, files));

        for (const { event, branch } of published)
        {
            assert.equal(matches(pr, event, branch, files), true, `pr does not match ${event} on ${branch} with ${files}`);
        }
    }
    assert.ok(triggers(publish).some(({ event, branch }) => matches(publish, event, branch, RELEASE_FILES)));
});

test("P6: publish-gitea asks for memory on the build pool with a capped heap", () =>
{
    const step = publish.steps["publish-gitea"];
    const kubernetes = step.backend_options?.kubernetes ?? {};

    assert.ok(kubernetes.resources?.requests?.memory, "no memory request");
    assert.ok(kubernetes.resources?.limits?.memory, "no memory limit");
    assert.equal(kubernetes.nodeSelector?.role, "build");
    assert.ok((kubernetes.tolerations ?? []).some((toleration) => toleration.key === "role"), "no role toleration");
    assert.match(step.environment?.NODE_OPTIONS ?? "", /--max-old-space-size/);
});

test("P7: a main push that changes no package manifest matches neither", () =>
{
    assert.equal(matches(pr, "push", "main", SOURCE_FILES), false);
    assert.equal(matches(publish, "push", "main", SOURCE_FILES), false);
});

test("P8: a pull request that changes only package manifests matches neither", () =>
{
    assert.equal(matches(pr, "pull_request", "feature/x", RELEASE_FILES), false);
    assert.equal(matches(pr, "pull_request", "feature/x", ["packages/auth/package.json", "packages/core/package.json"]), false);
    assert.equal(matches(publish, "pull_request", "feature/x", RELEASE_FILES), false);
});

test("P9: a manifest outside packages/<d>/ is not a release", () =>
{
    for (const file of ["packages/auth/src/package.json", "examples/01-minimal-api/package.json", "website/package.json", "package.json"])
    {
        assert.equal(matches(pr, "push", "main", [file]), false, file);
        assert.equal(matches(publish, "push", "main", [file]), false, file);
        assert.equal(matches(pr, "pull_request", "feature/x", [file]), true, file);
    }
});
