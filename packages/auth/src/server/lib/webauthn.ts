/**
 * @spfn/auth - WebAuthn Adapter
 *
 * The only module that imports `@simplewebauthn/server`. Everything above it
 * speaks in the four parameter types below, which are ours.
 *
 * Two reasons for the seam. The library refuses by throwing plain `Error`s whose
 * messages are its own — nothing here or above it reads those messages, so the
 * next minor release is free to reword them (the one refusal a caller tells
 * apart, a counter that went backwards, is decided here by comparing counters,
 * not by the library's wording: au7-B5). And a service test that
 * needs a controlled verifier result (a bad signature, a regressed counter) can
 * stub this module, while the happy paths keep running the real cryptography
 * against a fixture authenticator.
 *
 * Attestation is `none` (D10): synced passkeys are the target, and verifying an
 * attestation statement would tell us which authenticator model was used without
 * telling us anything about who is holding it.
 */

import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type AuthenticationResponseJSON,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { PasskeyConfig } from './config';
import type { PasskeyDeviceType } from '../entities/passkeys';

/**
 * The two wire shapes the browser produces, re-exported so nothing above this
 * seam has to name the library either. They are the library's own definitions of
 * what a valid response looks like, and a second copy here would be a second
 * opinion that starts disagreeing the moment the spec grows a field.
 */
export type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
export type {
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

/**
 * A WebAuthn response as it was presented, read once into the form every check
 * of it uses: the credential it names, the challenge its authenticator signed
 * over, and the response itself, of the shape the library verifies.
 */
export interface PresentedResponse<Response>
{
    /** The credential the response names (`id`). */
    credentialId: string;
    /** The challenge the browser echoed back in `clientDataJSON`. */
    challenge: string;
    response: Response;
}

/**
 * Read a presented sign-in assertion (`navigator.credentials.get()`): every
 * field this package or the library dereferences, with its type. The routes
 * take the body as `Unknown`, so this is where its shape is judged — and a
 * body that does not read is not a malformed request but an assertion that
 * does not verify: the caller answers it as it answers a wrong signature.
 *
 * @returns null when the value is not an assertion
 */
export function parseAssertion(presented: unknown): PresentedResponse<AuthenticationResponseJSON> | null
{
    const credential = credentialFields(presented);

    if (!credential || !isString(credential.response.authenticatorData) || !isString(credential.response.signature)
        || !isOptional(credential.response.userHandle, isString))
    {
        return null;
    }

    return { credentialId: credential.credentialId, challenge: credential.challenge, response: presented as AuthenticationResponseJSON };
}

/**
 * Read a presented registration attestation (`navigator.credentials.create()`),
 * as `parseAssertion` reads an assertion.
 *
 * @returns null when the value is not an attestation
 */
export function parseAttestation(presented: unknown): PresentedResponse<RegistrationResponseJSON> | null
{
    const credential = credentialFields(presented);

    if (!credential || !isString(credential.response.attestationObject)
        || !isOptional(credential.response.transports, isStringArray))
    {
        return null;
    }

    return { credentialId: credential.credentialId, challenge: credential.challenge, response: presented as RegistrationResponseJSON };
}

/** The fields an assertion and an attestation share, or null when one is missing or mistyped. */
function credentialFields(presented: unknown): { credentialId: string; challenge: string; response: Record<string, unknown> } | null
{
    if (!isRecord(presented) || !isString(presented.id) || !isString(presented.rawId)
        || presented.type !== 'public-key' || !isRecord(presented.response) || !isString(presented.response.clientDataJSON))
    {
        return null;
    }

    const challenge = echoedChallenge(presented.response.clientDataJSON);

    return challenge === null ? null : { credentialId: presented.id, challenge, response: presented.response };
}

/**
 * The challenge in `clientDataJSON` — the value the authenticator signed over,
 * which the library compares with the one we expect. Read from there rather
 * than from anywhere else in the body, which would let a caller point us at a
 * challenge row that has nothing to do with the assertion.
 */
function echoedChallenge(clientDataJSON: string): string | null
{
    const decoded = parseJson(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));

    return isRecord(decoded) && isString(decoded.challenge) ? decoded.challenge : null;
}

