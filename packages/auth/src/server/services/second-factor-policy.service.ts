/**
 * @spfn/auth - The second-factor policy, applied to an account
 *
 * `lib/second-factor-policy.ts` holds what the application stated; this reads
 * an account's state under it. Every question "is this account enrolled" in the
 * package goes through `isEnrolledUnderPolicy` — the step-up decision, the
 * step-up gate, `mfa/status`, the `mfaEnrolled` field of every event — so a
 * method the policy does not list counts nowhere.
 *
 * Its own module rather than part of `mfa.service`, because the device-
 * registration notice asks the same question and `mfa.service` imports that
 * notice: one more import the other way would be a cycle.
 */

import type { Context } from 'hono';
import { SecondFactorEnrolmentRequiredError, SecondFactorRequiredError } from '@spfn/auth/errors';

import { keysRepository, mfaEnrolmentRepository, passkeysRepository, usersRepository } from '../repositories';
import type { EnrolmentMethods } from '../repositories/mfa-enrolment.repository';
import { isMethodListed, isSecondFactorRequired } from '../lib/second-factor-policy';
import { isEnrolmentRoute } from '../lib/enrolment-routes';

function listedMethods(): EnrolmentMethods
{
    return { totp: isMethodListed('totp'), passkey: isMethodListed('passkey') };
}

/**
 * Whether the account has a live second factor of a listed method.
 *
 * A confirmed TOTP counts only while `'totp'` is listed, a marked passkey only
 * while `'passkey'` is. With the default methods this is exactly
 * `mfaEnrolmentRepository.isEnrolled`, the one statement it always was.
 */
export function isEnrolledUnderPolicy(userId: number): Promise<boolean>
{
    return mfaEnrolmentRepository.isEnrolledIn(userId, listedMethods());
}

/** What a sign-in answer adds when the session it describes may only enrol. */
export interface SecondFactorEnrolmentFields
{
    secondFactorEnrolmentRequired?: true;
}

/**
 * The `secondFactorEnrolmentRequired` half of a `LoginResult`.
 *
 * `{ secondFactorEnrolmentRequired: true }` exactly when the policy requires a
 * second factor and the account has none listed; nothing otherwise — absence is
 * how every answer read before the option existed, and an application with no
 * policy pays no query for it. Every path that answers a `LoginResult` spreads
 * this, so the answer cannot disagree with what `authenticate` then does.
 */
export async function secondFactorEnrolmentFields(userId: number): Promise<SecondFactorEnrolmentFields>
{
    if (!isSecondFactorRequired() || await isEnrolledUnderPolicy(userId))
    {
        return {};
    }

    return { secondFactorEnrolmentRequired: true };
}

/**
 * `secondFactorEnrolmentFields` for the owner of a device key.
 *
 * For the one sign-in answer that names a key rather than an account — OAuth
 * `finalize`, whose `userId` is the caller's own echo and no basis for
 * anything. The key row is read only while the policy requires a factor.
 */
export async function keySecondFactorEnrolmentFields(keyId: string): Promise<SecondFactorEnrolmentFields>
{
    if (!isSecondFactorRequired())
    {
        return {};
    }

    const key = await keysRepository.findByKeyIdOnPrimary(keyId);

    return key ? await secondFactorEnrolmentFields(key.userId) : {};
}

/**
 * Refuse a person who may only enrol, unless this request is an enrolment.
 *
 * Asked at every point a person principal is produced — the global
 * `authenticate` (its Bearer path and every auth profile, through
 * `runAuthProfile`), `optionalAuth`, one-time tokens and the OAuth 2.1 access
 * token — so no principal carrying a user reaches a handler without it. Not
 * evaluated at all while the policy does not require a second factor: no
 * query, no answer that differs from before.
 *
 * Read on the primary: an account that enrolled on the previous request is
 * admitted on this one, on the same session.
 *
 * @param route - the request, for the global `authenticate` only: the route it
 *   matched is looked at for the enrolment marker, from inside the chain that
 *   middleware runs in. `null` for every other producer — none of them stands
 *   in front of an enrolment route, and none may exempt one.
 * @throws SecondFactorEnrolmentRequiredError
 */
