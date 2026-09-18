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

export interface RenewSessionValue
{
    /** The new device key the session now runs on. */
    keyId: string;
}

/**
 * Renew a bound session key with a passkey assertion.
 *
 * What an app calls when a request came back `SessionRenewalRequiredError`: the
 * session's short-lived key has run out and one WebAuthn ceremony puts a new one
 * in the cookie. The person sees the system prompt, not a sign-in form.
 *
 * The body is `{ response }` and nothing else. The expiring key's id lives in an
 * HttpOnly cookie that page script cannot read, and the new key pair is the
 * Next.js proxy's to generate — both are injected there, exactly as they are for
 * `signInWithPasskey`. Nothing here handles a private key.
 *
 * Refusals from the server are rejected promises rather than results, on the same
 * rule the rest of this file follows: a `SessionRenewalRefusedError` means the
 * server declined — the key is past its grace, or was revoked — and the app's
 * answer is to send the person to sign in, which is not the same as the ceremony
 * failing.
 */
export async function renewSession(api: AuthApi): Promise<PasskeyResult<RenewSessionValue>>
{
    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.sessionRenewOptions.call({
        body: {},
    }) as PublicKeyCredentialRequestOptionsJSON;

    let response: AuthenticationResponseJSON;

    try
    {
        response = await startAuthentication({ optionsJSON });
    }
    catch (error)
    {
        return { ok: false, reason: failureReason(error, 'no-credential'), error };
    }

    const renewed = await api.sessionRenewVerify.call({
        body: { response },
    }) as { keyId?: string };

    return { ok: true, keyId: renewed.keyId ?? '' };
}

/** What a successful disable answers with — the mode the account is now in. */
export interface DisableSessionBindingValue
{
    mode: 'none';
}

export interface DisableSessionBindingOptions
{
    /**
     * The account password, for a browser with no passkey to hand.
     *
     * Send it, or let the ceremony run — one of the two is required. Key age is
     * deliberately not accepted: a session cookie copied in the minutes after a
     * sign-in carries exactly that, and it must not be able to switch the
     * protection off.
     */
    currentPassword?: string;
}

/**
 * Turn session binding off for this account.
 *
 * With `currentPassword` this is one call. Without it, the passkey ceremony runs
 * first and the assertion is what proves ownership — the same ceremony renewal
 * uses, for the same reason.
 *
 * Turning binding *on* needs no ceremony and no helper: it is
 * `api.setSessionBinding.call({ body: { mode: 'passkey' } })`. Leaving is the
 * privileged direction here, which is the reverse of the usual posture and is
 * the whole reason this helper exists.
 */
export async function disableSessionBinding(
    api: AuthApi,
    options: DisableSessionBindingOptions = {},
): Promise<PasskeyResult<DisableSessionBindingValue>>
{
    if (options.currentPassword)
    {
        await api.setSessionBinding.call({ body: { mode: 'none', currentPassword: options.currentPassword } });

        return { ok: true, mode: 'none' };
    }

    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.sessionBindingDisableOptions.call({
        body: {},
    }) as PublicKeyCredentialRequestOptionsJSON;

    let response: AuthenticationResponseJSON;

    try
    {
        response = await startAuthentication({ optionsJSON });
    }
    catch (error)
    {
        return { ok: false, reason: failureReason(error, 'no-credential'), error };
    }

    await api.setSessionBinding.call({ body: { mode: 'none', response } });

    return { ok: true, mode: 'none' };
}
