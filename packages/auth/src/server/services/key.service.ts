/**
 * @spfn/auth - Key Service
 *
 * Handles public key registration, rotation, and revocation
 */

import { type KeyAlgorithmType, type KeyPlatformType, type SessionBindingType } from '../types';
import { assertKeyMatchesAlgorithm, verifyKeyFingerprint } from '../helpers/jwt';
import { KEY_TTL_DAYS, decideKeyBinding } from '../lib/key-policy';
import { exemptsNewDevice, type PasskeyAssertionProof } from '../lib/passkey-assertion';
import { getBoundKeyTtlMs } from '../lib/config';
import { uaFamily, type UaFamily } from '../lib/ua-family';
import { keyIdClaimedByProof, verifyKeyReplacementProof } from '../lib/key-replacement-proof';
import { keyLiveness, type KeyWithAccountEpoch } from '../lib/key-liveness';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    InvalidKeyFingerprintError,
    KeyIdAlreadyRegisteredError,
} from '@spfn/auth/errors';
import { NotFoundError, ValidationError } from '@spfn/core/errors';
import { runInTransaction } from '@spfn/core/db';
import {
    deviceAuthorizationsRepository,
    deviceLinksRepository,
    keysRepository,
    mfaTotpRepository,
    usersRepository,
    webauthnChallengesRepository,
} from '../repositories';
import { revokeAllOAuth2GrantsForUser } from './oauth2-grant.service';
import { emitDeviceRegistered } from './device-registration.service';
import { accountRefusal, admissionRefusalError, type AdmissionRefusal, type PrincipalCredential } from './admission.service';
import {
    assertStepUp,
    carryStepUpVerification,
    mfaEnrolledForUser,
    openStepUpChallengeService,
    resumeStepUpChallengeService,
} from './mfa.service';
import type { MfaChallengeHandle } from './login-result';
import { MFA_CHALLENGE_CHANNELS, type DeferredLoginEvent, type MfaChallengeChannel } from '../entities/mfa-challenges';
import type { DeviceRegistrationChannel } from '../events';
import type { NewUserPublicKey, UserPublicKey } from '../entities/user-public-keys';
import type { User } from '../entities/users';
import { signInGuard, type SignInAttempt, type SignInIdentifier } from '../lib/sign-in-guard';
import { assertSignInAdmits, reportAccountRefusal, reportSignIn } from './sign-in-guard.service';

/**
 * Every door a key row is written through: the eleven sign-in channels, and
 * `keys/rotate`. Rotation is not a `DeviceRegistrationChannel` because it is
 * never a new device — it is refused rather than registered when it is not a
 * replacement — so it never reaches the device notice.
 */
export type KeyRegistrationChannel = DeviceRegistrationChannel | 'rotation';

/**
 * How a registration claims to replace a key the device already holds.
 *
 * A key id is not a secret — it rides every request token and the device
 * notice — so naming one proves nothing. Only the old private key can, and the
 * two shapes are the two ways it is presented.
 */
export type KeyReplacementClaim =
    /**
     * A sign-in's `replacementProof`, exactly as the body carried it: a short
     * JWT the old key signed over both key ids (`lib/key-replacement-proof`).
     * One that does not verify is not an error — the sign-in proved a
     * credential of its own, and is simply a new device.
     */
    | { proof: string }
    /**
     * The request itself was signed by the old key — `keys/rotate`, and a
     * bound session's renewal. An old key no longer live refuses the
     * registration with `refusal` and writes nothing, so a rotation racing a
     * revocation cannot leave a live key behind.
     */
    | { signedBy: string; reason: string; refusal: Error };

export interface RegisterPublicKeyParams
{
    userId: number;
    keyId: string;
    publicKey: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /** Device label for the key list. Display only — nothing is authorized by it. */
    deviceName?: string;
    platform?: KeyPlatformType;
    /**
     * Which door this device came through. Required, so that a registration path
     * added later has to say what it is rather than inherit an answer.
     */
    channel: KeyRegistrationChannel;
    /**
     * What the passkey assertion this sign-in was made with proved, on a
     * passkey sign-in. An assertion with user verification is a second proof,
     * and exempts the registration from the new-device second factor
     * (`decideStepUp`); one without it does not.
     */
    passkeyAssertion?: PasskeyAssertionProof;
    /** Client address of the registering request, absent when none resolved. */
    ip?: string;
    /** `user-agent` of the registering request, already truncated. */
    userAgent?: string;
    /**
     * Whether `proxy-guard` recognised the registering request as the trusted
     * Next.js proxy's (`deviceProvenance(c).webProxy`) — whether this is a web
     * session's key.
     *
     * Whether the key is bound is not the caller's to say: it is decided here,
     * under the account lock, from the account's `session_binding` and this
     * (`decideKeyBinding`), so a sign-in racing binding being turned on cannot
     * write an unbound web key onto a bound account. Never read off a request
     * body, and `platform` is not consulted — that field is display-only and a
     * native client may declare `'web'` freely. Omitted reads as "not the
     * proxy"; a replacement by signature (rotation, renewal) is the same device
     * as the key it replaces and stays a web key when that one was.
     */
    webProxy?: boolean;
    /**
     * The claim that this key replaces one the device already holds.
     *
     * A claim, not a fact: this function alone decides it (`claimReplacement`).
     * Absent, or a proof that does not hold, and the registration is a new device.
     */
    replaces?: KeyReplacementClaim;
    /**
     * What to announce if this registration is stopped and later verified (#95).
     *
     * Read only on a channel that can step up, and only when it does. The login
     * event has to fire once and with the original channel's payload, and the
     * app's own `metadata` and the social provider that carried it are gone by
     * the time `POST /_auth/mfa/verify` runs — so the announcement rides the
     * challenge row rather than being guessed at from the user row.
     */
    loginEvent?: DeferredLoginEvent;
    /**
     * The channel's own answer for an account that may not open a session,
     * where it is not `loginService`'s two (`AccountDisabledError`,
     * `AccountPendingDeletionError`). A signed-request replacement answers its
     * claim's `refusal` instead, and needs none.
     */
    inactiveAccount?: () => Error;
    /**
     * The channel's own answer for an account that is gone by the time its key
     * is written — the answer it gives a missing account at its own lookup.
     * Absent only on the channels that create the account in the same
     * transaction (register, signup link, invitation), where it cannot be
     * missing, and on a signed-request replacement, which answers its claim's
     * `refusal`.
     */
    missingAccount?: () => Error;
    /** The email or phone the sign-in named, for the app's `signIn` guard. On `password` only. */
    identifier?: SignInIdentifier;
}

