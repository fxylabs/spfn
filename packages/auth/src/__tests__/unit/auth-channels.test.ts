/**
 * @spfn/auth - The channels option and the route classification (#308)
 *
 * C13 of the #308 case table, and the option's own contract: every channel on
 * by default, a value that is not a boolean and a key that is not a channel
 * refused rather than ignored, and `createAuthLifecycle` resolving it in its
 * constructor. The route rows C2–C12 are in integration/auth-channels.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { mainAuthRouter } from '@/server/routes';
import { ROUTE_CHANNELS } from '@/server/routes/channels';
import {
    AUTH_CHANNELS,
    __resetChannelsForTests,
    assertChannelsConsistent,
    configureChannels,
    isChannelEnabled,
    requireChannel,
    type AuthChannelsOptions,
} from '@/server/lib/channels-config';
import { createAuthLifecycle } from '@/server/lifecycle';
import { AUTH_SURFACE_OPERATIONS } from '@/server/client-proof/contract-types';

describe('channels (#308)', () =>
{
    afterEach(() =>
    {
        __resetChannelsForTests();
    });

    it('C13: every key of mainAuthRouter is in the classification table', () =>
    {
        const unclassified = Object.keys(mainAuthRouter.routes).filter(key => !Object.hasOwn(ROUTE_CHANNELS, key));

        expect(unclassified).toEqual([]);
    });

    it('each /_auth contract operation names the route that serves it, by method and path', () =>
    {
        for (const operation of AUTH_SURFACE_OPERATIONS)
        {
            const route = mainAuthRouter.routes[operation.route!] as { method?: string; path?: string } | undefined;

            expect(route, operation.id).toBeDefined();
            expect(`${route!.method} ${route!.path}`, operation.id)
                .toBe(`${operation.method} ${operation.path.replace(/\{(\w+)\}/g, ':$1')}`);
        }
    });

    it('C13: the table names no route the router does not have', () =>
    {
        const stale = Object.keys(ROUTE_CHANNELS).filter(key => !Object.hasOwn(mainAuthRouter.routes, key));

        expect(stale).toEqual([]);
    });

    it('every channel is on until the app says otherwise', () =>
    {
        expect(AUTH_CHANNELS.map(isChannelEnabled)).toEqual([true, true, true, true]);
        expect(() => AUTH_CHANNELS.forEach(requireChannel)).not.toThrow();
    });

    it('a channel set to false answers 404 CHANNEL_DISABLED naming it, and leaves the others on', () =>
    {
        configureChannels({ deviceCode: false });

        expect(() => requireChannel('deviceCode')).toThrow(expect.objectContaining({
            name: 'ChannelDisabledError',
            statusCode: 404,
            code: 'CHANNEL_DISABLED',
            details: { channel: 'deviceCode' },
        }));
        expect(isChannelEnabled('deviceLink')).toBe(true);
        expect(isChannelEnabled('signup')).toBe(true);
    });

    it('F3a: a later createAuthLifecycle() without channels does not reopen a closed one', () =>
    {
        createAuthLifecycle({ channels: { signup: false } });
        createAuthLifecycle();

        expect(isChannelEnabled('signup')).toBe(false);
        expect(() => assertChannelsConsistent()).not.toThrow();
    });

    it('F3b: the same channels stated twice are no contradiction', () =>
    {
        createAuthLifecycle({ channels: { signup: false, deviceCode: false } });
        createAuthLifecycle({ channels: { signup: false, deviceCode: false } });

        expect(AUTH_CHANNELS.map(isChannelEnabled)).toEqual([false, true, false, true]);
        expect(() => assertChannelsConsistent()).not.toThrow();
    });

    it('F3c: different channels stated twice keep the channel closed, and afterInfrastructure rejects naming it', async () =>
    {
        createAuthLifecycle({ channels: { signup: false } });
        const lifecycle = createAuthLifecycle({ channels: { signup: true } });

        expect(isChannelEnabled('signup')).toBe(false);
        expect(() => assertChannelsConsistent()).toThrow(/signup/);
        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/different channels in two calls: signup\b/);
    });

    it('refuses a key that is not a channel, and a value that is not a boolean', () =>
    {
        expect(() => configureChannels({ totp: false } as AuthChannelsOptions)).toThrow(/channels\.totp is not a channel/);
        expect(() => configureChannels({ signup: 'false' } as unknown as AuthChannelsOptions)).toThrow(/must be true or false/);
    });

    it('createAuthLifecycle resolves the option in its constructor', () =>
    {
        createAuthLifecycle({ channels: { signup: false, deviceLink: false } });

        expect(isChannelEnabled('signup')).toBe(false);
        expect(isChannelEnabled('deviceLink')).toBe(false);
        expect(isChannelEnabled('passwordReset')).toBe(true);
        expect(isChannelEnabled('deviceCode')).toBe(true);
    });
});
