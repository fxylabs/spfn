/**
 * @spfn/auth - What each admission refusal is answered with, and what it means
 * for a browser session
 *
 * One table, read on both sides of the Next.js proxy. The backend answers a
 * refusal with the error its row names (`admissionRefusalError`); the proxy reads
 * the error code back off the response and asks this same table whether that code
 * ends the session (`isSessionEndingCode`). A refusal added to `AdmissionRefusal`
 * does not compile until its row says both, so the proxy cannot keep a list of its
 * own that has drifted from what the server answers.
 *
 * "Ends the session" is the key-refused family: this key or this account can no
 * longer act, so the cookie that holds the key is dead weight. A refusal that asks
 * the same session to do something first — enrol a second factor — leaves it.
 *
 * An expired key is the family's one member a session may survive: a bound key
 * inside its renewal grace is renewed with the passkey, not signed in again. The
 * refusal says which (`KeyExpiredDetails`), from the key row, so the proxy decides
 * on the backend's answer rather than on its cookie's copy of the binding.
 *
 * Every class of the family is its own (`KeyRevokedError`, `KeyExpiredError`,
 * `AccountNotFoundError`, `AccountDisabledError`, `AccountPendingDeletionError`)
 * and none is core's `UnauthorizedError` itself: that code is what every other
 * 401 answers — a stale one-time token, an ops token, an app's own refusal — and
 * a family that held it would sign the user out on any of them. The subclasses
 * still are `UnauthorizedError`s (or `ForbiddenError`s), for an app's
 * `instanceof` and status handling.
 *
 * No server dependency beyond the error classes: the proxy imports this.
 *
 * @module server/lib/admission-refusal
 */

import {
    AccountDisabledError,
    AccountNotFoundError,
    AccountPendingDeletionError,
    KeyExpiredError,
    KeyRevokedError,
    SecondFactorEnrolmentRequiredError,
} from '@spfn/auth/errors';

import type { UserStatus } from '../types';

/**
 * Why a person was not let in. Each door answers each reason in its own vocabulary.
 *
 * A purged account (`deletion: 'deleted'`) is answered as a disabled one, with
 * `'deleted'` where the status goes — the answer it has always had.
 */
export type AdmissionRefusal =
    | { reason: 'accountMissing' }
    | { reason: 'accountDisabled'; status: Exclude<UserStatus, 'active'> | 'deleted' }
    | { reason: 'pendingDeletion'; purgeScheduledAt: string | undefined }
    | { reason: 'credentialRevoked' }
    | { reason: 'credentialExpired'; renewable: boolean }
    | { reason: 'enrolmentRequired' };

type RefusalReason = AdmissionRefusal['reason'];

/** One row: the error class, how it is built from the refusal, and whether it ends a session. */
interface RefusalAnswer<R extends RefusalReason>
{
    errorType: { name: string };
    endsSession: boolean;
    error: (refusal: Extract<AdmissionRefusal, { reason: R }>) => Error;
}

const REFUSAL_ANSWERS: { [R in RefusalReason]: RefusalAnswer<R> } = {
    accountMissing: {
        errorType: AccountNotFoundError,
        endsSession: true,
        error: () => new AccountNotFoundError(),
    },
    accountDisabled: {
        errorType: AccountDisabledError,
        endsSession: true,
        error: refusal => new AccountDisabledError({ status: refusal.status }),
    },
    pendingDeletion: {
        errorType: AccountPendingDeletionError,
        endsSession: true,
        error: refusal => new AccountPendingDeletionError({ purgeScheduledAt: refusal.purgeScheduledAt }),
    },
    credentialRevoked: {
        errorType: KeyRevokedError,
        endsSession: true,
        error: () => new KeyRevokedError(),
    },
    credentialExpired: {
        errorType: KeyExpiredError,
        endsSession: true,
        error: refusal => keyExpiredError(refusal.renewable),
    },
    enrolmentRequired: {
        errorType: SecondFactorEnrolmentRequiredError,
        endsSession: false,
        error: () => new SecondFactorEnrolmentRequiredError(),
    },
};

/**
 * The error the cookie/Bearer surfaces answer an admission refusal with — the
 * same one per reason `authenticate` has always answered — and what a write
 * that re-admits its session under the account lock answers with, so a
 * session refused there is told what its next request would be told.
 */
export function admissionRefusalError(refusal: AdmissionRefusal): Error
{
    const answer = REFUSAL_ANSWERS[refusal.reason] as RefusalAnswer<typeof refusal.reason>;

    return answer.error(refusal as never);
}

/**
 * What a `KeyExpiredError` says about its key: `renewable: true` for a bound key
 * renewal still admits (`isRenewable` — inside its grace, not revoked), and
 * nothing for any other expired key, a bound one past its grace included.
 */
export interface KeyExpiredDetails
{
    renewable?: true;
}

/** The `KeyExpiredError` an expired key is answered with. */
export function keyExpiredError(renewable: boolean): KeyExpiredError
{
    const details: KeyExpiredDetails = renewable ? { renewable: true } : {};

    return new KeyExpiredError({ details });
}

/**
 * Whether a backend answer is the refusal of an expired key that can still be
 * renewed — read off the response body, as the proxy holds it.
 *
 * @param body - the backend's error body (`__type`, `details`, the envelope)
 */
export function isRenewableExpiry(body: unknown): boolean
{
    const answer = body as { __type?: unknown; error?: { code?: unknown }; details?: KeyExpiredDetails } | null;
    const code = answer?.error?.code ?? answer?.__type;

    return code === KeyExpiredError.name && answer?.details?.renewable === true;
}

/** The error codes (class names, as the response envelope carries them) of the key-refused family. */
export const SESSION_ENDING_CODES: ReadonlySet<string> = new Set(
    Object.values(REFUSAL_ANSWERS)
        .filter(answer => answer.endsSession)
        .map(answer => answer.errorType.name),
);

/**
 * Whether a backend answer with this error code means the session's key or
 * account can no longer act.
 *
 * @param code - `error.code` of the response envelope
 */
export function isSessionEndingCode(code: string | undefined): boolean
{
    return code !== undefined && SESSION_ENDING_CODES.has(code);
}
