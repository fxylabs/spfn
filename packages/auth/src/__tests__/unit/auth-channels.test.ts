/**
 * @spfn/auth - The channels option and the route classification (#308)
 *
 * C13 of the #308 case table, and the option's own contract: a value that is
 * not a boolean and a key that is not a channel refused rather than ignored, and `createAuthLifecycle` resolving it in its
 * constructor. The route rows C2–C12 are in integration/auth-channels.test.ts.
 *
 * #381 adds `invitations` and `selfDeletion`: U2 pins which routes they close,
 * B1 the boot refusal beside `deletion.allowSelfImmediate`.
 *
 * #475: a channel the package adds after the option shipped is off unless the
 * application turns it on. D1 pins that `passkeyLogin`, `invitations` and
 * `selfDeletion` are off for an application that states nothing and for one
 * that states only another channel; D2 that a channel added to
 * `AUTH_CHANNELS` alone is off.
 *
 * `channels` is read by the shared reader (#477): the rows for a value that is
 * not a plain object, a prototype posing as `Object.prototype` and a
 * non-enumerable misspelling are its own, in stated-options.test.ts, with the
 * row proving `configureChannels` reads through it.
 */

import { describe, it, expect, afterEach, onTestFinished } from 'vitest';
import { Hono } from 'hono';
import { registerRoutes } from '@spfn/core/route';
import { ErrorHandler } from '@spfn/core/middleware';

import { mainAuthRouter } from '@/server/routes';
import { ROUTE_CHANNELS } from '@/server/routes/channels';
import {
    AUTH_CHANNELS,
    __resetChannelsForTests,
    assertChannelsConsistent,
    channelStates,
    configureChannels,
    isChannelEnabled,
    requireChannel,
    type AuthChannelsOptions,
} from '@/server/lib/channels-config';
import { __resetDeletionForTests } from '@/server/lib/deletion-config';
import { createAuthLifecycle } from '@/server/lifecycle';
import { AUTH_SURFACE_OPERATIONS } from '@/server/client-proof/contract-types';

describe('channels (#308)', () =>
{
    afterEach(() =>
    {
        __resetChannelsForTests();
        __resetDeletionForTests();
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

    it('#381 U2: invitations closes exactly the /_auth/invitations routes, selfDeletion exactly the deletion request', () =>
    {
        const routes = mainAuthRouter.routes as Record<string, { path: string }>;
        const keysOf = (channel: string) => Object.keys(ROUTE_CHANNELS)
            .filter(key => ROUTE_CHANNELS[key as keyof typeof ROUTE_CHANNELS] === channel)
            .sort();

        expect(keysOf('invitations')).toEqual(Object.keys(routes).filter(key => routes[key]!.path.startsWith('/_auth/invitations')).sort());
        expect(keysOf('invitations')).toHaveLength(7);
        expect(keysOf('selfDeletion')).toEqual(['requestAccountDeletion']);
    });

    it.each([
        ['no channels', undefined],
        ['channels: { signup: false }', { signup: false }],
    ] as const)('#475 D1: with %s, passkeyLogin, invitations and selfDeletion are off and every route of theirs answers 404', async (_case, channels) =>
    {
        const app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: 'auth', handler: async (_c, next) => next() }]);
        app.onError(ErrorHandler());
        const routes = mainAuthRouter.routes as Record<string, { method: string; path: string }>;
        const offByDefault = Object.entries(ROUTE_CHANNELS)
            .filter(([, channel]) => channel === 'passkeyLogin' || channel === 'invitations' || channel === 'selfDeletion');

        createAuthLifecycle({ channels });

        expect(channelStates()).toEqual({
            signup: channels === undefined, passwordReset: true, deviceCode: true, deviceLink: true,
            passkeyLogin: false, invitations: false, selfDeletion: false,
        });
        expect(offByDefault).toHaveLength(10);

        for (const [key, channel] of offByDefault)
        {
            const { method, path } = routes[key]!;
            const response = await app.request(path.replace(/:\w+/g, 'x'.repeat(32)), {
                method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
            });

            expect(response.status, key).toBe(404);
            expect(await response.json(), key).toMatchObject({ code: 'CHANNEL_DISABLED', details: { channel } });
        }
    });

    it('#475 D2: a channel added to AUTH_CHANNELS alone is off — the on-by-default list never grows', () =>
    {
        const channels = AUTH_CHANNELS as unknown as string[];
        channels.push('addedLater');
        onTestFinished(() => void channels.pop());
        __resetChannelsForTests();

        expect((channelStates() as Record<string, boolean>).addedLater).toBe(false);

        configureChannels({ signup: false });

        expect((channelStates() as Record<string, boolean>).addedLater).toBe(false);
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
        createAuthLifecycle({ channels: { signup: false, deviceCode: false, passkeyLogin: true } });
        createAuthLifecycle({ channels: { signup: false, deviceCode: false, passkeyLogin: true } });

        expect(AUTH_CHANNELS.map(isChannelEnabled)).toEqual([false, true, false, true, true, false, false]);
        expect(() => assertChannelsConsistent()).not.toThrow();
    });

    it.each([
        ['stated both ways', { signup: false }, { signup: true }, 'signup', 'signup'],
        ['stated true beside left to its default, off', { passkeyLogin: true }, { signup: false }, 'passkeyLogin', 'signup, passkeyLogin'],
    ] as const)('F3c: a channel %s keeps it closed, and afterInfrastructure rejects naming it', async (_case, first, second, closed, named) =>
    {
        createAuthLifecycle({ channels: first });
        const lifecycle = createAuthLifecycle({ channels: second });

        expect(isChannelEnabled(closed)).toBe(false);
        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(`different channels in two calls: ${named}. `);
    });

    it('#381 B1: deletion.allowSelfImmediate without channels.selfDeletion: true refuses boot, saying to set it', async () =>
    {
        const lifecycle = createAuthLifecycle({ deletion: { allowSelfImmediate: true } });

        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/allowSelfImmediate is true, but the selfDeletion channel is off.*Set channels\.selfDeletion: true/);
    });

    it('refuses a key that is not a channel, and a value that is not a boolean', () =>
    {
        expect(() => configureChannels({ totp: false } as AuthChannelsOptions)).toThrow(/channels\.totp is not a channel/);
        expect(() => configureChannels({ signup: 'false' } as unknown as AuthChannelsOptions)).toThrow(/must be true or false/);
    });

    it('createAuthLifecycle resolves the option in its constructor', () =>
    {
        createAuthLifecycle({ channels: { signup: false, deviceLink: false, passkeyLogin: true } });

        expect(isChannelEnabled('signup')).toBe(false);
        expect(isChannelEnabled('deviceLink')).toBe(false);
        expect(isChannelEnabled('passkeyLogin')).toBe(true);
        expect(isChannelEnabled('passwordReset')).toBe(true);
        expect(isChannelEnabled('deviceCode')).toBe(true);
    });

    it('#373: GET /_auth/channels answers each channel turned from its default, with no session, one key per channel', async () =>
    {
        const app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: 'auth', handler: async (c) => c.body(null, 401) }]);
        const defaults = channelStates();

        for (const turned of AUTH_CHANNELS)
        {
            __resetChannelsForTests();
            configureChannels({ [turned]: !defaults[turned] });

            const response = await app.request('/_auth/channels');

            expect(response.status, turned).toBe(200);
            expect(await response.json(), turned).toEqual({ ...defaults, [turned]: !defaults[turned] });
        }
    });
});
