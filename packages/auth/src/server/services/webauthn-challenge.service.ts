/**
 * @spfn/auth - WebAuthn Challenge Handling
 *
 * The five things every WebAuthn ceremony in this package does with its nonce:
 * mint one, hash a presented one the way it was stored, read whether it is
 * still live, spend it exactly once, and read back the value the browser
 * actually signed over.
 *
 * The order is one rule for every ceremony: read the challenge, verify the
 * response outside the account lock, then spend the challenge inside the
 * locked transaction, together with what the ceremony writes. A lock wait that
 * runs out (`AccountBusyError`, "retry") therefore leaves the challenge live
 * for the retry, and the account row is locked before the challenge row — the
 * order the account purge's cascade takes them in.
 *
 * Lifted out of `passkey.service.ts` when the second factor became the third
 * ceremony (#95). Both callers need identical behaviour and neither may import
 * the other — `passkey.service.ts` calls `assertStepUp`, so the dependency runs
 * one way — which is what makes this its own module rather than an export of
 * either.
 *
 * `challengeIsLive` and `spendChallenge` answer a boolean instead of throwing,
 * because the refusal differs by caller: a passkey ceremony answers
 * `PasskeyChallengeError` and a step-up answers `MfaVerificationFailedError`,
 * and each is the uniform body its own surface promises.
 */

import crypto from 'crypto';

import { getPasskeyConfig } from '../lib/config';
import { webauthnChallengesRepository } from '../repositories';
import type { NewWebAuthnChallenge, WebAuthnChallenge, WebAuthnChallengeKind } from '../entities/webauthn-challenges';
import { stampColumns, type DeferredStamp } from '../lib/deferred-stamp';

/**
 * Bytes of entropy in a challenge.
 *
 * The WebAuthn spec asks for at least 16; 32 matches every other nonce this
 * package mints and leaves no reason to think about the number again.
 */
const CHALLENGE_BYTES = 32;

/**
 * Mint a challenge and park it, returning the value that goes on the wire.
 *
 * Only the SHA-256 reaches the row, so the stored form cannot be presented.
 *
 * @param kind - Which ceremony it may be spent on
 * @param userId - The account it belongs to, or null for a discoverable login
 */
export async function mintChallenge(kind: WebAuthnChallengeKind, userId: number | null): Promise<string>
{
    return await parkChallenge(kind, { userId });
}

/**
 * Mint a challenge for a ceremony a signed-in person starts, stamped with the
 * credential that started it and the account's key generation
 * (`lib/deferred-stamp.ts`): its completion is admitted against that stamp
 * (`admitDeferred`).
 *
 * @param passwordProvenAt - When the start was answered with the account
 *   password: a proof that belongs to this procedure, read back at its completion
 */
export async function mintStampedChallenge(
    kind: WebAuthnChallengeKind,
    stamp: DeferredStamp,
    passwordProvenAt: Date | null = null,
): Promise<string>
{
    return await parkChallenge(kind, { userId: stamp.userId, ...stampColumns(stamp), passwordProvenAt });
}

async function parkChallenge(
    kind: WebAuthnChallengeKind,
    owner: Pick<NewWebAuthnChallenge, 'userId' | 'startedByKeyId' | 'startedByProfile' | 'keyEpoch' | 'passwordProvenAt'>,
): Promise<string>
{
    const challenge = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');

    await webauthnChallengesRepository.create({
        ...owner,
        challengeHash: hashChallenge(challenge),
        kind,
        expiresAt: new Date(Date.now() + getPasskeyConfig().challengeTtlMs),
    });

    return challenge;
}

/** Hash a presented challenge the way it was stored. */
export function hashChallenge(challenge: string): string
{
    return crypto.createHash('sha256').update(challenge).digest('base64url');
}

/**
 * Whether the challenge this ceremony was started with is still one it may
 * spend — read, not spent. Asked before the response is verified, so an
 * unknown or used challenge costs no signature check; the spend comes later,
 * under the account lock (`spendChallenge`).
 *
 * Unknown, expired, already spent, another ceremony's kind, or another
 * account's — all one answer, because the remedy is the same in every case and
 * naming which applies describes a challenge the caller did not mint.
 *
 * @param owner - The account it was minted for, or null for a discoverable login
 */
export async function challengeIsLive(
    challenge: string,
    kind: WebAuthnChallengeKind,
    owner: number | null,
): Promise<boolean>
{
    return await liveChallenge(challenge, kind, owner) !== null;
}

/**
 * The challenge row `challengeIsLive` reads, for a ceremony whose completion
 * asks the row's stamp (`stampOf`). Null on every refusal alike.
 */
export async function liveChallenge(
    challenge: string,
    kind: WebAuthnChallengeKind,
    owner: number | null,
): Promise<WebAuthnChallenge | null>
{
    return await webauthnChallengesRepository.findLive(hashChallenge(challenge), kind, owner);
}

/**
 * Spend the challenge, inside the transaction that holds `accountId`'s lock
 * and writes what the ceremony earned. False when it is no longer there to
 * spend — another request with the same assertion got to it first.
 *
 * @param accountId - The locked account: the challenge's owner, or for a
 *   discoverable login the account the passkey signed in to
 */
export async function spendChallenge(
    challenge: string,
    kind: WebAuthnChallengeKind,
    accountId: number,
): Promise<boolean>
{
    return await webauthnChallengesRepository.consume(accountId, hashChallenge(challenge), kind);
}

/**
 * The challenge the browser echoed back, read out of `clientDataJSON`.
 *
 * Read here rather than trusted from elsewhere in the body: this is the value
 * the authenticator actually signed over, and the library compares it against
 * what we say we expect. Taking it from anywhere else would let a caller point
 * us at a challenge row that has nothing to do with the assertion.
 */
export function presentedChallenge(clientDataJSON: string): string
{
    const decoded = parseJson(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };

    return typeof decoded?.challenge === 'string' ? decoded.challenge : '';
}

/**
 * `JSON.parse` that answers null instead of throwing.
 *
 * The body is whatever a caller sent, and a malformed `clientDataJSON` has to
 * come out as the ordinary refusal rather than as a 500: the empty challenge it
 * yields matches no row, which is exactly the answer an unusable ceremony
 * deserves.
 */
function parseJson(text: string): Record<string, unknown> | null
{
    try
    {
        return JSON.parse(text) as Record<string, unknown>;
    }
    catch
    {
        return null;
    }
}
