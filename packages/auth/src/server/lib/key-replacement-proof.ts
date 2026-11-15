/**
 * @spfn/auth - Key Replacement Proof
 *
 * The one thing that makes a sign-in a *replacement* of a device's key rather
 * than a new device: a short-lived JWT signed with the old private key, naming
 * the old key and the new one. A key id is an identifier, not a secret — it is
 * in every request token and in the device notice — so naming it proves
 * nothing; only its private key can.
 *
 * The proof is told apart from a request token in both directions. It carries
 * its own issuer, which `verifyClientToken` (pinned to `spfn-client`) refuses,
 * and no `keyId` claim, which `authenticate` needs before it looks a key up. A
 * request token presented here fails the issuer and the `purpose` check.
 *
 * Signed by the Next.js proxy from the private key in the sealed session
 * cookie, and by a native client from the key it holds; verified by
 * `registerPublicKeyService` against the stored public key of the old key.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import { type KeyAlgorithmType } from '../types';
import { generateClientToken } from './crypto';

/** The `iss` of a replacement proof — never `spfn-client`, which request tokens use. */
export const KEY_REPLACEMENT_PROOF_ISSUER = 'spfn-key-replacement';

/** The `purpose` claim, checked as well as the issuer. */
export const KEY_REPLACEMENT_PROOF_PURPOSE = 'key-replacement';

/**
 * How long a proof is accepted after it was issued, by the server's clock.
 *
 * The proof's `iat` has to lie within this many seconds before the server's
 * now, whatever its `exp` says — so neither a longer expiry nor an issue time
 * dated ahead buys a proof more than this.
 */
export const KEY_REPLACEMENT_PROOF_MAX_AGE_SECONDS = 60;

/**
 * How far ahead of the server's clock a proof's `iat` may lie: the skew between
 * the signer's clock and this one, and nothing more.
 */
export const KEY_REPLACEMENT_PROOF_CLOCK_SKEW_SECONDS = 10;

/** What a verified proof says: this old key is being replaced by this new one. */
export interface KeyReplacementClaims
{
    oldKeyId: string;
    newKeyId: string;
}

/**
 * Sign a replacement proof with the old key's private half.
 *
 * @param privateKey - Base64 DER (PKCS#8) of the key being replaced
 * @param algorithm - the algorithm that key was registered under
 */
export function signKeyReplacementProof(
    claims: KeyReplacementClaims,
    privateKey: string,
    algorithm: KeyAlgorithmType,
): string
{
    return generateClientToken(
        { purpose: KEY_REPLACEMENT_PROOF_PURPOSE, oldKeyId: claims.oldKeyId, newKeyId: claims.newKeyId },
        privateKey,
        algorithm,
        { issuer: KEY_REPLACEMENT_PROOF_ISSUER, expiresIn: KEY_REPLACEMENT_PROOF_MAX_AGE_SECONDS },
    );
}

/**
 * The old key id a proof names, read without verifying anything.
 *
 * Only to find which stored public key to verify the proof against — nothing is
 * decided by it. Null for anything that does not decode to a string claim.
 */
export function keyIdClaimedByProof(proof: string): string | null
{
    const decoded = jwt.decode(proof);

    return decoded && typeof decoded === 'object' && typeof decoded.oldKeyId === 'string'
        ? decoded.oldKeyId
        : null;
}

/**
 * The claims of a proof that verifies against the old key's stored public key,
 * or null for one that does not — a bad signature, another issuer or purpose,
 * an expired proof, one issued outside the window around the server's clock, or
 * claims of the wrong shape.
 *
 * Null rather than a throw: on a sign-in an unverifiable proof is not an error,
 * it only means the registration is a new device.
 */
export function verifyKeyReplacementProof(
    proof: string,
    oldKey: { publicKey: string; algorithm: KeyAlgorithmType },
): KeyReplacementClaims | null
{
    const payload = verifiedPayload(proof, oldKey);

    if (!payload
        || !issuedJustNow(payload.iat)
        || payload.purpose !== KEY_REPLACEMENT_PROOF_PURPOSE
        || typeof payload.oldKeyId !== 'string'
        || typeof payload.newKeyId !== 'string')
    {
        return null;
    }

    return { oldKeyId: payload.oldKeyId, newKeyId: payload.newKeyId };
}

/**
 * Whether a proof's issue time lies in `[now − max age, now + skew]` by this
 * server's clock. The window is measured here and only here: a lifetime read off
 * the proof's own claims is one its signer chose.
 */
function issuedJustNow(iat: unknown): boolean
{
    const now = Math.floor(Date.now() / 1000);

    return typeof iat === 'number'
        && iat >= now - KEY_REPLACEMENT_PROOF_MAX_AGE_SECONDS
        && iat <= now + KEY_REPLACEMENT_PROOF_CLOCK_SKEW_SECONDS;
}

function verifiedPayload(
    proof: string,
    oldKey: { publicKey: string; algorithm: KeyAlgorithmType },
): jwt.JwtPayload | null
{
    try
    {
        const payload = jwt.verify(proof, crypto.createPublicKey({
            key: Buffer.from(oldKey.publicKey, 'base64'),
            format: 'der',
            type: 'spki',
        }), {
            algorithms: [oldKey.algorithm],
            issuer: KEY_REPLACEMENT_PROOF_ISSUER,
        });

        return typeof payload === 'object' ? payload : null;
    }
    catch
    {
        return null;
    }
}
