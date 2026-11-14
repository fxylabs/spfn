/**
 * Sign-in Channel Configuration
 *
 * Which ways into an account this application offers, set once during
 * `createAuthLifecycle()` and read at request time, as `device-auth-config.ts`
 * is.
 *
 * Every channel defaults to on, so an application that says nothing serves
 * exactly the routes it served before the option existed. Password sign-in has
 * no key: it is the one way in this package always offers, so no setting here
 * can leave an application with none.
 *
 * Only the routes read this (see `routes/channels.ts`). Service functions stay
 * callable by the application whatever it says — an operator who turns public
 * sign-up off still creates accounts by calling `registerService` — with one
 * exception: `signup: false` also refuses an account a first social sign-in
 * would create, because that is sign-up by another door.
 */

import { ChannelDisabledError } from '@spfn/auth/errors';

/** The channels an application can turn off. */
export const AUTH_CHANNELS = ['signup', 'passwordReset', 'deviceCode', 'deviceLink'] as const;

export type AuthChannel = typeof AUTH_CHANNELS[number];

/**
 * `createAuthLifecycle({ channels })`. Every key optional, every default `true`.
 *
 * - `signup` — `register`, the verified-email signup link, a registration code,
 *   and an account created by a first social sign-in
 * - `passwordReset` — the reset link and a password-reset code
 * - `deviceCode` — device-code login (`/_auth/device/*`)
 * - `deviceLink` — device link (`/_auth/device/link/*`)
 */
export type AuthChannelsOptions = Partial<Record<AuthChannel, boolean>>;

let enabled: Record<AuthChannel, boolean> = allEnabled();

/** The first resolution an application stated, to hold every later one to. */
let stated: Record<AuthChannel, boolean> | null = null;

/** Why boot must be refused, once two calls stated different channels. */
let contradiction: string | null = null;

function allEnabled(): Record<AuthChannel, boolean>
{
    return { signup: true, passwordReset: true, deviceCode: true, deviceLink: true };
}

/**
 * Set which channels exist. Called synchronously from `createAuthLifecycle()`,
 * so it takes effect before any handler can run.
 *
 * A closed channel is a security declaration, so only the application stating
 * otherwise changes it. A call that states nothing (`channels` undefined)
 * leaves the setting as it is: a second lifecycle built without the option
 * does not reopen what the first closed. A call that states different values
 * than an earlier one is a contradiction, refused at boot by
 * `assertChannelsConsistent` — and until then every channel either call
 * closed stays closed.
 *
 * A key this package does not know and a value that is not a boolean are
 * refused rather than ignored: either would leave open a channel the
 * application believes it closed.
 */
export function configureChannels(options: AuthChannelsOptions | undefined): void
{
    if (options === undefined)
    {
        return;
    }

    const resolved = resolveChannels(options);
    const differing = stated === null ? [] : AUTH_CHANNELS.filter(name => stated![name] !== resolved[name]);

    if (differing.length > 0 && contradiction === null)
    {
        contradiction = `createAuthLifecycle() was given different channels in two calls: ${differing.join(', ')}. `
            + 'State the channels once, or the same in every call. Until then they stay closed.';
    }

    stated ??= resolved;
    enabled = Object.fromEntries(AUTH_CHANNELS.map(name => [name, enabled[name] && resolved[name]])) as Record<AuthChannel, boolean>;
}

function resolveChannels(options: AuthChannelsOptions): Record<AuthChannel, boolean>
{
    const resolved = allEnabled();

    for (const [name, value] of Object.entries(options))
    {
        if (!(AUTH_CHANNELS as readonly string[]).includes(name))
        {
            throw new Error(`channels.${name} is not a channel. Known channels: ${AUTH_CHANNELS.join(', ')}.`);
        }

        if (value !== undefined && typeof value !== 'boolean')
        {
            throw new Error(`channels.${name} must be true or false, received ${String(value)}.`);
        }

        resolved[name as AuthChannel] = value ?? true;
    }

    return resolved;
}

/**
 * Refuse boot when two `createAuthLifecycle()` calls stated different channels.
 *
 * Called from `afterInfrastructure` rather than thrown by `configureChannels`:
 * a throw from the lifecycle constructor is swallowed by `loadAndMergeConfig()`
 * and leaves the server listening (see `lifecycle.ts`).
 */
export function assertChannelsConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** Test-only: every channel on, nothing stated, no contradiction */
export function __resetChannelsForTests(): void
{
    enabled = allEnabled();
    stated = null;
    contradiction = null;
}

/** Whether the application offers this channel. `true` until `configureChannels` says otherwise. */
export function isChannelEnabled(name: AuthChannel): boolean
{
    return enabled[name];
}

/**
 * A `ChannelDisabledError` (404 `CHANNEL_DISABLED`) when the application does
 * not offer this channel.
 *
 * Not found rather than forbidden, for the reason `requireAuthorizationServer`
 * gives: the routes register at import time, before `createAuthLifecycle()`
 * runs, so "not registered" is not available — and a route the application
 * does not offer is, to every caller, a route that is not there. Its own code
 * rather than `NotFoundError`, so a client tells it from an unknown record.
 */
export function requireChannel(name: AuthChannel): void
{
    if (!enabled[name])
    {
        throw new ChannelDisabledError({
            message: `This application does not offer ${name}. It is turned off by createAuthLifecycle({ channels }).`,
            details: { channel: name },
        });
    }
}