/**
 * What a registration settled on: a key, or a second factor still to prove.
 *
 * The `pending` branch is the 202 (#95). Its callers answer it to the client and
 * stop — no session, no event, no `lastLoginAt` — and everything they would have
 * done happens at `verify` instead.
 */
export type RegisterPublicKeyResult =
    | ({ pending: false } & RegisteredKeyBinding)
    | { pending: true; challenge: MfaChallengeHandle };

/**
 * The binding half of a registration that could not have been stepped up.
 *
 * Only the step-up channels can answer `pending` — a new key stopped by
 * `decideStepUp`, or a pending one resumed, which `answerForExistingKey` does
 * for those channels alone — so a caller on any other one is reading a case its
 * channel cannot reach. Throwing rather than defaulting is
 * the honest answer if that ever stops being true: a silent `{}` would seal an
 * unbound session for a key nobody had proved, which is the one outcome this
 * whole feature exists to prevent.
 */
export function registeredBinding(result: RegisterPublicKeyResult): RegisteredKeyBinding
{
    if (result.pending)
    {
        throw new Error('This registration channel cannot require a second factor');
    }

    return result;
}

export interface RotateKeyParams
{
    userId: number;
    oldKeyId: string;
    newKeyId: string;
    newPublicKey: string;
    fingerprint: string;
    algorithm?: KeyAlgorithmType;
    /** Omitted: the replaced key's label carries over, so rotation keeps its name. */
    deviceName?: string;
    platform?: KeyPlatformType;
    /**
     * Whether the rotation came through the trusted Next.js proxy
     * (`deviceProvenance(c).webProxy`). The new key is a web key when it did, or
     * when the key it replaces was one (`RegisterPublicKeyParams.webProxy`).
     */
    webProxy?: boolean;
}

export interface RotateKeyResult
{
    success: boolean;
    keyId: string;
}

export interface RevokeKeyParams
{
    userId: number;
    keyId: string;
    reason: string;
}

export interface RevokeAllKeysParams
{
    userId: number;
    /**
     * The key the request itself is signed with — spared unless includeCurrent.
     *
     * Optional because the two branches have different needs and always did: the
     * sparing branch has to know what to spare, and the `includeCurrent` branch
     * never reads it. The signed revoke-all link is the caller with no current
     * key to name — it arrives with no session at all — and requiring a value it
     * would have to invent is how a claim about a device that made no request
     * gets into a result.
     */
    currentKeyId?: string;
    /**
     * The credential the request presented (`getAuth(c).credential`), whose
     * step-up window an enrolled account is asked for. Absent where no
     * session makes the call: the signed revoke-all link proved itself by a
     * mailbox round trip, which is a credential this window cannot measure.
     */
    credential?: PrincipalCredential;
    /** true signs the caller out too. Default false: "my other devices". */
    includeCurrent?: boolean;
    reason: string;
}

export interface RevokeAllKeysResult
{
    revokedCount: number;
    currentKeyRevoked: boolean;
}

/** One registered device as the account surface shows it. */
export interface KeySummary
{
    keyId: string;
    deviceName?: string;
    /** One of `KEY_PLATFORM`, which is what the routes accept and the column stores. */
    platform?: KeyPlatformType;
    algorithm: KeyAlgorithmType;
    /** First bytes of the fingerprint — enough to tell two entries apart. */
    fingerprintPrefix: string;
    /**
     * Milliseconds since the Unix epoch, not an ISO string.
     *
     * One representation of a moment across the whole surface: a generated Swift
     * or Kotlin client reads an integer with no date formatter, and
     * `ISO8601DateFormatter` rejecting fractional seconds by default stops being
     * a way for the two SDKs to disagree about the same value.
     */
    createdAtMillis: number;
    lastUsedAtMillis?: number;
    expiresAtMillis?: number;
    /** The TTL has run out. The key still reads as active; authenticate refuses it. */
    isExpired: boolean;
    /** False once revoked. Only ever false when the caller asked for revoked keys. */
    isActive: boolean;
    /** When it was revoked, for the "what did I cut off, and when" reading. */
    revokedAtMillis?: number;
    /**
     * Client address the key was registered from, absent when none was resolved
     * or the key predates the column. Registration only — it does not move when
     * the device authenticates from somewhere else, which is what makes it
     * useful for recognising a device that was never yours.
     */
    registeredIp?: string;
    /** `user-agent` of the registering request, on the same terms as above. */
    registeredUserAgent?: string;
    /**
     * `'passkey'` when this key is bound to one, absent when it is not.
     *
     * Absent rather than `'none'`, so a deployment where nobody opted in answers
     * exactly the list it always did, and so every consumer reads "unbound" the
     * same way it reads it off a sign-in response.
     */
    binding?: SessionBindingType;
    /**
     * When this key was last seen from two client addresses inside the
     * concurrent-use window, absent when that has never been observed.
     *
     * A signal for the owner, not a refusal: addresses change legitimately, so
     * nothing is blocked by it and a device list that shows it is telling someone
     * to look rather than telling them something happened. The addresses
     * themselves are never returned.
     *
     * Only meaningful where proxy-guard is configured. Without it every web
     * request carries the Next.js server's own address, so two browsers on two
     * continents share one and this never fires.
     */
    concurrentUseAtMillis?: number;
}

