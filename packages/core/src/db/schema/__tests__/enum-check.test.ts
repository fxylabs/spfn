/**
 * enumCheck — rows E1 and E2 of spfn/spfn#167
 *
 * The SQL drizzle-kit generates is the contract: every row reads it through the
 * same API `spfn db push` uses (`drizzle-kit/api-postgres`). No database needed.
 */

import { describe, it, expect } from 'vitest';
import { pgSchema } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api-postgres';
import { enumCheck, enumText } from '../entity-helper';

const schema = pgSchema('spfn_enum_check_test');

/** A table in a schema whose column's SQL name differs from its property key. */
function postsTable<T extends readonly [string, ...string[]]>(values: T)
{
    return schema.table('posts', {
        postStatus: enumText('post_status', values).notNull(),
    }, (t) => [enumCheck(t.postStatus, values)]);
}

async function snapshot(values: readonly [string, ...string[]])
{
    return generateDrizzleJson({ posts: postsTable(values) });
}

describe('enumCheck', () =>
{
    it('E1: writes the values as literals with a quote doubled, named <table>_<column>_check', async () =>
    {
        const statements = await generateMigration(await generateDrizzleJson({}), await snapshot(['a', 'b', 'o\'clock']));

        expect(statements).toContain(
            'CREATE TABLE "spfn_enum_check_test"."posts" (\n'
            + '\t"post_status" text NOT NULL,\n'
            + '\tCONSTRAINT "posts_post_status_check" CHECK ("post_status" in (\'a\', \'b\', \'o\'\'clock\'))\n'
            + ');\n',
        );
    });

    it('E2: adding a value drops and re-adds the constraint under the same name', async () =>
    {
        const statements = await generateMigration(await snapshot(['a', 'b']), await snapshot(['a', 'b', 'c']));

        expect(statements).toEqual([
            'ALTER TABLE "spfn_enum_check_test"."posts" DROP CONSTRAINT "posts_post_status_check", '
            + 'ADD CONSTRAINT "posts_post_status_check" CHECK ("post_status" in (\'a\', \'b\', \'c\'));',
        ]);
    });

    it('E3: a value holding a backslash is refused when the table\'s extras are evaluated', async () =>
    {
        await expect(snapshot(['a', 'back\\slash'])).rejects.toThrow(
            'enumCheck on "post_status" refuses the value "back\\\\slash": '
            + 'a backslash in a literal reads as an escape under standard_conforming_strings = off',
        );
    });

    it('E4: reordering or repeating the values yields no statement', async () =>
    {
        expect(await generateMigration(await snapshot(['b', 'a', 'c']), await snapshot(['c', 'a', 'b', 'a']))).toEqual([]);
    });
});
