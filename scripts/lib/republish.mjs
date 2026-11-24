/**
 * Put on npmjs the exact tarball the Gitea registry already has for one
 * package version.
 *
 * A release used to be built twice: once by `.gitea/workflows/release.yml` for
 * the Gitea registry and once more by the GitHub mirror's workflow for npmjs.
 * The type build is not byte-deterministic, so one version named two tarballs
 * and a lockfile written against one registry failed its checksum against the
 * other (#463). Nothing here builds. The bytes come from Gitea, are checked
 * against Gitea's own `dist.integrity`, and are published as they are; npmjs's
 * `dist.integrity` is read back afterwards and has to be the same value.
 *
 * Everything that talks to the outside — `fetch`, the clock, `npm` — comes in
 * through `deps`, so `republish.test.mjs` runs it against a local server with
 * an injected clock.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { channelOf } from "./channel.mjs";
import { compareVersions } from "./version-order.mjs";

export const GITEA_REGISTRY = "https://git.superfunction.xyz/api/packages/superfunction/npm/";
export const NPMJS_REGISTRY = "https://registry.npmjs.org/";

/**
 * How long to wait for the Gitea release to publish the version.
 *
 * The mirror push reaches GitHub within seconds, while `release.yml` runs the
 * full check before it publishes: 22.7 to 26.7 minutes per run in the release
 * runs of 2026-11-22/23, and 47.7 minutes from push to publish for the one
 * that queued behind the previous release in the workflow's concurrency group.
 * A release waits behind at most one run (a newer one replaces a queued one),
 * so two runs end to end, about 54 minutes, is the longest expected wait; 90
 * leaves margin for a slow runner without hiding a release that never came.
 */
export const GITEA_WAIT_MS = 90 * 60 * 1000;
export const GITEA_POLL_MS = 30 * 1000;

/**
 * How long to wait for npmjs to serve a version it accepted.
 *
 * `npm publish` is one PUT of the version, its tarball and its `--tag`
 * (libnpmpublish `buildMetadata`), and returns on the registry's 2xx; the
 * "Your package is being processed and may take a few minutes to become
 * available." line is the registry's `npm-notice` header, printed by
 * npm-registry-fetch. npmjs scans a publish before serving it (GitHub
 * changelog, 2026-07-28, "npm publish-time malware scanning"): "typically
 * around five minutes. It may take longer, up to 15 minutes or more, at peak
 * times", "aren't a service guarantee", and a package can be "held for manual
 * review, or blocked". 15 minutes is the typical upper figure npm gives, not a
 * bound: past it the version may still come, or never, and the run says it
 * does not know which (`notServedError`).
 */
export const NPMJS_WAIT_MS = 15 * 60 * 1000;
export const NPMJS_POLL_MS = 30 * 1000;

/** The `sha512-…` entry of a Subresource Integrity string, or `null`. */
export function sha512Of(integrity)
{
    return (integrity ?? "").split(/\s+/).find((entry) => entry.startsWith("sha512-")) ?? null;
}

/**
 * The `sha512-…` entry of a registry's `dist.integrity`, refusing a document
 * without one: two missing values must not compare as the same bytes.
 */
function requireSha512(integrity, where)
{
    const sha512 = sha512Of(integrity);

    if (!sha512)
    {
        throw new Error(`${where} has no sha512 integrity (got ${JSON.stringify(integrity ?? null)}); `
            + "nothing can be compared or verified against it.");
    }

    return sha512;
}

