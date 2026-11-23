/**
 * `node --test scripts/lib/` — the two registries are one local HTTP server
 * (`/gitea/` and `/npmjs/`), `npm` is a recorder that "publishes" into the
 * npmjs half, and the clock is injected: no network, no real minutes.
 *
 * Each case is a way the republish could go wrong while the run stays green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITEA_POLL_MS, GITEA_WAIT_MS, republish, runDependencies } from "./republish.mjs";

const NAME = "@spfn/core";
const VERSION = "1.0.0-beta.1";
const TOKEN = "gitea-read-token";
const TARBALL = Buffer.from("the one tarball Gitea built");

const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/**
 * Serve `state` — `{ gitea, npmjs, tags, tarballBytes }`, each changeable
 * mid-test, and `respond(request, response)` answering a request itself when
 * it returns true — and log every request.
 */
async function listen(handler)
{
    const server = createServer(handler);

    await new Promise((done) => server.listen(0, "127.0.0.1", done));

    return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function registries(t, state)
{
    const requests = [];
    const { server, origin } = await listen((request, response) =>
    {
        requests.push({ url: request.url, headers: request.headers });

        if (state.respond?.(request, response))
        {
            return;
        }

        const [, registry] = request.url.split("/");
        const dist = state[registry];

        if (request.url.endsWith(".tgz"))
        {
            response.end(state.tarballBytes);

            return;
        }
        if (request.url.endsWith("/dist-tags"))
        {
            response.end(JSON.stringify(state.tags ?? {}));

            return;
        }

        response.writeHead(dist ? 200 : 404, { "content-type": "application/json" });
        response.end(JSON.stringify(dist ? { name: NAME, version: VERSION, dist } : { error: "Not found" }));
    });

    t.after(() => server.close());
    state.tarballBytes ??= TARBALL;

    return { origin, requests };
}

/** A clock whose `sleep` moves time instead of waiting, refusing to run past the bound by much. */
function fakeClock(onSleep = () => {})
{
    let now = 0;
    let sleeps = 0;

    return {
        now: () => now,
        sleep: async (ms) =>
        {
            sleeps += 1;
            assert.ok(sleeps <= GITEA_WAIT_MS / GITEA_POLL_MS + 2, "kept waiting past the bound");
            now += ms;
            onSleep(sleeps);
        },
    };
}

/** `npm` as a recorder: `publish` and `dist-tag add` change the npmjs half of `state` the way npmjs would. */
function fakeNpm(state, npmCalls)
{
    return (args) =>
    {
        npmCalls.push(args);
        if (args[0] === "publish")
        {
            state.npmjs = { integrity: integrity(readFileSync(args[1])) };
            state.tags = { ...state.tags, [args[args.indexOf("--tag") + 1]]: state.publishing };
        }
        if (args[0] === "dist-tag")
        {
            state.tags = { ...state.tags, [args[3]]: args[2].slice(args[2].lastIndexOf("@") + 1) };
        }
    };
}

function deps(t, origin, state, overrides = {})
{
    const workDir = mkdtempSync(join(tmpdir(), "republish-test-"));
    const npmCalls = [];

    t.after(() => rmSync(workDir, { recursive: true, force: true }));
    state.publishing = overrides.version ?? VERSION;

    return {
        name: NAME,
        version: VERSION,
        token: TOKEN,
        giteaRegistry: `${origin}/gitea/`,
        npmjsRegistry: `${origin}/npmjs/`,
        fetch,
        clock: fakeClock(),
        npm: fakeNpm(state, npmCalls),
        npmCalls,
        workDir,
        dryRun: false,
        log: () => {},
        ...overrides,
    };
}

const giteaDist = (origin) => ({ integrity: integrity(TARBALL), tarball: `${origin}/gitea/@spfn/core/-/core-${VERSION}.tgz` });

const published = (d) => d.npmCalls.filter((args) => args[0] === "publish");

// Unnoticed without it: a script that asks Gitea once and gives up (or skips)
// when the release run has not published yet — the normal case, since the
// mirror push arrives ~25 minutes early — would leave npmjs without the version.
test("a version that reaches Gitea while the run waits is published after the wait", async (t) =>
{
    const state = {};
    const { origin } = await registries(t, state);
    const d = deps(t, origin, state, {
        clock: fakeClock((sleeps) =>
        {
            if (sleeps === 3)
            {
                state.gitea = giteaDist(origin);
            }
        }),
    });

    assert.equal(await republish(d), "published");
    assert.equal(published(d).length, 1);
    assert.equal(state.npmjs.integrity, integrity(TARBALL));
});

// Unnoticed without it: a release run that never publishes would either hang
// the job until GitHub's six-hour limit or end with a message that does not
// say the Gitea release is what failed.
test("a version that never reaches Gitea fails at the bound, naming the Gitea release", async (t) =>
{
    const state = {};
    const { origin } = await registries(t, state);
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /The Gitea release did not publish @spfn\/core@1\.0\.0-beta\.1/);
    assert.ok(d.clock.now() >= GITEA_WAIT_MS);
    assert.equal(d.npmCalls.length, 0);
});