/** `JSON.parse` that answers null instead of throwing: the text is whatever a caller sent. */
function parseJson(text: string): unknown
{
    try
    {
        return JSON.parse(text);
    }
    catch
    {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string
{
    return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[]
{
    return Array.isArray(value) && value.every(isString);
}

function isOptional(value: unknown, is: (value: unknown) => boolean): boolean
{
    return value === undefined || is(value);
}

/** A credential the caller already has, offered so the same one is not enrolled twice. */
export interface KnownCredential
{
    credentialId: string;
    transports: string[] | null;
}

export interface RegistrationOptionsParams
{
    config: PasskeyConfig;
    /** The minted challenge, base64url — exactly what lands in `options.challenge`. */
    challenge: string;
    /** WebAuthn user handle — `users.publicId` bytes, never the row id (D8). */
    userHandle: Uint8Array;
    userName: string;
    userDisplayName: string;
    excludeCredentials: KnownCredential[];
}

export interface VerifyRegistrationParams
{
    config: PasskeyConfig;
    response: RegistrationResponseJSON;
    expectedChallenge: string;
}

/** What enrollment keeps from a verified attestation. */
export interface RegistrationOutcome
{
    /**
     * The authenticator verified the person (PIN, biometric) during this
     * registration, not only their presence. Only such a credential may be
     * marked as a second factor.
     */
    userVerified: boolean;
    credentialId: string;
    /** COSE public key, base64url — the form the column stores. */
    publicKey: string;
    counter: number;
    transports: string[] | null;
    deviceType: PasskeyDeviceType;
    backedUp: boolean;
    /**
     * The authenticator's model, as it claims it — lowercase, hyphenated. Always
     * present: the library refuses a registration without one, and an
     * authenticator that names no model reports the all-zero AAGUID.
     */
    aaguid: string;
}

export interface AuthenticationOptionsParams
{
    config: PasskeyConfig;
    challenge: string;
}

export interface VerifyAuthenticationParams
{
    config: PasskeyConfig;
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: {
        credentialId: string;
        /** COSE public key as stored, base64url. */
        publicKey: string;
        counter: number;
        transports: string[] | null;
    };
}

/**
 * A verified assertion, or why it was refused.
 *
 * `userVerified` is what this assertion proved beyond possession: the
 * authenticator verified the person (PIN, biometric). An assertion without it
 * signs its owner in, and is never a second factor.
 *
 * `counterRegression` is called out because it is the one refusal that is not
 * "this did not verify": the signature was good and the credential is the right
 * one, but the authenticator reported a counter at or below the stored value.
 * The caller logs it by passkey id and leaves the row alone (D11) — a synced
 * passkey reports 0 forever, so auto-revoking would punish the legitimate device
 * on a false positive.
 */
export type AuthenticationOutcome =
    | { verified: true; newCounter: number; userVerified: boolean; deviceType: PasskeyDeviceType; backedUp: boolean }
    | { verified: false; counterRegression: boolean };

/**
 * base64url text → the bytes it encodes.
 *
 * `.slice()` rather than the Buffer itself: the library's byte type is
 * `ReturnType<Uint8Array['slice']>`, which is a view over an ArrayBuffer this
 * value owns — a Buffer is a view into a shared pool and does not narrow to it.
 */
function decodeBase64Url(value: string): ReturnType<Uint8Array['slice']>
{
    return new Uint8Array(Buffer.from(value, 'base64url')).slice();
}

/** Bytes → base64url text, the form every credential field is stored in. */
function encodeBase64Url(value: Uint8Array): string
{
    return Buffer.from(value).toString('base64url');
}

/**
 * The `create()` options for enrolling a new credential on an identified account.
 *
 * `residentKey: 'required'` is what makes the credential discoverable, which is
 * what lets sign-in ask for no identifier at all (D3).
 */
export async function buildRegistrationOptions(
    params: RegistrationOptionsParams,
): Promise<PublicKeyCredentialCreationOptionsJSON>
{
    return await generateRegistrationOptions({
        rpName: params.config.rpName,
        rpID: params.config.rpId,
        userName: params.userName,
        userID: params.userHandle.slice(),
        userDisplayName: params.userDisplayName,
        // Bytes, not the base64url text: the library encodes a string as UTF-8
        // before base64url-ing it, so passing the text would put a different
        // value on the wire than the one this challenge is stored under.
        challenge: decodeBase64Url(params.challenge),
        attestationType: 'none',
        excludeCredentials: params.excludeCredentials.map(credential => ({
            id: credential.credentialId,
            transports: credential.transports ?? undefined,
        })),
        authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: params.config.userVerification,
        },
    });
}

/**
 * Verify an attestation, or say it did not verify.
 *
 * Every refusal the library raises — wrong origin, wrong rpId, a challenge that
 * does not match, a malformed response — comes back the same way. The caller
 * turns them all into one error, because the ceremony is retried identically in
 * each case and naming which one applies describes our configuration to whoever
 * asked.
 */
export async function verifyRegistration(
    params: VerifyRegistrationParams,
): Promise<RegistrationOutcome | null>
{
    const verification = await verifyRegistrationResponse({
        response: params.response,
        expectedChallenge: params.expectedChallenge,
        expectedOrigin: params.config.origins,
        expectedRPID: params.config.rpId,
        requireUserVerification: params.config.userVerification === 'required',
    }).catch(() => null);

    if (!verification?.verified)
    {
        return null;
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid, userVerified } = verification.registrationInfo;

    return {
        userVerified,
        credentialId: credential.id,
        publicKey: encodeBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        aaguid,
    };
}

/**
 * The `get()` options for a discoverable sign-in.
 *
 * `allowCredentials` is left empty on every call, whoever is asking. That is the
 * whole reason this route takes no identifier: an options response that varied
 * by account would answer "does this account exist" to anyone who asked (D3).
 */
export async function buildAuthenticationOptions(
    params: AuthenticationOptionsParams,
): Promise<PublicKeyCredentialRequestOptionsJSON>
{
    return await generateAuthenticationOptions({
        rpID: params.config.rpId,
        // Bytes, for the reason given in buildRegistrationOptions.
        challenge: decodeBase64Url(params.challenge),
        allowCredentials: [],
        userVerification: params.config.userVerification,
    });
}

/**
 * The counter rule of WebAuthn §6.1.1, on the counter the signature covered:
 * a credential that counts must report more than the stored value; one that
 * reports 0 against a stored 0 implements no counter and is never a regression.
 */
function counterRegressed(stored: number, reported: number): boolean
{
    return (stored > 0 || reported > 0) && reported <= stored;
}

/**
 * Verify an assertion against the stored credential.
 *
 * The library is asked to verify everything but the counter — it is handed a
 * stored counter of 0, which its own counter check never refuses — and the
 * counter it then reports as signed is compared here, against the stored one.
 * A regression is therefore recognised from the two numbers, not from the
 * wording of a library error (au7-B5).
 *
 * @returns the verified result, or why it was refused
 */
export async function verifyAuthentication(
    params: VerifyAuthenticationParams,
): Promise<AuthenticationOutcome>
{
    const verification = await verifyAuthenticationResponse({
        response: params.response,
        expectedChallenge: params.expectedChallenge,
        expectedOrigin: params.config.origins,
        expectedRPID: params.config.rpId,
        requireUserVerification: params.config.userVerification === 'required',
        credential: {
            id: params.credential.credentialId,
            publicKey: decodeBase64Url(params.credential.publicKey),
            counter: 0,
            transports: params.credential.transports ?? undefined,
        },
    }).catch(() => null);

    if (!verification?.verified)
    {
        return { verified: false, counterRegression: false };
    }

    const { newCounter, userVerified, credentialDeviceType, credentialBackedUp } = verification.authenticationInfo;

    if (counterRegressed(params.credential.counter, newCounter))
    {
        return { verified: false, counterRegression: true };
    }

    return {
        verified: true,
        newCounter,
        userVerified,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
    };
}