export interface ListKeysParams
{
    userId: number;
    /** Also return keys already revoked. Default false: only what can still sign. */
    includeRevoked?: boolean;
}

/** How much of the fingerprint the list returns. */
export const KEY_FINGERPRINT_PREFIX_LENGTH = 8;

/**
 * What a key is registered as when the caller names no algorithm.
 *
 * Named rather than repeated as a literal because it is a published fact: the
 * mobile contract states it for `StartDeviceAuthRequest.algorithm`, the one
 * optional algorithm on that surface, and a client that omits the field is
 * relying on this value being what it was told.
 */
export const DEFAULT_KEY_ALGORITHM: KeyAlgorithmType = 'ES256';

/**
 * What a registration settled on, for the caller that has to tell the browser.
 *
 * The sign-in paths put these two into their `LoginResult`, the Next.js proxy
 * copies them into the sealed cookie, and that is the whole carrier by which the
 * proxy learns a session is bound and when its key runs out. Returned rather than
 * looked up again: the row was just written (or just read), so a second query
 * would be a second answer to a question already settled.
 */
export interface RegisteredKeyBinding
{
    binding: SessionBindingType;
    /** null only for a key registered before expiry was stamped at all. */
    expiresAt: Date | null;
}

/**
 * Helper: Calculate key expiry date — hours for a bound key, KEY_TTL_DAYS otherwise
 *
 * The binding is the input because it is the whole difference: a bound key's
 * short life is the protection, and the only thing allowed to give it a new one
 * is a renewal carrying a fresh WebAuthn assertion.
 */
export function getKeyExpiryDate(binding: SessionBindingType): Date
{
    if (binding === 'passkey')
    {
        return new Date(Date.now() + getBoundKeyTtlMs());
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + KEY_TTL_DAYS);

    return expiresAt;
}

/**
 * Helper: 만료 시각이 지났는지 (null이면 만료 없음)
 */
function isExpired(expiresAt: Date | null): boolean
{
    return expiresAt !== null && new Date() > expiresAt;
}

/**
 * Whether this registration is stopped and asked for a second factor (#95).
 *
 * The decision lives here, at the one chokepoint every registration path goes
 * through, rather than at each of the four that can be stopped: a path added
 * later then inherits the rule instead of having to remember it.
 *
 * Asked only of a registration that is not a verified replacement — a device
 * already signed in swapping its key, proved by the old key itself, is not an
 * arrival and not a moment to challenge. Two terms remain. The account has a
 * second factor, or there is nothing to ask for. And the sign-in did not
 * already carry a second proof: the channel is one of those where a single
 * stolen credential would be enough on its own (a device-code approval
 * carried one), and a passkey sign-in's assertion did not show user
 * verification (`exemptsNewDevice`) — decided from what the assertion proved,
 * marked or not, never from the route it came by (au2-A3, au7-A4). A passkey
 * without user verification is possession alone, and a new device signed in
 * with one is asked for the second factor like a password sign-in. `register`,
 * `signup-link`, `invitation`, `renewal` and `rotation` cannot reach this at
 * all — the first three create the account, which is by construction
 * unenrolled, and the last two are replacements. The brand-new social account is
 * covered by the same fact: a user row `createOrLinkUser` has just written has no
 * second factor to ask for.
 */
async function decideStepUp(params: RegisterPublicKeyParams): Promise<MfaChallengeChannel | null>
{
    const channel = stepUpChannel(params.channel);

    if (!channel || (params.passkeyAssertion && exemptsNewDevice(params.passkeyAssertion)))
    {
        return null;
    }

    return await mfaEnrolledForUser(params.userId) ? channel : null;
}

/** The step-up channel a registration channel is, if it is one that can be stopped. */
function stepUpChannel(channel: KeyRegistrationChannel): MfaChallengeChannel | undefined
{
    return MFA_CHALLENGE_CHANNELS.find(candidate => candidate === channel);
}

/**
 * The answer for a keyId that is already registered.
 *
 * It is the same device signing in again only on a sign-in, and only when the
 * presented key is the one stored, for the same account. Then two cases are
 * ordinary: a key that is not revoked being re-registered is a repeated login
 * from one device, and a key still waiting on a second factor is a retried
 * registration — a native client reusing its keyId, or an OAuth state replayed
 * from the back button — on a channel that can have stopped it. Both get their
 * own state back rather than a 409, which would refuse a caller for holding a
 * key that is theirs.
 *
 * A registration that replaces by request signature (`replaces.signedBy` —
 * rotation, a bound session's renewal, whatever comes next) never is: it exists
 * to put a *new* key in place of the one that signed it, and a key id the
 * caller already holds — pending, active, the same public key or not — leaves
 * nothing to put in place. What decides it is that claim, not the channel's
 * name: answered any other way it is a 200 that renews and replaces nothing,
 * leaving the signing key as it was.
 *
 * Anything else — another public key under that id, a revoked key of their own
 * (and a key of an ended generation is one, see `keyLiveness`), a pending key
 * presented through a door that cannot step up, somebody else's key — is the
 * one error, told the same way on every path, so a caller cannot probe whether
 * a keyId exists.
 *
 * @throws KeyIdAlreadyRegisteredError
 */
