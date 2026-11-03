/**
 * Every function member of drizzle's select builders is classified
 *
 * `_select` wraps drizzle's select query builder and lets most members pass
 * through. A member that can add a join, a source or a query must be scoped or
 * refused; the rest must be unable to add rows. Review rv158 found two private
 * factories (`createJoin`, `createSetOperator`) that the named-method list
 * missed. This test reads the members from the installed drizzle and fails on
 * any it does not know, so an upgrade that adds one has to be classified here.
 *
 * Since #158 part 2 the members that execute or prepare the query are their
 * own classes: executing ones run through the tenant rules (R1–R6), preparing
 * ones are refused on a query that reads a tenancy table. A new member that
 * executes the query would bypass those rules unless it is filed with them.
 *
 * Since #162 `_selectOfUser` builds the same wrapper with the user scope; the
 * last block holds every classified member to its class on both builders.
 */

import { describe, it, expect, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
    EXECUTE_SELECT_MEMBERS,
    PREPARE_SELECT_MEMBERS,
    REFUSED_SELECT_MEMBERS,
    scopeSelectBuilder,
    tenantScope,
    userScope,
    type SelectScope,
} from '../select';
import { notes } from './fixtures';
import { members } from './tenancy-fixtures';

/** Members `_select` rewrites so they carry the tenant condition. */
const SCOPED = new Set(['from', 'where', 'innerJoin', 'leftJoin']);

/**
 * Members that cannot add a source, a join or a query and do not run it: they
 * order, group, bound, lock, annotate or serialize the query as it stands, or
 * return `this` (re-wrapped). `builder` is the class drizzle constructs the
 * query from; calling it by hand is outside what `_select` guards.
 */
const NEUTRAL = new Set([
    'constructor', 'builder',
    '$dynamic', '$withCache', 'withoutSelectionCastCodecs',
    'having', 'groupBy', 'orderBy', 'limit', 'offset', 'for', 'comment',
    'as', 'getSQL', 'toSQL', 'getSelectedFields', 'getUsedTables',
]);

/** Names that run the query; none of them may be filed as neutral. */
const EXECUTING_NAME = /execute|prepare|then|catch|finally|iterator|stream|cursor|run/i;

/** Names that would add a join or a query; none of them may be filed as neutral. */
const SOURCE_ADDING_NAME = /join|union|intersect|except|setoperator|lateral|from/i;

function prototypeLevels(object: object): object[]
{
    const levels: object[] = [];

    for (let level: object | null = object; level && level !== Object.prototype; level = Object.getPrototypeOf(level))
    {
        levels.push(level);
    }

    return levels;
}

function functionMembers(object: object): string[]
{
    const names = prototypeLevels(object)
        .flatMap((level) => Object.getOwnPropertyNames(level))
        .filter((name) => typeof (object as Record<string, unknown>)[name] === 'function');

    return [...new Set(names)].sort();
}

/** The proxy refuses members by string name, so a symbol-keyed function could not be refused. */
function symbolFunctionMembers(object: object): string[]
{
    return prototypeLevels(object)
        .flatMap((level) => Object.getOwnPropertySymbols(level))
        .filter((symbol) => typeof (object as Record<symbol, unknown>)[symbol] === 'function')
        .map(String);
}

function unclassified(members: string[]): string[]
{
    return members.filter((name) => !SCOPED.has(name)
        && !REFUSED_SELECT_MEMBERS.has(name)
        && !EXECUTE_SELECT_MEMBERS.has(name)
        && !PREPARE_SELECT_MEMBERS.has(name)
        && !NEUTRAL.has(name));
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

    it('no symbol-keyed function member exists, since the proxy could not refuse one', () =>
    {
        expect(symbolFunctionMembers(builder)).toEqual([]);
        expect(symbolFunctionMembers(query)).toEqual([]);
    });

    it('no neutral member is named like one that adds a join or a query', () =>
    {
        expect([...NEUTRAL].filter((name) => SOURCE_ADDING_NAME.test(name))).toEqual([]);
    });

    it('no neutral member is named like one that runs the query', () =>
    {
        expect([...NEUTRAL].filter((name) => EXECUTING_NAME.test(name))).toEqual([]);
    });

    it('every refused, executing or preparing name is a real member, so a typo cannot leave one open', () =>
    {
        const members = new Set(functionMembers(query));
        const listed = [...REFUSED_SELECT_MEMBERS, ...EXECUTE_SELECT_MEMBERS, ...PREPARE_SELECT_MEMBERS];

        expect(listed.filter((name) => !members.has(name))).toEqual([]);
    });
});

describe.each<[string, SelectScope]>([
    ['_select', tenantScope(7)],
    ['_selectOfUser', userScope(3)],
])('the %s builder over a visibleTo tenancy table', (method, scope) =>
{
    const scoped = (execution = vi.fn(async () => [])) =>
        scopeSelectBuilder(drizzle.mock().select(), scope, execution).from(members) as unknown as Record<string, (...args: unknown[]) => unknown>;

    it('refuses every refused member', () =>
    {
        for (const name of REFUSED_SELECT_MEMBERS)
        {
            expect(() => scoped()[name](), name).toThrow(`${name}() is not supported on a TenantRepository ${method}`);
        }
    });

    it('refuses every preparing member, since the table is a tenancy table', () =>
    {
        for (const name of PREPARE_SELECT_MEMBERS)
        {
            expect(() => scoped()[name]('q'), name).toThrow(`${name}() is not supported on a TenantRepository ${method} that reads a tenancy table`);
        }
    });

    it('runs every executing member through the scoped execution', async () =>
    {
        for (const name of EXECUTE_SELECT_MEMBERS)
        {
            const execution = vi.fn(async () => []);

            await scoped(execution)[name](() => undefined);

            expect({ name, calls: execution.mock.calls.length }).toEqual({ name, calls: 1 });
        }
    });
});
