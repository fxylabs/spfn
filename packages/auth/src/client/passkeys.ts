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

import type { AuthApi } from '@spfn/auth';

/** The typed auth client these helpers drive: `authApi`, or one built with `createAuthApi`. */
export type { AuthApi };

/**
 * Why a ceremony did not produce a session.
 *
 * - `unsupported`: this browser has no WebAuthn at all
 * - `cancelled`: the person dismissed the prompt
 * - `no-credential`: the authenticator had nothing for this relying party.
 *   From `enrollPasskey`: the account has session binding on, and the proof
 *   prompt (an assertion with a passkey it already holds) was dismissed or this
 *   device offered none of its passkeys. When the proof was asked only after
 *   the registration prompt, the result carries `retry`
 * - `busy`: the server answered 503 — another change to the account held it
 *   (`AccountBusyError`). Retryable: the session is not over, and nothing was
 *   spent. One rule for every helper: a retry never needs the authenticator to
 *   make something new. An assertion leaves nothing behind, so `renewSession`
 *   and `stepUpWithPasskey` are simply called again; a registration made a
 *   credential on the authenticator, so `enrollPasskey`'s `busy` carries
 *   `retry`, which posts that same attestation again — as does every other
 *   way `enrollPasskey` ends after the registration prompt without the
 *   passkey stored, a rejection included (`enrollPasskeyRetryOf`)
 * - `error`: anything else, with the original error attached
 */
export type PasskeyFailureReason = 'unsupported' | 'cancelled' | 'no-credential' | 'busy' | 'error';

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
    /**
     * The `passkeyAdd` proof the app already ran (`provePasskey(api, 'passkeyAdd')`),
     * sent as given: the session binding is not read and no proof prompt is shown.
     */
    passkeyResponse?: AuthenticationResponseJSON;
    /**
     * A `retry` handed back after the registration prompt — a `busy` or
     * `no-credential` result's, or a rejection's (`enrollPasskeyRetryOf`):
     * `register/verify` is posted again with the attestation and proof it
     * carried. No binding read and no registration prompt; the proof prompt
     * only if the verify asks the proof and the app did not supply it. The
     * other options are not read; the label travels in it.
     *
     * The registration's challenge lives `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS`
     * (five minutes by default) and is spent by the post that stores the
     * passkey. After either, the re-post answers 401 `PasskeyChallengeError` —
     * so does one whose first post was stored but its answer lost to the
     * network (the passkey list says which) — and a new ceremony is the only
     * way.
     */
    retry?: EnrollPasskeyRetry;
}

/** What `register/verify` is posted. */
export interface EnrolmentBody
{
    response: RegistrationResponseJSON;
    label?: string;
    passkeyResponse?: AuthenticationResponseJSON;
}

/**
 * A `register/verify` that did not store the passkey, kept to be posted again:
 * hand it back as `enrollPasskey(api, { retry })`. Built by the helper, not by
 * the app.
 */
export interface EnrollPasskeyRetry
{
    readonly body: EnrolmentBody;
    /** Whether a `PASSKEY_PROOF_REQUIRED` may still be answered with the helper's own proof. */
    readonly mayProve: boolean;
}

/**
 * `PasskeyResult`, with `retry` set on a failure after the registration
 * prompt: `busy`, and `no-credential` when the proof was asked after it.
 */
export type EnrollPasskeyResult =
    | ({ ok: true } & EnrollPasskeyValue)
    | { ok: false; reason: PasskeyFailureReason; error?: unknown; retry?: EnrollPasskeyRetry };

export interface EnrollPasskeyValue
{
    passkeyId: string;
    label: string | null;
    createdAt: string;
    /**
     * Present when the app requires a second factor and this session could only
     * enrol one: the passkey was also marked as the second factor, and the
     * session is ordinary from its next request.
     */
    mfaStatus?: {
        enrolled: boolean;
        methods: ('totp' | 'passkey')[];
        recoveryCodesRemaining: number;
    };
}