async function answerForExistingKey(
    existing: KeyWithAccountEpoch,
    params: RegisterPublicKeyParams,
    account: User,
): Promise<RegisterPublicKeyResult>
{
    if (params.replaces && 'signedBy' in params.replaces)
    {
        throw new KeyIdAlreadyRegisteredError();
    }

    const sameKey = existing.userId === params.userId
        && existing.publicKey === params.publicKey
        && existing.fingerprint === params.fingerprint;

    if (sameKey && keyLiveness(existing) !== 'revoked')
    {
        return { pending: false, ...await reRegisterOwnKey(existing, params, account) };
    }

    const resumed = sameKey && existing.pendingMfaChallengeId && stepUpChannel(params.channel)
        ? await resumeStepUpChallengeService(params.userId, existing.keyId)
        : null;

    if (resumed)
    {
        return { pending: true, challenge: resumed };
    }

    throw new KeyIdAlreadyRegisteredError();
}

/**
 * Write a key row — the one function every path that writes one goes through:
 * the eleven sign-in channels, renewal, `keys/rotate`, and invitation acceptance.
 *
 * Writing a key is itself a door, so it asks the account half of the admission
 * (`accountRefusal`) of the account it locks (`usersRepository.lockAccount`),
 * in the same transaction as the write, and takes the key generation from that
 * same read. The lock is the first thing this transaction does for the
 * account, and a caller that touched the account earlier in its own
 * transaction took it before that. A suspension, a deletion request or a
 * revoke-all cannot commit between the question and the key: it waits for the
 * key and then revokes it, or the key is refused. A status a channel read
 * earlier (on a replica, before the credential) decides nothing here. On a
 * sign-in channel — every one but renewal and rotation — the app's
 * `signIn.admit` is asked next, under the same lock, and `settled` is told
 * the outcome in this transaction (`reportRegistration`).
 *
 * It alone decides whether the key replaces one the device already held or
 * arrives as a new device (`claimReplacement`), and everything that follows
 * from that is decided here with it:
 *
 * - a **replacement** is never challenged, announces nothing, carries the old
 *   key's step-up record across, and inherits its key generation — so a
 *   rotation racing a global revocation writes a key that is dead on arrival;
 * - a **new device** has its second factor decided normally, is announced, and
 *   carries no step-up record, under the account's current key generation.
 *
 * `keyId` is UNIQUE across all users, so the lookup must ignore `isActive` —
 * filtering on it misses a revoked row and the insert then fails on the unique
 * index, rolling the whole login transaction back into a 500. Reuse is answered
 * by `answerForExistingKey` instead, before anything is revoked.
 *
 * An enrolled account arriving on a new device gets the key written **inactive**
 * and a challenge back (#95). Nothing else happens: no device event, no login
 * event, no `lastLoginAt` — those are what the challenge is holding, and they
 * fire at `POST /_auth/mfa/verify` or not at all.
 *
 * @throws KeyIdAlreadyRegisteredError keyId가 이미 쓰인 값일 때 (다른 공개키 · 폐기된 키 · 남의 키)
 * @throws InvalidKeyFingerprintError fingerprint가 publicKey와 맞지 않을 때
 * @throws KeyAlgorithmMismatchError 키의 SPKI 타입이 선언된 algorithm과 다를 때
 * @throws the claim's `refusal` when a signed-request replacement's old key is no longer live
 */
export async function registerPublicKeyService(
    params: RegisterPublicKeyParams,
): Promise<RegisterPublicKeyResult>
{
    // Before the existing-key answer too: a re-registration is compared against
    // the stored key by fingerprint, so the fingerprint has to be this key's.
    if (!verifyKeyFingerprint(params.publicKey, params.fingerprint))
    {
        throw new InvalidKeyFingerprintError();
    }

    return await runInTransaction(async () =>
    {
        const account = await lockAdmittedAccount(params);
        const result = await writeKey(params, account);

        await reportRegistration(params, account, result);

        return result;
    }, { context: 'auth:register-key' });
}

/** The key write itself, for an account locked and admitted. */
async function writeKey(params: RegisterPublicKeyParams, account: User): Promise<RegisterPublicKeyResult>
{
    const existing = await keysRepository.findWithAccountEpochOnPrimary(params.keyId);
    if (existing)
    {
        return await answerForExistingKey(existing, params, account);
    }

    // The defaulted algorithm is what gets stored, so it is the one the key has
    // to be: a key parked under an algorithm it cannot sign for would only fail
    // at proof verification, after the caller believes it is enrolled.
    assertKeyMatchesAlgorithm(params.publicKey, params.algorithm ?? DEFAULT_KEY_ALGORITHM);

    return await registerNewKey(params, account);
}

/** Whether a registration channel is a sign-in — every one but the two that continue a session. */
function isSignInChannel(channel: KeyRegistrationChannel): channel is Exclude<KeyRegistrationChannel, 'renewal' | 'rotation'>
{
    return channel !== 'renewal' && channel !== 'rotation';
}

/** The sign-in a registration is, as the app's `signIn` guard sees it; null on renewal and rotation. */
function signInAttemptOf(params: RegisterPublicKeyParams, account: User): SignInAttempt | null
{
    return isSignInChannel(params.channel)
        ? {
            user: account,
            channel: params.channel,
            stage: 'credential',
            identifier: params.identifier,
            ip: params.ip,
            userAgent: params.userAgent,
            webProxy: params.webProxy === true,
        }
        : null;
}

/**
 * Tell the app's `settled` that a sign-in started a session or was
 * challenged, in the transaction that wrote the key: a `settled` that throws
 * rolls the session back with it. Nothing without a guard.
 */
