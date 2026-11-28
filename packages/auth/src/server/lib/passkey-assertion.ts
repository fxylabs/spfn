/**
 * @spfn/auth - What a passkey assertion proved
 *
 * "This passkey counts as a second factor" used to be read from two settings
 * that disagreed: the policy's method list exempted a passkey sign-in from the
 * new-device check, marked or not and verified or not, while user verification
 * was enforced only when configured `required` (au2-A3, au7-A4). A security key
 * with no PIN therefore stood in for a second factor at sign-in, and was refused
 * as one at `mfa/verify`.
 *
 * So the verified assertion itself says what it proved, and every rule reads
 * that: user verification is a property of each assertion, judged on each use.
 * An assertion without it is possession alone — it signs its owner in, and is
 * never a second factor anywhere.
 */

import { isMethodListed } from './second-factor-policy';

/** A verified passkey assertion, by what it showed. */
export interface PasskeyAssertionProof
{
    credentialId: string;
    /** The authenticator verified the person (PIN, biometric), not only their presence. */
    userVerified: boolean;
    /** The owner marked this credential as their second factor. */
    markedSecondFactor: boolean;
}

/**
 * Whether a sign-in by this assertion needs no new-device second factor:
 * possession and verification were both shown, marked or not — while the
 * policy lists passkeys as a second factor at all. Decided from the proof, not
 * from the route it arrived on.
 */
export function exemptsNewDevice(assertion: PasskeyAssertionProof): boolean
{
    return assertion.userVerified && isMethodListed('passkey');
}

/**
 * Whether this assertion proves the account's second factor (`mfa/verify`,
 * `mfa/step-up`): user verification always, and the owner's mark unless the
 * caller accepts any live passkey (the enrolment-only step-up, #309).
 */
export function provesSecondFactor(assertion: PasskeyAssertionProof, candidates: 'marked' | 'live'): boolean
{
    return assertion.userVerified && isCandidatePasskey(assertion.markedSecondFactor, candidates);
}

/**
 * Whether a live passkey of the account is one a second-factor proof may come
 * from: one the owner marked, or any live one when the caller accepts that.
 * The proof judgement asks it of the asserting passkey, the step-up window of
 * the passkey a verification names (#539).
 */
export function isCandidatePasskey(markedSecondFactor: boolean, candidates: 'marked' | 'live'): boolean
{
    return candidates === 'live' || markedSecondFactor;
}
