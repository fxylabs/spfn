/**
 * Type regression: the generics of the subscription permission API.
 *
 * - `.canSubscribe<P>()` hands the predicate `principal: P | undefined`; without
 *   `P` the principal is `unknown`, never an app type core cannot know.
 * - `onSubscriptionChange` names an event of the router, never any string.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { Type } from '@sinclair/typebox';
import { defineEvent } from '../../event';
import { defineEventRouter } from '../../router';
import type { SSESubscribeOptions } from '../types';

interface AppPrincipal
{
    role: 'admin' | 'member';
}

const schema = Type.Object({ n: Type.Number() });
const router = defineEventRouter({
    auditLogged: defineEvent('types.audit', schema),
    runtimeChanged: defineEvent('types.runtime', schema),
});

type Change = Parameters<NonNullable<SSESubscribeOptions<typeof router>['onSubscriptionChange']>>[0];

describe('subscription permission generics', () =>
{
    it('canSubscribe<P> types the principal as P | undefined; without P it is unknown', () =>
    {
        const typed = defineEvent('types.typed', schema).canSubscribe<AppPrincipal>(({ principal }) =>
        {
            expectTypeOf(principal).toEqualTypeOf<AppPrincipal | undefined>();

            return principal?.role === 'admin';
        });

        const untyped = defineEvent('types.untyped', schema).canSubscribe(({ principal }) =>
        {
            expectTypeOf(principal).not.toEqualTypeOf<AppPrincipal | undefined>();
            expectTypeOf(principal).toBeUnknown();

            return true;
        });

        expect(typed._canSubscribe).toBeTypeOf('function');
        expect(untyped._canSubscribe).toBeTypeOf('function');
    });

    it('onSubscriptionChange names a router event, never an arbitrary string', () =>
    {
        expectTypeOf<Change['event']>().toEqualTypeOf<'auditLogged' | 'runtimeChanged'>();
        expectTypeOf<'notAnEvent'>().not.toMatchTypeOf<Change['event']>();
        expectTypeOf<Change['status']>().toEqualTypeOf<'granted' | 'revoked'>();
    });
});
