/**
 * `spfn db push` says which checks it leaves as they are (spfn/spfn#167)
 *
 * drizzle-kit's push never alters a check whose expression changed. Each row
 * pushes a schema into an in-memory PostgreSQL (PGlite) through the same
 * resolvePushPlan push uses, applies it, then plans the next schema.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgSchema, varchar } from 'drizzle-orm/pg-core';
import { enumCheck, enumText } from '@spfn/core/db';

import { resolvePushPlan } from '../push.js';
import { unchangedChecks } from '../utils/unchanged-checks.js';
import { displayUnchangedChecks } from '../utils/push-display.js';

const SCHEMA = 'i167';
const schema = pgSchema(SCHEMA);

function posts(values: readonly [string, ...string[]])
{
    return schema.table('posts', {
        postStatus: enumText('post_status', values).notNull(),
        kind: varchar('kind', { length: 16 }),
    }, (t) => [enumCheck(t.postStatus, values), enumCheck(t.kind, ['x', 'y'])]);
}

let client: PGlite;

/** The statements push plans for `table`, and the checks it warns about */
async function plan(table: ReturnType<typeof posts>)
{
    const { statements, unchangedChecks: unchanged } = await resolvePushPlan({ schema, posts: table }, drizzle({ client }), [SCHEMA]);

    return { statements, unchanged };
}

async function push(table: ReturnType<typeof posts>)
{
    for (const statement of (await plan(table)).statements)
    {
        await client.exec(statement);
    }
}

beforeEach(async () =>
{
    client = new PGlite();
    await client.exec(`CREATE SCHEMA ${SCHEMA}`);
});

afterEach(async () =>
{
    await client.close();
});

describe('db push and changed checks', () =>
{
    it('U1: a value added to an enumCheck is not pushed, and push names the check with the remedy', async () =>
    {
        await push(posts(['a', 'b']));

        const { statements, unchanged } = await plan(posts(['a', 'b', 'c']));

        expect(statements).toEqual([]);
        expect(unchanged).toEqual([{ schema: SCHEMA, table: 'posts', name: 'posts_post_status_check', value: '"post_status" in (\'a\', \'b\', \'c\')' }]);

        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        displayUnchangedChecks(unchanged);
        const lines = log.mock.calls.map(call => String(call[0]));
        log.mockRestore();

        expect(lines.join('\n')).toContain('Check "posts_post_status_check" on "i167"."posts" differs from the one in the database; db push does not change an existing check.');
        expect(lines.join('\n')).toContain('Run spfn db generate and spfn db migrate, or drop it and push again:');
        expect(lines.join('\n')).toContain('ALTER TABLE "i167"."posts" DROP CONSTRAINT "posts_post_status_check";');
    });

    it('U2: a removed value is named too', async () =>
    {
        await push(posts(['a', 'b']));

        expect((await plan(posts(['a']))).unchanged.map(check => check.name)).toEqual(['posts_post_status_check']);
    });

    it('U3: no change, reordered values, and a varchar column (cast on both sides) are not named', async () =>
    {
        await push(posts(['a', 'b']));

        expect(await plan(posts(['a', 'b']))).toEqual({ statements: [], unchanged: [] });
        expect(await plan(posts(['b', 'a']))).toEqual({ statements: [], unchanged: [] });
    });

    it('U4: a check the database lacks is not named: push creates it', async () =>
    {
        const { statements, unchanged } = await plan(posts(['a']));

        expect(statements.join('\n')).toContain('CONSTRAINT "posts_post_status_check"');
        expect(unchanged).toEqual([]);
    });

    it('U5: a declared expression PostgreSQL cannot parse against the table is named with its error', async () =>
    {
        await push(posts(['a']));

        const declared = { schema: SCHEMA, table: 'posts', name: 'posts_post_status_check', value: '"missing" in (\'a\')' };

        expect(await unchangedChecks(drizzle({ client }), [declared])).toEqual([{ ...declared, error: 'column "missing" does not exist' }]);
    });
});
