/**
 * @spfn/auth - Deferred admission
 *
 * `admitDeferred`: the one question every completion of a two-step procedure
 * asks of the stamp its intermediate record carries (`lib/deferred-stamp.ts`,
 * where the reasoning is). A door of the admission: it ends in `admitPrincipal`.
 *
 * @module server/services/deferred-admission.service
 */

import { DeferredCredentialUnsupportedError } from '@spfn/auth/errors';

import { keysRepository } from '../repositories';
import { sameCredential, type DeferredStamp, type StartingCredential } from '../lib/deferred-stamp';
import { ROUTE_ENROLMENT } from '../routes/channels';
import {
    admissionRefusalError,
    admitCompletion,
    sessionCredentialOf,
    type AdmissionRefusal,
    type Principal,
    type PrincipalCredential,
} from './admission.service';

/** How a procedure completes. */
export interface DeferredCompletion
{
    /**
     * The completing request's own credential (`getAuth(c).credential`, or the
     * renewal a renewal presents); null when no session completes it (the link callback).
     */
    credential: PrincipalCredential | null;
    /** The completing route: its class in `ROUTE_ENROLMENT` (#309) is the one the completion is admitted under. */
    route: keyof typeof ROUTE_ENROLMENT;
}

/** Why a record may not be completed. Each route answers it in its own vocabulary. */
export type DeferredRefusal =
    | { reason: 'unstamped' }
    | { reason: 'otherCredential' }
    | { reason: 'generationEnded' }
    | { reason: 'admission'; refusal: AdmissionRefusal };

export type DeferredAdmission = { admitted: Principal } | { refused: DeferredRefusal };

/**
 * What a credential a session presents is, as a stamp records it
 * (`sessionCredentialOf`).
 *
 * @throws DeferredCredentialUnsupportedError for a grant, which signs with no key and is no session
 */
export function startingCredentialOf(credential: PrincipalCredential): StartingCredential
{
    const session = sessionCredentialOf(credential);

    if (!session)
    {
        throw new DeferredCredentialUnsupportedError();
    }

    return session;
}

/**
 * Whether a procedure started under `stamp` may complete now, and the person
 * it is completed for.
 *
 * A session's completion presents its own credential, which must be the one
 * the procedure started with (`sameCredential`), and is admitted with it — so
 * its liveness is asked the way `admitPrincipal` asks it for its kind. A
 * session-less completion is admitted with the device key the stamp's key
 * stands for now; an application profile cannot be asked without its
 * verifier, so a stamp of one completes only in a session.
 *
 * Asked under the account lock by the transaction that writes what the
 * procedure earned, so the account it judges is the one the write lands on.
 * Answers rather than throws, like `admitPrincipal`: each route turns a
 * refusal into the answer its own taxonomy has (`deferredRefusalError`).
 */
export async function admitDeferred(
    stamp: DeferredStamp | null,
    completion: DeferredCompletion,
): Promise<DeferredAdmission>
{
    if (stamp === null)
    {
        return { refused: { reason: 'unstamped' } };
    }

    const credential = await completingCredential(stamp, completion.credential);

    if (credential === null)
    {
        return { refused: { reason: 'otherCredential' } };
    }

    const admission = await admitCompletion({
        userId: stamp.userId,
        credential,
        enrolment: ROUTE_ENROLMENT[completion.route],
    });

    if ('refused' in admission)
    {
        return { refused: { reason: 'admission', refusal: admission.refused } };
    }

    return admission.admitted.user.keyEpoch === stamp.keyEpoch
        ? admission
        : { refused: { reason: 'generationEnded' } };
}

/**
 * What the completion is admitted with: a session's own credential when it is
 * the one the procedure started with, else null; with no session, what the
 * stamp stands for now (`sealedStandingOf`).
 */
async function completingCredential(
    stamp: DeferredStamp,
    presented: PrincipalCredential | null,
): Promise<PrincipalCredential | null>
{
    if (presented === null)
    {
        return await sealedStandingOf(stamp);
    }

    // No stamp names a grant: it cannot start a procedure, so it completes none.
    if (presented.kind === 'oauth2Grant')
    {
        return null;
    }

    return sameCredential(stamp.startedBy, startingCredentialOf(presented)) ? presented : null;
}

/**
 * The credential a sealed stamp stands for now, with no session to present
 * one: the device key at the end of the chain of verified replacements that
 * retired the starting key, or that key itself. Whether it is live is the
 * admission's question. Null for an application profile, which only its
 * verifier, on a request, can admit.
 */
async function sealedStandingOf(stamp: DeferredStamp): Promise<PrincipalCredential | null>
{
    const { startedBy } = stamp;

    if (startedBy.kind !== 'deviceKey')
    {
        return null;
    }

    const keyId = await keysRepository.findReplacementChainEnd(stamp.userId, startedBy.keyId) ?? startedBy.keyId;

    return { kind: 'deviceKey', keyId };
}

/**
 * The error a session route answers a refusal with: the admission's own error
 * for a person who may not be let in — what their next request would be told —
 * and the route's "start again" error for a record this session may not
 * complete.
 */
export function deferredRefusalError(refusal: DeferredRefusal, startAgain: Error): Error
{
    return refusal.reason === 'admission' ? admissionRefusalError(refusal.refusal) : startAgain;
}