function integrityOfBytes(bytes)
{
    return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** `<registry>/<name>/<version>` — the scope's `/` encoded, as both registries expect. */
function versionUrl(registry, name, version)
{
    return new URL(`${name.replace("/", "%2f")}/${version}`, registry);
}

/**
 * `deps.fetch` with redirects refused: a Gitea request carries the token, and
 * every answer has to come from the host asked. fetch reports a refused
 * redirect, like any network failure, as a bare "fetch failed"; the rejection
 * here names the URL and the cause, since its message is all a CI log shows.
 */
function request(deps, url, headers = {})
{
    return deps.fetch(url, { headers, redirect: "error" }).catch((error) => Promise.reject(
        new Error(`Requesting ${url} failed: ${error.cause?.message ?? error.message}.`),
    ));
}

/**
 * The `dist` a registry has for `name@version`, or `null` while it has none.
 *
 * Only a 404 means "not there". Anything else that is not a 200 — a refused
 * token, a 5xx — is a failure now: treated as "not yet" it would turn a broken
 * credential into a 90-minute wait that ends blaming the release.
 */
async function registryDist(deps, registry, headers)
{
    const url = versionUrl(registry, deps.name, deps.version);
    const response = await request(deps, url, headers);

    if (response.status === 404)
    {
        return null;
    }
    if (!response.ok)
    {
        throw new Error(`${url.origin} answered ${response.status} for ${deps.name}@${deps.version} — `
            + "a failure of the registry or of the credential, not a version still on its way");
    }

    return (await response.json()).dist;
}

function giteaHeaders(deps)
{
    return { authorization: `Bearer ${deps.token}` };
}

/**
 * Ask a registry until it has the version or `wait.ms` has passed, then
 * throw `wait.timeout()`. Waiting is for an event that is expected and not a
 * retry: `registryDist` fails at once on anything but "not there yet".
 */
async function waitForVersion(deps, registry, headers, wait)
{
    const deadline = deps.clock.now() + wait.ms;

    for (;;)
    {
        const dist = await registryDist(deps, registry, headers);

        if (dist)
        {
            return dist;
        }
        if (deps.clock.now() >= deadline)
        {
            throw wait.timeout();
        }

        deps.log(`${deps.name}@${deps.version} is not on ${wait.where} yet — asking again in ${wait.pollMs / 1000} s`);
        await deps.clock.sleep(wait.pollMs);
    }
}

/** Wait for the Gitea release run to publish the version. */
export function waitForGitea(deps)
{
    return waitForVersion(deps, deps.giteaRegistry, giteaHeaders(deps), {
        ms: GITEA_WAIT_MS,
        pollMs: GITEA_POLL_MS,
        where: "the Gitea registry",
        timeout: () => new Error(`The Gitea release did not publish ${deps.name}@${deps.version}: `
            + `the Gitea registry still did not have it after ${GITEA_WAIT_MS / 60000} minutes. `
            + "Look at .gitea/workflows/release.yml's run for this push (if it did publish the version, "
            + "check that GITEA_PACKAGES_READ_TOKEN can read it); nothing was published to npmjs. "
            + "Once the version is there, run this workflow by hand to catch npmjs up."),
    });
}

/**
 * Download the tarball Gitea's metadata names, refusing it unless it is on
 * the Gitea registry's own origin (the token goes with the request) and its
 * bytes hash to `expected`, Gitea's sha512.
 */
export async function downloadFromGitea(deps, dist, expected)
{
    if (new URL(dist.tarball).origin !== new URL(deps.giteaRegistry).origin)
    {
        throw new Error(`The Gitea metadata for ${deps.name}@${deps.version} names a tarball on another host `
            + `(${new URL(dist.tarball).origin}); refusing to send the Gitea token there.`);
    }

    const response = await request(deps, dist.tarball, giteaHeaders(deps));

    if (!response.ok)
    {
        throw new Error(`Downloading ${dist.tarball} answered ${response.status}.`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (integrityOfBytes(bytes) !== expected)
    {
        throw new Error(`The tarball downloaded for ${deps.name}@${deps.version} does not match the Gitea registry's `
            + `dist.integrity (${expected}, got ${integrityOfBytes(bytes)}); nothing was published.`);
    }

    return bytes;
}

function npmjsDist(deps)
{
    return registryDist(deps, deps.npmjsRegistry, {});
}

function splitVersionError(deps, giteaIntegrity, npmjsIntegrity)
{
    return new Error(`npmjs already has ${deps.name}@${deps.version} with different bytes from the Gitea registry `
        + `(npmjs ${npmjsIntegrity}, Gitea ${giteaIntegrity}). A published version cannot be replaced on either `
        + "registry, so this version stays split; a lockfile written against one registry will not install from "
        + "the other. The next version will be published from the Gitea tarball.");
}

/**
 * The tag every version is published under. `npm publish` always sets one,
 * and npmjs applies it when processing ends, minutes later and outside the
 * rule below: published under its channel's tag, a version served after a
 * newer one would move that tag backwards. So no version is published under a
 * tag the rule governs; the run moves those itself once npmjs serves the
 * version. This tag is one per package and nothing removes it: npmjs refuses
 * a dist-tag delete to the publishing credential (#487), and each publish
 * moves it anyway. Runs of one package do not overlap (`tagsToMove`), yet two
 * versions can still be processing at once — a run that ended `not-served`
 * and the next one in the queue — and npmjs then sets this tag twice, in an
 * order nothing here controls. Whichever version it names, it is not a
 * channel tag, the rule never reads or moves it, and no install resolves it.
 * npm refuses a tag that is a valid SemVer range or holds a character
 * `encodeURIComponent` encodes (npm 12.2.3: `publish`, `dist-tag add`,
 * npm-package-arg); `publishing` is neither.
 */
export const PUBLISH_TAG = "publishing";

/**
 * npmjs answers 401, not 404, for the dist-tags of a scoped package it has
 * never had (measured 2026-11-23); the packument's 404 says which this is.
 */
async function npmjsLacksPackage(deps)
{
    const response = await request(deps, new URL(deps.name.replace("/", "%2f"), deps.npmjsRegistry));

    return response.status === 404;
}

/**
 * `<registry>/-/package/<name>/dist-tags`. npmjs serves it uncached (measured
 * 2026-11-23: no cache-control, Cloudflare DYNAMIC on repeated requests), so it
 * says where the tags point now; the packument is cached for 300 s.
 */
async function npmjsDistTags(deps)
{
    const url = new URL(`-/package/${deps.name.replace("/", "%2f")}/dist-tags`, deps.npmjsRegistry);
    const response = await request(deps, url);

    if (response.ok)
    {
        return response.json();
    }
    if (await npmjsLacksPackage(deps))
    {
        return {};
    }

    throw new Error(`${url} answered ${response.status}; cannot tell where npmjs's dist-tags point.`);
}

/**
 * The dist-tags this version moves on npmjs. Which tags a version is for is
 * main's channel rule, unchanged: its channel (`-alpha` → alpha, `-beta` →
 * beta, otherwise latest) and `latest`, for alpha and beta versions too. A tag
 * moves only to a version newer than the one it names now (`compareVersions`),
 * so two releases of one package finishing out of order leave it on the newer.
 * The rule reads and then writes, and npm dist-tags have no compare-and-swap:
 * it holds because each `publish-<pkg>.yml` runs one run of its package at a
 * time (`concurrency` with `queue: max`).
 */
function tagsToMove(deps, current)
{
    const tags = [...new Set([channelOf(deps.version), "latest"])];

    for (const tag of tags.filter((tag) => current[tag] && compareVersions(deps.version, current[tag]) <= 0))
    {
        deps.log(`left npmjs's ${tag} dist-tag on ${current[tag]}`
            + (current[tag] === deps.version ? "" : `, which is newer than ${deps.version}`));
    }

    return tags.filter((tag) => !current[tag] || compareVersions(deps.version, current[tag]) > 0);
}

/** npm's own error is already on stderr, above this message in the log. */
function npmFailure(deps, args, status)
{
    return new Error(`npm ${args[0]} for ${deps.name}@${deps.version} exited with ${status} (npm's error is above).`);
}

function runNpm(deps, args)
{
    const { status } = deps.npm(args);

    if (status !== 0)
    {
        throw npmFailure(deps, args, status);
    }
}

function moveTags(deps, tags)
{
    const spec = `${deps.name}@${deps.version}`;

    for (const tag of tags)
    {
        if (deps.dryRun)
        {
            deps.log(`dry run: would point npmjs's ${tag} dist-tag at ${spec}`);
        }
        else
        {
            runNpm(deps, ["dist-tag", "add", spec, tag, "--registry", deps.npmjsRegistry]);
        }
    }
}

/**
 * npmjs refusing the version number: E409 Conflict, or "cannot publish over
 * the previously published versions" (E403 from the registry, or npm's own
 * check of the packument). The refusal does not say why. npmjs gives it for a
 * version it serves, for one it is still processing (a re-run during an
 * earlier run's processing; not measured), and for one published and later
 * removed, which it never accepts again; E409 is also reported while another
 * version of the package is processing (not measured), and then npmjs never
 * took this version and a re-run publishes it. A removed version stays in the packument's `time`
 * map, but no npm source says a version still processing is absent from it,
 * so the map cannot tell the cases apart: the run waits as after an accepted
 * publish, and if npmjs does not serve the version, says it does not know why.
 */
function isVersionNumberRefused(stderr)
{
    return /code E409\b/.test(stderr) || /cannot publish over/i.test(stderr);
}

/**
 * Publish the downloaded bytes under `PUBLISH_TAG`: true when npmjs accepted them,
 * false when it refused the version number (`isVersionNumberRefused`).
 * `--registry` on the command line wins over a `publishConfig.registry` inside
 * the tarball (the unscoped `spfn` CLI pins the Gitea registry there for local
 * publishes), so the file goes to npmjs unchanged — the pin is part of the
 * bytes both registries serve.
 * `--provenance` signs over the file's sha512, which is all npm needs: it is
 * not limited to a directory publish, and `--dry-run` never reaches it.
 */
function publishToNpmjs(deps, bytes)
{
    const file = join(deps.workDir, `${deps.name.replace("@", "").replace("/", "-")}-${deps.version}.tgz`);

    writeFileSync(file, bytes);
    const args = [
        "publish", file,
        "--access", "public",
        "--tag", PUBLISH_TAG,
        "--registry", deps.npmjsRegistry,
        "--provenance",
        ...(deps.dryRun ? ["--dry-run"] : []),
    ];
    const { status, stderr } = deps.npm(args);

    if (status !== 0 && !isVersionNumberRefused(stderr))
    {
        throw npmFailure(deps, args, status);
    }

    return status === 0;
}

/**
 * The outcome a run reports when npmjs did not serve the version within
 * `NPMJS_WAIT_MS`: "failure" alone would read as a failed publish.
 */
export const NOT_SERVED = "not-served";

/**
 * Only what the run knows: npmjs has not served the version. Why is npmjs's
 * to say, on the package's page; a version it never took or a number it will
 * not reuse is a reason only when it refused the publish
 * (`isVersionNumberRefused`).
 */
function notServedError(deps, accepted)
{
    const spec = `${deps.name}@${deps.version}`;
    const minutes = NPMJS_WAIT_MS / 60000;
    const what = accepted
        ? `npmjs accepted the publish of ${spec} and has not served the version within ${minutes} minutes`
        : `npmjs refused to publish ${spec} (npm's error is above) and has not served the version within ${minutes} minutes`;
    const reasons = accepted
        ? "still processing it, or has held it for manual review or blocked it"
        : "still processing it, has held it for manual review or blocked it, never took it (E409 is also reported "
            + "while another version of the package is processing; a re-run then publishes it), or will not take this "
            + "version number again (a version published and removed is never accepted twice; the release then needs "
            + "a new version)";

    return Object.assign(new Error(`${what}. No dist-tag was moved. npmjs does not say why; likely it is ${reasons}. `
        + `See https://www.npmjs.com/package/${deps.name}/v/${deps.version}. A re-run of this workflow waits again `
        + "and finishes (integrity compared, dist-tags moved) only once npmjs serves the version. "
        + `${minutes} minutes is the typical upper figure npm gives for processing ("up to 15 minutes or more", `
        + "\"aren't a service guarantee\"), not a bound."), { outcome: NOT_SERVED });
}

/**
 * Wait for npmjs to serve the version: `npm publish` returns when npmjs has
 * accepted it, and npmjs processes it before serving the version or the tag
 * that came with it. The per-version document's 404 ("version not found")
 * carries no cache headers and is not cached (measured 2026-11-23), so each
 * ask sees the version as soon as npmjs serves it.
 */
function waitForNpmjs(deps, accepted)
{
    return waitForVersion(deps, deps.npmjsRegistry, {}, {
        ms: NPMJS_WAIT_MS,
        pollMs: NPMJS_POLL_MS,
        where: "npmjs",
        timeout: () => notServedError(deps, accepted),
    });
}

/**
 * Publish, wait for npmjs to serve the version, and compare its integrity.
 * Returns the outcome; with `--dry-run` nothing is published to wait for.
 */
async function publishAndConfirm(deps, dist, giteaIntegrity)
{
    const bytes = await downloadFromGitea(deps, dist, giteaIntegrity);
    const accepted = publishToNpmjs(deps, bytes);

    if (deps.dryRun)
    {
        return "dry-run";
    }

    const { integrity } = await waitForNpmjs(deps, accepted);
    const served = requireSha512(integrity, `npmjs's ${deps.name}@${deps.version}`);

    if (served !== giteaIntegrity)
    {
        throw accepted
            ? new Error(`After publishing, npmjs reports ${served} for ${deps.name}@${deps.version}, `
                + `not the Gitea registry's ${giteaIntegrity}.`)
            : splitVersionError(deps, giteaIntegrity, served);
    }

    return accepted ? "published" : "already-published";
}

/**
 * The whole flow for one version. Returns `"already-published"`,
 * `"published"` or `"dry-run"`; every refusal is a thrown `Error` whose
 * message is the explanation (with `outcome: NOT_SERVED` when npmjs did not
 * serve the version in time). The dist-tags are read and moved by the rule
 * only once npmjs serves the version with the Gitea bytes, so a run that
 * published and then failed is finished by a re-run once npmjs serves it.
 *
 * deps: { name, version, token, giteaRegistry, npmjsRegistry, fetch,
 *         clock: { now, sleep }, npm(args) → { status, stderr }, workDir, dryRun, log }
 */
export async function republish(deps)
{
    const dist = await waitForGitea(deps);
    const giteaIntegrity = requireSha512(dist.integrity, `The Gitea metadata for ${deps.name}@${deps.version}`);
    const present = await npmjsDist(deps);

    if (present)
    {
        const npmjsIntegrity = requireSha512(present.integrity, `npmjs's ${deps.name}@${deps.version}`);

        if (npmjsIntegrity !== giteaIntegrity)
        {
            throw splitVersionError(deps, giteaIntegrity, npmjsIntegrity);
        }

        deps.log(`${deps.name}@${deps.version} is already on npmjs with the same bytes as on the Gitea registry`);
    }

    const outcome = present ? "already-published" : await publishAndConfirm(deps, dist, giteaIntegrity);

    moveTags(deps, tagsToMove(deps, await npmjsDistTags(deps)));

    return outcome;
}

/**
 * `npm` with the npm token and no other secret: the Gitea token and both names
 * the npm token can arrive under are dropped from what it inherits, and the
 * token goes back only as NODE_AUTH_TOKEN, the variable setup-node's .npmrc
 * reads. stderr is read so a refused publish can be told apart, and passed on
 * to the log unchanged.
 */
function npmWithItsToken(env)
{
    const { GITEA_PACKAGES_READ_TOKEN: _gitea, NPM_TOKEN: npmToken, NODE_AUTH_TOKEN: _inherited, ...rest } = env;
    const childEnv = npmToken ? { ...rest, NODE_AUTH_TOKEN: npmToken } : rest;

    return (args) =>
    {
        const { status, stderr, error } = spawnSync("npm", args, {
            stdio: ["inherit", "inherit", "pipe"],
            env: childEnv,
            encoding: "utf8",
        });

        if (error)
        {
            throw error;
        }
        process.stderr.write(stderr);

        return { status, stderr };
    };
}

/**
 * The `deps` of a real run, from the process environment. Each credential
 * reaches only what needs it: GITEA_PACKAGES_READ_TOKEN only the headers of
 * the Gitea requests, NPM_TOKEN only the `npm` processes.
 */
export function runDependencies({ name, version, env, workDir, dryRun })
{
    return {
        name,
        version,
        token: env.GITEA_PACKAGES_READ_TOKEN,
        giteaRegistry: GITEA_REGISTRY,
        npmjsRegistry: NPMJS_REGISTRY,
        fetch,
        clock: { now: Date.now, sleep },
        npm: npmWithItsToken(env),
        workDir,
        dryRun,
        log: (line) => console.log(line),
    };
}