// Unnoticed without it: bytes that are not the ones Gitea's metadata
// describes — a truncated or substituted download — would be published to
// npmjs as this version, for good.
test("a download that does not match Gitea's integrity is refused and nothing is published", async (t) =>
{
    const state = { tarballBytes: Buffer.from("other bytes") };
    const { origin } = await registries(t, state);

    state.gitea = giteaDist(origin);
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /does not match the Gitea registry's dist\.integrity/);
    assert.equal(d.npmCalls.length, 0);
    assert.equal(state.npmjs, undefined);
});

// Unnoticed without it: the state #463 is about. The old workflow asked only
// whether npmjs had the version and skipped green; a split version would keep
// passing every run.
test("npmjs already holding different bytes for the version is a failure", async (t) =>
{
    const state = { npmjs: { integrity: integrity(Buffer.from("a second build")) } };
    const { origin } = await registries(t, state);

    state.gitea = giteaDist(origin);
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /npmjs already has @spfn\/core@1\.0\.0-beta\.1 with different bytes/);
    assert.equal(d.npmCalls.length, 0);
});

// Unnoticed without it: a metadata response naming a tarball elsewhere would
// receive the Gitea token with the download, and the run would still succeed.
test("a tarball URL on another host is refused before the token is sent", async (t) =>
{
    const state = {};
    const { origin } = await registries(t, state);
    const elsewhere = await registries(t, {});

    state.gitea = { integrity: integrity(TARBALL), tarball: `${elsewhere.origin}/gitea/core.tgz` };
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /names a tarball on another host/);
    assert.deepEqual(elsewhere.requests, []);
    assert.equal(d.npmCalls.length, 0);
});

/** An `npm` on PATH that only records the environment it was started with. */
function fakeNpmOnPath(t)
{
    const dir = mkdtempSync(join(tmpdir(), "republish-fake-npm-"));

    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "npm"), "#!/usr/bin/env node\n"
        + "require('fs').appendFileSync(__dirname + '/envs.jsonl', JSON.stringify(process.env) + '\\n');\n");
    chmodSync(join(dir, "npm"), 0o755);

    return {
        PATH: `${dir}:${process.env.PATH}`,
        envs: () => readFileSync(join(dir, "envs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    };
}

// Unnoticed without it: `npm` inheriting the whole environment hands the Gitea
// token to npm and anything it runs, and a request that picked up the npm
// token would hand it to Gitea — both runs stay green.
test("the npm token reaches only npm and the Gitea token only Gitea's requests", async (t) =>
{
    const npmToken = "npm-publish-token";
    const state = { npmjs: { integrity: integrity(TARBALL) } };
    const { origin, requests } = await registries(t, state);
    const npm = fakeNpmOnPath(t);

    state.gitea = giteaDist(origin);
    const d = {
        ...runDependencies({
            name: NAME,
            version: VERSION,
            env: { PATH: npm.PATH, GITEA_PACKAGES_READ_TOKEN: TOKEN, NPM_TOKEN: npmToken },
            workDir: tmpdir(),
            dryRun: false,
        }),
        giteaRegistry: `${origin}/gitea/`,
        npmjsRegistry: `${origin}/npmjs/`,
        log: () => {},
    };

    assert.equal(await republish(d), "already-published");
    assert.ok(npm.envs().length > 0, "npm was never run");
    for (const env of npm.envs())
    {
        assert.equal(env.NODE_AUTH_TOKEN, npmToken);
        assert.ok(!Object.values(env).includes(TOKEN), "npm received the Gitea token");
    }
    assert.ok(requests.some((request) => request.url.startsWith("/gitea/")));
    for (const request of requests)
    {
        assert.ok(!JSON.stringify(request.headers).includes(npmToken), `${request.url} received the npm token`);
    }
});

// Unnoticed without it: every run pointing the tags at its own version. Two
// releases of one package finishing out of order — 1.0.0-beta.10, then
// 1.0.0-beta.9 — would leave `latest` and `beta` on the older one, green.
// beta.9 against beta.10 also fails a comparison that reads "9" > "10".
test("a version finishing after a newer one leaves latest and its channel tag on the newer", async (t) =>
{
    const newer = "1.0.0-beta.10";
    const state = { tags: { beta: newer, latest: newer } };
    const { origin } = await registries(t, state);

    state.gitea = giteaDist(origin);
    const d = deps(t, origin, state, { version: "1.0.0-beta.9" });

    assert.equal(await republish(d), "published");
    assert.deepEqual(state.tags, { beta: newer, latest: newer, superseded: "1.0.0-beta.9" });
    assert.deepEqual(d.npmCalls.map((args) => args[0]), ["publish"]);
});

// Unnoticed without it: `npm publish` succeeds and `npm dist-tag add … latest`
// fails; "Re-run failed jobs" replays the push, finds the same bytes on npmjs
// and would end green with `latest` never moved.
test("a re-run after a failed dist-tag moves latest on a version npmjs already has", async (t) =>
{
    const state = { tags: { beta: "1.0.0-beta.0", latest: "1.0.0-beta.0" } };
    const { origin } = await registries(t, state);

    state.gitea = giteaDist(origin);
    const failing = deps(t, origin, state);
    const recorder = failing.npm;

    failing.npm = (args) =>
    {
        if (args[0] === "dist-tag")
        {
            throw new Error("npm error code E403");
        }
        recorder(args);
    };
    await assert.rejects(republish(failing), /E403/);
    assert.deepEqual(state.tags, { beta: VERSION, latest: "1.0.0-beta.0" });

    assert.equal(await republish(deps(t, origin, state)), "already-published");
    assert.deepEqual(state.tags, { beta: VERSION, latest: VERSION });
});

// Unnoticed without it: Gitea's metadata without a sha512 and npmjs's
// `dist` with only a shasum read as `null` on both sides, `null === null`,
// and the run would end green as "already published" having compared nothing.
test("a registry document without a sha512 is refused before any comparison", async (t) =>
{
    const state = { npmjs: { shasum: "da39a3ee5e6b4b0d3255bfef95601890afd80709" } };
    const { origin, requests } = await registries(t, state);

    state.gitea = { shasum: "da39a3ee5e6b4b0d3255bfef95601890afd80709", tarball: giteaDist(origin).tarball };
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /The Gitea metadata for @spfn\/core@1\.0\.0-beta\.1 has no sha512 integrity/);
    assert.ok(!requests.some((request) => request.url.endsWith(".tgz")));
    assert.equal(d.npmCalls.length, 0);
});

const redirectTo = (from, location) => (request, response) =>
{
    if (!request.url.startsWith(from))
    {
        return false;
    }
    response.writeHead(302, { location });
    response.end();

    return true;
};

// Unnoticed without it: following a redirect, the run would take the
// integrity and tarball URL it checks everything against from a host that is
// not the Gitea registry, and go green.
test("a redirect of the Gitea metadata request is refused, not followed", async (t) =>
{
    const elsewhere = await registries(t, {});
    const state = { respond: redirectTo("/gitea/@spfn%2fcore/", `${elsewhere.origin}/gitea/@spfn%2fcore/${VERSION}`) };
    const { origin } = await registries(t, state);

    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /failed: unexpected redirect/);
    assert.deepEqual(elsewhere.requests, []);
    assert.equal(d.npmCalls.length, 0);
});

