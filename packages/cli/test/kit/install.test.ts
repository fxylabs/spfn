/**
 * Unit 06 table A — setup and install — driven end to end against the fake
 * world. Every row of the table is one test, named after the row.
 *
 * What each test really asserts is not only the exit code but what did *not*
 * happen: no fetch before the allowlist, no file before the activation, no
 * commit before the gates, no second slot on a retry.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall } from '../../src/kit/operations/install.js';
import { runAbandon, runResume } from '../../src/kit/operations/resume.js';
import { runStatus } from '../../src/kit/operations/inspect.js';
import { JournalStore } from '../../src/kit/journal.js';
import { acquireOperationLock } from '../../src/kit/lock.js';
import { readInstalledLock, readLicenseFile } from '../../src/kit/installed-state.js';
import { scanValueForSecrets } from '../../src/kit/secret-scan.js';
import { KIT_EXIT, isKitError } from '../../src/kit/errors.js';
import { FakeKitWorld, FAKE_LICENSE_KEY, FAKE_SETUP_URL } from './fake-world.js';

/** The event sink has somewhere to write; these tests do not read it. */
function silent(): void
{
    // Intentionally quiet.
}

let root: string;
let target: string;

beforeEach(() =>
{
    root = mkdtempSync(join(tmpdir(), 'spfn-kit-install-'));
    target = join(root, 'project');
});

afterEach(() =>
{
    rmSync(root, { recursive: true, force: true });
});

function installRequest(world: FakeKitWorld, overrides: Partial<Parameters<typeof runInstall>[0]> = {})
{
    return {
        setupUrl: world.setupUrl,
        targetDir: target,
        readLicenseKey: async () => FAKE_LICENSE_KEY,
        json: true,
        write: silent,
        ...overrides,
    };
}

async function failureOf(run: () => Promise<unknown>): Promise<{ code: string; exitCode: number }>
{
    try
    {
        await run();
    }
    catch (error)
    {
        if (!isKitError(error))
        {
            throw error;
        }

        return { code: error.code, exitCode: error.exitCode };
    }

    throw new Error('expected the operation to be refused');
}

describe('table A — allowlisted link, empty target, valid entitled license', () =>
{
    it('installs, gates, locks and commits, and says it is only local-ready', async () =>
    {
        const world = new FakeKitWorld();
        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.status).toBe('completed');
        expect(result.exitCode).toBe(KIT_EXIT.OK);
        expect(result.code).toBe('KIT_LOCAL_READY');
        expect(result.summary).toContain('Nothing has been pushed or deployed yet.');

        const lock = readInstalledLock(join(target, '.spfn', 'kit-lock.json'));

        expect(lock?.release).toBe('1.0.0');
        expect(lock?.kitId).toBe('campaign-landing');
        // The Agent Pack is an archive, so it lands as a tree rather than
        // as one document at the manifest's path.
        expect(existsSync(join(target, '.spfn/agent-pack/agents-block.md'))).toBe(true);
        expect(existsSync(join(target, 'src/app/api/landing/route.ts'))).toBe(true);
        expect(existsSync(join(target, '.git'))).toBe(true);

        // The operation is finished, so nothing is left open.
        expect(new JournalStore(target, { now: () => world.now() }).readActive()).toBeNull();
    });

    it('hands the registry session to the child environment and nowhere else', async () =>
    {
        const world = new FakeKitWorld();

        await runInstall(installRequest(world), world.adapters);

        const [childEnv] = world.childEnvironments;

        expect(childEnv.SPFN_REGISTRY_TOKEN).toMatch(/^spfnr_session_/);

        // And as the registry's own npm configuration key, which is what the
        // package manager actually reads.
        expect(childEnv['npm_config_//packages.superfunction.xyz/npm/:_authToken'])
            .toBe(childEnv.SPFN_REGISTRY_TOKEN);

        // The .npmrc maps scopes to the registry and holds no credential — not
        // the value, and not a variable naming it. pnpm 10 and later ignore a
        // credential that comes from a project `.npmrc`, so putting one back
        // there breaks every install on them.
        const npmrc = readFileSync(join(target, '.npmrc'), 'utf8');

        expect(npmrc).toContain('@superfunction:registry=');
        expect(npmrc).not.toMatch(/_auth/i);
        expect(npmrc).not.toContain('${');
        expect(npmrc).not.toContain(childEnv.SPFN_REGISTRY_TOKEN);

        // Table F: the journal, the license file and the lock carry no secret.
        const state = [
            readFileSync(join(target, '.spfn', 'license.json'), 'utf8'),
            readFileSync(join(target, '.spfn', 'kit-lock.json'), 'utf8'),
        ].join('\n');

        expect(state).not.toContain(FAKE_LICENSE_KEY);
        expect(state).not.toContain(childEnv.SPFN_REGISTRY_TOKEN);
        expect(scanValueForSecrets(JSON.parse(readFileSync(join(target, '.spfn', 'license.json'), 'utf8')))).toEqual([]);
    });
});