async function reportRegistration(params: RegisterPublicKeyParams, account: User, result: RegisterPublicKeyResult): Promise<void>
{
    const attempt = signInGuard() && signInAttemptOf(params, account);

    if (attempt)
    {
        await reportSignIn({ ...attempt, result: result.pending ? 'challenged' : 'succeeded', keyId: params.keyId });
    }
}

/**
 * The account a key is written for, locked against a status change until the
 * transaction ends, and its key generation as of that lock.
 *
 * @throws the channel's answer for an account that may not open a session
 * @throws SignInRefusedError when the app's `signIn.admit` refuses a sign-in
 */
async function lockAdmittedAccount(params: RegisterPublicKeyParams): Promise<User>
{
    const account = await usersRepository.lockAccount(params.userId);
    if (!account)
    {
        throw inactiveAccountError({ reason: 'accountMissing' }, params);
    }

    // Reported to the app's `settled` once this transaction has rolled back
    // (`reportRefusal`), on a sign-in channel: the package's refusal of the
    // account, and the app's.
    const attempt = signInGuard() && signInAttemptOf(params, account);
    const refusal = await accountRefusal(account);
    if (refusal)
    {
        await reportAccountRefusal(attempt, refusal, params.keyId);
        throw inactiveAccountError(refusal, params);
    }

    // The app's say, after the package's and under the same lock: the one
    // `admit` that decides a sign-in, whatever the channel asked before.
    if (attempt)
    {
        await assertSignInAdmits(attempt, params.keyId);
    }

    return account;
}

/** A refused key write, answered as the channel answers an account that is not active. */
function inactiveAccountError(refusal: AdmissionRefusal, params: RegisterPublicKeyParams): Error
{
    if (params.replaces && 'signedBy' in params.replaces)
    {
        return params.replaces.refusal;
    }

    if (params.inactiveAccount)
    {
        return params.inactiveAccount();
    }

    switch (refusal.reason)
    {
        case 'accountDisabled':
            return new AccountDisabledError({ status: refusal.status });
        case 'pendingDeletion':
            return new AccountPendingDeletionError({ purgeScheduledAt: refusal.purgeScheduledAt });
        default:
            return params.missingAccount?.() ?? new NotFoundError({ message: 'User not found', resource: 'User' });
    }
}

/**
 * Write a key id nobody holds yet: settle the replacement claim, then write the
 * row as a replacement or as a new device, and do what follows from which.
 */
async function registerNewKey(params: RegisterPublicKeyParams, account: User): Promise<RegisterPublicKeyResult>
{
    const replaced = await claimReplacement(params);

    // Decided before the insert, so `is_active` is right the moment the row
    // exists. Deciding afterwards would leave a window, however short, in which
    // the key an unproven second factor is meant to be holding back is live.
    const stepUp = replaced ? null : await decideStepUp(params);
    const keyEpoch = replaced?.keyEpoch ?? account.keyEpoch;
    const row = await keysRepository.create(newKeyRow(params, replaced, account, keyEpoch, stepUp === null));

    if (stepUp)
    {
        return { pending: true, challenge: await openStepUpChallengeService({
            userId: params.userId,
            keyId: params.keyId,
            channel: stepUp,
            keyEpoch,
            loginEvent: params.loginEvent,
        }) };
    }

    // That same device under a new key id carries its second-factor
    // verification across: without it the step-up window would expire silently
    // every time the web proxy rotated. A rotation is never a new device — its
    // claim refuses instead — so it never reaches the notice.
    if (replaced)
    {
        await carryStepUpVerification(params.userId, replaced.keyId, params.keyId);
        await carryDeferredStamps(params.userId, replaced.keyId, params.keyId);
    }
    else if (params.channel !== 'rotation')
    {
        await emitDeviceRegistered(row, params.channel);
    }

    return { pending: false, binding: row.binding, expiresAt: row.expiresAt };
}

/**
 * Re-point the procedures the replaced key started — a pending TOTP enrolment,
 * live WebAuthn ceremonies — at the key that replaced it, in the replacement's
 * transaction (`lib/deferred-stamp.ts`). The web proxy replaces its key at
 * every sign-in, so without this a person who signed in again in the middle of
 * an enrolment would be refused at its completion on the same device. Only a
 * verified replacement reaches here: a key id merely named is a new device,
 * whose completion of another key's procedure is refused.
 */
async function carryDeferredStamps(userId: number, fromKeyId: string, toKeyId: string): Promise<void>
{
    await mfaTotpRepository.repointStamp(userId, fromKeyId, toKeyId);
    await webauthnChallengesRepository.repointStamps(userId, fromKeyId, toKeyId);
}

/**
 * Settle a replacement claim: the old key's row, revoked by this call, or null
 * when this registration is a new device.
 *
 * The old key has to be live, and each claim is held to that once. A proof is
 * checked here (`keyIdProvenByProof`): it arrives on a sign-in, where nothing
 * else has looked at the old key. A signed request was admitted by its
 * middleware, which is where liveness was already decided for it —
 * `authenticate` for `keys/rotate`, and for a renewal `authenticateForRenewal`,
 * whose grace window is the one place a bound key past its expiry is admitted.
 * Either way the old key is revoked by the same statement that checks it is
 * still active and of the current generation (`revokeForReplacement`), so a
 * revocation committing a moment earlier leaves nothing to replace rather than
 * a replacement of a dead key.
 *
 * @throws the claim's `refusal`, for a signed-request claim whose old key is no longer live
 */
