/**
 * Second-Factor Policy
 *
 * Whether this application requires a second factor, which methods count as
 * one, and whether recovery codes exist — set once during
 * `createAuthLifecycle({ secondFactor })` and read at request time, as
 * `channels-config.ts` is.
 *
 * With nothing stated the policy is the package's behaviour before the option
 * existed: nothing required, both methods, recovery codes on. Every reader
 * below answers exactly what that behaviour answers in that case, and
 * `isSecondFactorRequired()` is false, so the per-request enrolment check is
 * never evaluated and costs nothing.
 *
 * "Enrolled" is not stored anywhere new. It is the account's state read under
 * this policy (`isEnrolledUnderPolicy`), so an account becomes able to use the
 * application the moment it enrols, on the same session, and a session that
 * predates the policy is covered by construction.
 */

import { SecondFactorMethodDisabledError } from '@spfn/auth/errors';

import { isChannelEnabled } from './channels-config';
import { getEncryptionKeyring } from './oauth/token-cipher';

/** The methods that count as a second factor. */
export const SECOND_FACTOR_METHODS = ['totp', 'passkey'] as const;

export type SecondFactorMethod = typeof SECOND_FACTOR_METHODS[number];

/** What a method-gated route belongs to: a method, or the recovery codes. */
export type SecondFactorFeature = SecondFactorMethod | 'recoveryCodes';

/**
 * `createAuthLifecycle({ secondFactor })`. Every key optional.
 *
 * - `required` — default `false`. An account with no listed second factor can
 *   do nothing but enrol one.
 * - `methods` — default `['totp', 'passkey']`. Only these count as enrolled,
 *   only these are accepted as a proof, and only these can be enrolled.
 * - `recoveryCodes` — default `true`. `false` issues none and accepts none.
 */
export interface SecondFactorOptions
{
    required?: boolean;
    methods?: SecondFactorMethod[];
    recoveryCodes?: boolean;
}

export interface SecondFactorPolicy
{
    required: boolean;
    methods: readonly SecondFactorMethod[];
    recoveryCodes: boolean;
}

const OPTION_KEYS = ['required', 'methods', 'recoveryCodes'];

let policy: SecondFactorPolicy = defaultPolicy();

/** The first policy an application stated, to hold every later one to. */
let stated: SecondFactorPolicy | null = null;

/** Why boot must be refused, once two calls stated different policies. */
let contradiction: string | null = null;

function defaultPolicy(): SecondFactorPolicy
{
    return { required: false, methods: [...SECOND_FACTOR_METHODS], recoveryCodes: true };
}

/**
 * Set the policy. Called synchronously from `createAuthLifecycle()`, so it is
 * in force before any handler can run.
 *
 * The rule `configureChannels` follows: a call that states nothing leaves the
 * policy as it is, and a call that states a different one than an earlier call
 * is a contradiction refused at boot by `assertSecondFactorPolicy` — the first
 * statement stays in force meanwhile.
 *
 * An unknown key, an unknown method and a value of the wrong type are refused
 * here rather than ignored: each would leave the application believing it
 * required something it does not.
 */
export function configureSecondFactor(options: SecondFactorOptions | undefined): void
{
    if (options === undefined)
    {
        return;
    }

    const resolved = resolvePolicy(options);

    if (stated === null)
    {
        stated = resolved;
        policy = resolved;

        return;
    }

    const differing = describeDifference(stated, resolved);

    if (differing.length > 0 && contradiction === null)
    {
        contradiction = `createAuthLifecycle() was given different secondFactor policies in two calls: ${differing.join(', ')}. `
            + 'State the policy once, or the same in every call. Until then the first one stays in force.';
    }
}

function resolvePolicy(options: SecondFactorOptions): SecondFactorPolicy
{
    const unknown = Object.keys(options).filter(key => !OPTION_KEYS.includes(key));

    if (unknown.length > 0)
    {
        throw new Error(`secondFactor.${unknown[0]} is not an option. Known options: ${OPTION_KEYS.join(', ')}.`);
    }

    const resolved = defaultPolicy();

    resolved.required = booleanOption('required', options.required, resolved.required);
    resolved.recoveryCodes = booleanOption('recoveryCodes', options.recoveryCodes, resolved.recoveryCodes);
    resolved.methods = options.methods === undefined ? resolved.methods : resolveMethods(options.methods);

    return resolved;
}

function booleanOption(name: string, value: unknown, fallback: boolean): boolean
{
    if (value !== undefined && typeof value !== 'boolean')
    {
        throw new Error(`secondFactor.${name} must be true or false, received ${String(value)}.`);
    }

    return value ?? fallback;
}

/** The listed methods, deduplicated in the package's order. `[]` is kept for the boot refusal. */
function resolveMethods(methods: unknown): SecondFactorMethod[]
{
    if (!Array.isArray(methods))
    {
        throw new Error(`secondFactor.methods must be an array, received ${String(methods)}.`);
    }

    for (const method of methods)
    {
        if (!(SECOND_FACTOR_METHODS as readonly unknown[]).includes(method))
        {
            throw new Error(`secondFactor.methods: ${String(method)} is not a second-factor method. `
                + `Known methods: ${SECOND_FACTOR_METHODS.join(', ')}.`);
        }
    }

    return SECOND_FACTOR_METHODS.filter(method => methods.includes(method));
}