describe('table A — refusals that write nothing', () =>
{
    it('refuses a setup origin outside the allowlist before any fetch', async () =>
    {
        const world = new FakeKitWorld();
        let fetched = 0;
        const adapters = {
            ...world.adapters,
            setupFetcher: async (url: string) =>
            {
                fetched += 1;

                return world.adapters.setupFetcher(url);
            },
        };
        const failure = await failureOf(() => runInstall(
            installRequest(world, { setupUrl: 'https://example.com/setup/landing-kit' }),
            adapters,
        ));

        expect(failure.code).toBe('KIT_SETUP_URL_INVALID');
        expect(failure.exitCode).toBe(KIT_EXIT.REFUSED);
        expect(fetched).toBe(0);
        expect(existsSync(target)).toBe(false);
    });

    it('refuses a setup link that carries a query, which is where a key would ride', async () =>
    {
        const world = new FakeKitWorld();
        const failure = await failureOf(() => runInstall(
            installRequest(world, { setupUrl: `${FAKE_SETUP_URL}?license=spfnl_leaked` }),
            world.adapters,
        ));

        expect(failure.code).toBe('KIT_SETUP_URL_INVALID');
    });

    it('refuses a target directory that is not empty', async () =>
    {
        const world = new FakeKitWorld();

        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'README.md'), 'someone else lives here\n', 'utf8');

        const failure = await failureOf(() => runInstall(installRequest(world), world.adapters));

        expect(failure.code).toBe('KIT_TARGET_NOT_EMPTY');
        expect(existsSync(join(target, '.spfn'))).toBe(false);
    });

    it('refuses a manifest that is not signed by a trusted key, before writing anything', async () =>
    {
        const world = new FakeKitWorld();
        const adapters = { ...world.adapters, trustedKeys: [{ keyId: 'someone-else', publicKey: 'AAAA' }] };
        const failure = await failureOf(() => runInstall(installRequest(world), adapters));

        expect(failure.code).toBe('KIT_MANIFEST_INVALID');
        expect(existsSync(target)).toBe(false);
    });

    it('refuses a CLI older than the descriptor requires', async () =>
    {
        const world = new FakeKitWorld({ cliVersion: '0.2.9', minimumCliVersion: '0.3.0-beta.5' });
        const failure = await failureOf(() => runInstall(installRequest(world), world.adapters));

        expect(failure.code).toBe('KIT_CLI_INCOMPATIBLE');
        expect(failure.exitCode).toBe(KIT_EXIT.INCOMPATIBLE);
    });
});

describe('what an install leaves for Git', () =>
{
    it('ignores its own per-machine operation state from the moment it exists', async () =>
    {
        const world = new FakeKitWorld();

        await runInstall(installRequest(world), world.adapters);

        // Written by the CLI into its own directory, never into the customer's
        // root .gitignore — and present whatever the release's scaffold ships.
        const ignore = readFileSync(join(target, '.spfn', '.gitignore'), 'utf8');

        expect(ignore).toContain('operations/');
        expect(existsSync(join(target, '.spfn', 'operations'))).toBe(true);
    });
});