/**
 * Enroll a passkey on the device in front of the user.
 *
 * Requires a signed-in session. A 403 with code `RECENT_AUTH_REQUIRED` from the
 * options call means the caller should prompt for the password and try again
 * with `currentPassword`; that is a rejected promise, not a result here, because
 * it is the server declining rather than the ceremony failing.
 *
 * An account with session binding on must prove a passkey it already holds to
 * add one (`passkeyAdd`, 403 `PASSKEY_PROOF_REQUIRED` without it). So the
 * binding is read first, and a bound account sees two prompts: the proof
 * (`navigator.credentials.get()`), then the registration (`create()`). The proof
 * comes first because the registration's credential is made on the
 * authenticator before the server is asked: a proof dismissed after it would
 * leave a passkey in the person's password manager that the account never
 * stored. A binding read that fails is not an answer: its refusal (say 403
 * `SECOND_FACTOR_ENROLMENT_REQUIRED`) or network error is thrown before any
 * prompt. If the verify still asks the proof — binding turned on since the
 * read — the proof runs once and the same attestation is sent again; its
 * challenge was not spent. A second refusal is thrown, and so is the first
 * when the app supplied the proof.
 *
 * A dismissed proof prompt is `no-credential`, a dismissed registration prompt
 * `cancelled`, and a 503 at the verify `busy` (`AccountBusyError`: nothing was
 * written or spent). Once the registration prompt has made the credential,
 * every way this ends without it stored hands back `retry`: on the result
 * (`busy`; `no-credential` from a proof asked after it), or on the rejected
 * error, which is otherwise the server's refusal or the network's `TypeError`
 * as it came (`enrollPasskeyRetryOf(error)`) — a rejection, as every helper
 * here rejects a failed call. `enrollPasskey(api, { retry })` posts the same
 * attestation again, with no registration prompt.
 */