export async function assertSecondFactorAdmits(userId: number, route: Context | null): Promise<void>
{
    if (!isSecondFactorRequired() || (route !== null && isEnrolmentRoute(route)))
    {
        return;
    }

    if (await mfaEnrolmentRepository.isEnrolledInOnPrimary(userId, listedMethods()))
    {
        return;
    }

    throw new SecondFactorEnrolmentRequiredError();
}

/**
 * Whether the account may only enrol: the policy requires a second factor and
 * the account has none of the listed methods. Read on the primary, as the
 * admission is, so it agrees with what `authenticate` just decided. False
 * without a query while nothing is required.
 */
export async function isEnrolmentOnly(userId: number): Promise<boolean>
{
    return isSecondFactorRequired() && !await mfaEnrolmentRepository.isEnrolledInOnPrimary(userId, listedMethods());
}

/**
 * Whether enrolling on this account needs a proof first (#309): it is in the
 * enrolment-only state and already holds a credential it could prove itself
 * with — a live passkey, marked or not, a confirmed TOTP, listed or not, or
 * while recovery codes are on an unspent one. An account that holds none
 * enrols on first use. Without this, a stolen password would be enough to
 * enrol the thief's factor on an account whose owner holds one already.
 *
 * Takes the owner row's lock first, so the decision is the account's state as
 * of this request: two enrolments in flight on one account are decided one
 * after the other, and the second sees what the first wrote.
 */
export async function enrolmentNeedsProof(userId: number): Promise<boolean>
{
    if (!isSecondFactorRequired())
    {
        return false;
    }

    await usersRepository.lockById(userId);

    return await isEnrolmentOnly(userId)
        && await mfaEnrolmentRepository.holdsProofCredentialOnPrimary(userId, isMethodListed('recoveryCodes'));
}

/**
 * Refuse a change that would take the account's last listed second factor away.
 *
 * `removing` is what the change takes: every factor (`mfa/disable`), or one
 * passkey — its mark, or the passkey itself. A passkey that is not marked
 * removes no factor and is never refused. Only while the policy requires a
 * second factor; otherwise nothing is read.
 *
 * Run inside the removing transaction, and it takes the owner row's lock
 * itself before it reads — a route that already holds it re-takes it for
 * free — so two removals in flight cannot each count the other's factor.
 *
 * This is a rule of the routes. `disableMfaService` called by the application
 * is the operator's re-issue path and is not refused.
 *
 * @throws SecondFactorRequiredError
 */
export async function assertNotLastListedFactor(
    userId: number,
    removing: { all: true } | { passkeyId: number },
): Promise<void>
{
    if (!isSecondFactorRequired())
    {
        return;
    }

    await usersRepository.lockById(userId);

    if (!await removesListedFactor(userId, removing) || await keepsListedFactor(userId, removing))
    {
        return;
    }

    throw new SecondFactorRequiredError();
}

async function removesListedFactor(userId: number, removing: { all: true } | { passkeyId: number }): Promise<boolean>
{
    if ('all' in removing)
    {
        return await isEnrolledUnderPolicy(userId);
    }

    if (!isMethodListed('passkey'))
    {
        return false;
    }

    const passkey = await passkeysRepository.findLiveByIdAndUserId(removing.passkeyId, userId);

    return passkey?.secondFactor === true;
}

async function keepsListedFactor(userId: number, removing: { all: true } | { passkeyId: number }): Promise<boolean>
{
    return 'all' in removing
        ? false
        : await mfaEnrolmentRepository.hasListedFactorBesides(userId, removing.passkeyId, listedMethods());
}
