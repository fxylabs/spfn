/**
 * Tenancy options — rows P1–P9 and D1–D9 of the #159/#160 design case table
 *
 * P: `defineTenancy({ property })` names the tenant column's property key (#159).
 * D: `tenancy.reference(..., { onDelete })` chooses the composite foreign key's
 *    delete action (#160).
 *
 * The SQL drizzle-kit generates is the contract, as in tenancy-schema.test.ts.
 * No database needed.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { index, pgSchema, text } from 'drizzle-orm/pg-core';
import { id } from '../../schema';
import { defineTenancy, type Tenancy, type TenancyReferenceOptions } from '../tenancy';
import { findTenantColumn } from '../registry';
import { generatedSql } from './tenancy-db';
import { authors, tenancy, workspaces } from './tenancy-fixtures';

/** The statements of `sql` that mention `needle`. */
function statementsWith(sql: string[], needle: string): string[]
{
    return sql.filter((statement) => statement.includes(needle));
}

function createTable(sql: string[], table: string): string
{
    return sql.find((statement) => statement.startsWith(`CREATE TABLE ${table} (`)) ?? '';
}

/** A tenancy over the fixture workspaces with the tenant column `workspace_id`, under the property `workspaceId`. */
function workspaceTenancy()
{
    return defineTenancy({ tenants: workspaces, authorize: () => true, column: 'workspace_id', property: 'workspaceId' });
}

describe('defineTenancy({ property }) (#159)', () =>
{
    it('P1 the tenant column is keyed by the property, and the SQL is what column alone generates', async () =>
    {
        const named = pgSchema('spfn_tenancy_p1');
        const plain = pgSchema('spfn_tenancy_p1_plain');
        const records = workspaceTenancy().table(named, 'records', { id: id(), body: text('body') });
        const plainTenancy = defineTenancy({ tenants: workspaces, authorize: () => true, column: 'workspace_id' });
        const plainRecords = plainTenancy.table(plain, 'records', { id: id(), body: text('body') });
        const sql = await generatedSql({ named, workspaces, records });
        const plainSql = await generatedSql({ plain, workspaces, plainRecords });

        expect(sql).toEqual(plainSql.map((statement) => statement.replaceAll('spfn_tenancy_p1_plain', 'spfn_tenancy_p1')));
        expect(createTable(sql, '"spfn_tenancy_p1"."records"')).toContain('"workspace_id" bigint NOT NULL');
        expectTypeOf<typeof records.$inferSelect>().toEqualTypeOf<{ id: number; workspaceId: number; body: string | null }>();
        expectTypeOf<typeof records.$inferSelect>().not.toHaveProperty('tenantId');
        expectTypeOf<typeof records.$inferInsert>().toHaveProperty('workspaceId');
        expectTypeOf<typeof records.$inferInsert>().not.toHaveProperty('tenantId');
    });

    it('P2 the registry reports the property as the tenant column\'s key, which TenantRepository reads', () =>
    {
        const records = workspaceTenancy().table(pgSchema('spfn_tenancy_p2'), 'records', { id: id() });
        const ref = findTenantColumn(records);

        expect(ref?.key).toBe('workspaceId');
        expect(ref?.column.name).toBe('workspace_id');
    });

    it('P3 extra config reaches the tenant column through the property', async () =>
    {
        const schema = pgSchema('spfn_tenancy_p3');
        const records = workspaceTenancy().table(schema, 'records', { id: id() },
            (t) => [index('records_workspace_id_idx').on(t.workspaceId, t.id)]);
        const sql = await generatedSql({ schema, workspaces, records });

        expect(sql).toContain('CREATE INDEX "records_workspace_id_idx" ON "spfn_tenancy_p3"."records" ("workspace_id","id");');
    });

    it('P4 a reference between tables of the tenancy uses the tenant column on both sides', async () =>
    {
        const schema = pgSchema('spfn_tenancy_p4');
        const custom = workspaceTenancy();
        const folders = custom.table(schema, 'folders', { id: id() });
        const files = custom.table(schema, 'files', { id: id(), folderId: custom.reference('folder', () => folders) });
        const sql = await generatedSql({ schema, workspaces, folders, files });

        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_p4"."files" ADD CONSTRAINT "files_folder_fk" FOREIGN KEY ("workspace_id","folder_id") '
            + 'REFERENCES "spfn_tenancy_p4"."folders"("workspace_id","id") ON DELETE CASCADE;',
        );
        expect(statementsWith(sql, 'FOREIGN KEY ("folder_id")')).toEqual([]);
    });

    it('P5 declaring a column under the property throws, a reference included', () =>
    {
        const schema = pgSchema('spfn_tenancy_p5');
        const custom = workspaceTenancy();
        const folders = custom.table(schema, 'folders', { id: id() });

        expect(() => custom.table(schema, 'a', { id: id(), workspaceId: text('other') }))
            .toThrow('declares "workspaceId"; the tenant column "workspace_id" is added by tenancy.table');
        expect(() => custom.table(schema, 'b', { id: id(), workspaceId: custom.reference('folder', () => folders) }))
            .toThrow('declares "workspaceId"');
    });

    it('P6 a column keyed tenantId is an ordinary column when the property is another name', async () =>
    {
        const schema = pgSchema('spfn_tenancy_p6');
        const records = workspaceTenancy().table(schema, 'records', { id: id(), tenantId: text('legacy_tenant_code') });
        const sql = await generatedSql({ schema, workspaces, records });
        const table = createTable(sql, '"spfn_tenancy_p6"."records"');

        expect(table).toContain('"workspace_id" bigint NOT NULL');
        expect(table).toContain('"legacy_tenant_code" text');
        expect(findTenantColumn(records)?.key).toBe('workspaceId');
        expectTypeOf<typeof records.$inferSelect>()
            .toEqualTypeOf<{ id: number; workspaceId: number; tenantId: string | null }>();
    });

    it('P7 an empty, non-string or "id" property throws', () =>
    {
        const message = 'defineTenancy({ property }) takes a non-empty property name other than "id"';

        expect(() => defineTenancy({ tenants: workspaces, authorize: () => true, property: '' })).toThrow(message);
        expect(() => defineTenancy({ tenants: workspaces, authorize: () => true, property: 42 as never })).toThrow(message);
        expect(() => defineTenancy({ tenants: workspaces, authorize: () => true, property: 'id' })).toThrow(message);
    });

    it('P8 without property the tenant column stays tenantId', () =>
    {
        expect(findTenantColumn(authors)?.key).toBe('tenantId');
        expectTypeOf(tenancy).toEqualTypeOf<Tenancy<'tenantId'>>();
        expectTypeOf<typeof authors.$inferSelect>().toHaveProperty('tenantId');
    });

    it('P9 two tenancies that differ only in property are one tenancy to a reference', async () =>
    {
        const schema = pgSchema('spfn_tenancy_p9');
        const keyed = workspaceTenancy();
        const plain = defineTenancy({ tenants: workspaces, authorize: () => true, column: 'workspace_id' });
        const folders = keyed.table(schema, 'folders', { id: id() });
        const files = plain.table(schema, 'files', { id: id(), folderId: plain.reference('folder', () => folders) });
        const sql = await generatedSql({ schema, workspaces, folders, files });

        expect(sql).toContain(
            'ALTER TABLE "spfn_tenancy_p9"."files" ADD CONSTRAINT "files_folder_fk" FOREIGN KEY ("workspace_id","folder_id") '
            + 'REFERENCES "spfn_tenancy_p9"."folders"("workspace_id","id") ON DELETE CASCADE;',
        );
    });
});

