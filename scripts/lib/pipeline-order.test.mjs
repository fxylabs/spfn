/**
 * `node --test scripts/lib/` — the Gitea publish waits for the main check (w-xacm7).
 *
 * | #  | event, branch          | expected                                                 |
 * |----|------------------------|----------------------------------------------------------|
 * | P1 | push, main             | `pr` and `publish` match; `publish` requires `pr`        |
 * | P2 | manual, main           | both match, so the dependency is present and kept        |
 * | P3 | pull_request, any      | `pr` matches, `publish` does not                         |
 * | P4 | push, feature branch   | neither matches                                          |
 * | P5 | every publish trigger  | `pr` matches it too                                      |
 * | P6 | —                      | `publish-gitea` asks for memory on the build pool        |
 *
 * Woodpecker drops a workflow whose required `depends_on` names a workflow that
 * did not match the event, so P2 and P5 are what keep the publish from silently
 * never starting. The matcher covers the `when` forms these two files use: a
 * list or a single map, `event` a string or a list, an optional `branch` string.
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

function entryMatches(entry, event, branch)
{
    return asList(entry.event).includes(event)
        && (entry.branch === undefined || entry.branch === branch);
}

function matches(workflow, event, branch)
{
    return asList(workflow.when).some((entry) => entryMatches(entry, event, branch));
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

test("P1: a main push matches pr and publish, and publish requires pr", () =>
{
    assert.equal(matches(pr, "push", "main"), true);
    assert.equal(matches(publish, "push", "main"), true);
    assert.ok(requiredDependencies(publish).includes("pr"), `depends_on: ${JSON.stringify(publish.depends_on)}`);
});

test("P2: a manual run on main matches pr and publish, so the dependency is kept", () =>
{
    assert.equal(matches(pr, "manual", "main"), true);
    assert.equal(matches(publish, "manual", "main"), true);
});

test("P3: a pull request matches pr and not publish", () =>
{
    assert.equal(matches(pr, "pull_request", "feature/x"), true);
    assert.equal(matches(publish, "pull_request", "feature/x"), false);
});

test("P4: a push to a feature branch matches neither", () =>
{
    assert.equal(matches(pr, "push", "feature/x"), false);
    assert.equal(matches(publish, "push", "feature/x"), false);
});

test("P5: every event and branch publish matches, pr matches too", () =>
{
    const published = triggers(publish).filter(({ event, branch }) => matches(publish, event, branch));

    assert.ok(published.length > 0);
    for (const { event, branch } of published)
    {
        assert.equal(matches(pr, event, branch), true, `pr does not match ${event} on ${branch}`);
    }
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
