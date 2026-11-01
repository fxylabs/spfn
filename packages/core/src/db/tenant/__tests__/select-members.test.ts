/**
 * Every function member of drizzle's select builders is classified
 *
 * `_select` wraps drizzle's select query builder and lets most members pass
 * through. A member that can add a join, a source or a query must be scoped or
 * refused; the rest must be unable to add rows. Review rv158 found two private
 * factories (`createJoin`, `createSetOperator`) that the named-method list
 * missed. This test reads the members from the installed drizzle and fails on
 * any it does not know, so an upgrade that adds one has to be classified here.
 */

import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { REFUSED_SELECT_MEMBERS } from '../select';
import { notes } from './fixtures';

/** Members `_select` rewrites so they carry the tenant condition. */
const SCOPED = new Set(['from', 'where', 'innerJoin', 'leftJoin']);

/**
 * Members that cannot add a source, a join or a query: they order, group,
 * bound, lock, annotate, serialize, prepare or execute the query as it stands,
 * or return `this` (re-wrapped). `builder` is the class drizzle constructs the
 * query from; calling it by hand is outside what `_select` guards.
 */
const NEUTRAL = new Set([
    'constructor', 'builder',
    '$dynamic', '$withCache', 'withoutSelectionCastCodecs',
    'having', 'groupBy', 'orderBy', 'limit', 'offset', 'for', 'comment',
    'as', 'getSQL', 'toSQL', 'getSelectedFields', 'getUsedTables',
    '_prepare', 'prepare', 'execute', 'then', 'catch', 'finally',
]);

function functionMembers(object: object): string[]
{
    const names = new Set<string>();

    for (let level: object | null = object; level && level !== Object.prototype; level = Object.getPrototypeOf(level))
    {
        for (const name of Object.getOwnPropertyNames(level))
        {
            if (typeof (object as Record<string, unknown>)[name] === 'function')
            {
                names.add(name);
            }
        }
    }

    return [...names].sort();
}

function unclassified(members: string[]): string[]
{
    return members.filter((name) => !SCOPED.has(name) && !REFUSED_SELECT_MEMBERS.has(name) && !NEUTRAL.has(name));
}

describe('drizzle select builder members', () =>
{
    const builder = drizzle.mock().select();
    const query = builder.from(notes);

    it('every member of the pre-from builder is classified', () =>
    {
        expect(unclassified(functionMembers(builder))).toEqual([]);
    });

    it('every member of the query builder is classified', () =>
    {
        expect(unclassified(functionMembers(query))).toEqual([]);
    });

    it('every refused name is a real member, so a typo cannot leave one open', () =>
    {
        const members = new Set(functionMembers(query));

        expect([...REFUSED_SELECT_MEMBERS].filter((name) => !members.has(name))).toEqual([]);
    });
});
