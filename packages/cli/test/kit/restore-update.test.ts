/**
 * Unit 06 tables B, C and D — clean clone restore, plan, and update.
 *
 * A "clean clone" here is built the way a real one is: install into one
 * directory, copy only what Git would have carried (everything except
 * `node_modules` and the gitignored operation state), and then restore in the
 * copy. That is what makes the restore assertions meaningful — the copy has the
 * committed lock and license file, and nothing else.
 */

import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall } from '../../src/kit/operations/install.js';
import { runRestore } from '../../src/kit/operations/restore.js';
import { runUpdate } from '../../src/kit/operations/update.js';
import { runResume } from '../../src/kit/operations/resume.js';
import { runCheck } from '../../src/kit/operations/inspect.js';
import { JournalStore } from '../../src/kit/journal.js';
import { acquireOperationLock } from '../../src/kit/lock.js';
import { readInstalledLock } from '../../src/kit/installed-state.js';
import { KIT_EXIT, isKitError } from '../../src/kit/errors.js';
import { FakeKitWorld, FAKE_LICENSE_KEY } from './fake-world.js';

const R0 = { version: '1.0.0', sequence: 1, releaseClass: 'feature' as const };
const R1 = {
    version: '1.1.0',
    sequence: 2,
    releaseClass: 'maintenance' as const,
    edgesFrom: ['1.0.0'],
    managed: { 'src/app/api/landing/route.ts': '// managed bridge 1.1.0\n' },
};
const R1_BREAKING = { ...R1, releaseClass: 'breaking' as const };

/** The event sink has somewhere to write; these tests do not read it. */
function silent(): void
{
    // Intentionally quiet.
}

let root: string;
let target: string;

beforeEach(() =>
{
    root = mkdtempSync(join(tmpdir(), 'spfn-kit-update-'));
    target = join(root, 'project');
});

afterEach(() =>
{
    rmSync(root, { recursive: true, force: true });
});

async function install(world: FakeKitWorld): Promise<void>
{
    const result = await runInstall({
        setupUrl: world.setupUrl,
        targetDir: target,
        readLicenseKey: async () => FAKE_LICENSE_KEY,
        json: true,
        write: silent,
    }, world.adapters);

    if (result.status !== 'completed')
    {
        throw new Error(`fixture install did not complete: ${result.code}`);
    }
}

/** What a `git clone` would give you: no node_modules, no operation state. */
function cleanClone(): string
{
    const clone = join(root, 'clone');

    cpSync(target, clone, {
        recursive: true,
        filter: source => !source.includes('node_modules') && !source.includes(join('.spfn', 'operations')),
    });

    return clone;
}

