/**
 * @spfn/auth/client - Passkeys (WebAuthn)
 *
 * Four browser helpers over the two ceremonies. Each one is `options` from the
 * server, `navigator.credentials` in the browser, `verify` back to the server —
 * and each answers with a discriminated union instead of throwing.
 *
 * That is the whole point of this file. A person closing the system passkey
 * sheet raises `NotAllowedError`, and so does a person whose authenticator has
 * nothing to offer; neither is an application error, and code that has to tell
 * them apart by catching and re-reading `error.name` gets it wrong once and
 * shows a red banner to someone who simply changed their mind.
 *
 * Ships to browsers: no Node built-ins here, `Buffer` included. The base64url
 * helpers come from `@simplewebauthn/browser`, which is bundled into this entry.
 */

import {
    browserSupportsWebAuthn,
    browserSupportsWebAuthnAutofill,
    startAuthentication,
    startRegistration,
    type AuthenticationResponseJSON,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
} from '@simplewebauthn/browser';

import type { authApi } from '@spfn/auth';

/** The typed auth client these helpers drive. */
export type AuthApi = typeof authApi;

/**
 * Why a ceremony did not produce a session.
 *
 * - `unsupported`: this browser has no WebAuthn at all
 * - `cancelled`: the person dismissed the prompt
 * - `no-credential`: the authenticator had nothing for this relying party
 * - `error`: anything else, with the original error attached
 */
export type PasskeyFailureReason = 'unsupported' | 'cancelled' | 'no-credential' | 'error';

export type PasskeyResult<T> =
    | ({ ok: true } & T)
    | { ok: false; reason: PasskeyFailureReason; error?: unknown };

/** Whether this browser can run a WebAuthn ceremony at all. */
export function isPasskeySupported(): boolean
{
    return browserSupportsWebAuthn();
}

/**
 * Whether the browser can offer passkeys inside the ordinary autofill dropdown.
 *
 * Worth checking before rendering a sign-in form: conditional mediation is what
 * turns a passkey into "tap the suggestion above the keyboard", and where it is
 * missing the form needs a visible "Sign in with a passkey" button instead.
 */
export async function isConditionalMediationAvailable(): Promise<boolean>
{
    return await browserSupportsWebAuthnAutofill();
}

/**
 * The reason a ceremony failure should be reported as.
 *
 * `NotAllowedError` is the browser's answer both to "the person said no" and to
 * "nothing here matched", and the specification deliberately does not
 * distinguish them — telling a caller which applied would say whether a
 * credential for this site exists on the device. So it is `cancelled` in both
 * cases on registration, and `no-credential` on a sign-in that offered no
 * credentials to choose from, which is the reading a UI wants.
 */
function failureReason(error: unknown, whenNotAllowed: PasskeyFailureReason): PasskeyFailureReason
{
    return (error as { name?: string } | null)?.name === 'NotAllowedError' ? whenNotAllowed : 'error';
}

export interface EnrollPasskeyOptions
{
    /** Owner-facing name for the passkey list, e.g. the device model. */
    label?: string;
    /** Sent when the session proved itself longer ago than the recent-auth window. */
    currentPassword?: string;
}

export interface EnrollPasskeyValue
{
    passkeyId: string;
    label: string | null;
    createdAt: string;
}

/**
 * Enroll a passkey on the device in front of the user.
 *
 * Requires a signed-in session. A 403 with code `RECENT_AUTH_REQUIRED` from the
 * options call means the caller should prompt for the password and try again
 * with `currentPassword`; that is a rejected promise, not a result here, because
 * it is the server declining rather than the ceremony failing.
 */
export async function enrollPasskey(
    api: AuthApi,
    options: EnrollPasskeyOptions = {},
): Promise<PasskeyResult<EnrollPasskeyValue>>
{
    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.passkeyRegisterOptions.call({
        body: { currentPassword: options.currentPassword },
    }) as PublicKeyCredentialCreationOptionsJSON;

    let response: RegistrationResponseJSON;

    try
    {
        response = await startRegistration({ optionsJSON });
    }
    catch (error)
    {
        return { ok: false, reason: failureReason(error, 'cancelled'), error };
    }

    const enrolled = await api.passkeyRegisterVerify.call({
        body: { response, label: options.label },
    }) as EnrollPasskeyValue;

    return { ok: true, ...enrolled };
}

export interface SignInWithPasskeyOptions
{
    /**
     * Offer the passkey through the browser's autofill dropdown instead of a
     * modal. Needs an `<input autocomplete="username webauthn">` on the page.
     */
    conditional?: boolean;
    deviceName?: string;
    platform?: string;
}

export interface SignInWithPasskeyValue
{
    userId: string;
    publicId: string;
    email?: string;
    phone?: string;
    passwordChangeRequired: boolean;
}

/**
 * Sign in with a passkey, no identifier asked for.
 *
 * The device key the session runs on is generated and stored by the Next.js
 * proxy interceptor, exactly as on a password login — nothing here handles a
 * private key.
 */
export async function signInWithPasskey(
    api: AuthApi,
    options: SignInWithPasskeyOptions = {},
): Promise<PasskeyResult<SignInWithPasskeyValue>>
{
    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.passkeyLoginOptions.call({
        body: {},
    }) as PublicKeyCredentialRequestOptionsJSON;

    let response: AuthenticationResponseJSON;

    try
    {
        response = await startAuthentication({ optionsJSON, useBrowserAutofill: options.conditional === true });
    }
    catch (error)
    {
        return { ok: false, reason: failureReason(error, 'no-credential'), error };
    }

    const session = await api.passkeyLoginVerify.call({
        body: { response },
    }) as SignInWithPasskeyValue;

    return { ok: true, ...session };
}
