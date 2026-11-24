/**
 * Channel Configuration
 *
 * Which ways into an account — and which ways to create or end one — this
 * application offers, set once during `createAuthLifecycle()` and read at
 * request time, as `device-auth-config.ts` is.
 *
 * A way into an account is opened by the application, never by an upgrade.
 * The four channels `channels` shipped with in 0.3 are on unless the
 * application turns them off: they were served before the option existed.
 * Every other channel — `passkeyLogin`, `invitations`, `selfDeletion` and any
 * a later release adds — is off unless the application turns it on. That
 * rule is `ON_BY_DEFAULT` below, a list that never grows, so a channel added
 * to `AUTH_CHANNELS` alone is off.
 *
 * Password sign-in has no key: it is the one way in this package always
 * offers, so no setting here can leave an application with none.
 *
 * Only the routes read this (see `routes/channels.ts`). Service functions stay
 * callable by the application whatever it says — an operator who turns public
 * sign-up off still creates accounts by calling `registerService` — with one
 * exception: `signup: false` also refuses an account a first social sign-in
 * would create, because that is sign-up by another door.
 */

import { ChannelDisabledError } from '@spfn/auth/errors';

import { readOptions, type OptionTerms } from '@spfn/core/options';

/** The channels an application can turn on or off. */
export const AUTH_CHANNELS = [
    'signup',
    'passwordReset',
    'deviceCode',
    'deviceLink',
    'passkeyLogin',
    'invitations',
    'selfDeletion',
] as const;

export type AuthChannel = typeof AUTH_CHANNELS[number];

/**
 * The channels on when the application does not state them: the four the
 * `channels` option shipped with in 0.3, each served before the option
 * existed.
 *
 * This list never grows. A channel a release adds goes into `AUTH_CHANNELS`
 * alone and is off until the application states it `true`.
 */
const ON_BY_DEFAULT: readonly AuthChannel[] = Object.freeze(['signup', 'passwordReset', 'deviceCode', 'deviceLink']);

/**
 * `createAuthLifecycle({ channels })`. Every key optional: an application
 * states only what it changes. A key left out, or `undefined`, takes the
 * channel's default.
 *
 * On unless stated `false`:
 * - `signup` — `register`, the verified-email signup link, a registration code,
 *   and an account created by a first social sign-in
 * - `passwordReset` — the reset link and a password-reset code
 * - `deviceCode` — device-code login (`/_auth/device/*`)
 * - `deviceLink` — device link (`/_auth/device/link/*`)
 *
 * Off unless stated `true`, as is every channel a later release adds:
 * - `passkeyLogin` — passkey sign-in (`/_auth/passkeys/login/*`). Passkey
 *   registration, the second-factor ceremonies and session renewal stay on.
 * - `invitations` — the whole invitation family (`/_auth/invitations/*`):
 *   issuing, listing, settling, reading and accepting. A pending invitation
 *   stays pending and cannot be accepted while it is off.
 * - `selfDeletion` — `POST /_auth/deletion/request` only. Cancelling a
 *   pending deletion and its `account_deletion` code stay on: a pending
 *   deletion blocks every sign-in, and that is its only way back.
 */
export type AuthChannelsOptions = Partial<Record<AuthChannel, boolean>>;

let enabled: Record<AuthChannel, boolean> = defaultChannels();

/** The first resolution an application stated, to hold every later one to. */
let stated: Record<AuthChannel, boolean> | null = null;

/** Why boot must be refused, once two calls stated different channels. */
let contradiction: string | null = null;

function defaultChannels(): Record<AuthChannel, boolean>
{
    return Object.fromEntries(AUTH_CHANNELS.map(name => [name, ON_BY_DEFAULT.includes(name)])) as Record<AuthChannel, boolean>;
}

/**
 * Set which channels exist. Called synchronously from `createAuthLifecycle()`,
 * so it takes effect before any handler can run.
 *
 * Each stated call resolves to every channel: what it states, and the default
 * for what it leaves out. The defaults stand only until a call states
 * `channels`; the first such call's resolution replaces them.
 *
 * A closed channel is a security declaration, so only the application stating
 * otherwise changes it. A call that states nothing (`channels` undefined)
 * leaves the setting as it is: a second lifecycle built without the option
 * does not reopen what the first closed. A call whose resolution differs from
 * the first one's — one states `passkeyLogin: true`, the other leaves it to
 * its default, off — is a contradiction, refused at boot by
 * `assertChannelsConsistent`, and until then every channel either call
 * resolved off stays off.
 *
 * A `channels` that is not a plain object, a key this package does not know
 * and a value that is not a boolean are refused here, before any
 * handler can run, rather than read as "on" or "off": each would leave a
 * channel in a state the application never decided on. The type says the
 * same to a TypeScript caller; this says it to a JavaScript caller and to a
 * cast.
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
            + 'A channel left out takes its default. State the channels once, or the same in every call. '
            + 'Until then they stay closed.';
    }

    const current = stated === null ? resolved : enabled;

    stated ??= resolved;
    enabled = Object.fromEntries(AUTH_CHANNELS.map(name => [name, current[name] && resolved[name]])) as Record<AuthChannel, boolean>;
}

/** How the shared reader's refusals name a channel. */
const CHANNEL_TERMS: OptionTerms = { noun: 'a channel', plural: 'channels', giving: 'giving channels true or false' };

/**
 * Each channel read once, by `readOptions`, into the snapshot both checked
 * and resolved: an own getter or a Proxy cannot pass the checks with one
 * value and resolve to another. A channel the snapshot holds as `undefined`,
 * or does not hold, takes its default.
 */
function resolveChannels(options: AuthChannelsOptions): Record<AuthChannel, boolean>
{
    const read = readOptions<AuthChannelsOptions>('channels', options, AUTH_CHANNELS, CHANNEL_TERMS);
    const notBoolean = AUTH_CHANNELS.find(name => read[name] !== undefined && typeof read[name] !== 'boolean');

    if (notBoolean !== undefined)
    {
        throw new Error(`channels.${notBoolean} must be true or false, received ${String(read[notBoolean])}.`);
    }

    const defaults = defaultChannels();

    return Object.fromEntries(AUTH_CHANNELS.map(name => [name, read[name] ?? defaults[name]])) as Record<AuthChannel, boolean>;
}

/**
 * Refuse boot when two `createAuthLifecycle()` calls stated different channels.
 *
 * Called from `afterInfrastructure` rather than thrown by `configureChannels`:
 * a contradiction is only known once every `createAuthLifecycle()` call has
 * run (see `lifecycle.ts`).
 */
export function assertChannelsConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** Test-only: every channel at its default, nothing stated, no contradiction */
export function __resetChannelsForTests(): void
{
    enabled = defaultChannels();
    stated = null;
    contradiction = null;
}

/** Whether the application offers this channel: its default until `configureChannels` says otherwise. */
export function isChannelEnabled(name: AuthChannel): boolean
{
    return enabled[name];
}

/**
 * Every channel and whether the application offers it, one key per entry of
 * `AUTH_CHANNELS` — what `GET /_auth/channels` answers. A copy: nothing a
 * caller does with it opens a channel.
 */
export function channelStates(): Record<AuthChannel, boolean>
{
    return { ...enabled };
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
            message: `This application does not offer ${name}: it is off in createAuthLifecycle({ channels }).`,
            details: { channel: name },
        });
    }
}