async function claimReplacement(params: RegisterPublicKeyParams): Promise<UserPublicKey | null>
{
    const claim = params.replaces;

    if (!claim)
    {
        return null;
    }

    if ('signedBy' in claim)
    {
        const replaced = await keysRepository.revokeForReplacement(claim.signedBy, params.userId, claim.reason, params.keyId);

        if (!replaced)
        {
            throw claim.refusal;
        }

        return replaced;
    }

    const oldKeyId = await keyIdProvenByProof(claim.proof, params);

    return oldKeyId
        ? await keysRepository.revokeForReplacement(oldKeyId, params.userId, `Replaced by new key on ${params.channel} sign-in`, params.keyId)
        : null;
}

/**
 * The old key a sign-in's `replacementProof` proves, or null.
 *
 * The proof names the old key; its stored public key is what the signature is
 * checked against, so only that key's private half can have made it. The key
 * has to be this account's and live — a key `authenticate` would refuse, expired
 * as much as revoked, can no more vouch for a successor than sign a request —
 * and the proof has to name the very key being registered: a proof made for
 * another new key, or by another account's key, proves nothing here. Every
 * failure is the same null, so the answer a caller gets never says whether a
 * key id exists.
 */
async function keyIdProvenByProof(proof: string, params: RegisterPublicKeyParams): Promise<string | null>
{
    const claimedKeyId = keyIdClaimedByProof(proof);
    const oldKey = claimedKeyId ? await keysRepository.findWithAccountEpochOnPrimary(claimedKeyId) : null;

    if (!oldKey || oldKey.userId !== params.userId || keyLiveness(oldKey) !== 'live')
    {
        return null;
    }

    const claims = verifyKeyReplacementProof(proof, oldKey);

    return claims && claims.oldKeyId === oldKey.keyId && claims.newKeyId === params.keyId
        ? oldKey.keyId
        : null;
}

/**
 * The row a registration writes.
 *
 * `authenticatedAt` is now — every path that writes a key proved a credential
 * on the way, except a rotation, which proves only that it holds the old key
 * and so inherits when a person last proved one on this device. Treating a
 * rotation as a fresh authentication is what let a stale session satisfy the
 * recent-authentication gate by rotating.
 *
 * Whether it is bound is decided here, for every path at once, from the
 * account's setting as locked and whether the key is a web session's
 * (`decideKeyBinding`): every web key of a bound account is a bound key.
 */
function newKeyRow(
    params: RegisterPublicKeyParams,
    replaced: UserPublicKey | null,
    account: User,
    keyEpoch: number,
    isActive: boolean,
): NewUserPublicKey
{
    const rotated = params.channel === 'rotation' ? replaced : null;
    const viaWebProxy = params.webProxy === true || replaced?.viaWebProxy === true;
    const binding = decideKeyBinding(account.sessionBinding, viaWebProxy);

    return {
        userId: params.userId,
        keyId: params.keyId,
        publicKey: params.publicKey,
        algorithm: params.algorithm ?? DEFAULT_KEY_ALGORITHM,
        fingerprint: params.fingerprint,
        keyEpoch,
        authenticatedAt: rotated?.authenticatedAt ?? new Date(),
        isActive,
        viaWebProxy,
        binding,
        ...deviceFields(params, replaced, binding),
    };
}

/** What the new row records about the device, by how it came to be written. */
function deviceFields(params: RegisterPublicKeyParams, replaced: UserPublicKey | null, binding: SessionBindingType)
{
    if (replaced && params.channel === 'rotation')
    {
        return rotatedDevice(params, replaced, binding);
    }

    if (replaced && params.channel === 'renewal')
    {
        return renewedDevice(params, replaced, binding);
    }

    return registeringDevice(params, binding);
}

/** The browser family a registering request's `user-agent` names; null when it sent none. */
function recordedFamily(userAgent: string | undefined): UaFamily | null
{
    return userAgent ? uaFamily(userAgent) : null;
}

/** What a registration knows about the device: what this request said about it. */
function registeringDevice(params: RegisterPublicKeyParams, binding: SessionBindingType)
{
    return {
        deviceName: params.deviceName,
        platform: params.platform,
        registeredIp: params.ip ?? null,
        registeredUserAgent: params.userAgent ?? null,
        registeredUaFamily: recordedFamily(params.userAgent),
        // Hours for a bound key, 90 days otherwise
        expiresAt: getKeyExpiryDate(binding),
    };
}

/**
 * What a rotation knows about the device: everything the replaced row said.
 *
 * The label and platform carry over unless the client renames them; where and
 * what it registered from carry over always. The binding is the account's
 * setting applied to the device (`newKeyRow`), not anything this request chose.
 *
 * A *bound* key's expiry carries over verbatim, rather than being recomputed.
 * A rotation is not a renewal: recomputing would hand a bound key another full
 * window every time the browser rotated, which is a way to hold a bound session
 * open forever without ever presenting the credential that binding exists to ask
 * for. `session/renew` is the only path that moves it.
 *
 * An unbound rotation resets the ninety days, exactly as it did before #97.
 * Inheriting there would mean an app that rotates at every login — the
 * documented reason `rotateKey` exists — rotating on day 89 into a key that
 * expires tomorrow, and signing every one of its users out on day 91.
 */
function rotatedDevice(params: RegisterPublicKeyParams, replaced: UserPublicKey, binding: SessionBindingType)
{
    return {
        deviceName: params.deviceName ?? replaced.deviceName,
        platform: params.platform ?? replaced.platform,
        registeredIp: replaced.registeredIp,
        registeredUserAgent: replaced.registeredUserAgent,
        registeredUaFamily: replaced.registeredUaFamily,
        expiresAt: binding === 'passkey' && replaced.binding === 'passkey'
            ? replaced.expiresAt
            : getKeyExpiryDate(binding),
    };
}

