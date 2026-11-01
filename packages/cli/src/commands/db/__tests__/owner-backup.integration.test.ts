/**
 * Backup and restore of a row-level security table — row O4 of the #158 part 2
 * design case table
 *
 * Runs the real `pg_dump` and `pg_restore` through `spfn db backup` and
 * `spfn db restore`. The owner is TEST_DATABASE_URL (the core package's test
 * database by default); the app role is TEST_APP_DATABASE_URL, or the other of
 * the two non-superuser roles scripts/test-services.sh creates. Skips when the
 * database or the PostgreSQL client tools are not available.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { appUrl, OWNER_URL } from './helpers/test-database';

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));
vi.mock('prompts', () => ({ default: vi.fn(async () => ({ confirm: true })) }));

const { dbBackup } = await import('../backup');
const { dbRestore } = await import('../restore');

const SCHEMA = 'spfn_cli_owner_o4';

function hasClientTools(): boolean
{
    return ['pg_dump', 'pg_restore'].every((tool) =>
    {
        try
        {
            execFileSync(tool, ['--version'], { stdio: 'ignore' });

            return true;
        }
        catch
        {
            return false;
        }
    });
}

describe('backup and restore through the owner connection (integration)', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const appRole = decodeURIComponent(new URL(appUrl()).username);
    const originalCwd = process.cwd();
    let workDir = '';
    let available = false;

    beforeAll(async () =>
    {
        available = hasClientTools() && await owner`select 1`.then(() => true, () => false);

        if (!available) return;

        await owner.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await owner.unsafe(`CREATE SCHEMA ${SCHEMA}`);
        await owner.unsafe(`CREATE TABLE ${SCHEMA}.notes (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL, title text NOT NULL)`);
        await owner.unsafe(`ALTER TABLE ${SCHEMA}.notes ENABLE ROW LEVEL SECURITY`);
        await owner.unsafe(`CREATE POLICY notes_tenant_isolation ON ${SCHEMA}.notes
            USING (tenant_id = current_setting('app.tenant_id')::bigint)
            WITH CHECK (tenant_id = current_setting('app.tenant_id')::bigint)`);
        await owner.unsafe(`INSERT INTO ${SCHEMA}.notes (tenant_id, title) VALUES (7, 'a'), (7, 'b'), (9, 'c')`);
        await owner.unsafe(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${appRole}`);
        await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${appRole}`);
        // SELECT too, beyond the app's USAGE, so that row-level security is the
        // one reason left for pg_dump to refuse the app role
        await owner.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${appRole}`);

        // Backups land in ./backups and the commands touch ./.gitignore: give them
        // a directory of their own inside the package's ignored cache.
        mkdirSync(join(originalCwd, 'node_modules', '.cache'), { recursive: true });
        workDir = mkdtempSync(join(originalCwd, 'node_modules', '.cache', 'spfn-owner-backup-'));
        process.chdir(workDir);
        process.env.DATABASE_URL = appUrl();
    });

    afterAll(async () =>
    {
        process.chdir(originalCwd);
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;

        if (available)
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
            rmSync(workDir, { recursive: true, force: true });
        }

        await owner.end();
        vi.restoreAllMocks();
    });

    it('O4 a policy table backed up through the owner URL restores into an emptied schema with the same rows', async () =>
    {
        if (!available) return;

        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const file = join(workDir, 'o4.dump');

        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        // As the app role — a role the policy applies to — pg_dump refuses
        await expect(dbBackup({ format: 'custom', schema: SCHEMA, output: join(workDir, 'as-app.dump') })).rejects.toThrow('exit 1');
        expect(errors.mock.calls.flat().join('\n')).toMatch(/row-level security/);

        process.env.DATABASE_OWNER_URL = OWNER_URL;

        await dbBackup({ format: 'custom', schema: SCHEMA, output: file });
        await owner.unsafe(`DROP SCHEMA ${SCHEMA} CASCADE`);
        await dbRestore(file);

        const [{ rows }] = await owner.unsafe(`select count(*)::int as rows from ${SCHEMA}.notes`);
        const [{ rls }] = await owner.unsafe(`select relrowsecurity as rls from pg_class where oid = '${SCHEMA}.notes'::regclass`);
        const policies = await owner.unsafe(`select policyname from pg_policies where schemaname = '${SCHEMA}'`);

        expect(rows).toBe(3);
        expect(rls).toBe(true);
        expect(policies.map((policy) => policy.policyname)).toEqual(['notes_tenant_isolation']);
        expect(exit).toHaveBeenCalledTimes(1);
    });
});
