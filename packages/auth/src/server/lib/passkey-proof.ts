/**
 * @spfn/auth - Passkey proof for letting another credential in
 *
 * Session binding rests on one premise: a copied session cookie does not hold
 * the passkey, so at its key's expiry the copy ends. A session that could hand
 * out a credential outliving its own key — approve a device-code sign-in for a
 * key of its own, issue a device link, add a passkey, set a first password,
 * link a social identity, consent to an OAuth2 client — would turn the copy's
 * live hours into a way in for good. So on an account with binding on, each of
 * those procedures asks a passkey assertion made for it.
 *
 * Each procedure is its own challenge kind (`PASSKEY_PROOF_PROCEDURES`),
 * stamped with the session that asked (`lib/deferred-stamp.ts`): an assertion
 * made to approve a device does not issue a link, and only the session that
 * asked can spend it. A second factor or the password does not satisfy it:
 * binding's premise is the passkey, and a copied session may well hold a
 * step-up its original just made. The check is the renewal-grade
 * assertion binding-off already uses (`checkRenewalAssertionService`), so an
 * assertion that does not verify spends its challenge: callers run
 * `checkPasskeyProof` (passkey.service) outside any transaction and
 * `assertPasskeyProven` (here) under the account lock, in the transaction that
 * writes. The options are `startPasskeyProofService` (session-binding.service).
 *
 * Accounts without binding are not asked, and a proof they send is ignored —
 * except by turning binding on (`bindingEnable`), which asks it of every
 * account: binding then depends on exactly this assertion, so the enable
 * proves the owner can make it (`spendPasskeyProof`).
 *
 * Here rather than in a service so that every service a procedure lives in —
 * the passkey service among them — can reach it without an import cycle.
 *
 * @module server/lib/passkey-proof
 */

import { PasskeyProofRequiredError } from '@spfn/auth/errors';

import type { User } from '../entities/users';

/** A passkey assertion that verified, not yet spent (`RenewalProof`). */
export interface PasskeyProof
{
    /** Under the account lock: false when the proof went stale, or the challenge is not this session's. */
    spend: () => Promise<boolean>;
}

/**
 * Under the account lock, with the account as locked: on an account with
 * session binding on, spend the proof or refuse. Nothing for an unbound one.
 *
 * @throws PasskeyProofRequiredError when the account is bound and no proof for this procedure holds
 */
export async function assertPasskeyProven(
    account: Pick<User, 'sessionBinding'> | null,
    proof: PasskeyProof | null,
): Promise<void>
{
    if (account?.sessionBinding !== 'passkey')
    {
        return;
    }

    await spendPasskeyProof(proof);
}

/**
 * Under the account lock: spend the proof or refuse, whatever the account's
 * setting — for turning session binding on, which asks the proof of an account
 * not yet bound (`bindingEnable`).
 *
 * @throws PasskeyProofRequiredError when no proof for this procedure holds
 */
export async function spendPasskeyProof(proof: PasskeyProof | null, message?: string): Promise<void>
{
    if (!proof || !await proof.spend())
    {
        throw new PasskeyProofRequiredError({ message });
    }
}
