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

import { NotFoundError } from '@spfn/core/errors';

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

function allEnabled(): Record<AuthChannel, boolean>
{
    return { signup: true, passwordReset: true, deviceCode: true, deviceLink: true };
}

/**
 * Set which channels exist. Called synchronously from `createAuthLifecycle()`,
 * so it takes effect before any handler can run.
 *
 * A key this package does not know and a value that is not a boolean are
 * refused rather than ignored: either would leave open a channel the
 * application believes it closed.
 */
export function configureChannels(options: AuthChannelsOptions = {}): void
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

    enabled = resolved;
}

/** Whether the application offers this channel. `true` until `configureChannels` says otherwise. */
export function isChannelEnabled(name: AuthChannel): boolean
{
    return enabled[name];
}

/**
 * A 404 when the application does not offer this channel.
 *
 * Not found rather than forbidden, for the reason `requireAuthorizationServer`
 * gives: the routes register at import time, before `createAuthLifecycle()`
 * runs, so "not registered" is not available — and a route the application
 * does not offer is, to every caller, a route that is not there.
 */
export function requireChannel(name: AuthChannel): void
{
    if (!enabled[name])
    {
        throw new NotFoundError({
            message: `This application does not offer ${name}. It is turned off by createAuthLifecycle({ channels }).`,
        });
    }
}