/** The scopes a child's `pnpm_config__auth` routes to the private registry. */
function routedScopes(env: Record<string, string>): string[]
{
    const [byScope] = Object.values(JSON.parse(env.pnpm_config__auth)) as object[];

    return Object.keys(byScope);
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

describe('table B — clean clone and credentials', () =>
{
    it('restores a clean clone from the committed lock and the machine credential', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        expect(existsSync(join(clone, 'node_modules'))).toBe(false);

        const result = await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters);

        expect(result.status).toBe('completed');
        expect(result.code).toBe('KIT_RESTORE_COMPLETE');
        expect(existsSync(join(clone, 'node_modules', '.installed'))).toBe(true);

        // Restore reinstalls; it does not rewrite the source it was handed.
        expect(readFileSync(join(clone, 'src/app/api/landing/route.ts'), 'utf8'))
            .toBe(readFileSync(join(target, 'src/app/api/landing/route.ts'), 'utf8'));
    });

    it('routes only the signed manifest\'s scopes to the private registry, whatever the lock lists', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();
        const lockFile = join(clone, '.spfn/kit-lock.json');
        const lock = JSON.parse(readFileSync(lockFile, 'utf8'));

        // The digest and release still match the manifest, so restore accepts
        // the lock; only its unsigned package list names one scope more.
        lock.packages.push({ ...lock.packages[0], name: '@types/node' });
        writeFileSync(lockFile, JSON.stringify(lock), 'utf8');

        const result = await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters);
        const scopes = world.childEnvironments.map(routedScopes);

        expect(result.status).toBe('completed');
        expect(scopes.at(-1)).toEqual(scopes[0]);
    });

    it('stops with KIT_CREDENTIAL_MISSING on a machine that holds no credential', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        world.credentials.items.clear();

        const result = await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters);

        expect(result.status).toBe('failed');
        expect(result.code).toBe('KIT_CREDENTIAL_MISSING');
        expect(result.next?.command).toContain('recover');
        expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    });

    it('stops with KIT_CREDENTIAL_STALE when another machine now holds the current one', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        world.faults.registryStale = true;

        const result = await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters);

        expect(result.code).toBe('KIT_CREDENTIAL_STALE');
        expect(result.exitCode).toBe(KIT_EXIT.REFUSED);
    });

    it('refuses to guess a release when the lock is unreadable', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        writeFileSync(join(clone, '.spfn', 'kit-lock.json'), '{"schemaVersion":1}\n', 'utf8');

        const failure = await failureOf(() => runRestore({ projectDir: clone, json: true, write: silent }, world.adapters));

        expect(failure.code).toBe('KIT_LOCK_INVALID');
    });

    it('leaves the checkout untouched when the catalog cannot be reached', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        world.faults.catalogUnavailable = true;

        await expect(runRestore({ projectDir: clone, json: true, write: silent }, world.adapters)).rejects.toThrow();
        expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    });

    it('refuses to restore on top of a managed file someone edited', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        writeFileSync(join(clone, '.spfn/agent-pack/agents-block.md'), '# edited by hand\n', 'utf8');

        const result = await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters);

        expect(result.code).toBe('KIT_MANAGED_DRIFT');
        expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    });

    it('reinstalls on a resume when the restored graph is gone', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        world.faults.failingGates.add('build');

        expect((await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters)).code)
            .toBe('KIT_GATE_FAILED');

        rmSync(join(clone, 'node_modules'), { recursive: true });
        world.faults.failingGates.clear();

        const resumed = await runResume({
            projectDir: clone,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed).toMatchObject({ status: 'completed', code: 'KIT_RESTORE_COMPLETE' });
        expect(existsSync(join(clone, 'node_modules', '@spfn', 'core', 'package.json'))).toBe(true);
    });

    it('stops a resumed restore on a managed file edited since its install', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);

        const clone = cleanClone();

        world.faults.failingGates.add('build');
        await runRestore({ projectDir: clone, json: true, write: silent }, world.adapters);

        writeFileSync(join(clone, 'src/app/api/landing/route.ts'), '// edited by hand\n', 'utf8');
        world.faults.failingGates.clear();

        const resumed = await runResume({
            projectDir: clone,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed).toMatchObject({
            code: 'KIT_RESUME_MISMATCH',
            evidence: { checkpoint: 'install-frozen', reason: 'managed-drift: src/app/api/landing/route.ts' },
        });
    });

    it('warns that the graph is not installed when node_modules is there and the graph is not', async () =>
    {
        const world = new FakeKitWorld();

        await install(world);
        rmSync(join(target, 'node_modules', '@spfn'), { recursive: true });

        const check = await runCheck({ projectDir: target }, world.adapters);

        expect(check.diagnostics).toContainEqual(expect.objectContaining({
            code: 'KIT_GATE_FAILED',
            summary: 'The dependency graph is not installed in this checkout.',
        }));
    });
});

