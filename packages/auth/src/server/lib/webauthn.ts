/**
 * @spfn/auth - WebAuthn Adapter
 *
 * The only module that imports `@simplewebauthn/server`. Everything above it
 * speaks in the four parameter types below, which are ours.
 *
 * Two reasons for the seam. The library refuses by throwing plain `Error`s whose
 * messages are its own — a service that caught those directly would be matching
 * on strings the next minor release is free to reword. And a service test that
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
    credentialId: string;
    /** COSE public key, base64url — the form the column stores. */
    publicKey: string;
    counter: number;
    transports: string[] | null;
    deviceType: PasskeyDeviceType;
    backedUp: boolean;
    aaguid: string | null;
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
 * `counterRegression` is called out because it is the one refusal that is not
 * "this did not verify": the signature was good and the credential is the right
 * one, but the authenticator reported a counter at or below the stored value.
 * The caller logs it by passkey id and leaves the row alone (D11) — a synced
 * passkey reports 0 forever, so auto-revoking would punish the legitimate device
 * on a false positive.
 */
export type AuthenticationOutcome =
    | { verified: true; newCounter: number; deviceType: PasskeyDeviceType; backedUp: boolean }
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

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;

    return {
        credentialId: credential.id,
        publicKey: encodeBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? null,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        aaguid: aaguid || null,
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

/** Whether a library refusal was the counter check rather than the cryptography. */
function isCounterRegression(error: unknown): boolean
{
    return error instanceof Error && /counter value/i.test(error.message);
}

/**
 * Verify an assertion against the stored credential.
 *
 * @returns the verified result, or why it was refused
 */
export async function verifyAuthentication(
    params: VerifyAuthenticationParams,
): Promise<AuthenticationOutcome>
{
    try
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
                counter: params.credential.counter,
                transports: params.credential.transports ?? undefined,
            },
        });

        if (!verification.verified)
        {
            return { verified: false, counterRegression: false };
        }

        const { newCounter, credentialDeviceType, credentialBackedUp } = verification.authenticationInfo;

        return {
            verified: true,
            newCounter,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
        };
    }
    catch (error)
    {
        return { verified: false, counterRegression: isCounterRegression(error) };
    }
}