/**
 * What a passkey renewal knows about the device: the replaced row's provenance —
 * renewing is not appearing for the first time — and a fresh bound window.
 *
 * The browser family is the one value a renewal may add. A bound key's family
 * is what admission compares every request against (`familyRefusal`), so it is
 * carried over and never overwritten; only a row that recorded none (it
 * predates the column, or was registered without a `user-agent`) takes the
 * renewing request's, and is compared from then on.
 */
function renewedDevice(params: RegisterPublicKeyParams, replaced: UserPublicKey, binding: SessionBindingType)
{
    return {
        deviceName: params.deviceName ?? replaced.deviceName,
        platform: params.platform ?? replaced.platform,
        registeredIp: replaced.registeredIp,
        registeredUserAgent: replaced.registeredUserAgent,
        registeredUaFamily: replaced.registeredUaFamily ?? recordedFamily(params.userAgent),
        expiresAt: getKeyExpiryDate(binding),
    };
}

/**
 * The caller signing in again with a key it already holds that nobody revoked —
 * a repeated login from one device, which is an ordinary path and stays a no-op
 * success.
 *
 * The sign-in just proved a credential on this device, so `authenticatedAt`
 * moves to now.
 *
 * Expiry is the other thing looked at. Nothing flips `isActive` when a TTL runs
 * out, so returning quietly on an expired key would answer the login 200 while
 * `authenticate` refuses every request it makes afterwards: signed in, and
 * nothing works. The sign-in just proved the identity again, so the expiry moves.
 *
 * A bound key is the exception, and it is the feature. Its short life is what a
 * copied cookie cannot outlast, and extending it on a login — a login a copied
 * cookie can perform, since the password is what it asks for and not the
 * credential binding exists to require — would hand back the ninety days this
 * setting was turned on to withhold. It is left expired and `session/renew`,
 * which needs a fresh WebAuthn assertion, is the only way to a live key.
 *
 * An unbound web key signing in again on a bound account is bound now, like a
 * new key would be (`decideKeyBinding`), with a bound key's short life.
 */
async function reRegisterOwnKey(
    existing: UserPublicKey,
    params: RegisterPublicKeyParams,
    account: User,
): Promise<RegisteredKeyBinding>
{
    const renewed = existing.binding === 'passkey' ? null : renewedUnboundKey(existing, params, account);

    await keysRepository.markReauthenticated(existing.keyId, params.userId, renewed ?? undefined);

    return renewed ?? { binding: existing.binding, expiresAt: existing.expiresAt };
}

/**
 * What an unbound key signing in again changes to: bound, when it is a web key
 * of a bound account; otherwise ninety days again, only once it has expired.
 * Null when nothing changes.
 */
function renewedUnboundKey(existing: UserPublicKey, params: RegisterPublicKeyParams, account: User)
{
    const viaWebProxy = params.webProxy === true || existing.viaWebProxy;
    const binding = decideKeyBinding(account.sessionBinding, viaWebProxy);

    if (binding === 'none' && !isExpired(existing.expiresAt))
    {
        return null;
    }

    return { binding, viaWebProxy, expiresAt: getKeyExpiryDate(binding) };
}

/**
 * Whether a key waits to be bound: a web key — recorded as one, or used through
 * the attested proxy on this request — that is unbound, on an account whose
 * binding is on. A state rather than an event, so a bind that failed once is
 * tried again whenever the key is used. The caller holds a live key; under the
 * account lock `bindWebKeyService` asks liveness too.
 */
export function awaitsWebBinding(
    key: Pick<UserPublicKey, 'binding' | 'viaWebProxy'>,
    account: Pick<User, 'sessionBinding'>,
    webProxy: boolean,
): boolean
{
    return key.binding === 'none' && decideKeyBinding(account.sessionBinding, key.viaWebProxy || webProxy) === 'passkey';
}

/**
 * Bind a web session's key whose account is bound (au3-A5): one registered
 * before `via_web_proxy` existed, or a successor of one, carries no answer
 * until it is used through the proxy, and a bind attempted then may have
 * failed. Under the account lock the state is read again (`awaitsWebBinding`,
 * and the key live); when it still holds, the key gets the rule a web sign-in
 * on a bound account gets, with a bound key's short life (`getKeyExpiryDate`),
 * and is recorded as a web key by the same statement (`bindKeys`). The request
 * that used it is served; the key asks for a passkey at its next expiry.
 *
 * @param webProxy - the request using the key came through the attested proxy
 */
export async function bindWebKeyService(userId: number, keyId: string, webProxy: boolean): Promise<void>
{
    await runInTransaction(async () =>
    {
        const account = await usersRepository.lockAccount(userId);
        const key = await keysRepository.findWithAccountEpochOnPrimary(keyId);

        if (account && key?.userId === userId && keyLiveness(key) === 'live' && awaitsWebBinding(key, account, webProxy))
        {
            await keysRepository.bindKeys(userId, [keyId], getKeyExpiryDate('passkey'));
        }
    }, { context: 'auth:bind-web-key' });
}

/**
 * Rotate user's public key (revoke old, register new)
 *
 * The request is signed by the old key, and that is the proof the shared
 * registration is handed: the old key is revoked only if it is still live, by
 * the statement that checks it, and a rotation whose old key is already gone —
 * revoked a moment ago, or outdated by a sign-out-everywhere — is refused with
 * the answer `authenticate` gives a revoked key, writing nothing.
 *
 * @throws InvalidKeyFingerprintError fingerprint가 newPublicKey와 맞지 않을 때
 * @throws KeyAlgorithmMismatchError 새 키의 SPKI 타입이 선언된 algorithm과 다를 때
 * @throws KeyIdAlreadyRegisteredError newKeyId가 이미 쓰인 값일 때 — 호출자 자신의 키(대기·활성)라도
 * @throws KeyRevokedError 이전 키가 이미 폐기됐을 때
 */