describe('table A — activation refused', () =>
{
    it('writes no scaffold when the license key is rejected', async () =>
    {
        const world = new FakeKitWorld();
        const result = await runInstall(
            installRequest(world, { readLicenseKey: async () => 'spfnl_not_a_real_key' }),
            world.adapters,
        );

        expect(result.status).toBe('failed');
        expect(result.code).toBe('KIT_LICENSE_REQUIRED');
        expect(existsSync(join(target, 'package.json'))).toBe(false);
        expect(readLicenseFile(join(target, '.spfn', 'license.json'))).toBeNull();

        // The pending keychain item is the only thing the attempt created, and
        // it is gone again.
        expect(world.credentials.items.size).toBe(0);
    });

    it('reports a project limit without changing any existing project', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.activationStatus = 'project-limit';

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.code).toBe('KIT_PROJECT_LIMIT');
        expect(result.exitCode).toBe(KIT_EXIT.REFUSED);
        expect(existsSync(join(target, 'package.json'))).toBe(false);
    });

    it('records a failed install as resumable, not as finished', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.packageInstallFails = true;

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.status).toBe('failed');
        expect(result.exitCode).toBe(KIT_EXIT.RESUMABLE);

        const journal = new JournalStore(target, { now: () => world.now() }).readActive();

        expect(journal?.status).toBe('failed');
        expect(journal?.checkpoints.find(entry => entry.id === 'activation-complete')?.status).toBe('completed');
        expect(journal?.checkpoints.find(entry => entry.id === 'install-frozen')?.status).toBe('failed');
    });
});

