/**
 * Principal types (#138) — `.principal<P>()` names who the callbacks'
 * `principal` is. Every assertion is an `expectTypeOf` expression on types
 * alone: vitest runs them, and `pnpm type-check` fails when a positive stops
 * compiling or a negative starts to.
 *
 * | #  | assertion                                                                  |
 * |----|----------------------------------------------------------------------------|
 * | P1 | `.principal<Auth>()` then `.read(ctx => …)`: `ctx.principal` is `Auth \| undefined` |
 * | P2 | `.canRead`: `Auth \| undefined`                                            |
 * | P3 | `.canWrite`: `Auth`                                                        |
 * | P4 | `.write`: `Auth`                                                           |
 * | P5 | no `.principal()`: all four are `unknown`                                  |
 * | P6 | `.principal<Auth>()` after `.key()` / `.value()` / `.data()`: key, value and data types kept |
 * | P7 | `.key(K)` after `.principal<Auth>()`: principal type kept                  |
 * | P8 | negative: `ctx.principal.user` in `.read` without narrowing does not type-check |
 */

import { describe, expectTypeOf, it } from 'vitest';
import { defineState } from '../state-builder';
import type { StateBuilder } from '../state-builder';
import type { StateShape } from '../types';
import { Consent, ConsentData, ConsentInput, WorkspaceKey } from './state-harness';

interface Auth
{
    userId: string;
    user: { email: string };
}

type ReadCtx<B> = B extends StateBuilder<any, any> ? Parameters<Parameters<B['read']>[0]>[0] : never;

type CanReadCtx<B> = B extends StateBuilder<any, any> ? Parameters<Parameters<B['canRead']>[0]>[0] : never;

type CanWriteCtx<B> = B extends StateBuilder<any, any> ? Parameters<Parameters<B['canWrite']>[0]>[0] : never;

type WriteCtx<B> = B extends StateBuilder<any, any> ? Parameters<Parameters<B['write']>[1]>[0] : never;

type Shape<B> = B extends StateBuilder<any, infer T extends StateShape> ? T : never;

const declared = defineState('consent').principal<Auth>().value(Consent);
const undeclared = defineState('consent').value(Consent);
const keyedAfter = defineState('member').principal<Auth>().key(WorkspaceKey).value(Consent);
const declaredLast = defineState('member').key(WorkspaceKey).value(Consent).data(ConsentData).principal<Auth>();

describe('principal types', () =>
{
    it('P1 .read receives Auth | undefined', () =>
    {
        expectTypeOf<ReadCtx<typeof declared>['principal']>().toEqualTypeOf<Auth | undefined>();
    });

    it('P2 .canRead receives Auth | undefined', () =>
    {
        expectTypeOf<CanReadCtx<typeof declared>['principal']>().toEqualTypeOf<Auth | undefined>();
    });

    it('P3 .canWrite receives Auth', () =>
    {
        expectTypeOf<CanWriteCtx<typeof declared>['principal']>().toEqualTypeOf<Auth>();
    });

    it('P4 .write receives Auth', () =>
    {
        expectTypeOf<WriteCtx<typeof declared>['principal']>().toEqualTypeOf<Auth>();
        expectTypeOf(declared.write).toBeCallableWith(ConsentInput, ({ principal }) => void principal.user.email);
    });

    it('P5 without .principal() every callback receives unknown', () =>
    {
        expectTypeOf<ReadCtx<typeof undeclared>['principal']>().toEqualTypeOf<unknown>();
        expectTypeOf<CanReadCtx<typeof undeclared>['principal']>().toEqualTypeOf<unknown>();
        expectTypeOf<CanWriteCtx<typeof undeclared>['principal']>().toEqualTypeOf<unknown>();
        expectTypeOf<WriteCtx<typeof undeclared>['principal']>().toEqualTypeOf<unknown>();
    });

    it('P6 .principal() declared last keeps the key, value and data types', () =>
    {
        expectTypeOf<Shape<typeof declaredLast>['key']>().toEqualTypeOf<typeof WorkspaceKey>();
        expectTypeOf<Shape<typeof declaredLast>['value']>().toEqualTypeOf<typeof Consent>();
        expectTypeOf<Shape<typeof declaredLast>['data']>().toEqualTypeOf<typeof ConsentData>();
        expectTypeOf<ReadCtx<typeof declaredLast>>().toEqualTypeOf<{ subject: string; principal: Auth | undefined; key: { workspaceId: string } }>();
    });

    it('P7 .key() declared after .principal() keeps the principal type', () =>
    {
        expectTypeOf<Shape<typeof keyedAfter>['principal']>().toEqualTypeOf<Auth>();
        expectTypeOf<CanReadCtx<typeof keyedAfter>>().toEqualTypeOf<{ subject: string; principal: Auth | undefined; key: { workspaceId: string } }>();
    });

    it('P8 negative: .read cannot reach principal.user without narrowing', () =>
    {
        expectTypeOf<ReadCtx<typeof declared>['principal']>().not.toMatchTypeOf<{ user: unknown }>();
        expectTypeOf<NonNullable<ReadCtx<typeof declared>['principal']>>().toMatchTypeOf<{ user: unknown }>();
    });
});
