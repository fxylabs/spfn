/**
 * @spfn/auth - what each caller of the device parking routes sends, as the generated client types it (#143)
 *
 * | # | situation | expected |
 * | --- | --- | --- |
 * | T1 | `authApi.redeemDeviceLinkWeb` / `startDeviceAuthWeb` / `redeemDeviceLink` | the web routes take the page's fields alone; the mobile redeem still requires the key |
 *
 * Checked by `tsc` (`pnpm type-check`); at run time the assertions are no-ops.
 */

import { describe, it, expectTypeOf } from 'vitest';

import type { authApi } from '../../index';

type CallInput<TCall extends (...args: never[]) => unknown> = Parameters<TCall>[0];

describe('the device parking routes\' generated client types (#143)', () =>
{
    it('T1 the web routes take what a page sends; the mobile redeem still requires the key', () =>
    {
        expectTypeOf<{ body: { userCode: string } }>().toMatchTypeOf<CallInput<typeof authApi.redeemDeviceLinkWeb.call>>();
        expectTypeOf<{ body: { userCode: string; deviceName: string } }>().toMatchTypeOf<CallInput<typeof authApi.redeemDeviceLinkWeb.call>>();
        expectTypeOf<{ body: Record<string, never> }>().toMatchTypeOf<CallInput<typeof authApi.startDeviceAuthWeb.call>>();

        expectTypeOf<{ body: { userCode: string } }>().not.toMatchTypeOf<CallInput<typeof authApi.redeemDeviceLink.call>>();
        expectTypeOf<keyof NonNullable<CallInput<typeof authApi.redeemDeviceLinkWeb.call>>['body']>()
            .toEqualTypeOf<'userCode' | 'deviceName'>();
    });
});
