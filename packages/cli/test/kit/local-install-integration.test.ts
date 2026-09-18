/**
 * One install, end to end, with the local ports actually running things.
 *
 * Everything the other Kit tests fake is real here except the database: pnpm
 * resolves and unpacks from a registry listening on loopback, the release's
 * gate runs as a child process, and Git makes a commit that `git rev-parse`
 * can name afterwards. The point is not coverage — the ports have their own
 * tests — but the join. A port can satisfy its own test and still be wrong
 * about what it hands the next one: an `.npmrc` referencing a variable the
 * child never receives, a lockfile written for a registry the install does not
 * use, a commit attempted in a directory Git was never told about.
 *
 * The database stays a stub, deliberately: standing up PostgreSQL would test
 * PostgreSQL. What the database port does with a real child process is covered
 * in `local-ports.test.ts` and in the last case here.
 *
 * Everything runs against 127.0.0.1, and `--registry` points pnpm at the
 * fixture, so no request can reach a real registry even if a name resolved.
 */

import { execFileSync } from 'node:child_process';
import { execa } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall } from '../../src/kit/operations/install.js';
import { createKitRemotePorts } from '../../src/kit/http/index.js';
import { createKitLocalPorts } from '../../src/kit/local/index.js';
import { SpfnDatabasePort } from '../../src/kit/local/database.js';
import { HttpLicensePort } from '../../src/kit/http/control-plane.js';
import { newCandidateCredential } from '../../src/kit/credentials.js';
import { createChildEnv, registryNpmrc } from '../../src/kit/child-env.js';
import type { DatabasePort, KitAdapters } from '../../src/kit/ports.js';
import { FAKE_KIT_PACKAGE, FakeKitWorld, npmTarball } from './fake-world.js';
import { KitHttpFixture, fixtureLicenseKey } from './http-fixture.js';

const KIT_ID = 'campaign-landing';
const PACKAGES_URL = 'https://packages.superfunction.xyz';
const CONTROL_PLANE_URL = 'https://start.superfunction.xyz';
const CORE = { name: '@spfn/core', version: '0.3.0-beta.5' };
const KIT = { name: FAKE_KIT_PACKAGE, version: '1.0.0' };

/** A database that answers "configured, reachable, nothing waiting". */
const settledDatabase: DatabasePort = {
    async status()
    {
        return { configured: true, reachable: true, applied: ['0001_init'], pending: [] };
    },
    async migrate()
    {
        return { ok: true, applied: ['0001_init'], pending: [] };
    },
};

let fixture: KitHttpFixture;
let world: FakeKitWorld;
let licenseKey: string;
let root: string;
let target: string;
let store: string;
let emptyNpmrc: string;

const pnpmAvailable = hasPnpm();

beforeEach(async () =>
{
    root = mkdtempSync(join(tmpdir(), 'spfn-kit-integration-'));
    target = join(root, 'project');
    store = join(root, 'pnpm-store');
    // An empty file standing in for the machine's own npm configuration. A
    // developer's `~/.npmrc` commonly points a scope at a private registry,
    // and without this the install would reach it — over the real network,
    // carrying the bearer meant for the fixture.
    emptyNpmrc = join(root, 'isolated.npmrc');
    writeFileSync(emptyNpmrc, '', 'utf8');

    fixture = new KitHttpFixture();
    await fixture.start();

    licenseKey = fixtureLicenseKey();
    // Three slots: one for the lockfile seed, one for the install, one spare.
    fixture.addLicense(licenseKey, { kitId: KIT_ID, projectLimit: 3 });
    fixture.addPackage(CORE.name, CORE.version, npmTarball(CORE.name, CORE.version));
    fixture.addPackage(KIT.name, KIT.version, npmTarball(KIT.name, KIT.version));
});

afterEach(async () =>
{
    await fixture.stop();
    rmSync(root, { recursive: true, force: true });
});

function hasPnpm(): boolean
{
    try
    {
        execFileSync('pnpm', ['--version'], { stdio: 'ignore' });

        return true;
    }
    catch
    {
        return false;
    }
}

/**
 * An npm environment that reads no configuration but its own.
 *
 * A developer's `~/.npmrc` usually points a scope at a private registry. Left
 * alone it would take precedence over `--registry`, and the install would
 * leave the machine — carrying a bearer meant for a loopback fixture.
 * `fetch_retries=0` turns a wrong address into a fast failure instead of two
 * minutes of retries.
 */