describe('table A — retries, waits and resumes', () =>
{
    it('retries the exact install once with a fresh session after an unauthorized fetch', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.registryUnauthorizedOnce = true;

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.status).toBe('completed');
        expect(world.childEnvironments).toHaveLength(2);
        expect(world.childEnvironments[0].SPFN_REGISTRY_TOKEN).not.toBe(world.childEnvironments[1].SPFN_REGISTRY_TOKEN);
    });

    it('waits for a database instead of guessing, then resumes to completion', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.databaseConfigured = false;

        const waiting = await runInstall(installRequest(world), world.adapters);

        expect(waiting.status).toBe('waiting');
        expect(waiting.exitCode).toBe(KIT_EXIT.INPUT_REQUIRED);
        expect(waiting.code).toBe('KIT_WAITING_DATABASE');
        // The graph is installed by this point, so the lock that names the
        // release is already written — a wait is not an unfinished identity.
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.0.0');
        expect(new JournalStore(target, { now: () => world.now() }).readActive()?.status).toBe('waiting-cloud');

        world.faults.databaseConfigured = true;

        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed.status).toBe('completed');
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.0.0');

        // The license was read once, at the first activation, and never again.
        expect(world.activationCalls).toHaveLength(1);
    });

    it('refuses, rather than waits, when the project bookkeeping does not match its migrations (#370)', async () =>
    {
        const world = new FakeKitWorld();
        const mismatch = 'project (src/server/drizzle): bookkeeping does not match local migrations; '
            + '`spfn db migrate` will refuse. id 1 matches a folder named 20231114221320_*';

        // `db status --json` cannot read a status it would refuse, so it says unreachable too.
        world.faults.databaseReachable = false;
        world.faults.databaseBookkeepingMismatch = mismatch;

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.status).toBe('failed');
        expect(result.exitCode).toBe(KIT_EXIT.REFUSED);
        expect(result.code).toBe('CLI_MIGRATION_BOOKKEEPING_MISMATCH');
        expect(result.summary).toContain('`spfn db migrate` would refuse it');
        expect(result.evidence).toMatchObject({ reason: 'bookkeeping-mismatch', detail: mismatch });
    });

    it('makes no commit when a gate fails, and commits after the gate is fixed', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.failingGates.add('build');

        const failed = await runInstall(installRequest(world), world.adapters);

        expect(failed.code).toBe('KIT_GATE_FAILED');
        // The lock is already there: the gates read it, so it is written when
        // the graph lands rather than after they pass. What a failed gate must
        // not produce is a commit.
        expect(existsSync(join(target, '.spfn', 'kit-lock.json'))).toBe(true);
        expect(existsSync(join(target, '.git'))).toBe(false);

        world.faults.failingGates.clear();

        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed.status).toBe('completed');
        expect(existsSync(join(target, '.git'))).toBe(true);
    });

    it('refuses a resume over a graph that moved to another version since the gate failed', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.failingGates.add('build');

        expect((await runInstall(installRequest(world), world.adapters)).code).toBe('KIT_GATE_FAILED');

        writeFileSync(
            join(target, 'node_modules', '@spfn', 'core', 'package.json'),
            `${JSON.stringify({ name: '@spfn/core', version: '99.0.0' })}\n`,
            'utf8',
        );
        world.faults.failingGates.clear();

        const installs = world.childEnvironments.length;
        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed).toMatchObject({
            status: 'failed',
            code: 'KIT_RESUME_MISMATCH',
            evidence: {
                checkpoint: 'install-frozen',
                reason: 'installed-graph-moved: @spfn/core expected 0.3.0-beta.5, found 99.0.0',
            },
        });
        expect(world.childEnvironments).toHaveLength(installs);
        expect(existsSync(join(target, '.git'))).toBe(false);
    });

    it('fails the gates when a gate leaves the release\'s graph gone, and commits nothing', async () =>
    {
        const world = new FakeKitWorld();

        const result = await runInstall(installRequest(world), {
            ...world.adapters,
            gates: {
                async run()
                {
                    rmSync(join(target, 'node_modules', '@spfn'), { recursive: true, force: true });
                    rmSync(join(target, 'node_modules', '@superfunction'), { recursive: true, force: true });

                    return { ok: true };
                },
            },
        });

        expect(result).toMatchObject({
            code: 'KIT_GATE_FAILED',
            evidence: { gate: 'installed-graph', when: 'after', firstPackage: '@spfn/core', actual: 'absent' },
        });
        expect(existsSync(join(target, '.git'))).toBe(false);
    });

    it('runs no gate on a graph that is gone by the time the gates start', async () =>
    {
        const world = new FakeKitWorld();
        const gatesRun: string[] = [];

        world.faults.databasePending = ['0002_add_table'];

        const result = await runInstall(installRequest(world), {
            ...world.adapters,
            database: {
                ...world.adapters.database,
                async migrate(request)
                {
                    rmSync(join(target, 'node_modules', '@spfn'), { recursive: true });

                    return world.adapters.database.migrate(request);
                },
            },
            gates: {
                async run(gate, request)
                {
                    gatesRun.push(gate);

                    return world.adapters.gates.run(gate, request);
                },
            },
        });

        expect(result).toMatchObject({
            code: 'KIT_GATE_FAILED',
            evidence: { gate: 'installed-graph', when: 'before', firstPackage: '@spfn/core' },
        });
        expect(gatesRun).toEqual([]);
        expect(existsSync(join(target, '.git'))).toBe(false);
    });

    it('refuses an install whose package manager left another graph than the release pins', async () =>
    {
        const world = new FakeKitWorld();

        world.onPackageInstall = (projectDir) =>
        {
            writeFileSync(
                join(projectDir, 'node_modules', '@spfn', 'core', 'package.json'),
                `${JSON.stringify({ name: '@spfn/core', version: '0.3.0-beta.4' })}\n`,
                'utf8',
            );
        };

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result).toMatchObject({
            code: 'KIT_UNSUPPORTED_RESOLUTION',
            phase: 'dependencies',
            evidence: { firstPackage: '@spfn/core', expected: '0.3.0-beta.5', actual: '0.3.0-beta.4' },
        });
    });

    it('stops with a mismatch when a managed file changed under a completed checkpoint', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.databaseConfigured = false;
        await runInstall(installRequest(world), world.adapters);

        // Someone edits a file the Kit manages while the operation is parked.
        writeFileSync(join(target, 'src/app/api/landing/route.ts'), '// edited by hand\n', 'utf8');
        world.faults.databaseConfigured = true;

        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed.status).toBe('failed');
        expect(resumed.code).toBe('KIT_RESUME_MISMATCH');
        expect(resumed.exitCode).toBe(KIT_EXIT.RESUMABLE);
        expect(resumed.evidence?.checkpoint).toBe('materialize-complete');
    });
});