describe('table C — plan', () =>
{
    it('produces a plan with a stable digest, zero customer writes and no approval for a maintenance release', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);

        const first = await runUpdate({ projectDir: target, planOnly: true, json: true, write: silent }, world.adapters);
        const second = await runUpdate({ projectDir: target, planOnly: true, json: true, write: silent }, world.adapters);

        expect(first.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(second.planDigest).toBe(first.planDigest);
        expect(first.plan?.customerWrites).toBe(0);
        expect(first.plan?.edges).toEqual(['100-to-110']);
        expect(first.plan?.requiresHumanApproval).toBe(false);
        expect(existsSync(join(target, 'node_modules', '.installed'))).toBe(true);
    });

    it('plans read-only on a drifted project but refuses to apply', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);
        writeFileSync(join(target, '.spfn/agent-pack/agents-block.md'), '# edited by hand\n', 'utf8');

        const planned = await runUpdate({ projectDir: target, planOnly: true, json: true, write: silent }, world.adapters);

        expect(planned.status).toBe('completed');

        const failure = await failureOf(() => runUpdate({ projectDir: target, json: true, write: silent }, world.adapters));

        expect(failure.code).toBe('KIT_MANAGED_DRIFT');

        const check = await runCheck({ projectDir: target }, world.adapters);

        expect(check.healthy).toBe(false);
        expect(check.diagnostics.some(diagnostic => diagnostic.code === 'KIT_MANAGED_DRIFT')).toBe(true);
    });

    it('refuses a target with no signed edge chain', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish({ version: '2.0.0', sequence: 3, releaseClass: 'feature' });

        const failure = await failureOf(() => runUpdate({
            projectDir: target,
            toRelease: '2.0.0',
            planOnly: true,
            json: true,
            write: silent,
        }, world.adapters));

        expect(failure.code).toBe('KIT_UPDATE_EDGE_MISSING');
    });

    it('refuses a release the license no longer covers', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);
        world.faults.entitled = false;

        const failure = await failureOf(() => runUpdate({ projectDir: target, planOnly: true, json: true, write: silent }, world.adapters));

        expect(failure.code).toBe('KIT_ENTITLEMENT_EXPIRED');
    });
});

