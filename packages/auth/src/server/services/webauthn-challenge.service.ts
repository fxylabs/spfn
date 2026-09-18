/**
 * @spfn/auth - WebAuthn Challenge Handling
 *
 * The four things every WebAuthn ceremony in this package does with its nonce:
 * mint one, hash a presented one the way it was stored, spend it exactly once,
 * and read back the value the browser actually signed over.
 *
 * Lifted out of `passkey.service.ts` when the second factor became the third
 * ceremony (#95). Both callers need identical behaviour and neither may import
 * the other — `passkey.service.ts` calls `assertStepUp`, so the dependency runs
 * one way — which is what makes this its own module rather than an export of
 * either.
 *
 * `spendChallenge` answers a boolean instead of throwing, because the refusal
 * differs by caller: a passkey ceremony answers `PasskeyChallengeError` and a
 * step-up answers `MfaVerificationFailedError`, and each is the uniform body its
 * own surface promises.
 */

import crypto from 'crypto';

import { getPasskeyConfig } from '../lib/config';
import { webauthnChallengesRepository } from '../repositories';
import type { WebAuthnChallengeKind } from '../entities/webauthn-challenges';

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
    const challenge = crypto.randomBytes(CHALLENGE_BYTES).toString('base64url');

    await webauthnChallengesRepository.create({
        challengeHash: hashChallenge(challenge),
        kind,
        userId,
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
 * Spend the challenge this ceremony was started with.
 *
 * Unknown, expired, already spent, another ceremony's kind, or another
 * account's — all one answer, because the remedy is the same in every case and
 * naming which applies describes a challenge the caller did not mint.
 *
 * @returns true when this call spent a challenge of that kind for that account
 */
export async function spendChallenge(
    challenge: string,
    kind: WebAuthnChallengeKind,
    userId: number | null,
): Promise<boolean>
{
    const spent = await webauthnChallengesRepository.consume(hashChallenge(challenge), kind);

    return Boolean(spent) && spent!.userId === userId;
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
