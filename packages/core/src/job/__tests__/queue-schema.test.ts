/**
 * The queue migration SQL (#171) — no database
 *
 * - M1 a queue schema older than pg-boss's first migration start: pg-boss
 *   itself returns that start's plan for it (`getMigrationPlans` filters
 *   `previous >= from`), which would run on a schema it was not written for.
 * - N1 (i171af4, rv432d N-b) a schema name pg-boss's unquoted SQL folds to
 *   another schema (`Queue` → `queue`) read from the catalog: absent, so
 *   pg-boss may be installed — where its install would create another
 *   schema than the one read.
 * - N2 (i171af5, rv432e F2) a schema name pg-boss's unquoted SQL breaks on —
 *   a PostgreSQL keyword other than an unreserved one (`select`, `left`,
 *   `between`), or `pg_…` — read from the catalog as absent, so pg-boss may
 *   be installed, and accepted as the declared queue schema: the install
 *   then fails on it.
 * - N3 (i171af6) the same names given to `queueInstallSql` or
 *   `queueMigrationSql`: pg-boss's own check takes them, so the SQL comes
 *   back, for another schema than the one named (`Queue`) or one PostgreSQL
 *   refuses (`select`, `pg_queue`), instead of `QueueSchemaNameError`.
 */

import { describe, expect, it } from 'vitest';
import PgBoss from 'pg-boss';

import type { CatalogDb } from '../../db';
import { QUEUE_SCHEMA_VERSION, QueueSchemaNameError, QueueSchemaVersionError, queueInstallSql, queueMigrationSql, readQueueSchemaState } from '../queue-schema';

describe('queueMigrationSql', () =>
{
    it('M1 refuses a version older than pg-boss migrates from, naming both, where pg-boss returns a plan', () =>
    {
        expect(PgBoss.getMigrationPlans('spfn_queue', '24')).toContain('CREATE OR REPLACE FUNCTION spfn_queue.create_queue');
        expect(() => queueMigrationSql('spfn_queue', 24)).toThrow(QueueSchemaVersionError);
        expect(() => queueMigrationSql('spfn_queue', 24)).toThrow(new RegExp(`version 24; pg-boss \\S+ needs ${QUEUE_SCHEMA_VERSION}`));
    });

    it('N3 queueInstallSql and queueMigrationSql refuse a name pg-boss\'s SQL folds or breaks on', () =>
    {
        for (const schema of ['Queue', 'select', 'pg_queue'])
        {
            expect(() => queueInstallSql(schema)).toThrow(QueueSchemaNameError);
            expect(() => queueMigrationSql(schema, QUEUE_SCHEMA_VERSION - 1)).toThrow(QueueSchemaNameError);
        }
    });
});

describe('readQueueSchemaState', () =>
{
    const unread: CatalogDb = {
        execute: async () =>
        {
            throw new Error('the catalog was read');
        },
    };

    it('N1 refuses a name pg-boss\'s SQL folds to another schema before it reads the catalog', async () =>
    {
        await expect(readQueueSchemaState(unread, 'Queue')).rejects.toThrow(QueueSchemaNameError);
    });

    it('N2 refuses a keyword pg-boss\'s SQL breaks on, reserved, type or function name, or column name, and a pg_ name, before it reads the catalog', async () =>
    {
        for (const schema of ['select', 'left', 'between', 'pg_queue'])
        {
            await expect(readQueueSchemaState(unread, schema)).rejects.toThrow(QueueSchemaNameError);
        }
    });
});