function isolatedNpmEnv(): Record<string, string>
{
    return {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        npm_config_userconfig: emptyNpmrc,
        npm_config_globalconfig: emptyNpmrc,
        npm_config_fetch_retries: '0',
    };
}

/**
 * The real clock, in the instant shape the Kit documents use.
 *
 * One definition for the whole suite: the fake world is seeded from it at
 * construction and the adapters read it afterwards, so the descriptor the
 * world issues is never dated ahead of the install that resolves it.
 */
const now = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Published addresses resolved onto the fixture; the registry is loopback. */
const mappedFetch = (url: string, init?: RequestInit): Promise<Response> => fetch(
    url.replace(CONTROL_PLANE_URL, fixture.origin).replace(PACKAGES_URL, fixture.origin),
    init,
);

/** The scaffold's `package.json`: two real dependencies and one real gate. */
function scaffoldPackageJson(): string
{
    return `${JSON.stringify({
        name: 'kit-scaffold',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { build: 'node -e "process.stdout.write(String(0))"' },
        dependencies: { [CORE.name]: CORE.version, [KIT.name]: KIT.version },
    }, null, 4)}\n`;
}

/**
 * A lockfile for exactly this graph, produced by pnpm itself.
 *
 * Written by running a non-frozen install once in a directory of its own. A
 * lockfile pasted in by hand would either be wrong now or stop being right the
 * next time pnpm changed its format — and the case below exists to prove a
 * *frozen* install works, which needs a lockfile pnpm agrees with.
 */
async function seedLockfile(): Promise<string>
{
    const seed = join(root, 'seed');
    const credential = newCandidateCredential();
    const activation = await new HttpLicensePort({ baseUrl: CONTROL_PLANE_URL, fetchImpl: mappedFetch }).activate({
        kitId: KIT_ID,
        installationId: 'op-lockfile-seed',
        localClientId: 'lc-seed',
        licenseKey,
        candidateCredential: credential,
    });

    expect(activation.status).toBe('activated');

    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, 'package.json'), scaffoldPackageJson(), 'utf8');
    writeFileSync(join(seed, '.npmrc'), registryNpmrc(['@spfn', '@superfunction'], fixture.registryUrl), 'utf8');

    // Spawned asynchronously, not with `execFileSync`. The registry pnpm is
    // talking to is this process's own HTTP server, and a synchronous child
    // blocks the event loop that would have answered it — the two would wait
    // for each other until pnpm's socket timed out.
    const seeded = await execa('pnpm', [
        'install',
        '--no-frozen-lockfile',
        '--registry', fixture.registryUrl,
        '--store-dir', store,
        '--ignore-scripts',
        '--ignore-workspace',
    ], {
        cwd: seed,
        // The product's own environment, not a hand-rolled one. The seed is
        // the first thing to talk to the fixture registry, so if the credential
        // does not reach a package-manager child this way, it fails here.
        env: createChildEnv({
            parent: {},
            extra: isolatedNpmEnv(),
            registryToken: credential,
            registryUrl: fixture.registryUrl,
        }),
        extendEnv: false,
        reject: false,
        timeout: 180_000,
    });

    if (seeded.exitCode !== 0)
    {
        throw new Error(`seeding the lockfile failed:\n${seeded.stderr}\n${seeded.stdout}`);
    }

    return readFileSync(join(seed, 'pnpm-lock.yaml'), 'utf8');
}

/** Build the release around a given scaffold, and put it in the store. */
function publish(lockfile: string): void
{
    world = new FakeKitWorld({
        kitId: KIT_ID,
        releaseStoreUrl: `${PACKAGES_URL}/kits/${KIT_ID}`,
        registryUrl: fixture.registryUrl,
        now: now(),
        releases: [{
            version: KIT.version,
            sequence: 1,
            gates: ['build'],
            scaffoldFiles: {
                'package.json': scaffoldPackageJson(),
                'pnpm-lock.yaml': lockfile,
                'src/app/page.tsx': 'export default function Page() { return null; }\n',
            },
        }],
    });
    fixture.release = {
        catalog: world.signedCatalog(),
        manifests: { [KIT.version]: world.sign(world.latest.manifest) },
        artifacts: world.artifactStore(),
    };
}

