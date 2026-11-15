/**
 * @spfn/auth - Deferred procedure stamps
 *
 * The stamp itself lives here, free of the admission so the repositories that
 * store it can name it; `admitDeferred` is `services/deferred-admission.service.ts`.
 *
 * A two-step procedure — start, then complete — used to decide its authority
 * at the start and carry that decision in an intermediate record that said
 * neither who started it nor under what standing: a pending TOTP enrolment, a
 * WebAuthn challenge, a sealed social-link state. At completion, the moment the
 * account actually changes, the record's mere existence passed. A session the
 * owner had since signed out, or one that started before the owner enrolled a
 * second factor, finished what it had started (au7-A1, au5-A1, au7-A3).
 *
 * So every such record carries one stamp — the account, the credential that
 * started the procedure and the account's key generation then — and every
 * completion passes one function, `admitDeferred`
 * (`services/deferred-admission.service.ts`), which asks of the account as it
 * is now:
 *
 * (a) when a session completes it, the completing request's own credential is
 *     the starting one: the same kind and the same identity — a device key by
 *     its key id, an application's auth profile by its name and the key id its
 *     verifier reported;
 * (b) the starting credential is still live, asked the way `admitPrincipal`
 *     asks it for that kind — a device key by `keyLiveness`, an application
 *     profile by its verifier having admitted it on the completing request —
 *     and the account's key generation is the stamp's;
 * (c) `admitPrincipal` admits the person now.
 *
 * A session-less completion (the link callback) is judged by (b) and (c), and
 * so only a device key can start one: an application profile's liveness has
 * no record to be read without its verifier, and the link start refuses it.
 * A record without a stamp was written before stamps existed and is refused:
 * the person starts again. Every such record is short-lived.
 *
 * A verified replacement of a starting device key (`keys/rotate`, a renewal, a
 * sign-in whose `replacementProof` the old key signed) is the same device: the
 * stamps on rows are re-pointed to the new key in the replacement's own
 * transaction (`registerPublicKeyService`). A sealed stamp cannot be
 * re-pointed, so for a session-less completion the starting key stands for the
 * key its verified replacements lead to (`replacedByKeyId`), and for no other.
 * An application profile has no replacement: its key id is the verifier's.
 *
 * What the procedure's own rule is — "adding a factor requires step-up", "a
 * passkey needs recent authentication" — is asked by the completing service,
 * after this, against the account as it is now. This answers only whether the
 * record may still be completed at all.
 *
 * @module server/lib/deferred-stamp
 */

import type { User } from '../entities/users';

/**
 * The credential a procedure was started with, by what identifies it. The two
 * kinds of credential a signed-in session presents: a one-time token stands
 * for the device key that issued it.
 */
export type StartingCredential =
    | { kind: 'deviceKey'; keyId: string }
    | { kind: 'appProfile'; profile: string; keyId: string };

/** Who started a procedure, and under what standing. */
export interface DeferredStamp
{
    userId: number;
    startedBy: StartingCredential;
    /** The account's key generation (`users.key_epoch`) at the start. */
    keyEpoch: number;
}

/**
 * A row that may carry a stamp: the stamp columns as the entities declare them.
 * `startedByProfile` is null for a device key, and names the profile otherwise.
 */
export interface StampedRow
{
    userId: number | null;
    startedByKeyId: string | null;
    startedByProfile: string | null;
    keyEpoch: number | null;
}

/** The stamp a procedure started now, with this credential, records. */
export function stampFor(account: Pick<User, 'id' | 'keyEpoch'>, startedBy: StartingCredential): DeferredStamp
{
    return { userId: account.id, startedBy, keyEpoch: account.keyEpoch };
}

/** The stamp a row carries, or null for a row written before stamps existed. */
export function stampOf(row: StampedRow): DeferredStamp | null
{
    if (row.userId === null || row.startedByKeyId === null || row.keyEpoch === null)
    {
        return null;
    }

    const startedBy: StartingCredential = row.startedByProfile === null
        ? { kind: 'deviceKey', keyId: row.startedByKeyId }
        : { kind: 'appProfile', profile: row.startedByProfile, keyId: row.startedByKeyId };

    return { userId: row.userId, startedBy, keyEpoch: row.keyEpoch };
}

/** The stamp columns a row stores for a stamp. */
export function stampColumns(stamp: DeferredStamp): Omit<StampedRow, 'userId'>
{
    return {
        startedByKeyId: stamp.startedBy.keyId,
        startedByProfile: stamp.startedBy.kind === 'appProfile' ? stamp.startedBy.profile : null,
        keyEpoch: stamp.keyEpoch,
    };
}

/** Whether two credentials are the same one: the same kind, and the same identity. */
export function sameCredential(a: StartingCredential, b: StartingCredential): boolean
{
    if (a.kind !== b.kind || a.keyId !== b.keyId)
    {
        return false;
    }

    return a.kind === 'deviceKey' || (b.kind === 'appProfile' && a.profile === b.profile);
}
