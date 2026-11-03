/**
 * `spfn db tenant export` / `import` over a `visibleTo` membership table and a
 * `visibleThrough` tenant list — rows C1–C2 of the #162 design case table
 *
 * The export and the import find tenant tables by the tenant column marker and
 * set `app.tenant_id` only (#162 design 4-5), so a membership table is one more
 * tenant table and the tenant list stays out, as before. Same database harness
 * as tenant-export.integration.test.ts; skips without a database, except in CI.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { appUrl, OWNER_URL, requireDatabase } from './helpers/test-database';
import { createSchema, createTenantFixtures, seed, seedMembers } from './helpers/tenant-fixtures';

vi.mock('@spfn/core/server', () => ({ loadEnv: vi.fn() }));

const { exportTenant } = await import('../tenant/export');
const { importTenant, prepareImport } = await import('../tenant/import');
const { buildTenantPlan } = await import('../tenant/plan');

const SCHEMA = 'spfn_cli_tenant_members';

const fixtures = createTenantFixtures(SCHEMA, { members: true });
const plan = buildTenantPlan(fixtures.imports);

describe('spfn db tenant export and import with a visibleTo table (integration)', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const appRole = decodeURIComponent(new URL(appUrl()).username);
    const originalCwd = process.cwd();
    let available = false;
    let workDir = '';

    const memberships = async () => (await owner.unsafe(`select id, tenant_id, user_id, status from ${SCHEMA}.members order by id`))
        .map((row) => `${row.id}:${row.tenant_id}:${row.user_id}:${row.status}`);

    beforeAll(async () =>
    {
        available = await requireDatabase(owner, 'tenant members integration tests');
    });

    beforeEach(async () =>
    {
        mkdirSync(join(originalCwd, 'node_modules', '.cache'), { recursive: true });
        workDir = mkdtempSync(join(originalCwd, 'node_modules', '.cache', 'spfn-tenant-members-'));
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        if (!available) return;

        await createSchema(owner, fixtures, appRole);
        await seed(owner, SCHEMA);
        await seedMembers(owner, SCHEMA);
    });

    afterEach(() =>
    {
        rmSync(workDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    afterAll(async () =>
    {
        if (available)
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        }

        await owner.end();
    });

    it('C1 exporting tenant 7 writes the members of workspace 7 only, and no workspaces file', async () =>
    {
        expect(plan.tables.map((table) => table.name)).toContain('members');
        expect(plan.tables.map((table) => table.name)).not.toContain('workspaces');

        if (!available) return;

        const directory = join(workDir, 'export');
        const manifest = await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });

        expect(manifest.tables.find((table) => table.name === 'members')?.rows).toBe(2);
        expect(readdirSync(directory).some((file) => file.includes('workspaces'))).toBe(false);
    });

    it('C2 import --replace swaps workspace 7\'s memberships for the file\'s; 9 and 11 keep theirs', async () =>
    {
        if (!available) return;

        const directory = join(workDir, 'export');

        await exportTenant({ tenantId: 7, plan, url: appUrl(), directory });
        await owner.unsafe(`DELETE FROM ${SCHEMA}.members WHERE tenant_id = 7 AND user_id = 5`);
        await owner.unsafe(`INSERT INTO ${SCHEMA}.members (tenant_id, user_id, status) VALUES (7, 8, 'invited'), (9, 8, 'active')`);
        await importTenant(await prepareImport(directory, plan), { url: OWNER_URL, replace: true });

        expect(await memberships()).toEqual(['1:7:3:active', '2:9:3:active', '3:7:5:active', '4:11:3:invited', '102:9:8:active']);
    });
});