function describeDifference(first: SecondFactorPolicy, second: SecondFactorPolicy): string[]
{
    const differing: string[] = [];

    if (first.required !== second.required)
    {
        differing.push(`required (${first.required} / ${second.required})`);
    }

    if (first.methods.join(',') !== second.methods.join(','))
    {
        differing.push(`methods ([${first.methods.join(', ')}] / [${second.methods.join(', ')}])`);
    }

    if (first.recoveryCodes !== second.recoveryCodes)
    {
        differing.push(`recoveryCodes (${first.recoveryCodes} / ${second.recoveryCodes})`);
    }

    return differing;
}

/**
 * Refuse boot on a policy that contradicts itself, another statement, or the
 * rest of the configuration.
 *
 * Called from `afterInfrastructure` beside `assertChannelsConsistent`, and for
 * its reason: a throw from the lifecycle constructor is swallowed by
 * `loadAndMergeConfig()` and leaves the server listening. Silent when no
 * policy was stated.
 */
export function assertSecondFactorPolicy(env: Record<string, string | undefined> = process.env): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }

    if (stated === null)
    {
        return;
    }

    assertSomeMethodListed();
    assertNoUnprovenChannel();
    assertPasskeyUserVerification(env);
    assertTotpEnrollable();
}

function assertSomeMethodListed(): void
{
    if (policy.methods.length === 0)
    {
        throw new Error('secondFactor.methods is empty: no second factor could ever be enrolled or proved. '
            + `List at least one of ${SECOND_FACTOR_METHODS.join(', ')}, or omit methods for both.`);
    }
}

/**
 * A device-code approval and a device-link confirmation sign a device in
 * without any listed method, so a required second factor cannot hold while
 * either exists.
 */
function assertNoUnprovenChannel(): void
{
    if (!policy.required)
    {
        return;
    }

    for (const channel of ['deviceCode', 'deviceLink'] as const)
    {
        if (isChannelEnabled(channel))
        {
            throw new Error(`secondFactor.required is true, but the ${channel} channel is on, and it signs a device in `
                + `with no listed second factor. Turn it off with createAuthLifecycle({ channels: { ${channel}: false } }).`);
        }
    }
}

function assertPasskeyUserVerification(env: Record<string, string | undefined>): void
{
    const configured = env.SPFN_AUTH_PASSKEY_USER_VERIFICATION?.trim().toLowerCase();

    if (isPasskeyOnly() && configured && configured !== 'required')
    {
        throw new Error('secondFactor.methods is [\'passkey\'], which needs passkey user verification, but '
            + `SPFN_AUTH_PASSKEY_USER_VERIFICATION is "${env.SPFN_AUTH_PASSKEY_USER_VERIFICATION}". `
            + 'Set it to required, or unset it and the policy raises it.');
    }
}

/** A required TOTP-only policy no one could enrol under, because the secret cannot be stored. */
function assertTotpEnrollable(): void
{
    if (policy.required && !isMethodListed('passkey') && getEncryptionKeyring().length === 0)
    {
        throw new Error('secondFactor requires TOTP, the only listed method, but SPFN_AUTH_TOKEN_ENCRYPTION_KEYS is '
            + 'unset, so no one could enrol. Set it in .env.server.');
    }
}

/** Test-only: the default policy, nothing stated, no contradiction */
export function __resetSecondFactorPolicyForTests(): void
{
    policy = defaultPolicy();
    stated = null;
    contradiction = null;
}

/** The policy in force. */
export function getSecondFactorPolicy(): SecondFactorPolicy
{
    return policy;
}

/** Whether an account with no listed second factor is held to enrolling one. */
export function isSecondFactorRequired(): boolean
{
    return policy.required;
}

/** Whether a second-factor method or the recovery codes are offered. */
export function isMethodListed(feature: SecondFactorFeature): boolean
{
    return feature === 'recoveryCodes' ? policy.recoveryCodes : policy.methods.includes(feature);
}

/** Whether the passkey is the one listed method — the case that raises user verification. */
export function isPasskeyOnly(): boolean
{
    return policy.methods.length === 1 && policy.methods[0] === 'passkey';
}

/**
 * A `SecondFactorMethodDisabledError` (404 `SECOND_FACTOR_METHOD_DISABLED`)
 * when the policy does not offer this method or the recovery codes.
 *
 * Not found, for the reason `requireChannel` gives: the routes register at
 * import time, before the policy is stated, and a route the application does
 * not offer is, to every caller, a route that is not there.
 */
export function requireMethod(feature: SecondFactorFeature): void
{
    if (!isMethodListed(feature))
    {
        throw new SecondFactorMethodDisabledError({
            message: `This application does not offer ${feature} as a second factor. `
                + 'It is turned off by createAuthLifecycle({ secondFactor }).',
            details: { method: feature },
        });
    }
}