describe('tenancy.reference({ onDelete }) (#160)', () =>
{
    const D = '"spfn_tenancy_d"';
    const schema = pgSchema('spfn_tenancy_d');
    const targets = tenancy.table(schema, 'targets', { id: id() });
    const links = tenancy.table(schema, 'links', {
        id: id(),
        d1: tenancy.reference('d1', () => targets),
        d2: tenancy.reference('d2', () => targets, { onDelete: 'restrict' }),
        d3: tenancy.reference('d3', () => targets, { onDelete: 'no action' }),
        d4: tenancy.reference('d4', () => targets, { onDelete: 'cascade' }),
        d5: tenancy.reference('d5', () => targets, { optional: true }),
        d6: tenancy.reference('d6', () => targets, { optional: true, onDelete: 'cascade' }),
        d7: tenancy.reference('d7', () => targets, { optional: true, onDelete: 'restrict' }),
    });
    const sqlOf = () => generatedSql({ schema, workspaces, targets, links });

    /** The foreign key statement of reference `name` on `links`, up to its ON DELETE clause. */
    const foreignKey = (name: string, action: string) =>
        `ALTER TABLE ${D}."links" ADD CONSTRAINT "links_${name}_fk" FOREIGN KEY ("tenant_id","${name}_id") `
        + `REFERENCES ${D}."targets"("tenant_id","id")${action};`;

    it.each([
        ['D1', 'd1', 'NOT NULL', ' ON DELETE CASCADE', 'a required reference without onDelete cascades'],
        ['D2', 'd2', 'NOT NULL', ' ON DELETE RESTRICT', 'a required reference with restrict'],
        ['D3', 'd3', 'NOT NULL', '', 'a required reference with no action has no ON DELETE clause'],
        ['D4', 'd4', 'NOT NULL', ' ON DELETE CASCADE', 'a required reference with cascade spelled out'],
        ['D5', 'd5', 'nullable', '', 'an optional reference without onDelete has no ON DELETE clause'],
        ['D6', 'd6', 'nullable', ' ON DELETE CASCADE', 'an optional reference with cascade'],
        ['D7', 'd7', 'nullable', ' ON DELETE RESTRICT', 'an optional reference with restrict'],
    ])('%s %s: %s column, foreign key%s (%s)', async (_row, name, nullability, action) =>
    {
        const sql = await sqlOf();
        const column = `"${name}_id" bigint${nullability === 'NOT NULL' ? ' NOT NULL' : ''},`;

        expect(createTable(sql, `${D}."links"`)).toContain(column);
        expect(sql).toContain(foreignKey(name, action));
    });

    it('D8 an onDelete outside cascade, restrict and no action throws at the reference', () =>
    {
        for (const onDelete of ['set null', 'set default', 'CASCADE', 42])
        {
            expect(() => tenancy.reference('bad', () => targets, { onDelete: onDelete as never }))
                .toThrow(`tenancy.reference('bad') takes onDelete 'cascade', 'restrict' or 'no action', received ${JSON.stringify(onDelete)}`);
        }
    });

    it('D9 onDelete is typed as the three actions only', () =>
    {
        expectTypeOf<TenancyReferenceOptions['onDelete']>().toEqualTypeOf<'cascade' | 'restrict' | 'no action' | undefined>();
        expectTypeOf<{ onDelete: 'set null' }>().not.toExtend<TenancyReferenceOptions>();
        expectTypeOf<{ optional: true; onDelete: 'set default' }>().not.toExtend<TenancyReferenceOptions>();
    });
});
