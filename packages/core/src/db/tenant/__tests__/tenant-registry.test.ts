/**
 * tenantKey() and the tenant registry
 *
 * Pins the drizzle 1.0.0-rc.4 behaviour the registry depends on — the column
 * build step runs once per table and an alias column forwards `config` — and
 * row 36 of the w-h3adm design case table: a table without tenantKey() is left
 * exactly as before.
 */

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { alias, bigint, getTableConfig, pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { foreignKey, id, tenantKey, timestamps } from '../../schema';
import { findTenantColumn, listTenantTables } from '../registry';

const schema = pgSchema('spfn_registry_test');

const projects = schema.table('projects', {
    id: id(),
    tenantId: tenantKey(),
    name: text('name'),
});

const tasks = schema.table('tasks', {
    id: id(),
    workspaceId: tenantKey('workspace_id'),
    projectId: foreignKey('project', () => projects.id),
});

const users = pgTable('registry_users', {
    id: id(),
    email: text('email'),
    ...timestamps(),
});

describe('tenantKey()', () =>
{
    it('declares a not-null bigint with no default', () =>
    {
        const column = getTableConfig(projects).columns.find((candidate) => candidate.name === 'tenant_id');

        expect(column?.getSQLType()).toBe('bigint');
        expect(column?.notNull).toBe(true);
        expect(column?.hasDefault).toBe(false);
    });

    it('registers the table with its schema and column name', () =>
    {
        expect(listTenantTables()).toEqual(expect.arrayContaining([
            { schema: 'spfn_registry_test', name: 'projects', columnName: 'tenant_id' },
            { schema: 'spfn_registry_test', name: 'tasks', columnName: 'workspace_id' },
        ]));
    });

    it('finds the tenant column by its property key', () =>
    {
        expect(findTenantColumn(projects)?.key).toBe('tenantId');
        expect(findTenantColumn(tasks)?.key).toBe('workspaceId');
    });

    it('finds the tenant column through an alias, qualified by the alias', () =>
    {
        const other = alias(projects, 'other');
        const ref = findTenantColumn(other);

        expect(ref?.key).toBe('tenantId');
        expect(drizzle.mock().select().from(other).where(eq(ref!.column, 1)).toSQL().sql)
            .toMatch(/"other"\."tenant_id" = \$1/);
    });

    it('refuses a second tenant column on one table', () =>
    {
        expect(() => schema.table('twice', { a: tenantKey('a'), b: tenantKey('b') }))
            .toThrow(/more than one tenantKey\(\) column/);
    });

    it('finds nothing for subqueries or raw values', () =>
    {
        expect(findTenantColumn(drizzle.mock().select().from(projects).as('sq'))).toBeUndefined();
        expect(findTenantColumn(undefined)).toBeUndefined();
    });
});

describe('row 36: a table without tenantKey()', () =>
{
    it('is not registered and has no tenant column', () =>
    {
        expect(findTenantColumn(users)).toBeUndefined();
        expect(listTenantTables().some((table) => table.name === 'registry_users')).toBe(false);
    });

    it('keeps the columns the existing helpers declare', () =>
    {
        const columns = getTableConfig(users).columns.map((column) => [column.name, column.getSQLType(), column.notNull]);

        expect(columns).toEqual([
            ['id', 'bigserial', true],
            ['email', 'text', false],
            ['created_at', 'timestamp with time zone', true],
            ['updated_at', 'timestamp with time zone', true],
        ]);
    });

    it('keeps a plain bigint column unregistered even when it is named tenant_id', () =>
    {
        const legacy = pgTable('registry_legacy', { tenantId: bigint('tenant_id', { mode: 'number' }) });

        expect(findTenantColumn(legacy)).toBeUndefined();
    });
});