function adaptersFor(projectDir: string, database: DatabasePort): KitAdapters
{
    const local = createKitLocalPorts({
        packageManager: {
            registryUrl: fixture.registryUrl,
            storeDir: store,
            ignoreScripts: true,
            ignoreWorkspace: true,
            timeoutMs: 180_000,
            extraEnv: isolatedNpmEnv(),
        },
        gateTimeoutMs: 120_000,
    });
    const remote = createKitRemotePorts({
        projectDir,
        endpoints: { controlPlaneUrl: CONTROL_PLANE_URL, registryUrl: fixture.registryUrl, source: 'environment' },
        credentials: world.credentials,
        trustedKeys: world.trustedKeys,
        now,
        packageManager: local.packageManager,
        fetchImpl: mappedFetch,
        timeoutMs: 10_000,
    });

    return {
        clock: { now },
        cliVersion: world.adapters.cliVersion,
        controlPlaneUrl: CONTROL_PLANE_URL,
        registryUrl: fixture.registryUrl,
        trustedKeys: world.trustedKeys,
        credentials: world.credentials,
        // A setup link must be https and on the official origin, so the
        // descriptor still comes from the fixture fetcher rather than loopback.
        setupFetcher: world.adapters.setupFetcher,
        catalog: remote.catalog,
        license: remote.license,
        registry: remote.registry,
        artifacts: remote.artifacts,
        scaffold: remote.scaffold,
        packageManager: remote.packageManager,
        database,
        gates: local.gates,
        git: local.git,
        loadProjectModule: world.adapters.loadProjectModule,
    };
}

function install(): ReturnType<typeof runInstall>
{
    return runInstall({
        setupUrl: world.setupUrl,
        targetDir: target,
        readLicenseKey: async () => licenseKey,
        json: true,
        write: () => undefined,
    }, adaptersFor(target, settledDatabase));
}

describe.runIf(pnpmAvailable)('an install with the local ports actually running', () =>
{
    it('installs the exact graph from the loopback registry, runs the gate and commits', async () =>
    {
        publish(await seedLockfile());

        const result = await install();

        expect(result.status).toBe('completed');
        expect(result.code).toBe('KIT_LOCAL_READY');

        // pnpm really unpacked both packages from the fixture.
        expect(existsSync(join(target, 'node_modules', CORE.name, 'package.json'))).toBe(true);
        expect(JSON.parse(readFileSync(join(target, 'node_modules', KIT.name, 'package.json'), 'utf8')).version)
            .toBe(KIT.version);

        // Git really made a commit, and the worktree is clean afterwards.
        expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target }).toString().trim())
            .toMatch(/^[0-9a-f]{40}$/);
        expect(execFileSync('git', ['status', '--porcelain'], { cwd: target }).toString().trim()).toBe('');
        expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: target }).toString().trim())
            .toBe(`chore: install ${KIT_ID} ${KIT.version}`);

        // And every package of the graph was proven through the proxy first.
        const asked = fixture.requests.map(request => decodeURIComponent(request.path));

        expect(asked).toContain(`/npm/${KIT.name}`);
        expect(asked).toContain(`/npm/${CORE.name}`);

        // The project it left behind names the scopes and holds no credential.
        // pnpm 10 and later ignore a credential from a project `.npmrc`,
        // so a line put back here is an unauthorized install for every adopter
        // on it — and this install would still pass, because the session also
        // arrives in the environment.
        const npmrc = readFileSync(join(target, '.npmrc'), 'utf8');

        expect(npmrc).toContain('@spfn:registry=');
        expect(npmrc).not.toMatch(/_auth/i);
        expect(npmrc).not.toContain('${');
    }, 300_000);

    it('refuses rather than resolving when the release ships a lockfile for another graph', async () =>
    {
        // The scaffold's lockfile no longer describes its own `package.json`.
        // A frozen install must stop; resolving something else would produce a
        // project the release never pinned.
        publish((await seedLockfile()).replace(new RegExp(CORE.version, 'g'), '0.3.0-beta.4'));

        const result = await install();

        expect(result.status).toBe('failed');
        expect(existsSync(join(target, 'node_modules'))).toBe(false);
    }, 300_000);
});

/**
 * The pnpm versions the credential path is proven against.
 *
 * Not the machine's own pnpm: this is the one part of the install whose
 * correctness depends on a *release* of the package manager rather than on
 * anything in this repository. pnpm stopped expanding environment variables in
 * credentials that come from a project `.npmrc`, and the install broke for every
 * adopter on it without a line of this code changing.
 *
 * Three versions, because they behave three different ways and each one is
 * somebody's: 9 expands a project credential and cannot read a ported
 * environment key; 10 can read neither, which is the combination Vercel builds
 * on; 11 reads the ported key and refuses the project credential. A future
 * release that moves the rule again fails here rather than in somebody's
 * terminal.
 *
 * A version corepack cannot produce is skipped rather than failed — an offline
 * machine is not a regression.
 */