describe('table C — product tooling is watched, not trusted', () =>
{
    it('refuses a release whose tooling writes while it claims to be planning', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.toolingWritesOutsideAllowlist = true;

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.status).toBe('failed');
        expect(result.code).toBe('KIT_MANAGED_DRIFT');

        // The write landed in the throwaway copy, never in the customer's tree.
        expect(existsSync(join(target, 'tooling-side-effect.txt'))).toBe(false);
    });

    it('refuses a plan that would write customer source', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.toolingPlansCustomerWrite = true;

        const result = await runInstall(installRequest(world), world.adapters);

        expect(result.status).toBe('failed');
        expect(result.code).toBe('KIT_MANIFEST_INVALID');
        expect(result.evidence?.reason).toBe('customer-write');
    });
});

describe('table A — abandon', () =>
{
    it('records the abandonment, reports what survives it, and deletes nothing', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.databaseConfigured = false;

        const waiting = await runInstall(installRequest(world), world.adapters);
        const result = await runAbandon({ projectDir: target, json: true, write: silent }, world.adapters);

        expect(result.code).toBe('KIT_OPERATION_ABANDONED');
        expect(result.exitCode).toBe(KIT_EXIT.OK);
        expect(result.evidence?.activationId).toMatch(/^act-/);
        expect(result.next?.requiresHumanApproval).toBe(true);

        // Files, activation and history all stay; only the open operation ends.
        expect(existsSync(join(target, 'package.json'))).toBe(true);
        expect(existsSync(join(target, '.spfn/agent-pack/agents-block.md'))).toBe(true);

        const store = new JournalStore(target, { now: () => world.now() });

        expect(store.readActive()).toBeNull();
        expect(store.readHistory(waiting.operationId as string)?.status).toBe('abandoned');

        // The project is free again: a resume finds nothing to continue.
        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed.code).toBe('KIT_NOTHING_TO_RESUME');
    });
});

describe('table A and D — one operation at a time', () =>
{
    it('refuses to resume an operation while a live process still holds the lock', async () =>
    {
        const world = new FakeKitWorld();

        world.faults.databaseConfigured = false;

        const waiting = await runInstall(installRequest(world), world.adapters);

        expect(waiting.status).toBe('waiting');

        // A second CLI process, alive, is holding the same project.
        acquireOperationLock({
            root: target,
            operationId: waiting.operationId as string,
            command: 'kit install',
            now: world.now(),
            activeJournal: null,
            isProcessAlive: () => true,
        });
        world.faults.databaseConfigured = true;

        const failure = await failureOf(() => runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters));

        expect(failure.code).toBe('KIT_OPERATION_ACTIVE');
        expect(failure.exitCode).toBe(KIT_EXIT.REFUSED);
    });

    it('reports the installed release and no open operation once the install finished', async () =>
    {
        const world = new FakeKitWorld();

        await runInstall(installRequest(world), world.adapters);

        const status = await runStatus({ projectDir: target }, world.adapters);

        expect(status.installed).toBe(true);
        expect(status.release).toBe('1.0.0');
        expect(status.credential).toBe('present');
        expect(status.managedDrift).toBe(0);
        expect(status.operation).toBeNull();
        expect(status.updateAvailable).toBeNull();
    });

    it('reports remote facts as unknown when the catalog cannot be reached', async () =>
    {
        const world = new FakeKitWorld();

        await runInstall(installRequest(world), world.adapters);
        world.faults.catalogUnavailable = true;

        const status = await runStatus({ projectDir: target }, world.adapters);

        expect(status.installed).toBe(true);
        expect(status.release).toBe('1.0.0');
        expect(status.updateAvailable).toBe('unknown');
        expect(status.catalogSequence).toBe('unknown');
    });
});