export async function enrollPasskey(
    api: AuthApi,
    options: EnrollPasskeyOptions = {},
): Promise<EnrollPasskeyResult>
{
    if (options.retry !== undefined)
    {
        return await verifyEnrolment(api, options.retry);
    }

    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const proof = options.passkeyResponse === undefined
        ? await provePasskeyIfBound(api)
        : { ok: true as const, passkeyResponse: options.passkeyResponse };

    if (!proof.ok)
    {
        return proof;
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

    return await verifyEnrolment(api, {
        body: { response, label: options.label, passkeyResponse: proof.passkeyResponse },
        mayProve: options.passkeyResponse === undefined,
    });
}

/**
 * The `passkeyAdd` proof when the account has session binding on; no proof,
 * and no prompt, when the read answers that it has not.
 *
 * A read that fails rejects as itself — a refusal, a network error — before
 * any ceremony: not knowing the binding is not "unbound", and registering
 * blind on a bound account leaves a credential the server never stores.
 */
async function provePasskeyIfBound(api: AuthApi): Promise<PasskeyResult<Partial<PasskeyProofValue>>>
{
    const binding = await api.getSessionBinding.call();

    return binding.mode === 'passkey' ? await provePasskey(api, 'passkeyAdd') : { ok: true };
}

/**
 * `register/verify`, with the proof asked and the same attestation sent once
 * more when it answers `PASSKEY_PROOF_REQUIRED` and `mayProve`. A 503 is
 * `busy`, carrying the post to make again.
 */
async function verifyEnrolment(api: AuthApi, retry: EnrollPasskeyRetry): Promise<EnrollPasskeyResult>
{
    return await api.passkeyRegisterVerify.call({ body: retry.body }).then(
        (enrolled): EnrollPasskeyResult => ({ ok: true, ...enrolled as EnrollPasskeyValue }),
        (error: unknown): EnrollPasskeyResult | Promise<EnrollPasskeyResult> =>
        {
            if (isServiceUnavailable(error))
            {
                return { ok: false, reason: 'busy', error, retry };
            }

            return retry.mayProve && isPasskeyProofRequired(error)
                ? proveAndResend(api, retry)
                : rejectCarrying(retry)(error);
        },
    );
}

/**
 * The proof `register/verify` asked for, and the attestation sent again with
 * it. A proof that did not happen, or a rejection of either call, hands back
 * the first post: re-posted, it is asked the proof again, which a refused
 * proof needs.
 */
async function proveAndResend(api: AuthApi, retry: EnrollPasskeyRetry): Promise<EnrollPasskeyResult>
{
    const proof = await provePasskey(api, 'passkeyAdd').catch(rejectCarrying(retry));

    if (!proof.ok)
    {
        return { ...proof, retry };
    }

    return await verifyEnrolment(api, {
        body: { ...retry.body, passkeyResponse: proof.passkeyResponse },
        mayProve: false,
    }).catch(rejectCarrying(retry));
}

/**
 * Rejects with the error as it came — the server's class, the transport's
 * `TypeError` — carrying `retry`, so a rejection after `create()` still hands
 * back the attestation the authenticator made.
 */
function rejectCarrying(retry: EnrollPasskeyRetry): (error: unknown) => Promise<never>
{
    return error => Promise.reject(Object.assign(
        error !== null && typeof error === 'object' ? error : new Error(String(error), { cause: error }),
        { retry },
    ));
}

/**
 * The `retry` an `enrollPasskey` rejection carries: present on every rejection
 * after the registration prompt made a credential, absent before it.
 */
export function enrollPasskeyRetryOf(error: unknown): EnrollPasskeyRetry | undefined
{
    return (error as { retry?: EnrollPasskeyRetry } | null)?.retry;
}

/**
 * A 403 `PASSKEY_PROOF_REQUIRED`, read by name as `mfa-confirm-flow` reads its
 * errors: `authApi` restores the class, a client built without the registry
 * throws an `ApiError` whose `response` is the envelope.
 */
function isPasskeyProofRequired(error: unknown): boolean
{
    const answered = error as { name?: unknown; code?: unknown; response?: { __type?: unknown } } | null;

    return [answered?.name, answered?.code, answered?.response?.__type]
        .some(name => name === 'PasskeyProofRequiredError' || name === 'PASSKEY_PROOF_REQUIRED');
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
    /**
     * `true` only under a second-factor policy that does not list passkeys
     * (#309): the account has a listed factor and this device is new, so the
     * answer is a challenge rather than a session — the fields above are then
     * absent. Finish it with `completeMfaWithCode` and `challenge.secret`.
     */
    mfaRequired?: boolean;
    challenge?: { secret: string; expiresAtMillis: number };
    /** `true` when the session may only enrol a second factor (#309). */
    secondFactorEnrolmentRequired?: boolean;
}

/**
 * Sign in with a passkey, no identifier asked for.
 *
 * The device key the session runs on is generated and stored by the Next.js
 * proxy interceptor, exactly as on a password login — nothing here handles a
 * private key.
 *
 * Passkey sign-in is off unless the app sets `channels.passkeyLogin: true` in
 * `createAuthLifecycle({ channels })`; while it is off both calls answer 404
 * `CHANNEL_DISABLED` (`ChannelDisabledError`), and the rejection reaches the
 * caller as thrown.
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
 *
 * A 503 is neither: the account was busy with another change
 * (`AccountBusyError`, with `Retry-After`), the renewal wrote nothing, and its
 * challenge is unspent. It comes back as `{ ok: false, reason: 'busy' }` so an
 * app does not read it as a refusal and send a signed-in person to sign in;
 * calling `renewSession` again is the answer.
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
    }).then(
        value => value as { keyId: string },
        (error: unknown) => isServiceUnavailable(error) ? { busy: error } : Promise.reject(error),
    );

    return 'busy' in renewed
        ? { ok: false, reason: 'busy', error: renewed.busy }
        : { ok: true, keyId: renewed.keyId };
}

/**
 * A 503 from the server, as the client hands it over: a restored error class
 * carries `statusCode`, an `ApiError` carries `status`.
 */
function isServiceUnavailable(error: unknown): boolean
{
    const answered = error as { statusCode?: unknown; status?: unknown } | null;

    return answered?.statusCode === 503 || answered?.status === 503;
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
 * Turning binding *on* is `provePasskey(api, 'bindingEnable')`, then
 * `api.setSessionBinding.call({ body: { mode: 'passkey', passkeyResponse } })`.
 * Leaving is the privileged direction here, which is the reverse of the usual
 * posture and is the whole reason this helper exists.
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

/**
 * The procedures by which a session lets another credential into an account —
 * each asks a passkey proof when the account has session binding on — and
 * turning binding on, which asks one of every account. Read off the route's
 * input, so it is the list the server accepts; a refusal names one as
 * `details.procedure`.
 */
export type PasskeyProofProcedure = Parameters<AuthApi['passkeyProofOptions']['call']>[0]['body']['procedure'];

/** The assertion to send as that procedure's `passkeyResponse`. */
export interface PasskeyProofValue
{
    passkeyResponse: AuthenticationResponseJSON;
}

/**
 * Run the passkey ceremony one procedure asks of an account with session
 * binding on — after it answered 403 `PASSKEY_PROOF_REQUIRED`, or up front —
 * and hand back the assertion to send with it.
 *
 * @example
 * const proof = await provePasskey(api, 'deviceApprove');
 * if (proof.ok)
 * {
 *     await api.approveDeviceAuth.call({ body: { userCode, passkeyResponse: proof.passkeyResponse } });
 * }
 */
export async function provePasskey(
    api: AuthApi,
    procedure: PasskeyProofProcedure,
): Promise<PasskeyResult<PasskeyProofValue>>
{
    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.passkeyProofOptions.call({
        body: { procedure },
    }) as PublicKeyCredentialRequestOptionsJSON;

    try
    {
        return { ok: true, passkeyResponse: await startAuthentication({ optionsJSON }) };
    }
    catch (error)
    {
        return { ok: false, reason: failureReason(error, 'no-credential'), error };
    }
}

// ============================================================================
// Second-factor step-up on a new device (#95)
// ============================================================================

/**
 * What a completed step-up answers with — the sign-in the 202 was standing in for.
 *
 * Deliberately loose about the login fields. Through the Next.js proxy the
 * session is already sealed by the time this resolves and the app reads it from
 * the session cookie; a native client reads `userId` off the body. `keyId` and
 * `challengeHash` are the proxy's business and are not repeated here.
 */
export interface CompleteMfaValue
{
    userId?: string;
    keyId: string;
}

/**
 * Finish a sign-in that answered `mfaRequired` with a code from the
 * authenticator app.
 *
 * The challenge is the `secret` from that 202 — or, on the web OAuth path, the
 * `?challenge=` the callback handler put on the confirm page's URL. It is single
 * use and lives ten minutes.
 *
 * A wrong code is a rejected promise carrying `MfaVerificationFailedError`, not
 * a result: it is the server declining rather than a ceremony failing, and there
 * is no ceremony here at all. Five wrong ones end the challenge and the person
 * signs in again.
 *
 * @param api - the typed auth client
 * @param challenge - the challenge secret from the 202 or the callback query
 * @param code - the six digits, spaces and dashes and all
 */
export async function completeMfaWithCode(
    api: AuthApi,
    challenge: string,
    code: string,
): Promise<CompleteMfaValue>
{
    return await api.mfaVerify.call({ body: { challenge, code } }) as CompleteMfaValue;
}

/**
 * Finish the same sign-in with one of the ten written-down recovery codes.
 *
 * Single use, and the count in `mfa/status` drops by one — an app that warns at
 * two remaining reads it from there after this resolves.
 */
export async function completeMfaWithRecoveryCode(
    api: AuthApi,
    challenge: string,
    recoveryCode: string,
): Promise<CompleteMfaValue>
{
    return await api.mfaVerify.call({ body: { challenge, recoveryCode } }) as CompleteMfaValue;
}

/**
 * Finish the same sign-in with a passkey the owner marked as a second factor.
 *
 * `options` from the server, `navigator.credentials` in the browser, `verify`
 * back — the shape every ceremony in this file has, and a discriminated union
 * rather than a throw for the same reason: a person who dismisses the system
 * sheet has not hit an application error.
 *
 * The challenge is what names the account, since there is no session yet. A
 * passkey the owner never marked is refused with the same body as a wrong code.
 */
export async function completeMfaWithPasskey(
    api: AuthApi,
    challenge: string,
): Promise<PasskeyResult<CompleteMfaValue>>
{
    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.mfaVerifyOptions.call({
        body: { challenge },
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

    const verified = await api.mfaVerify.call({ body: { challenge, response } }) as CompleteMfaValue;

    return { ok: true, ...verified };
}

// ============================================================================
// Step-up on this device (#372, #393)
// ============================================================================

/** The assertion to send as `{ response }`, to `mfa/step-up` or to the app's own route. */
export interface StepUpAssertionValue
{
    response: AuthenticationResponseJSON;
}

/**
 * Run the passkey ceremony of a step-up and hand back the assertion, unspent —
 * for an app route that takes a second-factor proof itself
 * (`checkSecondFactorProof(userId, { response }, { kind: 'stepUp', credential })`,
 * then `spend()`), or for `mfa/step-up` (`stepUpWithPasskey`).
 *
 * `mfa/step-up/options` and `navigator.credentials`; nothing is posted after.
 * The assertion is spent once, by whichever of `mfa/step-up` or the app's
 * `spend()` runs first; only the session that asked for it can spend it. It is
 * not tied to an action: what it authorizes is the app's to decide. It proves
 * the second factor as at `mfa/step-up`: with user verification, from a passkey
 * marked as a second factor while the policy lists `'passkey'`; anything else
 * is a wrong proof. In the enrolment-only state any live passkey proves it, but
 * an app route never meets that state: `authenticate` refuses such a session
 * 403 `SECOND_FACTOR_ENROLMENT_REQUIRED` before app code runs.
 *
 * A dismissed prompt is `no-credential`, as for the other assertions here,
 * whose `allowCredentials` is empty too. A refusal of the options call is a
 * rejected promise.
 *
 * @example
 * const proof = await stepUpAssertion(api);
 * if (proof.ok)
 * {
 *     await appApi.exportData.call({ body: { response: proof.response } });   // the app's own route
 * }
 */
export async function stepUpAssertion(api: AuthApi): Promise<PasskeyResult<StepUpAssertionValue>>
{
    if (!isPasskeySupported())
    {
        return { ok: false, reason: 'unsupported' };
    }

    const optionsJSON = await api.mfaStepUpOptions.call({
        body: {},
    }) as PublicKeyCredentialRequestOptionsJSON;

    try
    {
        return { ok: true, response: await startAuthentication({ optionsJSON }) };
    }
    catch (error)
    {
        return { ok: false, reason: failureReason(error, 'no-credential'), error };
    }
}

/**
 * Prove the second factor again on a signed-in device with a passkey, so the
 * change that answered 403 `STEP_UP_REQUIRED` can be retried.
 *
 * `stepUpAssertion`, then `mfa/step-up` with `{ response }` — and the same
 * split `completeMfaWithPasskey` makes: a ceremony that did not happen is a
 * result, the server declining is a rejected promise. A passkey the owner never
 * marked, or an assertion without user verification, is `MfaVerificationFailedError`
 * (401, with the body a wrong code gets); too many wrong proofs, 429
 * `SECOND_FACTOR_LOCKED`.
 *
 * A 503 is neither: the account was busy with another change
 * (`AccountBusyError`), and the assertion's challenge was not spent. It comes
 * back as `{ ok: false, reason: 'busy' }`, as from `renewSession`; calling
 * `stepUpWithPasskey` again is the answer. (An app holding the assertion from
 * `stepUpAssertion` can post that same assertion again instead.)
 *
 * @example
 * const stepUp = await stepUpWithPasskey(api);
 * if (stepUp.ok)
 * {
 *     await api.changePassword.call({ body: { currentPassword, newPassword } });
 * }
 */
export async function stepUpWithPasskey(api: AuthApi): Promise<PasskeyResult<{}>>
{
    const proof = await stepUpAssertion(api);

    if (!proof.ok)
    {
        return proof;
    }

    return await api.mfaStepUp.call({ body: { response: proof.response } }).then(
        (): PasskeyResult<{}> => ({ ok: true }),
        (error: unknown) => isServiceUnavailable(error)
            ? { ok: false, reason: 'busy', error }
            : Promise.reject(error),
    );
}
