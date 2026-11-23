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

import { execFileSync } from "node:child_process";
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
 * Ask Gitea until it has the version or `GITEA_WAIT_MS` has passed. Waiting is
 * for an event that is expected — the release run publishing — and not a
 * retry: `registryDist` fails at once on anything but "not there yet".
 */
export async function waitForGitea(deps)
{
    const deadline = deps.clock.now() + GITEA_WAIT_MS;

    for (;;)
    {
        const dist = await registryDist(deps, deps.giteaRegistry, giteaHeaders(deps));

        if (dist)
        {
            return dist;
        }
        if (deps.clock.now() >= deadline)
        {
            throw new Error(`The Gitea release did not publish ${deps.name}@${deps.version}: `
                + `the Gitea registry still did not have it after ${GITEA_WAIT_MS / 60000} minutes. `
                + "Look at .gitea/workflows/release.yml's run for this push (if it did publish the version, "
                + "check that GITEA_PACKAGES_READ_TOKEN can read it); nothing was published to npmjs. "
                + "Once the version is there, run this workflow by hand to catch npmjs up.");
        }

        deps.log(`${deps.name}@${deps.version} is not on the Gitea registry yet — asking again in ${GITEA_POLL_MS / 1000} s`);
        await deps.clock.sleep(GITEA_POLL_MS);
    }
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
 * The tag a version is published under when every tag it would take already
 * names a newer version: `npm publish` always sets one, and moving the
 * channel's tag or `latest` backwards is what the rule below exists to stop.
 */
export const SUPERSEDED_TAG = "superseded";

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
 */
async function tagsToMove(deps)
{
    const current = await npmjsDistTags(deps);
    const tags = [...new Set([channelOf(deps.version), "latest"])];

    for (const tag of tags.filter((tag) => current[tag] && compareVersions(deps.version, current[tag]) <= 0))
    {
        deps.log(`left npmjs's ${tag} dist-tag on ${current[tag]}`
            + (current[tag] === deps.version ? "" : `, which is newer than ${deps.version}`));
    }

    return tags.filter((tag) => !current[tag] || compareVersions(deps.version, current[tag]) > 0);
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
            deps.npm(["dist-tag", "add", spec, tag, "--registry", deps.npmjsRegistry]);
        }
    }
}

/**
 * Publish the downloaded bytes under `tag`. `--registry` on the command line
 * wins over a `publishConfig.registry` inside the tarball (the unscoped `spfn` CLI pins
 * the Gitea registry there for local publishes), so the file goes to npmjs
 * unchanged — the pin is part of the bytes both registries serve.
 * `--provenance` signs over the file's sha512, which is all npm needs: it is
 * not limited to a directory publish, and `--dry-run` never reaches it.
 */
function publishToNpmjs(deps, bytes, tag)
{
    const file = join(deps.workDir, `${deps.name.replace("@", "").replace("/", "-")}-${deps.version}.tgz`);

    writeFileSync(file, bytes);
    deps.npm([
        "publish", file,
        "--access", "public",
        "--tag", tag,
        "--registry", deps.npmjsRegistry,
        "--provenance",
        ...(deps.dryRun ? ["--dry-run"] : []),
    ]);
}

/**
 * Read npmjs's integrity back from the per-version document. Measured
 * 2026-11-23: a 404 carries no cache headers and is not cached; a 200 is
 * uncached for a scoped name (Cloudflare DYNAMIC) but `max-age=300` and served
 * from the CDN for the unscoped `spfn`. Before the publish this run got a 404
 * for the version, so no cached answer for it exists and the first ask sees
 * the version just published.
 */
async function confirmPublished(deps, giteaIntegrity)
{
    const published = await npmjsDist(deps);

    if (!published)
    {
        throw new Error(`After publishing, npmjs does not have ${deps.name}@${deps.version}.`);
    }
    if (requireSha512(published.integrity, `npmjs's ${deps.name}@${deps.version}`) !== giteaIntegrity)
    {
        throw new Error(`After publishing, npmjs reports ${sha512Of(published.integrity)} for ${deps.name}@${deps.version}, `
            + `not the Gitea registry's ${giteaIntegrity}.`);
    }
}

/**
 * The whole flow for one version. Returns `"already-published"`,
 * `"published"` or `"dry-run"`; every refusal is a thrown `Error` whose
 * message is the explanation. A version npmjs already has with the same bytes
 * still gets its tags moved by the rule, so a run that published and then
 * failed to move a tag is finished by any re-run.
 *
 * deps: { name, version, token, giteaRegistry, npmjsRegistry, fetch,
 *         clock: { now, sleep }, npm(args), workDir, dryRun, log }
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
        moveTags(deps, await tagsToMove(deps));

        return "already-published";
    }

    const bytes = await downloadFromGitea(deps, dist, giteaIntegrity);
    const [publishTag = SUPERSEDED_TAG, ...otherTags] = await tagsToMove(deps);

    publishToNpmjs(deps, bytes, publishTag);
    if (!deps.dryRun)
    {
        await confirmPublished(deps, giteaIntegrity);
    }
    moveTags(deps, otherTags);

    return deps.dryRun ? "dry-run" : "published";
}

/**
 * `npm` with the npm token and no other secret: the Gitea token and both names
 * the npm token can arrive under are dropped from what it inherits, and the
 * token goes back only as NODE_AUTH_TOKEN, the variable setup-node's .npmrc
 * reads.
 */
function npmWithItsToken(env)
{
    const { GITEA_PACKAGES_READ_TOKEN: _gitea, NPM_TOKEN: npmToken, NODE_AUTH_TOKEN: _inherited, ...rest } = env;
    const childEnv = npmToken ? { ...rest, NODE_AUTH_TOKEN: npmToken } : rest;

    return (args) => execFileSync("npm", args, { stdio: "inherit", env: childEnv });
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