export async function rotateKeyService(
    params: RotateKeyParams,
): Promise<RotateKeyResult>
{
    registeredBinding(await registerPublicKeyService({
        userId: params.userId,
        keyId: params.newKeyId,
        publicKey: params.newPublicKey,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        deviceName: params.deviceName,
        platform: params.platform,
        webProxy: params.webProxy,
        channel: 'rotation',
        replaces: {
            signedBy: params.oldKeyId,
            reason: 'Replaced by key rotation',
            refusal: admissionRefusalError({ reason: 'credentialRevoked' }),
        },
    }));

    return {
        success: true,
        keyId: params.newKeyId,
    };
}

/**
 * Revoke a user's public key.
 *
 * Returns false when this call revoked nothing: the key belongs to somebody
 * else, or it was already revoked, or there is no such key. A caller acting on
 * a key id from outside (the device list) can therefore answer "not found"
 * instead of reporting a revocation that never happened — and the login paths
 * can tell a device replacement from a brand-new device, which is what decides
 * whether the owner is told about it. The repository scopes the update by
 * userId, so someone else's key is never touched either way.
 */
export async function revokeKeyService(
    params: RevokeKeyParams,
): Promise<boolean>
{
    const { userId, keyId, reason } = params;

    return await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        return await keysRepository.revokeByKeyIdAndUserId(keyId, userId, reason) !== null;
    }, { context: 'auth:revoke-key' });
}

/**
 * List the caller's active keys — one entry per device that can sign for them.
 *
 * `isExpired` is computed rather than stored: an expired key keeps `isActive`
 * true (nothing flips it), and `authenticate` refuses it at request time. A list
 * that showed it as simply "active" would be telling the user something the
 * server does not act on.
 *
 * The fingerprint is truncated. Its full value is what a native sign-in must
 * send as its nonce (issue #63), and an account page has no use for it beyond
 * telling two entries apart.
 */
export async function listKeysService(params: ListKeysParams): Promise<KeySummary[]>
{
    const rows = await keysRepository.listForUser(params.userId, params.includeRevoked);

    return rows.map(row => ({
        keyId: row.keyId,
        deviceName: row.deviceName ?? undefined,
        platform: row.platform ?? undefined,
        algorithm: row.algorithm,
        fingerprintPrefix: row.fingerprint.slice(0, KEY_FINGERPRINT_PREFIX_LENGTH),
        createdAtMillis: row.createdAt.getTime(),
        lastUsedAtMillis: row.lastUsedAt?.getTime(),
        expiresAtMillis: row.expiresAt?.getTime(),
        isExpired: isExpired(row.expiresAt),
        isActive: row.isActive,
        revokedAtMillis: row.revokedAt?.getTime(),
        registeredIp: row.registeredIp ?? undefined,
        registeredUserAgent: row.registeredUserAgent ?? undefined,
        binding: row.binding === 'passkey' ? row.binding : undefined,
        concurrentUseAtMillis: row.concurrentUseAt?.getTime(),
    }));
}

/**
 * Revoke every active key the user has, optionally sparing the current one.
 *
 * The caller's own key is spared by default, so "sign out my other devices"
 * does not also end the session making the request. Passing
 * `includeCurrent: true` is the full sign-out, which until now was reachable
 * only as a side effect of changing a password.
 *
 * Live device authorizations are refused as well, in both modes. A device
 * waiting on an approved code has no key yet, so it is never the caller's own
 * device and never the one being spared — but its next poll would register a
 * brand-new active key, which would undo the revocation seconds after it ran.
 * That is the whole point of the call: the user has decided nothing else is to
 * stay signed in.
 *
 * `revokedCount` counts keys only, since that is the number the caller's screen
 * means by "devices signed out"; a code nobody had collected was never a session.
 */
export async function revokeAllKeysService(
    params: RevokeAllKeysParams,
): Promise<RevokeAllKeysResult>
{
    const { userId, currentKeyId, includeCurrent = false, reason } = params;

    if (!includeCurrent && !currentKeyId)
    {
        throw new ValidationError({ message: 'currentKeyId is required unless includeCurrent is set' });
    }

    return await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        // Only when a session is making the call (see `credential`).
        if (params.credential)
        {
            await assertStepUp({ userId, credential: params.credential });
        }

        const revoked = !includeCurrent && currentKeyId
            ? await keysRepository.revokeAllActiveByUserIdExcept(userId, currentKeyId, reason)
            : await keysRepository.revokeAllActiveByUserId(userId, reason);

        await revokeEveryWayBackIn(userId);

        return { revokedCount: revoked.length, currentKeyRevoked: includeCurrent };
    }, { context: 'auth:revoke-all-keys' });
}

/**
 * What a global revocation ends beside the keys: every way a device could sign
 * itself back in after it.
 */
async function revokeEveryWayBackIn(userId: number): Promise<void>
{
    await deviceAuthorizationsRepository.denyAllActiveByUserId(userId);

    // Device links the account issued go with them, for the same reason: an
    // approved link nobody has collected would register a key after this.
    await deviceLinksRepository.expireAllLiveByUserId(userId);

    // A grant the user gave a CLI carries a refresh token, so a client holding
    // one signs itself back in within the hour — which is exactly the client a
    // global revocation is aimed at. Revoked alongside the device codes, and for
    // the reason they are.
    await revokeAllOAuth2GrantsForUser(userId);
}