// Unnoticed without it: the host check approves the tarball URL, a redirect
// then sends the download to a host it never approved (Node's fetch drops the
// Authorization header across origins, but keeps it on a same-origin path),
// and bytes that hash right are published green.
test("a redirect of the tarball download is refused, not followed", async (t) =>
{
    const elsewhere = await registries(t, {});
    const state = { respond: redirectTo("/gitea/@spfn/core/-/", `${elsewhere.origin}/elsewhere/core.tgz`) };
    const { origin } = await registries(t, state);

    state.gitea = giteaDist(origin);
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /failed: unexpected redirect/);
    assert.deepEqual(elsewhere.requests, []);
    assert.equal(d.npmCalls.length, 0);
});

// Unnoticed without it: a refused token or a 5xx read as "not there yet" — 90
// minutes of waiting that end blaming the Gitea release, not the credential.
test("an answer other than 404 while waiting fails at once, naming the status", async (t) =>
{
    const state = {
        respond: (request, response) =>
        {
            if (!request.url.startsWith("/gitea/"))
            {
                return false;
            }
            response.writeHead(401, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "reqPackageAccess" }));

            return true;
        },
    };
    const { origin } = await registries(t, state);
    const d = deps(t, origin, state);

    await assert.rejects(republish(d), /answered 401 for @spfn\/core@1\.0\.0-beta\.1/);
    assert.equal(d.clock.now(), 0);
    assert.equal(d.npmCalls.length, 0);
});

// Unnoticed without it: `npm publish` exits 0 but npmjs does not hold the
// Gitea bytes for the version; the run would go green and move the tags onto it.
test("npmjs not holding the Gitea bytes after a publish is a failure, and no tag moves", async (t) =>
{
    const state = {};
    const { origin } = await registries(t, state);

    state.gitea = giteaDist(origin);
    const d = deps(t, origin, state);
    const recorder = d.npm;

    d.npm = (args) =>
    {
        recorder(args);
        state.npmjs = { integrity: integrity(Buffer.from("what npmjs ended up with")) };
    };

    await assert.rejects(republish(d), /After publishing, npmjs reports/);
    assert.deepEqual(d.npmCalls.map((args) => args[0]), ["publish"]);
});