describe('table D — update, approval and resume', () =>
{
    it('updates through the signed edge, rewrites the lock and commits', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);

        const result = await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        expect(result.status).toBe('completed');
        expect(result.code).toBe('KIT_UPDATE_COMPLETE');
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.1.0');
        expect(readFileSync(join(target, 'src/app/api/landing/route.ts'), 'utf8')).toBe('// managed bridge 1.1.0\n');
    });

    it('takes the dead credential line out of an .npmrc an older CLI wrote', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);

        // Exactly what a project installed before the registry session moved
        // into the child's environment carries. pnpm 10 and later refuse to
        // expand a variable in a credential that came from a project `.npmrc`,
        // so the line does nothing there but warn about a leaking secret.
        writeFileSync(join(target, '.npmrc'), [
            '@superfunction:registry=https://packages.superfunction.xyz/npm/',
            '//packages.superfunction.xyz/npm/:_authToken=${SPFN_REGISTRY_TOKEN}',
            'always-auth=true',
            '',
        ].join('\n'), 'utf8');

        expect((await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters)).status)
            .toBe('completed');

        const npmrc = readFileSync(join(target, '.npmrc'), 'utf8');

        expect(npmrc).toContain('@superfunction:registry=');
        expect(npmrc).not.toMatch(/_auth/i);
        expect(npmrc).not.toContain('${');
    });

    it('is an idempotent no-op when the project is already on the target release', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);
        await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        const again = await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        expect(again.status).toBe('completed');
        expect(again.code).toBe('KIT_UPDATE_NOT_NEEDED');
        expect(again.exitCode).toBe(KIT_EXIT.OK);
    });

    it('waits for an exact plan approval on a breaking release and writes nothing', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1_BREAKING);

        const waiting = await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        expect(waiting.status).toBe('waiting');
        expect(waiting.exitCode).toBe(KIT_EXIT.INPUT_REQUIRED);
        expect(waiting.next?.requiresHumanApproval).toBe(true);
        expect(waiting.next?.approvalDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.0.0');
        expect(new JournalStore(target, { now: () => world.now() }).readActive()?.status).toBe('waiting-approval');
    });

    it('refuses an approval digest that belongs to a different plan', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1_BREAKING);

        const result = await runUpdate({
            projectDir: target,
            approvedPlanDigest: `sha256:${'0'.repeat(64)}`,
            json: true,
            write: silent,
        }, world.adapters);

        expect(result.status).toBe('waiting');
        expect(result.evidence?.reason).toBe('approval-mismatch');
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.0.0');
    });

    it('proceeds once the exact digest is approved', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1_BREAKING);

        const planned = await runUpdate({ projectDir: target, planOnly: true, json: true, write: silent }, world.adapters);
        const result = await runUpdate({
            projectDir: target,
            approvedPlanDigest: planned.planDigest,
            json: true,
            write: silent,
        }, world.adapters);

        expect(result.status).toBe('completed');
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.1.0');
    });

    it('refuses a second update while another operation is open', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1_BREAKING);
        await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        acquireOperationLock({
            root: target,
            operationId: 'op-20260817000000-update-other',
            command: 'kit update',
            now: world.now(),
            activeJournal: null,
            isProcessAlive: () => true,
        });

        const failure = await failureOf(() => runUpdate({ projectDir: target, json: true, write: silent }, world.adapters));

        expect(failure.code).toBe('KIT_OPERATION_ACTIVE');
    });

    it('refuses to start on a dirty worktree', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);
        world.faults.gitDirty = true;

        const failure = await failureOf(() => runUpdate({ projectDir: target, json: true, write: silent }, world.adapters));

        expect(failure.code).toBe('KIT_WORKTREE_DIRTY');
    });

    it('applies only the pending migrations on a resume, and stops if the database disagrees', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish({ ...R1, withMigrations: true });

        world.faults.databasePending = ['0002_landing'];
        world.faults.migrationFails = true;

        const failed = await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        expect(failed.code).toBe('KIT_MIGRATION_FAILED');
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.0.0');

        world.faults.migrationFails = false;

        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed.status).toBe('completed');
        expect(readInstalledLock(join(target, '.spfn', 'kit-lock.json'))?.release).toBe('1.1.0');
    });

    it('stops with KIT_RESUME_MISMATCH when the journal says migrated and the database does not', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish({ ...R1, withMigrations: true });

        world.faults.failingGates.add('build');

        const failed = await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters);

        expect(failed.code).toBe('KIT_GATE_FAILED');

        // The database gained work after the checkpoint said it had none.
        world.faults.failingGates.clear();
        world.faults.databasePending = ['0003_added_behind_our_back'];

        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed.status).toBe('failed');
        expect(resumed.code).toBe('KIT_RESUME_MISMATCH');
        expect(resumed.evidence?.checkpoint).toBe('migration-applied');
    });

    it('reinstalls the target graph on a resume when it is gone, and completes', async () =>
    {
        const world = new FakeKitWorld({ releases: [R0] });

        await install(world);
        world.publish(R1);
        world.faults.failingGates.add('build');

        expect((await runUpdate({ projectDir: target, json: true, write: silent }, world.adapters)).code)
            .toBe('KIT_GATE_FAILED');

        rmSync(join(target, 'node_modules'), { recursive: true });
        world.faults.failingGates.clear();

        const resumed = await runResume({
            projectDir: target,
            readLicenseKey: async () => FAKE_LICENSE_KEY,
            json: true,
            write: silent,
        }, world.adapters);

        expect(resumed).toMatchObject({ status: 'completed', code: 'KIT_UPDATE_COMPLETE' });
        expect(existsSync(join(target, 'node_modules', '@spfn', 'core', 'package.json'))).toBe(true);
    });
});
