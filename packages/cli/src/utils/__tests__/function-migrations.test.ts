import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    applyFunctionMigrationPlan,
    readMigrationEntries,
    type FunctionMigrationPlan,
    type MigrationDb,
} from '../function-migrations.js';

function pgliteDb(client: PGlite): MigrationDb
{
    const statusDb = drizzle({ client });

    return {
        query: async (text, params) =>
            (await client.query(text, params as unknown[])).rows as Record<string, unknown>[],
        execute: query => statusDb.execute(query),
        transaction: fn => client.transaction(tx => fn({
            query: async (text, params) =>
                (await tx.query(text, params as unknown[])).rows as Record<string, unknown>[],
        })) as Promise<never>,
    };
}

function makePlan(entries: FunctionMigrationPlan['entries']): FunctionMigrationPlan
{
    return {
        packageName: '@spfn/testpkg',
        migrationsDir: '/unused',
        packagePath: '/unused',
        entries,
    };
}

describe('readMigrationEntries', () =>
{
    let dir: string | undefined;

    afterEach(() =>
    {
        if (dir)
        {
            rmSync(dir, { recursive: true, force: true });
            dir = undefined;
        }
    });

    it('reads the drizzle-kit ≤0.31 journal layout in idx order', () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-fnmig-'));
        mkdirSync(join(dir, 'meta'));
        writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
            version: '7',
            entries: [
                { idx: 1, when: 2000, tag: '0001_second' },
                { idx: 0, when: 1000, tag: '0000_first' },
            ],
        }));
        writeFileSync(join(dir, '0000_first.sql'), 'CREATE TABLE a (id int);\n--> statement-breakpoint\nCREATE TABLE b (id int);');
        writeFileSync(join(dir, '0001_second.sql'), 'CREATE TABLE c (id int);');

        const entries = readMigrationEntries(dir, '@spfn/testpkg');

        expect(entries.map(e => e.name)).toEqual(['0000_first', '0001_second']);
        expect(entries.map(e => e.millis)).toEqual([1000, 2000]);
        expect(entries[0]?.statements).toEqual([
            'CREATE TABLE a (id int);',
            'CREATE TABLE b (id int);',
        ]);
        expect(entries[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('reads the drizzle-kit 1.0 folder layout with UTC timestamps', () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-fnmig-'));
        mkdirSync(join(dir, '20260102030405_second'));
        mkdirSync(join(dir, '20260101000000_first'));
        writeFileSync(join(dir, '20260102030405_second', 'migration.sql'), 'CREATE TABLE b (id int);');
        writeFileSync(join(dir, '20260101000000_first', 'migration.sql'), 'CREATE TABLE a (id int);');

        const entries = readMigrationEntries(dir, '@spfn/testpkg');

        expect(entries.map(e => e.name)).toEqual(['20260101000000_first', '20260102030405_second']);
        expect(entries[0]?.millis).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
        expect(entries[1]?.millis).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    });

    it('fails when a journal entry has no SQL file', () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-fnmig-'));
        mkdirSync(join(dir, 'meta'));
        writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({
            entries: [{ idx: 0, when: 1000, tag: '0000_missing' }],
        }));

        expect(() => readMigrationEntries(dir!, '@spfn/testpkg'))
            .toThrow('@spfn/testpkg: migration file not found: 0000_missing.sql');
    });

    it('fails on an unparseable journal', () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-fnmig-'));
        mkdirSync(join(dir, 'meta'));
        writeFileSync(join(dir, 'meta', '_journal.json'), 'not json');

        expect(() => readMigrationEntries(dir!, '@spfn/testpkg'))
            .toThrow('@spfn/testpkg: invalid migration journal');
    });

    it('fails on a 1.0-layout folder without a leading timestamp', () =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-fnmig-'));
        mkdirSync(join(dir, 'not-a-timestamp'));
        writeFileSync(join(dir, 'not-a-timestamp', 'migration.sql'), 'CREATE TABLE a (id int);');

        expect(() => readMigrationEntries(dir!, '@spfn/testpkg'))
            .toThrow('@spfn/testpkg: migration folder name must start with a YYYYMMDDHHMMSS timestamp');
    });
});

describe('applyFunctionMigrationPlan', () =>
{
    let client: PGlite | undefined;

    afterEach(async () =>
    {
        await client?.close();
        client = undefined;
    });

    it('applies pending migrations once and records them', async () =>
    {
        client = new PGlite();
        const db = pgliteDb(client);
        const plan = makePlan([
            { name: '0000_first', millis: 1000, hash: 'hash-a', statements: ['CREATE TABLE fn_a (id int)'] },
            { name: '0001_second', millis: 2000, hash: 'hash-b', statements: ['CREATE TABLE fn_b (id int)'] },
        ]);

        expect(await applyFunctionMigrationPlan(db, plan)).toBe(2);
        expect(await applyFunctionMigrationPlan(db, plan)).toBe(0);

        const records = await db.query(
            'SELECT hash, created_at FROM drizzle."__spfn_fn_testpkg_migrations" ORDER BY id',
        );
        expect(records.map(r => r.hash)).toEqual(['hash-a', 'hash-b']);

        const tables = await db.query(
            `SELECT table_name FROM information_schema.tables WHERE table_name IN ('fn_a', 'fn_b')`,
        );
        expect(tables).toHaveLength(2);
    });

    it('continues from records written by the previous drizzle-based runner', async () =>
    {
        client = new PGlite();
        const db = pgliteDb(client);

        // Simulate a database migrated by drizzle-orm ≤0.45 (hash + created_at rows)
        await db.query('CREATE SCHEMA IF NOT EXISTS drizzle');
        await db.query(
            `CREATE TABLE drizzle."__spfn_fn_testpkg_migrations" (
                id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
            )`,
        );
        await db.query(
            `INSERT INTO drizzle."__spfn_fn_testpkg_migrations" (hash, created_at) VALUES ($1, $2)`,
            ['hash-a', 1000],
        );

        const plan = makePlan([
            { name: '0000_first', millis: 1000, hash: 'hash-a', statements: ['CREATE TABLE fn_a (id int)'] },
            { name: '0001_second', millis: 2000, hash: 'hash-b', statements: ['CREATE TABLE fn_b (id int)'] },
        ]);

        expect(await applyFunctionMigrationPlan(db, plan)).toBe(1);

        const tables = await db.query(
            `SELECT table_name FROM information_schema.tables WHERE table_name IN ('fn_a', 'fn_b')`,
        );
        expect(tables.map(t => t.table_name)).toEqual(['fn_b']);
    });

    it('rolls back the batch when a statement fails', async () =>
    {
        client = new PGlite();
        const db = pgliteDb(client);
        const plan = makePlan([
            { name: '0000_first', millis: 1000, hash: 'hash-a', statements: ['CREATE TABLE fn_a (id int)'] },
            { name: '0001_broken', millis: 2000, hash: 'hash-b', statements: ['CREATE TABLE fn_a (id int)'] },
        ]);

        await expect(applyFunctionMigrationPlan(db, plan)).rejects.toThrow();

        const records = await db.query(
            'SELECT hash FROM drizzle."__spfn_fn_testpkg_migrations"',
        );
        expect(records).toHaveLength(0);

        const tables = await db.query(
            `SELECT table_name FROM information_schema.tables WHERE table_name = 'fn_a'`,
        );
        expect(tables).toHaveLength(0);
    });
});
