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

        const lines = notice(unchanged);

        expect(lines).toContain('Check "posts_post_status_check" on "i167"."posts" differs from the one in the database: '
            + 'PostgreSQL reads the two expressions differently; db push does not change an existing check.');
        expect(lines).toContain('Run spfn db generate and spfn db migrate, or drop it and push again:');
        expect(lines).toContain('ALTER TABLE "i167"."posts" DROP CONSTRAINT "posts_post_status_check";');
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

    it('U5: a declared expression PostgreSQL cannot compare is named with its error', async () =>
    {
        await push(posts(['a']));

        const declared = { schema: SCHEMA, table: 'posts', name: 'posts_post_status_check', value: '"post_status" > 1' };

        expect(await unchangedChecks(drizzle({ client }), [declared]))
            .toEqual([{ ...declared, error: 'operator does not exist: text > integer' }]);
        expect(notice([{ ...declared, error: 'operator does not exist: text > integer' }])).toContain(
            'Check "posts_post_status_check" on "i167"."posts" could not be compared with the one in the database '
            + '(operator does not exist: text > integer); db push does not change an existing check.');
    });

    it('U6: a check naming a column the table does not have yet differs, and is named so', async () =>
    {
        await push(posts(['a']));

        const declared = { schema: SCHEMA, table: 'posts', name: 'posts_post_status_check', value: '"added" in (\'a\')' };
        const unchanged = await unchangedChecks(drizzle({ client }), [declared]);

        expect(unchanged).toEqual([{ ...declared, absentColumn: 'column "added" does not exist' }]);
        expect(notice(unchanged)).toContain(
            'Check "posts_post_status_check" on "i167"."posts" differs from the one in the database: it names a column '
            + 'the table does not have yet (column "added" does not exist); db push does not change an existing check.');
    });
});

/**
 * The comparison is the planner's reading of both expressions, not their
 * meaning; these rows pin the limits the notice, README and JSDoc state.
 */
describe('what the check comparison reports', () =>
{
    const amount = { schema: SCHEMA, table: 'amounts', name: 'amounts_check' };

    beforeEach(async () =>
    {
        await client.exec(`CREATE TABLE ${SCHEMA}.amounts (amount numeric, x integer)`);
    });

    it('L1: a numeric literal written with another scale is named, although it means the same', async () =>
    {
        await client.exec(`ALTER TABLE ${SCHEMA}.amounts ADD CONSTRAINT amounts_check CHECK (amount > 1.0)`);

        const declared = { ...amount, value: '"amount" > 1' };

        expect(await unchangedChecks(drizzle({ client }), [declared])).toEqual([declared]);
    });

    it('L2: a rewrite the planner folds to the stored expression is not named', async () =>
    {
        await client.exec(`ALTER TABLE ${SCHEMA}.amounts ADD CONSTRAINT amounts_check CHECK (x > 0)`);

        expect(await unchangedChecks(drizzle({ client }), [{ ...amount, value: '"x" > 0 AND true' }])).toEqual([]);
    });

    it('L3: an enumCheck stored with its values in another order is named', async () =>
    {
        await client.exec(`ALTER TABLE ${SCHEMA}.amounts ADD COLUMN s text, ADD CONSTRAINT amounts_check CHECK (s in ('b', 'a'))`);

        const declared = { ...amount, value: '"s" in (\'a\', \'b\')' };

        expect(await unchangedChecks(drizzle({ client }), [declared])).toEqual([declared]);
    });

    it('Q1: one statement lists the stored checks, then one per stored check; a failing one hides no other', async () =>
    {
        await client.exec(`ALTER TABLE ${SCHEMA}.amounts ADD CONSTRAINT a_check CHECK (x > 0),
            ADD CONSTRAINT b_check CHECK (x > 1), ADD CONSTRAINT c_check CHECK (x > 2)`);
        const declared = [
            { ...amount, name: 'a_check', value: '"x" > 0' },
            { ...amount, name: 'b_check', value: '"x" > 5' },
            { ...amount, name: 'c_check', value: '"x" > \'a\'' },
            { ...amount, name: 'd_check', value: '"x" > 3' },
        ];
        const query = vi.spyOn(client, 'query');

        const unchanged = await unchangedChecks(drizzle({ client }), declared);

        expect(query).toHaveBeenCalledTimes(4);
        expect(unchanged).toEqual([
            declared[1],
            { ...declared[2], error: 'invalid input syntax for type integer: "a"' },
        ]);
    });
});

/** The lines displayUnchangedChecks prints for `checks` */
function notice(checks: Parameters<typeof displayUnchangedChecks>[0]): string
{
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    displayUnchangedChecks(checks);
    const lines = log.mock.calls.map(call => String(call[0])).join('\n');
    log.mockRestore();

    return lines;
}