const PNPM_VERSIONS = ['9.1.2', '10.34.5', '11.23.0'];

function corepackCanRun(version: string): boolean
{
    try
    {
        const shown = execFileSync('corepack', [`pnpm@${version}`, '--version'], {
            // Outside this repository on purpose. pnpm refuses to run under
            // corepack as a version other than the one the nearest
            // `packageManager` field names, and this repo pins 9.1.2 — asked
            // from in here, every other version would report itself
            // unavailable and quietly skip the case it exists to cover.
            cwd: tmpdir(),
            env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 180_000,
        }).toString().trim();

        return shown === version;
    }
    catch
    {
        return false;
    }
}

const runnablePnpm = pnpmAvailable ? PNPM_VERSIONS.filter(corepackCanRun) : [];

describe.runIf(runnablePnpm.length > 0)('the registry credential, on each supported pnpm', () =>
{
    for (const version of PNPM_VERSIONS)
    {
        it.runIf(runnablePnpm.includes(version))(`authenticates against the private registry on pnpm ${version}`, async () =>
        {
            const project = join(root, `pm-${version}`);
            const credential = newCandidateCredential();
            const activation = await new HttpLicensePort({ baseUrl: CONTROL_PLANE_URL, fetchImpl: mappedFetch }).activate({
                kitId: KIT_ID,
                installationId: `op-pnpm-${version}`,
                localClientId: `lc-${version}`,
                licenseKey,
                candidateCredential: credential,
            });

            expect(activation.status).toBe('activated');

            mkdirSync(project, { recursive: true });
            writeFileSync(join(project, 'package.json'), scaffoldPackageJson(), 'utf8');
            // Exactly the two artifacts the product produces: the `.npmrc` it
            // writes into the project, and the environment it builds for the
            // child. Nothing here spells a credential out by hand.
            writeFileSync(join(project, '.npmrc'), registryNpmrc(['@spfn', '@superfunction'], fixture.registryUrl), 'utf8');

            const installed = await execa('corepack', [
                `pnpm@${version}`,
                'install',
                '--no-frozen-lockfile',
                '--registry', fixture.registryUrl,
                // A store and a metadata cache of this test's own. A shared one
                // would serve the packages from disk, and the case would pass
                // without the credential ever being presented.
                '--store-dir', join(project, 'store'),
                '--cache-dir', join(project, 'cache'),
                '--ignore-scripts',
                '--ignore-workspace',
            ], {
                cwd: project,
                env: createChildEnv({
                    parent: {},
                    extra: {
                        ...isolatedNpmEnv(),
                        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
                        // The project is under the OS temp directory and names
                        // no package manager of its own, but a machine whose
                        // temp directory sits below one would otherwise have
                        // pnpm refuse to run as anything else.
                        pnpm_config_pm_on_fail: 'ignore',
                    },
                    registryToken: credential,
                    registryUrl: fixture.registryUrl,
                }),
                extendEnv: false,
                reject: false,
                timeout: 300_000,
            });

            // The tail only, never the child's whole output: a package
            // manager's error text is not written with this CLI's rules in mind.
            expect({ exitCode: installed.exitCode, tail: lastLine(String(installed.stderr ?? '')) })
                .toMatchObject({ exitCode: 0 });
            expect(existsSync(join(project, 'node_modules', CORE.name, 'package.json'))).toBe(true);

            // The packages really came over the wire. The fixture answers 401
            // without a bearer it accepts, so a request that reached it at all
            // is a request the credential opened — and a run served from a warm
            // store would have made none.
            expect(fixture.requests.some(request => request.path.startsWith('/npm/'))).toBe(true);
        }, 420_000);
    }
});

/** The last non-empty line of a child's output, for a readable failure. */
function lastLine(text: string): string
{
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    return lines.length === 0 ? '' : lines[lines.length - 1];
}

describe('the database port against its real child process', () =>
{
    it('reports a project with no database configured, without reading its env values', async () =>
    {
        const project = join(root, 'no-database');

        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'p', private: true }), 'utf8');

        const status = await new SpfnDatabasePort({ timeoutMs: 120_000 }).status({ cwd: project });

        expect(status.configured).toBe(false);
        expect(status.pending).toEqual([]);
    }, 180_000);
});
