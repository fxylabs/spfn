/**
 * push-identity admits the schemas drizzle-kit's push admits (spfn/spfn#173)
 *
 * drizzle-kit reads `schemaFilter` with the minimatch it bundles; push-identity
 * reads it with the CLI's own. Each row creates schemas in an in-memory
 * PostgreSQL (PGlite), declares none, and compares the schemas drizzle-kit's
 * push would drop with those existingObjects admits, so a matcher that reads
 * a glob otherwise than drizzle-kit's fails here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { existingObjects } from '../utils/push-identity.js';

const SCHEMAS = ['app', 'apps', 'App', '.app', 'app.x', 'spfn_auth', 'spfn_cms', 'spfn_'];

const FILTERS = [
    ['app'],
    ['*'],
    ['spfn_*'],
    ['spfn_*', '!spfn_cms'],
    ['!app'],
    ['app?', 'spfn_[ac]*'],
    ['{app,spfn_cms}'],
    ['@(app|apps)'],
    ['.*'],
];

describe('existingObjects', () =>
{
    let client: PGlite;

    beforeAll(async () =>
    {
        client = new PGlite();
        await client.waitReady;
        for (const schema of SCHEMAS)
        {
            await client.exec(`CREATE SCHEMA "${schema}"`);
        }
    });

    afterAll(async () =>
    {
        await client.close();
    });

    it.each(FILTERS)('schemaFilter %j admits the schemas drizzle-kit\'s push admits', async (...schemaFilter) =>
    {
        const { pushSchema } = await import('drizzle-kit/api-postgres');
        const db = drizzle({ client });
        const { sqlStatements } = await pushSchema({}, db, { schemas: schemaFilter, tables: [], entities: undefined, extensions: [] });
        const dropped = sqlStatements.flatMap(statement => /^DROP SCHEMA "([^"]+)"/.exec(statement)?.[1] ?? []);
        const admitted = (await existingObjects(db, {}, schemaFilter)).filter(object => object.entityType === 'schemas').map(object => object.name);

        expect(admitted.sort()).toEqual(dropped.sort());
    });
});
